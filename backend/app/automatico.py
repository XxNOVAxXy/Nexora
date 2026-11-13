"""Extracción automática de estados de cuenta.

Cada ``intervalo`` minutos un hilo del backend revisa Gmail con el filtro de estados de cuenta y extrae con Gemini
los adjuntos nuevos. El resultado se guarda como borrador en ``AlmacenExtracciones``, igual que si el usuario
hubiera pulsado "Extraer" y guardado. Nunca envía nada a SaveData: ese paso sigue siendo manual.

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
    ExtraccionDanada,
    GuardarExtraccionRequest,
    cuenta_id,
    escribir_atomico,
)
from .gemini import GeminiRequestError, GeminiUnavailableError, clave_campo, normalizar_campos_solicitados
from .gmail import GmailNotConnectedError, GmailRateLimitError

logger = logging.getLogger("nexora.automatico")

MAX_INTENTOS = 3
MAX_CORREOS_POR_CICLO = 100
# Margen hacia atrás sobre el último correo procesado: Gmail no garantiza el orden exacto de llegada.
MARGEN_BUSQUEDA = timedelta(days=1)
# Un archivo de bloqueo más viejo que esto es de un proceso que murió a mitad de un ciclo.
BLOQUEO_CADUCA_SEGUNDOS = 30 * 60
INTERVALO_PREDETERMINADO = 20

TERMINALES = {"extraido", "omitido", "error"}


def intervalo_desde_entorno(valor: str | None) -> float:
    """``NEXORA_INTERVALO_MINUTOS``: entero o decimal >= 1. Cualquier otro valor usa 20."""
    try:
        minutos = float((valor or "").strip())
    except ValueError:
        return INTERVALO_PREDETERMINADO
    return minutos if minutos >= 1 else INTERVALO_PREDETERMINADO


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


class _CortarCiclo(Exception):
    """Gmail limita las consultas, se perdió la conexión o el backend se está apagando: se sigue en otro ciclo."""


# --- Conversión del resultado de Gemini en borrador (port de documentoDesdeExtraccion del frontend) ----------

def borrador_desde_extraccion(resultado: dict[str, Any], campos: list[str], *, filename: str, attachment_id: str | None, lote: str) -> GuardarExtraccionRequest:
    """Documento nuevo (sin filas previas): filas de la IA con ids únicos del lote, las columnas pedidas creadas como
    columnas del usuario y llenadas con lo que la IA encontró (celdas marcadas en ``extras_ia``), y las sugerencias
    de la IA guardadas para el menú "+ Campo". Las sugerencias no se convierten en columnas: eso lo decide el usuario.
    """
    transacciones = [
        {**fila, "id": f"ia-{lote}-{indice + 1}", "origen": "ia"}
        for indice, fila in enumerate(resultado.get("transacciones") or [])
    ]
    columnas = [
        {"id": f"campo-auto-{lote}-{indice + 1}", "nombre": nombre, "origen": "manual"}
        for indice, nombre in enumerate(campos[:MAX_CAMPOS_EXTRA])
    ]
    resultados = {clave_campo(item.get("nombre", "")): item for item in resultado.get("resultados_campos") or []}
    for columna in columnas:
        encontrado = resultados.get(clave_campo(columna["nombre"]))
        if not encontrado or not encontrado.get("encontrado"):
            continue
        valores = encontrado.get("valores") or []
        por_huella: dict[str, list[str]] = {}
        for item in valores:
            por_huella.setdefault(item.get("huella", ""), []).append(item.get("valor", ""))
        unico = encontrado.get("valor_documento") or ""
        for fila in transacciones:
            if valores:
                cola = por_huella.get(fila.get("huella") or "")
                valor = cola.pop(0) if cola else ""
            else:
                valor = unico
            valor = valor[:MAX_VALOR_CAMPO]
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
    ) -> None:
        self.raiz = raiz
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
        base: dict[str, Any] = {"activo": False, "activado_en": None, "ultimo_correo": None, "ultima_revision": None, "ultimo_resultado": None, "ultimo_error": None, "adjuntos": {}}
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

    def campos_a_buscar(self, email: str) -> list[str]:
        """Columnas que el usuario agregó o aceptó en sus extracciones guardadas (más recientes primero, máx. 30).
        Las sugerencias que no eligió no están en ``campos_extra`` y nunca se piden."""
        listado = sorted(self.almacen.listar(email), key=lambda item: item.get("actualizado") or "", reverse=True)
        nombres: list[str] = []
        for entrada in listado:
            try:
                documento = self.almacen.obtener(email, entrada["messageId"], entrada["partId"])
            except (ExtraccionDanada, ValueError, TypeError, KeyError):
                continue
            nombres += [campo.get("nombre", "") for campo in (documento or {}).get("campos_extra") or []]
        return normalizar_campos_solicitados(nombres)[:MAX_CAMPOS_EXTRA]

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
            "adjuntos": {
                clave: {k: entrada.get(k) for k in ("estado", "intentos", "error", "version", "actualizado")}
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
        if not self.gemini.status().get("enabled"):
            self._cerrar_ciclo(email, "sin_gemini", None)
            return {"resultado": "sin_gemini"}

        resumen = {"resultado": "ok", "extraidos": 0, "errores": 0, "omitidos": 0}
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
        campos = self.campos_a_buscar(email)
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

    def _procesar_adjunto(self, email: str, message_id: str, part_id: str, adjunto: dict[str, Any], campos: list[str], resumen: dict[str, Any]) -> str:
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
            resultado = self.gemini.extract_document(data, media_type, nombre or filename, campos_solicitados=campos)
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
        self._anotar(email, clave, estado="extraido", error=None, version=documento.get("version"))
        resumen["extraidos"] += 1
        logger.info("Extraccion automatica guardada %s transacciones=%d", clave, len(documento.get("transacciones", [])))
        return "extraido"

    def _fallo(self, email: str, clave: str, intentos: int, mensaje: str, resumen: dict[str, Any]) -> str:
        estado = "error" if intentos >= MAX_INTENTOS else "pendiente"
        self._anotar(email, clave, estado=estado, intentos=intentos, error=mensaje[:500])
        if estado == "error":
            resumen["errores"] += 1
        return estado

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
