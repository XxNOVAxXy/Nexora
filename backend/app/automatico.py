"""Extracción automática de estados de cuenta.

Cada ``intervalo`` minutos un hilo del backend revisa Gmail con el filtro de estados de cuenta y extrae con Gemini
los adjuntos nuevos. El resultado se guarda como borrador en ``AlmacenExtracciones``, igual que si el usuario
hubiera pulsado "Extraer" y guardado.

Envío automático a SaveData (``envio_activo``, apagado por defecto): los adjuntos extraídos *con el interruptor
encendido* (``enviar_auto``) se marcan como revisados y se envían con ``ServicioEnvio.enviar`` (mismo Id,
Actualizacion y formato que el envío manual). Solo si el usuario no tocó el documento (misma versión, sin envíos
ajenos). El intento se registra (``envio.estado = en_curso``) antes de contactar SaveData; un reinicio a mitad nunca
reenvía a ciegas. Con ``solo_si_cuadra`` (encendido por defecto) un documento que no cuadra, con importes inválidos o
dudosos queda en ``requiere_revision``. Errores claros: hasta ``MAX_INTENTOS`` envíos, uno por ciclo. Timeout
(incierto): nunca se reintenta.

Estado por cuenta en ``<raiz>/<cuenta_id>.json`` (escritura atómica):

- ``activo`` / ``activado_en``: solo se procesan correos recibidos después de ``activado_en``. Pausar y reanudar
  conserva la fecha original.
- ``adjuntos``: registro por ``messageId__partId`` (``pendiente``, ``en_curso``, ``extraido``, ``omitido``,
  ``error``). Se escribe ``en_curso`` con el intento ya contado *antes* de llamar a Gemini, así un reinicio a mitad
  de la llamada cuenta como intento fallido y nunca produce una segunda extracción guardada.
- ``ultimo_correo``: último correo procesado por completo; acota la búsqueda en Gmail.

Un solo ciclo a la vez: un lock del proceso y un archivo de bloqueo (``.ciclo.lock``) por si hay dos procesos.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from . import filtro_estados
from .extracciones import (
    ID_DOCUMENTO_SEGURO,
    MAX_CAMPOS_EXTRA,
    MAX_SUGERENCIAS_CAMPOS,
    MAX_VALOR_CAMPO,
    ConflictoVersion,
    EnvioEnCurso,
    GuardarExtraccionRequest,
    cuenta_id,
    escribir_atomico,
)
from .gemini import GeminiRequestError, GeminiUnavailableError, clave_campo, normalizar_campos_solicitados
from .gmail import GmailNotConnectedError, GmailRateLimitError
from .orden_fechas import ordenar_por_fecha
from .plantilla_campos import AlmacenPlantillas, deducir_campos

logger = logging.getLogger("nexora.automatico")

MAX_INTENTOS = 3
MAX_CORREOS_POR_CICLO = 100
# Margen hacia atrás sobre el último correo procesado: Gmail no garantiza el orden exacto de llegada.
MARGEN_BUSQUEDA = timedelta(days=1)
# Un archivo de bloqueo más viejo que esto es de un proceso que murió a mitad de un ciclo.
BLOQUEO_CADUCA_SEGUNDOS = 30 * 60
INTERVALO_PREDETERMINADO = 20

TERMINALES = {"extraido", "omitido", "error"}
# Estados finales del envío automático: nunca se vuelve a enviar solo.
TERMINALES_ENVIO = {"enviado", "requiere_revision", "error", "incierto", "sin_savedata", "omitido"}


def intervalo_desde_entorno(valor: str | None) -> float:
    """``NEXORA_INTERVALO_MINUTOS``: entero o decimal >= 1. Cualquier otro valor usa 20."""
    try:
        minutos = float((valor or "").strip())
    except ValueError:
        return INTERVALO_PREDETERMINADO
    return minutos if minutos >= 1 else INTERVALO_PREDETERMINADO


def _envio_publico(envio: Any) -> dict[str, Any] | None:
    if not isinstance(envio, dict):
        return None
    return {k: envio.get(k) for k in ("estado", "intentos", "error", "motivos", "problemas", "version", "actualizado")}


def _iso(momento: datetime | None) -> str | None:
    return None if momento is None else momento.astimezone(timezone.utc).isoformat(timespec="seconds")


def _fecha(valor: Any) -> datetime | None:
    if not isinstance(valor, str) or not valor:
        return None
    try:
        momento = datetime.fromisoformat(valor)
    except ValueError:
        return None
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


def _comparable(nombre: str) -> str:
    """Igual que ``nombreComparable`` del frontend: sin acentos, minúsculas y espacios simples."""
    sin_acentos = "".join(c for c in unicodedata.normalize("NFKD", nombre) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", sin_acentos).strip().lower()


class _DocumentoTocado(Exception):
    """El usuario guardó, editó o envió el documento: el envío automático ya no lo toca."""


def motivos_sin_cuadrar(problemas: dict[str, Any]) -> list[str]:
    """Por qué un documento no pasa la protección "Enviar solo si cuadra"."""
    motivos = []
    if problemas.get("cuadra") is not True:
        motivos.append("La validacion contable no cuadra." if problemas.get("cuadra") is False else "La validacion contable esta incompleta.")
    if problemas.get("invalidos"):
        motivos.append(f"{problemas['invalidos']} importe(s) invalido(s).")
    if problemas.get("dudosos"):
        motivos.append(f"{problemas['dudosos']} importe(s) dudoso(s).")
    return motivos


def problemas_encontrados(problemas: dict[str, Any]) -> list[str]:
    """Todo lo que la revisión exigiría confirmar; se anota cuando se envía con la protección apagada."""
    motivos = motivos_sin_cuadrar(problemas)
    if problemas.get("diferencias"):
        motivos.append(f"{problemas['diferencias']} diferencia(s) en la validacion.")
    if problemas.get("en_revision"):
        motivos.append(f"{problemas['en_revision']} movimiento(s) marcados para revision.")
    return motivos


class _CortarCiclo(Exception):
    """Gmail limita las consultas, se perdió la conexión o el backend se está apagando: se sigue en otro ciclo."""


# --- Conversión del resultado de Gemini en borrador (port de documentoDesdeExtraccion del frontend) ----------

def _valor_unico(valores: list[dict[str, Any]]) -> str | None:
    """Valores por fila que en realidad son uno solo: todos iguales (y no vacíos)."""
    distintos = {str(item.get("valor") or "").strip() for item in valores} - {""}
    return distintos.pop()[:MAX_VALOR_CAMPO] if len(distintos) == 1 else None


def borrador_desde_extraccion(resultado: dict[str, Any], campos: list[dict[str, Any]], *, filename: str, attachment_id: str | None, lote: str) -> GuardarExtraccionRequest:
    """Documento nuevo (sin filas previas) a partir de la configuración de campos.

    Filas de la IA con ids únicos del lote y ordenadas por fecha; los campos configurados creados vinculados a la
    configuración (``plantilla_id``) y llenados con lo que la IA encontró; las sugerencias de la IA guardadas para el
    menú "+ Campo" (no se convierten en campos: eso lo decide el usuario).

    El tipo configurado manda:
    - "Una vez" (documento): toma el valor único; si la IA lo encontró por fila con todos los valores iguales, se
      acepta como valor único. Con valores distintos no se llena (hay que revisar el tipo en Configuración).
    - "En cada movimiento": toma los valores por fila; un valor único del documento no se repite en cada fila.
    """
    transacciones = [
        {**fila, "id": f"ia-{lote}-{indice + 1}", "origen": "ia"}
        for indice, fila in enumerate(ordenar_por_fecha(list(resultado.get("transacciones") or []), (resultado.get("resumen") or {}).get("periodo", "")))
    ]
    columnas: list[dict[str, Any]] = []
    for configurado in campos[:MAX_CAMPOS_EXTRA]:
        columna: dict[str, Any] = {"id": configurado["id"], "nombre": configurado["nombre"], "origen": configurado.get("origen", "manual"), "plantilla_id": configurado["id"]}
        if configurado.get("clave"):
            columna["clave"] = configurado["clave"]
        if configurado.get("alcance") == "documento":
            columna.update(alcance="documento", valor="")
        columnas.append(columna)
    resultados = {clave_campo(item.get("nombre", "")): item for item in resultado.get("resultados_campos") or []}
    for columna in columnas:
        encontrado = resultados.get(clave_campo(columna["nombre"]))
        if not encontrado or not encontrado.get("encontrado"):
            continue
        valores = encontrado.get("valores") or []
        unico = (encontrado.get("valor_documento") or "").strip()[:MAX_VALOR_CAMPO]
        if columna.get("alcance") == "documento":
            valor = unico if not valores else _valor_unico(valores)
            if valor:
                columna.update(valor=valor, valor_ia=True)
            continue
        if not valores:
            continue  # Valor único del documento en un campo "En cada movimiento": nunca se repite en cada fila.
        por_huella: dict[str, list[str]] = {}
        for item in valores:
            por_huella.setdefault(item.get("huella", ""), []).append(item.get("valor", ""))
        for fila in transacciones:
            cola = por_huella.get(fila.get("huella") or "")
            valor = (cola.pop(0) if cola else "")[:MAX_VALOR_CAMPO]
            if not valor:
                continue
            fila["extras"] = {**(fila.get("extras") or {}), columna["id"]: valor}
            fila["extras_ia"] = [*(fila.get("extras_ia") or []), columna["id"]]
    return GuardarExtraccionRequest.model_validate({
        "version_base": None,
        "estado": "borrador",
        "resumen": resultado.get("resumen") or {},
        "transacciones": transacciones,
        "formato_numerico": resultado.get("formato_numerico"),
        "modelo": resultado.get("model"),
        "prompt_version": resultado.get("prompt_version"),
        "filename": filename,
        "attachmentId": attachment_id,
        "campos_extra": columnas,
        "sugerencias_campos": list(resultado.get("sugerencias_campos") or [])[:MAX_SUGERENCIAS_CAMPOS],
    })


class ExtractorAutomatico:
    def __init__(
        self,
        raiz: Path,
        gmail: Any,
        gemini: Any,
        almacen: Any,
        intervalo_minutos: float = INTERVALO_PREDETERMINADO,
        reloj: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        plantillas: AlmacenPlantillas | None = None,
        envios: Any = None,
    ) -> None:
        self.raiz = raiz
        # ServicioEnvio de savedata.py: el envío automático reutiliza exactamente el envío manual.
        self.envios = envios
        # Configuración de campos; sin ella, la lista efectiva es la deducida de las extracciones guardadas.
        self.plantillas = plantillas or AlmacenPlantillas(raiz / "_sin_configuracion", lambda email: deducir_campos(almacen, email))
        self.gmail = gmail
        self.gemini = gemini
        self.almacen = almacen
        self.intervalo_minutos = intervalo_minutos
        self.reloj = reloj
        self._ciclo = threading.Lock()
        self._estado_lock = threading.Lock()
        self._parar = threading.Event()
        self._despertar = threading.Event()
        self._hilo: threading.Thread | None = None
        self._proxima: datetime | None = None

    # --- Estado persistente -------------------------------------------------------------------

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.json"

    def _leer(self, email: str) -> dict[str, Any]:
        ruta = self._ruta(email)
        base: dict[str, Any] = {"activo": False, "activado_en": None, "ultimo_correo": None, "ultima_revision": None, "ultimo_resultado": None, "ultimo_error": None,
                                "envio_activo": False, "solo_si_cuadra": True, "envio_activado_en": None, "adjuntos": {}}
        if not ruta.exists():
            return base
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # Nunca se pierde la fecha de activación en silencio: un archivo dañado deja el proceso pausado.
            logger.exception("Estado de la extraccion automatica danado: %s", ruta.name)
            return base
        return {**base, **datos, "adjuntos": dict(datos.get("adjuntos") or {})}

    def _mutar(self, email: str, cambio: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with self._estado_lock:
            estado = self._leer(email)
            cambio(estado)
            escribir_atomico(self._ruta(email), estado)
            return estado

    def _anotar(self, email: str, clave: str, **valores: Any) -> dict[str, Any]:
        def cambio(estado: dict[str, Any]) -> None:
            entrada = dict(estado["adjuntos"].get(clave) or {"intentos": 0})
            entrada.update(valores, actualizado=_iso(self.reloj()))
            estado["adjuntos"][clave] = entrada
        return self._mutar(email, cambio)["adjuntos"][clave]

    def configurar(self, email: str, activo: bool) -> dict[str, Any]:
        def cambio(estado: dict[str, Any]) -> None:
            estado["activo"] = activo
            # La fecha de activación se fija la primera vez y se conserva al pausar y reanudar.
            if activo and not estado.get("activado_en"):
                estado["activado_en"] = _iso(self.reloj())
        self._mutar(email, cambio)
        if activo:
            self.revisar_ahora()
        return self.estado(email)

    def savedata_configurada(self) -> bool:
        return self.envios is not None and bool(self.envios.url().strip())

    def configurar_envio(self, email: str, envio_activo: bool, solo_si_cuadra: bool) -> dict[str, Any]:
        """Interruptores del envío automático. Encenderlo exige SAVEDATA_URL; solo aplica a lo que se extraiga después."""
        if envio_activo and not self.savedata_configurada():
            raise ValueError("SAVEDATA_URL no esta configurada en el backend.")

        def cambio(estado: dict[str, Any]) -> None:
            if envio_activo and not estado.get("envio_activo"):
                estado["envio_activado_en"] = _iso(self.reloj())
            estado["envio_activo"] = envio_activo
            estado["solo_si_cuadra"] = solo_si_cuadra
        self._mutar(email, cambio)
        return self.estado(email)

    def campos_configurados(self, email: str) -> list[dict[str, Any]]:
        """Campos de la configuración (o, si nunca se guardó, los deducidos de las extracciones guardadas)."""
        return self.plantillas.efectiva(email)

    def campos_a_buscar(self, email: str) -> list[str]:
        """Nombres que se piden a Gemini: los de la configuración de campos."""
        return normalizar_campos_solicitados([campo["nombre"] for campo in self.campos_configurados(email)])[:MAX_CAMPOS_EXTRA]

    def estado(self, email: str) -> dict[str, Any]:
        estado = self._leer(email)
        try:
            gemini_listo = bool(self.gemini.status().get("enabled"))
        except Exception:
            gemini_listo = False
        return {
            "activo": bool(estado["activo"]),
            "activado_en": estado["activado_en"],
            "ultima_revision": estado["ultima_revision"],
            "proxima_revision": _iso(self._proxima) if estado["activo"] and self.corriendo() else None,
            "en_curso": self._ciclo.locked(),
            "intervalo_minutos": self.intervalo_minutos,
            "ultimo_resultado": estado["ultimo_resultado"],
            "ultimo_error": estado["ultimo_error"],
            "gemini_configurado": gemini_listo,
            "campos": self.campos_a_buscar(email),
            "envio_activo": bool(estado.get("envio_activo")),
            "solo_si_cuadra": estado.get("solo_si_cuadra") is not False,
            "envio_activado_en": estado.get("envio_activado_en"),
            "savedata_configurada": self.savedata_configurada(),
            "adjuntos": {
                clave: {
                    **{k: entrada.get(k) for k in ("estado", "intentos", "error", "version", "actualizado")},
                    "enviar_auto": bool(entrada.get("enviar_auto")),
                    "envio": _envio_publico(entrada.get("envio")),
                }
                for clave, entrada in estado["adjuntos"].items()
            },
        }

    # --- Bloqueo entre procesos ---------------------------------------------------------------

    def _tomar_bloqueo(self) -> Path | None:
        ruta = self.raiz / ".ciclo.lock"
        self.raiz.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(ruta, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    if time.time() - ruta.stat().st_mtime > BLOQUEO_CADUCA_SEGUNDOS:
                        ruta.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                return None
            with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
                archivo.write(f"{os.getpid()} {_iso(self.reloj())}")
            return ruta
        return None

    # --- Ciclo --------------------------------------------------------------------------------

    def ejecutar_ciclo(self) -> dict[str, Any]:
        """Un ciclo completo. Si ya hay otro en curso (en este u otro proceso) no hace nada."""
        if not self._ciclo.acquire(blocking=False):
            return {"resultado": "en_curso"}
        try:
            bloqueo = self._tomar_bloqueo()
            if bloqueo is None:
                return {"resultado": "en_curso"}
            try:
                return self._ciclo_protegido()
            finally:
                bloqueo.unlink(missing_ok=True)
        finally:
            self._ciclo.release()

    def _ciclo_protegido(self) -> dict[str, Any]:
        try:
            email = self.gmail.profile().get("email")
        except GmailNotConnectedError:
            return {"resultado": "sin_gmail"}
        except GmailRateLimitError:
            return {"resultado": "limite_gmail"}
        except Exception as error:
            logger.warning("Extraccion automatica: no se pudo identificar la cuenta: %s", error)
            return {"resultado": "sin_gmail"}
        if not email:
            return {"resultado": "sin_gmail"}
        estado = self._leer(email)
        activado = _fecha(estado.get("activado_en"))
        if not estado["activo"] or activado is None:
            return {"resultado": "pausado"}
        # Reintentos de envío pendientes: no dependen de Gmail ni de Gemini.
        envios_previos = self._procesar_envios(email)
        if not self.gemini.status().get("enabled"):
            self._cerrar_ciclo(email, "sin_gemini", None)
            return {"resultado": "sin_gemini"}

        resumen = {"resultado": "ok", "extraidos": 0, "errores": 0, "omitidos": 0, "enviados": envios_previos}
        try:
            self._procesar(email, estado, activado, resumen)
        except _CortarCiclo as corte:
            resumen["resultado"] = "interrumpido"
            self._cerrar_ciclo(email, "interrumpido", str(corte) or None)
            return resumen
        except GmailRateLimitError as error:
            resumen["resultado"] = "limite_gmail"
            self._cerrar_ciclo(email, "limite_gmail", str(error))
            return resumen
        except Exception as error:
            logger.exception("Extraccion automatica: el ciclo fallo")
            resumen["resultado"] = "error"
            self._cerrar_ciclo(email, "error", str(error))
            return resumen
        self._cerrar_ciclo(email, "ok", None)
        return resumen

    def _cerrar_ciclo(self, email: str, resultado: str, error: str | None) -> None:
        def cambio(estado: dict[str, Any]) -> None:
            estado["ultima_revision"] = _iso(self.reloj())
            estado["ultimo_resultado"] = resultado
            estado["ultimo_error"] = error
        self._mutar(email, cambio)

    def _candidatos(self, estado: dict[str, Any], activado: datetime) -> list[str]:
        ultimo = _fecha((estado.get("ultimo_correo") or {}).get("recibido"))
        desde = activado if ultimo is None else max(activado, ultimo - MARGEN_BUSQUEDA)
        query = f"{filtro_estados.construir_query('inbox')} after:{int(desde.timestamp())}"
        ids = self.gmail.buscar_ids(query, MAX_CORREOS_POR_CICLO)
        # Los adjuntos con reintentos pendientes se vuelven a revisar aunque ya no entren en la búsqueda.
        pendientes = [clave.split("__", 1)[0] for clave, entrada in estado["adjuntos"].items() if entrada.get("estado") not in TERMINALES]
        return list(dict.fromkeys([*pendientes, *ids]))

    def _procesar(self, email: str, estado: dict[str, Any], activado: datetime, resumen: dict[str, Any]) -> None:
        campos = self.campos_configurados(email)
        ultimo: dict[str, Any] | None = estado.get("ultimo_correo")
        for message_id in self._candidatos(estado, activado):
            if self._parar.is_set():
                raise _CortarCiclo("El backend se esta apagando.")
            if not ID_DOCUMENTO_SEGURO.fullmatch(message_id):
                continue
            mensaje = self.gmail.get_message(message_id)
            recibido = _fecha(mensaje.get("receivedAt"))
            # Solo correos que llegaron después de activar el proceso; nunca los anteriores.
            if recibido is None or recibido <= activado:
                continue
            if filtro_estados.asunto_coincide(mensaje.get("subject", "")) is None:
                continue
            completo = True
            for adjunto in mensaje.get("attachments") or []:
                part_id = str(adjunto.get("partId") or "")
                if not filtro_estados.es_documento_extraible(adjunto) or not ID_DOCUMENTO_SEGURO.fullmatch(part_id):
                    continue
                if self._procesar_adjunto(email, message_id, part_id, adjunto, campos, resumen) not in TERMINALES:
                    completo = False
            if completo and (ultimo is None or (_fecha(ultimo.get("recibido")) or activado) < recibido):
                ultimo = {"id": message_id, "recibido": _iso(recibido)}
                self._mutar(email, lambda e, u=ultimo: e.__setitem__("ultimo_correo", u))

    def _procesar_adjunto(self, email: str, message_id: str, part_id: str, adjunto: dict[str, Any], campos: list[dict[str, Any]], resumen: dict[str, Any]) -> str:
        clave = f"{message_id}__{part_id}"
        entrada = self._leer(email)["adjuntos"].get(clave) or {}
        if entrada.get("estado") in TERMINALES:
            return entrada["estado"]
        intentos = int(entrada.get("intentos") or 0)
        if intentos >= MAX_INTENTOS:
            self._anotar(email, clave, estado="error", error=entrada.get("error") or "Se agotaron los intentos.")
            resumen["errores"] += 1
            return "error"
        # Una extracción guardada (o editada) por el usuario nunca se toca.
        if self.almacen.obtener(email, message_id, part_id) is not None:
            self._anotar(email, clave, estado="omitido", error=None)
            resumen["omitidos"] += 1
            return "omitido"

        # El intento queda contado en disco antes de llamar a Gemini.
        self._anotar(email, clave, estado="en_curso", intentos=intentos + 1, error=None)
        filename = str(adjunto.get("filename") or "")
        attachment_id = str(adjunto.get("id") or "")
        try:
            data, media_type, nombre = self.gmail.attachment(message_id, attachment_id)
            resultado = self.gemini.extract_document(data, media_type, nombre or filename, campos_solicitados=[campo["nombre"] for campo in campos])
        except (GmailRateLimitError, GmailNotConnectedError, GeminiUnavailableError) as error:
            # No es culpa del documento: el intento no cuenta y se sigue en el siguiente ciclo.
            self._anotar(email, clave, estado="pendiente", intentos=intentos, error=str(error))
            raise _CortarCiclo(str(error)) from error
        except GeminiRequestError as error:
            estado = self._fallo(email, clave, intentos + 1, str(error), resumen)
            if error.status_code == 429:
                raise _CortarCiclo(str(error)) from error
            return estado
        except Exception as error:
            logger.exception("Extraccion automatica fallo para %s", clave)
            return self._fallo(email, clave, intentos + 1, str(error) or error.__class__.__name__, resumen)

        try:
            solicitud = borrador_desde_extraccion(resultado, campos, filename=nombre or filename, attachment_id=attachment_id or None, lote=uuid.uuid4().hex[:8])
            documento = self.almacen.guardar(email, message_id, part_id, solicitud)
        except (ConflictoVersion, EnvioEnCurso):
            # El usuario guardó este documento mientras Gemini extraía: lo suyo se conserva.
            self._anotar(email, clave, estado="omitido", error=None)
            resumen["omitidos"] += 1
            return "omitido"
        except Exception as error:
            logger.exception("Extraccion automatica: no se pudo guardar %s", clave)
            return self._fallo(email, clave, intentos + 1, str(error) or error.__class__.__name__, resumen)
        # Solo lo extraído con el envío automático encendido se envía solo.
        enviar_auto = bool(self._leer(email).get("envio_activo"))
        self._anotar(email, clave, estado="extraido", error=None, version=documento.get("version"), enviar_auto=enviar_auto)
        resumen["extraidos"] += 1
        logger.info("Extraccion automatica guardada %s transacciones=%d", clave, len(documento.get("transacciones", [])))
        if enviar_auto and self._enviar_auto(email, message_id, part_id) == "enviado":
            resumen["enviados"] = resumen.get("enviados", 0) + 1
        return "extraido"

    def _fallo(self, email: str, clave: str, intentos: int, mensaje: str, resumen: dict[str, Any]) -> str:
        estado = "error" if intentos >= MAX_INTENTOS else "pendiente"
        self._anotar(email, clave, estado=estado, intentos=intentos, error=mensaje[:500])
        if estado == "error":
            resumen["errores"] += 1
        return estado

    # --- Envío automático a SaveData -----------------------------------------------------------

    def _procesar_envios(self, email: str) -> int:
        """Reintenta los envíos automáticos que quedaron pendientes (o interrumpidos) en ciclos anteriores."""
        estado = self._leer(email)
        if not estado.get("envio_activo"):
            return 0
        enviados = 0
        for clave, entrada in estado["adjuntos"].items():
            if entrada.get("estado") != "extraido" or not entrada.get("enviar_auto"):
                continue
            if (entrada.get("envio") or {}).get("estado") in TERMINALES_ENVIO:
                continue
            message_id, _, part_id = clave.partition("__")
            if self._enviar_auto(email, message_id, part_id) == "enviado":
                enviados += 1
        return enviados

    def _anotar_envio(self, email: str, clave: str, **valores: Any) -> dict[str, Any]:
        def cambio(estado: dict[str, Any]) -> None:
            entrada = dict(estado["adjuntos"].get(clave) or {"intentos": 0})
            envio = dict(entrada.get("envio") or {"intentos": 0, "intentos_ids": []})
            envio.update(valores, actualizado=_iso(self.reloj()))
            entrada["envio"] = envio
            estado["adjuntos"][clave] = entrada
        return self._mutar(email, cambio)["adjuntos"][clave]["envio"]

    def _reflejar_en_documento(self, email: str, message_id: str, part_id: str, envio: dict[str, Any], intento_id: str | None = None) -> None:
        """Copia el estado del envío automático al documento (lo muestra la página Envíos) y marca su intento."""
        def cambio(documento: dict[str, Any] | None) -> dict[str, Any]:
            if documento is None:
                raise _DocumentoTocado()
            envios = [{**item, "automatico": True} if intento_id and item.get("id") == intento_id else item for item in documento.get("envios", [])]
            return {**documento, "envios": envios, "envio_automatico": {k: envio.get(k) for k in ("estado", "intentos", "error", "motivos", "problemas", "actualizado")}}
        try:
            self.almacen.actualizar(email, message_id, part_id, cambio)
        except _DocumentoTocado:
            pass
        except Exception:
            logger.exception("Envio automatico: no se pudo anotar el estado en el documento %s__%s", message_id, part_id)

    def _terminar_envio(self, email: str, message_id: str, part_id: str, estado: str, **valores: Any) -> str:
        clave = f"{message_id}__{part_id}"
        intento_id = valores.pop("intento_id", None)
        envio = self._anotar_envio(email, clave, estado=estado, **valores)
        if estado != "omitido":
            self._reflejar_en_documento(email, message_id, part_id, envio, intento_id)
        return estado

    def _enviar_auto(self, email: str, message_id: str, part_id: str) -> str | None:
        """Marca como revisado y envía a SaveData un documento extraído automáticamente que nadie tocó.

        Devuelve el estado del envío automático, o None si no aplica.
        """
        clave = f"{message_id}__{part_id}"
        cuenta = self._leer(email)
        entrada = cuenta["adjuntos"].get(clave) or {}
        if self.envios is None or not cuenta.get("envio_activo") or not entrada.get("enviar_auto") or entrada.get("estado") != "extraido":
            return None
        envio = dict(entrada.get("envio") or {})
        if envio.get("estado") in TERMINALES_ENVIO:
            return envio["estado"]
        intentos = int(envio.get("intentos") or 0)
        propios = list(envio.get("intentos_ids") or [])

        documento = self.almacen.leer_completo(email, message_id, part_id)
        if documento is None:
            return self._terminar_envio(email, message_id, part_id, "omitido", error="El documento ya no existe.")
        ajenos = [item for item in documento.get("envios") or [] if item.get("id") not in propios]

        if envio.get("estado") == "en_curso":
            # El backend se detuvo a mitad del envío. Si ServicioEnvio llegó a registrar el intento, SaveData pudo
            # haberlo recibido: nunca se reenvía a ciegas.
            if ajenos:
                ultimo = ajenos[-1]
                ids = [*propios, ultimo.get("id")]
                if ultimo.get("resultado") == "exito":
                    return self._terminar_envio(email, message_id, part_id, "enviado", error=None, intentos_ids=ids, intento_id=ultimo.get("id"))
                if ultimo.get("resultado") == "error":
                    return self._terminar_envio(email, message_id, part_id, "error" if intentos >= MAX_INTENTOS else "pendiente", error=ultimo.get("error"), intentos_ids=ids, intento_id=ultimo.get("id"))
                return self._terminar_envio(email, message_id, part_id, "incierto", error="El backend se detuvo durante el envio; verifica en SaveData si llego.", intentos_ids=ids, intento_id=ultimo.get("id"))
            # SaveData nunca se contactó: se puede intentar de nuevo (el intento ya quedó contado).

        if intentos >= MAX_INTENTOS:
            return self._terminar_envio(email, message_id, part_id, "error", error=envio.get("error") or "Se agotaron los intentos de envio.")
        if not self.savedata_configurada():
            return self._terminar_envio(email, message_id, part_id, "sin_savedata", error="SAVEDATA_URL no esta configurada: se extrajo pero no se envio.")
        if ajenos:
            return self._terminar_envio(email, message_id, part_id, "omitido", error="El documento ya se envio manualmente.")

        version_revisada = envio.get("version")
        if version_revisada is None:
            # Primera vez: el documento debe seguir siendo el borrador que guardó el proceso automático.
            if documento.get("estado") != "borrador" or documento.get("version") != entrada.get("version"):
                return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito el documento.")
            problemas = documento.get("problemas") or {}
            motivos = motivos_sin_cuadrar(problemas)
            if motivos and cuenta.get("solo_si_cuadra") is not False:
                return self._terminar_envio(email, message_id, part_id, "requiere_revision", error=None, motivos=motivos, problemas=problemas_encontrados(problemas))
            try:
                revisado = self.almacen.actualizar(email, message_id, part_id, self._marcar_revisado(documento.get("version")))
            except _DocumentoTocado:
                return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito el documento.")
            version_revisada = revisado.get("version")
            self._anotar_envio(email, clave, version=version_revisada, problemas=problemas_encontrados(problemas), motivos=[])
        elif documento.get("estado") != "revisado" or documento.get("version") != version_revisada:
            return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito el documento.")

        # El intento queda contado en disco antes de contactar SaveData.
        self._anotar_envio(email, clave, estado="en_curso", intentos=intentos + 1, error=None)
        return self._enviar_y_registrar(email, message_id, part_id, version_revisada, intentos + 1, propios)

    def _marcar_revisado(self, version: Any) -> Callable[[dict[str, Any] | None], dict[str, Any]]:
        def cambio(documento: dict[str, Any] | None) -> dict[str, Any]:
            if documento is None or documento.get("version") != version or documento.get("estado") != "borrador" or documento.get("envios"):
                raise _DocumentoTocado()
            ahora = _iso(self.reloj())
            return {**documento, "estado": "revisado", "version": int(version) + 1, "actualizado": ahora, "revisado_en": ahora,
                    "revisado_con_problemas": bool((documento.get("problemas") or {}).get("total")), "revisado_automaticamente": True}
        return cambio

    def _enviar_y_registrar(self, email: str, message_id: str, part_id: str, version: int, intentos: int, propios: list[str]) -> str:
        # Sucursal, artículo y carga inicial no forman parte del cuerpo (ver datos_documento): aquí no se exigen.
        from .savedata import EnvioRequest, NoSePuedeEnviar

        solicitud = EnvioRequest.model_construct(version_base=version, sucursal=None, articulo=None, carga_inicial=False, confirmar_reenvio=False, agregar_de_nuevo=False)
        try:
            respuesta, intento, _documento = self.envios.enviar(email, message_id, part_id, solicitud)
        except (ConflictoVersion, EnvioEnCurso):
            return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito o esta enviando el documento.")
        except NoSePuedeEnviar as error:
            if error.code == "savedata_sin_configurar":
                return self._terminar_envio(email, message_id, part_id, "sin_savedata", error=str(error))
            if error.code == "savedata_url_invalida":
                return self._terminar_envio(email, message_id, part_id, "error", error=str(error))
            return self._terminar_envio(email, message_id, part_id, "omitido", error=str(error))
        except Exception as error:
            # ServicioEnvio no registró el intento: SaveData no se contactó.
            logger.exception("Envio automatico fallo para %s__%s", message_id, part_id)
            estado = "error" if intentos >= MAX_INTENTOS else "pendiente"
            return self._terminar_envio(email, message_id, part_id, estado, error=(str(error) or error.__class__.__name__)[:500])

        ids = [*propios, intento["id"]]
        logger.info("Envio automatico %s__%s resultado=%s", message_id, part_id, respuesta.resultado)
        if respuesta.resultado == "exito":
            return self._terminar_envio(email, message_id, part_id, "enviado", error=None, intentos_ids=ids, intento_id=intento["id"])
        if respuesta.resultado == "incierto":
            # Pudo haber llegado: nunca se reintenta solo.
            return self._terminar_envio(email, message_id, part_id, "incierto", error=respuesta.mensaje, intentos_ids=ids, intento_id=intento["id"])
        estado = "error" if intentos >= MAX_INTENTOS else "pendiente"
        return self._terminar_envio(email, message_id, part_id, estado, error=respuesta.mensaje, intentos_ids=ids, intento_id=intento["id"])

    # --- Hilo programado ----------------------------------------------------------------------

    def corriendo(self) -> bool:
        return self._hilo is not None and self._hilo.is_alive()

    def iniciar(self) -> None:
        if self.corriendo():
            return
        self._parar.clear()
        self._hilo = threading.Thread(target=self._bucle, name="nexora-automatico", daemon=True)
        self._hilo.start()

    def detener(self, espera: float = 10.0) -> None:
        self._parar.set()
        self._despertar.set()
        if self._hilo is not None:
            self._hilo.join(timeout=espera)
        self._hilo = None
        self._proxima = None

    def revisar_ahora(self) -> bool:
        """Adelanta la siguiente revisión. False si ya hay un ciclo en curso."""
        if self._ciclo.locked():
            return False
        if self.corriendo():
            self._despertar.set()
        else:
            threading.Thread(target=self._ejecutar_seguro, name="nexora-automatico-manual", daemon=True).start()
        return True

    def _ejecutar_seguro(self) -> None:
        try:
            self.ejecutar_ciclo()
        except Exception:
            logger.exception("Extraccion automatica: error inesperado en el ciclo")

    def _bucle(self) -> None:
        segundos = self.intervalo_minutos * 60
        while not self._parar.is_set():
            self._ejecutar_seguro()
            if self._parar.is_set():
                break
            self._proxima = self.reloj() + timedelta(seconds=segundos)
            self._despertar.wait(timeout=segundos)
            self._despertar.clear()
