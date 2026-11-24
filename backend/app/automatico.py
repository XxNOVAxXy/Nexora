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
- ``ultimo_correo``: último correo con al menos un adjunto válido procesado por completo.
- ``revisado_hasta``: fecha del correo más reciente ya evaluado (extraído o descartado); acota la búsqueda en Gmail.
- ``descartados``: por qué se descartó cada correo o adjunto (``MOTIVOS``), con tope de ``MAX_DESCARTES``.
- ``ultimo_ciclo``: resumen del último ciclo, también de los que terminan antes de revisar Gmail.
- ``ciclo_en_curso``: marca escrita al empezar un ciclo y borrada al cerrarlo. Si el backend se reinicia a mitad,
  al arrancar (o en el siguiente ciclo) ese ciclo se registra como ``interrumpido_reinicio``.
- ``avisos``: lo que el usuario debe ver (envíos, documentos que requieren revisión, errores), con ``leido``.

Un solo ciclo a la vez: un lock del proceso y un archivo de bloqueo (``.ciclo.lock``) por si hay dos procesos.
Los logs de cada paso identifican la cuenta solo por ``cuenta_id`` y los correos por su id de Gmail: nunca
incluyen email, asunto, nombres de archivo ni importes.
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
    TipoDocumentoGuardado,
    cuenta_id,
    es_contable,
    escribir_atomico,
)
from .gemini import GeminiRequestError, GeminiUnavailableError, clave_campo, normalizar_campos_solicitados
from .gmail import GmailNotConnectedError, GmailRateLimitError
from .orden_fechas import ordenar_por_fecha
from .plantilla_campos import AlmacenPlantillas, deducir_campos
from .recepcion import ServicioRecepcion
from .tipos_documento import AlmacenTipos, deteccion_manual, direccion, detectar_tipo, huella_documento, para_clasificar, tipo_para_extraer

logger = logging.getLogger("nexora.automatico")

MAX_INTENTOS = 3
MAX_CORREOS_POR_CICLO = 100
# Margen hacia atrás sobre el último correo procesado: Gmail no garantiza el orden exacto de llegada.
MARGEN_BUSQUEDA = timedelta(days=1)
# Un archivo de bloqueo más viejo que esto es de un proceso que murió a mitad de un ciclo.
BLOQUEO_CADUCA_SEGUNDOS = 30 * 60
INTERVALO_PREDETERMINADO = 20

# "bandeja": el diagnóstico no fue ok (o se agotaron los intentos); queda en la Bandeja de captura manual.
TERMINALES = {"extraido", "omitido", "error", "bandeja"}
# Estados finales del envío automático: nunca se vuelve a enviar solo.
TERMINALES_ENVIO = {"enviado", "requiere_revision", "error", "incierto", "sin_savedata", "omitido"}

MAX_DESCARTES = 200
MAX_DESCARTES_CICLO = 50
MAX_AVISOS = 100

# Motivos de descarte de un correo o adjunto (el frontend tiene su propio texto para cada código).
MOTIVOS: dict[str, str] = {
    "id_invalido": "Identificador de Gmail no valido.",
    "sin_fecha": "Gmail no informo la fecha de recepcion.",
    "anterior_a_activacion": "Llego antes de activar la extraccion automatica.",
    "asunto_no_coincide": "El asunto no parece un estado de cuenta ni una poliza, y el remitente no esta en las reglas.",
    "sin_adjunto_valido": "El correo no trae un PDF o imagen extraible.",
    "adjunto_no_extraible": "El adjunto no es PDF ni imagen.",
    "ya_tenia_extraccion": "Ya tenia una extraccion guardada; no se toca.",
    "guardado_por_usuario": "El usuario guardo el documento mientras se extraia.",
    "envio_omitido": "No se envio automaticamente a SaveData.",
    "sin_savedata": "SAVEDATA_URL no esta configurada: se extrajo pero no se envio.",
}
INTERRUMPIDO_REINICIO = "El backend se reinicio o se apago antes de terminar el ciclo."


def _proceso_vivo(pid: int) -> bool:
    """Si el proceso ``pid`` sigue vivo. Ante la duda (sin permisos) se considera vivo."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: existe, pero es de otro usuario.
        try:
            codigo = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(codigo)):
                return True
            return codigo.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _resumen_vacio() -> dict[str, int]:
    return {"correos_encontrados": 0, "extraidos": 0, "enviados": 0, "requieren_revision": 0, "inciertos": 0,
            "omitidos": 0, "errores": 0, "ya_revisados": 0, "en_bandeja": 0}


def _tipos_adjuntos(adjuntos: list[dict[str, Any]]) -> str:
    """Tipos de los adjuntos (tipo MIME y extensión), nunca el nombre del archivo."""
    tipos = []
    for adjunto in adjuntos:
        extension = Path(str(adjunto.get("filename") or "")).suffix.lower()[:10]
        tipo = str(adjunto.get("mimeType") or "desconocido")[:60]
        tipos.append(f"{tipo} ({extension})" if extension else tipo)
    return ", ".join(dict.fromkeys(tipos))


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


def motivos_sin_cuadrar(problemas: dict[str, Any], contable: bool = True) -> list[str]:
    """Por qué un documento no pasa la protección "Enviar solo si cuadra" (sin validación contable: solo los importes)."""
    motivos = []
    if contable and problemas.get("cuadra") is not True:
        motivos.append("La validacion contable no cuadra." if problemas.get("cuadra") is False else "La validacion contable esta incompleta.")
    if problemas.get("invalidos"):
        motivos.append(f"{problemas['invalidos']} importe(s) invalido(s).")
    if problemas.get("dudosos"):
        motivos.append(f"{problemas['dudosos']} importe(s) dudoso(s).")
    return motivos


def problemas_encontrados(problemas: dict[str, Any], contable: bool = True) -> list[str]:
    """Todo lo que la revisión exigiría confirmar; se anota cuando se envía con la protección apagada."""
    motivos = motivos_sin_cuadrar(problemas, contable)
    if problemas.get("diferencias"):
        motivos.append(f"{problemas['diferencias']} diferencia(s) en la validacion.")
    if problemas.get("en_revision"):
        motivos.append(f"{problemas['en_revision']} movimiento(s) marcados para revision.")
    return motivos


def sin_datos_extraidos(documento: dict[str, Any]) -> bool:
    """Documento que no es estado de cuenta sin ningún campo con valor y sin filas con valores: no hay nada que enviar."""
    if es_contable(documento.get("tipo_documento")):
        return False
    con_valor = any(str(campo.get("valor") or "").strip() for campo in documento.get("campos_extra") or [] if campo.get("alcance") == "documento")
    con_filas = any(any(str(valor).strip() for valor in (fila.get("extras") or {}).values()) for fila in documento.get("transacciones") or [])
    return not con_valor and not con_filas


SIN_DATOS = "No se extrajo ningun dato del documento (todos los campos estan vacios y no hay filas)."


class _CortarCiclo(Exception):
    """Gmail limita las consultas, se perdió la conexión o el backend se está apagando: se sigue en otro ciclo."""


# --- Conversión del resultado de Gemini en borrador (port de documentoDesdeExtraccion del frontend) ----------

def _valor_unico(valores: list[dict[str, Any]]) -> str | None:
    """Valores por fila que en realidad son uno solo: todos iguales (y no vacíos)."""
    distintos = {str(item.get("valor") or "").strip() for item in valores} - {""}
    return distintos.pop()[:MAX_VALOR_CAMPO] if len(distintos) == 1 else None


def borrador_desde_extraccion(resultado: dict[str, Any], campos: list[dict[str, Any]], *, filename: str, attachment_id: str | None, lote: str,
                              tipo_documento: dict[str, Any] | None = None) -> GuardarExtraccionRequest:
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
        "tipo_documento": tipo_documento,
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
        tipos: AlmacenTipos | None = None,
        recepcion: ServicioRecepcion | None = None,
    ) -> None:
        self.raiz = raiz
        # Originales en disco, diagnóstico, eventos y Bandeja de captura manual. Sin ella (pruebas antiguas), el
        # adjunto va directo a la extracción como antes.
        self.recepcion = recepcion
        # ServicioEnvio de savedata.py: el envío automático reutiliza exactamente el envío manual.
        self.envios = envios
        # Configuración de campos; sin ella, la lista efectiva es la deducida de las extracciones guardadas.
        self.plantillas = plantillas or AlmacenPlantillas(raiz / "_sin_configuracion", lambda email: deducir_campos(almacen, email))
        # Tipos de documento: detección del tipo de cada adjunto y campos que se piden según el tipo.
        self.tipos = tipos or AlmacenTipos(raiz / "_sin_tipos", self.plantillas)
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
        # Marca del ciclo en curso en este proceso: "revisando" solo mientras existe.
        self._en_curso_desde: datetime | None = None
        # El siguiente ciclo lo pidió el usuario ("Revisar ahora").
        self._manual = False
        # Última cuenta conocida: permite registrar un ciclo que termina sin poder consultar Gmail.
        self._cuenta_conocida: str | None = None
        # Distingue esta instancia de una anterior en el mismo proceso (equivale a un reinicio).
        self._instancia = uuid.uuid4().hex[:12]

    # --- Estado persistente -------------------------------------------------------------------

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.json"

    def _leer(self, email: str) -> dict[str, Any]:
        ruta = self._ruta(email)
        base: dict[str, Any] = {"activo": False, "activado_en": None, "ultimo_correo": None, "revisado_hasta": None, "ultima_revision": None, "ultimo_resultado": None,
                                "ultimo_error": None, "envio_activo": False, "solo_si_cuadra": True, "envio_activado_en": None, "adjuntos": {},
                                "descartados": {}, "ultimo_ciclo": None, "ciclo_en_curso": None, "avisos": [], "revision_solicitada_en": None}
        if not ruta.exists():
            return base
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # Nunca se pierde la fecha de activación en silencio: un archivo dañado deja el proceso pausado.
            logger.exception("Estado de la extraccion automatica danado: %s", ruta.name)
            return base
        estado = {**base, **datos, "adjuntos": dict(datos.get("adjuntos") or {}), "descartados": dict(datos.get("descartados") or {}),
                  "avisos": list(datos.get("avisos") or [])}
        ultimo = estado.get("ultimo_correo")
        if isinstance(ultimo, dict) and not any(clave.startswith(f"{ultimo.get('id')}__") for clave in estado["adjuntos"]):
            # Versiones anteriores marcaban como "último correo" uno sin ningún adjunto válido: solo acota la búsqueda.
            estado["revisado_hasta"] = self._mas_reciente(estado.get("revisado_hasta"), ultimo.get("recibido"))
            estado["ultimo_correo"] = None
        return estado

    @staticmethod
    def _mas_reciente(*valores: Any) -> str | None:
        fechas = [fecha for fecha in (_fecha(valor) for valor in valores) if fecha is not None]
        return _iso(max(fechas)) if fechas else None

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
            self.revisar_ahora(email)
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
        en_curso_desde = self._en_curso_desde or self._otro_proceso_en_curso()
        solicitada = _fecha(estado.get("revision_solicitada_en"))
        ultimo_ciclo = estado.get("ultimo_ciclo") if isinstance(estado.get("ultimo_ciclo"), dict) else None
        inicio_ultimo = _fecha((ultimo_ciclo or {}).get("inicio"))
        # "Revisar ahora" sigue pendiente hasta que empieza un ciclo posterior (con un margen por si el hilo murió).
        pendiente = (solicitada is not None and (inicio_ultimo is None or inicio_ultimo < solicitada)
                     and self.reloj() - solicitada < timedelta(minutes=self.intervalo_minutos + 5))
        descartados = sorted(estado["descartados"].items(), key=lambda par: str(par[1].get("ultima_vez") or ""), reverse=True)
        avisos = [aviso for aviso in estado["avisos"] if isinstance(aviso, dict)][:MAX_AVISOS]
        return {
            "activo": bool(estado["activo"]),
            "activado_en": estado["activado_en"],
            "ultima_revision": estado["ultima_revision"],
            "proxima_revision": _iso(self._proxima) if estado["activo"] and self.corriendo() else None,
            "en_curso": en_curso_desde is not None,
            "ciclo_en_curso_desde": _iso(en_curso_desde),
            "revision_solicitada_en": estado.get("revision_solicitada_en"),
            "revision_pendiente": bool(pendiente),
            "ultimo_ciclo": ultimo_ciclo,
            "descartados": [{"clave": clave, **{k: entrada.get(k) for k in ("message_id", "part_id", "motivo", "detalle", "asunto", "recibido", "primera_vez", "ultima_vez", "veces")}}
                            for clave, entrada in descartados[:MAX_DESCARTES]],
            "avisos": avisos,
            "avisos_sin_leer": sum(1 for aviso in avisos if not aviso.get("leido")),
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

    def marcar_avisos_leidos(self, email: str, ids: list[str] | None = None) -> dict[str, Any]:
        """Marca como leídos los avisos ``ids`` (o todos)."""
        def cambio(estado: dict[str, Any]) -> None:
            estado["avisos"] = [{**aviso, "leido": True} if ids is None or aviso.get("id") in ids else aviso for aviso in estado["avisos"] if isinstance(aviso, dict)]
        self._mutar(email, cambio)
        return self.estado(email)

    # --- Bloqueo entre procesos ---------------------------------------------------------------

    def _ruta_bloqueo(self) -> Path:
        return self.raiz / ".ciclo.lock"

    def _leer_bloqueo(self) -> tuple[int, float] | None:
        """(pid, antigüedad en segundos) del archivo de bloqueo, o None si no existe."""
        ruta = self._ruta_bloqueo()
        try:
            antiguedad = time.time() - ruta.stat().st_mtime
            contenido = ruta.read_text(encoding="utf-8").split()
        except (FileNotFoundError, OSError, UnicodeDecodeError):
            return None
        try:
            pid = int(contenido[0]) if contenido else 0
        except ValueError:
            pid = 0
        return pid, antiguedad

    def _bloqueo_caducado(self, pid: int, antiguedad: float) -> bool:
        """Más viejo que ``BLOQUEO_CADUCA_SEGUNDOS`` o de otro proceso que ya murió (p. ej. un ``--reload``)."""
        return antiguedad > BLOQUEO_CADUCA_SEGUNDOS or (pid != os.getpid() and not _proceso_vivo(pid))

    def _otro_proceso_en_curso(self) -> datetime | None:
        """Inicio aproximado del ciclo de otro proceso vivo, si lo hay."""
        if self._ciclo.locked():
            return None
        bloqueo = self._leer_bloqueo()
        if bloqueo is None or bloqueo[0] == os.getpid() or self._bloqueo_caducado(*bloqueo):
            return None
        return self.reloj() - timedelta(seconds=bloqueo[1])

    def _tomar_bloqueo(self) -> Path | None:
        ruta = self._ruta_bloqueo()
        self.raiz.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(ruta, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                bloqueo = self._leer_bloqueo()
                if bloqueo is None or self._bloqueo_caducado(*bloqueo):
                    ruta.unlink(missing_ok=True)
                    continue
                return None
            with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
                archivo.write(f"{os.getpid()} {_iso(self.reloj())}")
            return ruta
        return None

    # --- Ciclos interrumpidos por un reinicio -------------------------------------------------

    def _marca_huerfana(self, marca: Any, *, con_bloqueo: bool) -> bool:
        """Si la marca ``ciclo_en_curso`` es de un ciclo que ya no está corriendo.

        Con el bloqueo tomado ningún otro ciclo puede estar corriendo: cualquier marca es de un ciclo muerto.
        """
        if not isinstance(marca, dict):
            return False
        if con_bloqueo:
            return True
        pid = int(marca.get("pid") or 0)
        if pid == os.getpid():
            return marca.get("instancia") != self._instancia or self._en_curso_desde is None
        return not _proceso_vivo(pid)

    def _registrar_interrupcion(self, estado: dict[str, Any], *, con_bloqueo: bool) -> bool:
        """Convierte una marca ``ciclo_en_curso`` huérfana en un ``ultimo_ciclo`` "interrumpido por reinicio" con aviso."""
        marca = estado.get("ciclo_en_curso")
        if not self._marca_huerfana(marca, con_bloqueo=con_bloqueo):
            return False
        estado["ciclo_en_curso"] = None
        estado["ultimo_ciclo"] = {"inicio": marca.get("inicio"), "fin": None, "detectado_en": _iso(self.reloj()), "origen": marca.get("origen") or "programado",
                                  "resultado": "interrumpido_reinicio", "error": INTERRUMPIDO_REINICIO, **_resumen_vacio(), "descartes": [], "descartes_total": 0}
        estado["ultimo_resultado"] = "interrumpido_reinicio"
        estado["ultimo_error"] = INTERRUMPIDO_REINICIO
        aviso = self._aviso("error_ciclo", "Un ciclo de la extraccion automatica se interrumpio por un reinicio del backend; se retomara en la siguiente revision.")
        estado["avisos"] = [aviso, *[a for a in estado.get("avisos") or [] if isinstance(a, dict)]][:MAX_AVISOS]
        return True

    def _recuperar_interrumpido(self, email: str, *, con_bloqueo: bool) -> bool:
        """Registra como ``interrumpido_reinicio`` un ciclo de esta cuenta que nunca llegó a cerrarse."""
        registrado = False

        def cambio(estado: dict[str, Any]) -> None:
            nonlocal registrado
            registrado = self._registrar_interrupcion(estado, con_bloqueo=con_bloqueo)
        with self._estado_lock:
            if not isinstance(self._leer(email).get("ciclo_en_curso"), dict):
                return False  # Sin marca: no se reescribe el archivo.
        self._mutar(email, cambio)
        if registrado:
            logger.warning("Ciclo automatico interrumpido por reinicio registrado cuenta=%s", cuenta_id(email))
        return registrado

    def _recuperar_al_arrancar(self) -> None:
        """Al arrancar: los ciclos que el reinicio cortó antes de cerrarse quedan registrados, no como fantasmas.

        Se recorre cada archivo de cuenta porque al arrancar aún no se sabe qué cuenta está conectada.
        """
        if not self.raiz.exists():
            return
        bloqueo = self._leer_bloqueo()
        if bloqueo is not None and not self._bloqueo_caducado(*bloqueo):
            return  # Otro proceso vivo está en un ciclo: él cerrará el suyo.
        for ruta in self.raiz.glob("*.json"):
            with self._estado_lock:
                try:
                    estado = json.loads(ruta.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(estado, dict) or not self._registrar_interrupcion(estado, con_bloqueo=False):
                    continue
                escribir_atomico(ruta, estado)
            logger.warning("Ciclo automatico interrumpido por reinicio registrado cuenta=%s", ruta.stem)

    # --- Ciclo --------------------------------------------------------------------------------

    def _tomar_origen(self) -> str:
        with self._estado_lock:
            origen = "manual" if self._manual else "programado"
            self._manual = False
        return origen

    def ejecutar_ciclo(self) -> dict[str, Any]:
        """Un ciclo completo. Si ya hay otro en curso (en este u otro proceso) no hace nada."""
        if not self._ciclo.acquire(blocking=False):
            return {"resultado": "en_curso"}
        try:
            bloqueo = self._tomar_bloqueo()
            if bloqueo is None:
                logger.info("Ciclo automatico omitido: otro proceso tiene un ciclo en curso")
                return {"resultado": "en_curso"}
            self._en_curso_desde = self.reloj()
            try:
                return self._ciclo_protegido(self._tomar_origen())
            finally:
                self._en_curso_desde = None
                bloqueo.unlink(missing_ok=True)
        finally:
            self._ciclo.release()

    def _salida_temprana(self, email: str | None, inicio: datetime, origen: str, resultado: str, error: str | None) -> dict[str, Any]:
        """Ciclos que terminan antes de revisar Gmail: también quedan registrados (si se conoce la cuenta)."""
        email = email or self._cuenta_conocida
        logger.info("Ciclo automatico fin resultado=%s origen=%s cuenta=%s", resultado, origen, cuenta_id(email) if email else "desconocida")
        if email:
            ciclo = {"inicio": _iso(inicio), "fin": _iso(self.reloj()), "origen": origen, "resultado": resultado, "error": error, **_resumen_vacio(), "descartes": [], "descartes_total": 0}

            def cambio(estado: dict[str, Any]) -> None:
                estado["ultimo_ciclo"] = ciclo
                if resultado != "pausado":
                    estado["ultima_revision"] = ciclo["fin"]
                    estado["ultimo_resultado"] = resultado
                    estado["ultimo_error"] = error
            try:
                self._mutar(email, cambio)
            except OSError:
                logger.exception("Ciclo automatico: no se pudo registrar el resultado")
        return {"resultado": resultado}

    def _ciclo_protegido(self, origen: str = "programado") -> dict[str, Any]:
        inicio = self.reloj()
        logger.info("Ciclo automatico inicio origen=%s", origen)
        try:
            email = self.gmail.profile().get("email")
        except GmailNotConnectedError:
            return self._salida_temprana(None, inicio, origen, "sin_gmail", "Gmail no esta conectado.")
        except GmailRateLimitError:
            return self._salida_temprana(None, inicio, origen, "limite_gmail", "Gmail limito las consultas; se reintentara en la siguiente revision.")
        except Exception as error:
            logger.warning("Ciclo automatico: no se pudo identificar la cuenta (%s)", error.__class__.__name__)
            return self._salida_temprana(None, inicio, origen, "sin_gmail", "No se pudo identificar la cuenta de Gmail.")
        if not email:
            return self._salida_temprana(None, inicio, origen, "sin_gmail", "Gmail no esta conectado.")
        self._cuenta_conocida = email
        # Con el bloqueo tomado, una marca de ciclo que quedó en el archivo es de un ciclo que el reinicio cortó.
        self._recuperar_interrumpido(email, con_bloqueo=True)
        estado = self._leer(email)
        activado = _fecha(estado.get("activado_en"))
        if not estado["activo"] or activado is None:
            self._reintentar_pedidos_al_configurar(email)
            return self._salida_temprana(email, inicio, origen, "pausado", None)
        logger.info("Ciclo automatico cuenta=%s", cuenta_id(email))
        self._mutar(email, lambda e: e.__setitem__("ciclo_en_curso", {"inicio": _iso(inicio), "origen": origen, "pid": os.getpid(), "instancia": self._instancia}))

        ctx: dict[str, Any] = {"resumen": _resumen_vacio(), "descartes": [], "claves": {"enviado": [], "requiere_revision": [], "error": [], "incierto": []}}
        resumen = ctx["resumen"]
        resultado, error = "ok", None
        try:
            # Reintentos de envío pendientes: no dependen de Gmail ni de Gemini.
            self._procesar_envios(email, ctx)
            if not self.gemini.status().get("enabled"):
                resultado, error = "sin_gemini", "Gemini no esta configurado."
            else:
                self._procesar(email, estado, activado, ctx)
        except _CortarCiclo as corte:
            resultado, error = ("interrumpido_reinicio", INTERRUMPIDO_REINICIO) if self._parar.is_set() else ("interrumpido", str(corte) or None)
        except GmailRateLimitError as fallo:
            resultado, error = "limite_gmail", str(fallo)
        except Exception as fallo:
            logger.exception("Ciclo automatico: el ciclo fallo")
            resultado, error = "error", str(fallo) or fallo.__class__.__name__
        self._cerrar_ciclo(email, resultado, error, inicio=inicio, origen=origen, ctx=ctx)
        if resultado == "sin_gemini":
            return {"resultado": "sin_gemini"}
        return {"resultado": resultado, **resumen}

    def _aviso(self, tipo: str, texto: str, claves: list[str] | None = None) -> dict[str, Any]:
        return {"id": uuid.uuid4().hex[:12], "fecha": _iso(self.reloj()), "tipo": tipo, "texto": texto, "claves": list(claves or [])[:20], "leido": False}

    @staticmethod
    def _por_tipo(claves: list[str], tipo_de: dict[str, str]) -> str:
        """"1 Fianzas, 1 Autos individuales": cuántos de cada tipo (los más frecuentes primero); con un solo tipo, solo su nombre."""
        conteo: dict[str, int] = {}
        for clave in claves:
            nombre = tipo_de.get(clave) or "Sin tipo"
            conteo[nombre] = conteo.get(nombre, 0) + 1
        if len(conteo) == 1:
            return next(iter(conteo))  # todos del mismo tipo: "1 requiere revisión (Gastos médicos mayores)"
        return ", ".join(f"{n} {nombre}" for nombre, n in sorted(conteo.items(), key=lambda item: (-item[1], item[0])))

    @classmethod
    def texto_envios(cls, ctx: dict[str, Any]) -> str | None:
        """"Se enviaron 2 (1 Fianzas, 1 Autos individuales) · 1 requiere revisión (Gastos médicos mayores)"."""
        claves, tipo_de = ctx["claves"], ctx.get("tipo_de") or {}
        partes = []
        if claves["enviado"]:
            n = len(claves["enviado"])
            partes.append(f"Se {'envió' if n == 1 else 'enviaron'} {n} ({cls._por_tipo(claves['enviado'], tipo_de)})")
        if claves["requiere_revision"]:
            n = len(claves["requiere_revision"])
            partes.append(f"{n} {'requiere' if n == 1 else 'requieren'} revisión ({cls._por_tipo(claves['requiere_revision'], tipo_de)})")
        return " · ".join(partes) or None

    def _avisos_del_ciclo(self, resultado: str, error: str | None, ctx: dict[str, Any]) -> list[dict[str, Any]]:
        claves = ctx["claves"]
        tipo_de = ctx.get("tipo_de") or {}
        avisos = []
        # Un solo aviso con lo que se envió y lo que no, por tipo.
        resumen_envios = self.texto_envios(ctx)
        if resumen_envios:
            avisos.append(self._aviso("enviado" if claves["enviado"] else "requiere_revision", f"{resumen_envios}.", [*claves["enviado"], *claves["requiere_revision"]]))
        if claves["incierto"]:
            n = len(claves["incierto"])
            avisos.append(self._aviso("incierto", f"{n} envío{'' if n == 1 else 's'} incierto{'' if n == 1 else 's'} ({self._por_tipo(claves['incierto'], tipo_de)}): verifica en SaveData si {'llegó' if n == 1 else 'llegaron'}.", claves["incierto"]))
        if claves.get("bandeja"):
            n = len(claves["bandeja"])
            avisos.append(self._aviso("bandeja", f"{n} documento{'' if n == 1 else 's'} {'pasó' if n == 1 else 'pasaron'} a la bandeja de captura manual (contraseña, dañado, escaneado o formato no soportado).", claves["bandeja"]))
        if claves["error"]:
            n = len(claves["error"])
            avisos.append(self._aviso("error", f"{n} documento{'' if n == 1 else 's'} con error al extraer o enviar ({self._por_tipo(claves['error'], tipo_de)}).", claves["error"]))
        if resultado in ("error", "interrumpido_reinicio"):
            texto = INTERRUMPIDO_REINICIO if resultado == "interrumpido_reinicio" else f"El ciclo de la extraccion automatica fallo: {(error or '')[:200]}"
            avisos.append(self._aviso("error_ciclo", texto))
        return avisos

    def _cerrar_ciclo(self, email: str, resultado: str, error: str | None, *, inicio: datetime | None = None, origen: str = "programado", ctx: dict[str, Any] | None = None) -> None:
        ctx = ctx or {"resumen": _resumen_vacio(), "descartes": [], "claves": {"enviado": [], "requiere_revision": [], "error": [], "incierto": []}}
        fin = _iso(self.reloj())
        resumen = ctx["resumen"]
        ciclo = {"inicio": _iso(inicio) or fin, "fin": fin, "origen": origen, "resultado": resultado, "error": error, **resumen,
                 "descartes": ctx["descartes"][:MAX_DESCARTES_CICLO], "descartes_total": len(ctx["descartes"]),
                 "texto_envios": self.texto_envios(ctx) if "claves" in ctx else None}
        avisos = self._avisos_del_ciclo(resultado, error, ctx)

        def cambio(estado: dict[str, Any]) -> None:
            estado["ultima_revision"] = fin
            estado["ultimo_resultado"] = resultado
            estado["ultimo_error"] = error
            estado["ultimo_ciclo"] = ciclo
            estado["ciclo_en_curso"] = None
            estado["avisos"] = [*reversed(avisos), *estado["avisos"]][:MAX_AVISOS]
        self._mutar(email, cambio)
        logger.info("Ciclo automatico fin resultado=%s origen=%s correos=%d extraidos=%d enviados=%d requieren_revision=%d inciertos=%d omitidos=%d errores=%d ya_revisados=%d",
                    resultado, origen, resumen["correos_encontrados"], resumen["extraidos"], resumen["enviados"], resumen["requieren_revision"], resumen["inciertos"],
                    resumen["omitidos"], resumen["errores"], resumen["ya_revisados"])

    def _descartar(self, email: str, ctx: dict[str, Any], clave: str, motivo: str, *, message_id: str, part_id: str | None = None,
                   detalle: str | None = None, mensaje: dict[str, Any] | None = None) -> None:
        """Registra por qué se descartó un correo o adjunto. Repetido con el mismo motivo solo actualiza la fecha."""
        ahora = _iso(self.reloj())
        nuevo = True

        def cambio(estado: dict[str, Any]) -> None:
            nonlocal nuevo
            previo = estado["descartados"].get(clave)
            nuevo = not isinstance(previo, dict) or previo.get("motivo") != motivo
            entrada = {
                "message_id": message_id[:128], "part_id": part_id, "motivo": motivo, "detalle": (detalle or MOTIVOS.get(motivo) or "")[:300],
                "asunto": str((mensaje or {}).get("subject") or (previo or {}).get("asunto") or "")[:140] or None,
                "recibido": (mensaje or {}).get("receivedAt") or (previo or {}).get("recibido"),
                "primera_vez": ahora if nuevo else previo.get("primera_vez"), "ultima_vez": ahora,
                "veces": 1 if nuevo else int(previo.get("veces") or 1) + 1,
            }
            estado["descartados"][clave] = entrada
            if len(estado["descartados"]) > MAX_DESCARTES:
                ordenados = sorted(estado["descartados"].items(), key=lambda par: str(par[1].get("ultima_vez") or ""), reverse=True)
                estado["descartados"] = dict(ordenados[:MAX_DESCARTES])
        self._mutar(email, cambio)
        logger.info("Ciclo automatico descartado message_id=%s part_id=%s motivo=%s%s", message_id[:128] if ID_DOCUMENTO_SEGURO.fullmatch(message_id) else "(invalido)",
                    part_id or "-", motivo, "" if nuevo else " (ya registrado)")
        if nuevo:
            ctx["resumen"]["omitidos"] += 1
            ctx["descartes"].append({"clave": clave, "message_id": message_id[:128], "part_id": part_id, "motivo": motivo,
                                     "detalle": (detalle or MOTIVOS.get(motivo) or "")[:300], "asunto": str((mensaje or {}).get("subject") or "")[:140] or None})
        else:
            ctx["resumen"]["ya_revisados"] += 1

    def _candidatos(self, estado: dict[str, Any], activado: datetime, remitentes: list[str] | None = None) -> list[str]:
        ultimo = _fecha(self._mas_reciente((estado.get("ultimo_correo") or {}).get("recibido"), estado.get("revisado_hasta")))
        desde = activado if ultimo is None else max(activado, ultimo - MARGEN_BUSQUEDA)
        query = f"{filtro_estados.construir_query('inbox', remitentes or [])} after:{int(desde.timestamp())}"
        ids = self.gmail.buscar_ids(query, MAX_CORREOS_POR_CICLO)
        # Los adjuntos con reintentos pendientes se vuelven a revisar aunque ya no entren en la búsqueda.
        pendientes = [clave.split("__", 1)[0] for clave, entrada in estado["adjuntos"].items() if entrada.get("estado") not in TERMINALES]
        return list(dict.fromkeys([*pendientes, *ids]))

    def _avanzar(self, email: str, campo: str, valor: Any) -> None:
        def cambio(estado: dict[str, Any]) -> None:
            if campo == "revisado_hasta":
                estado["revisado_hasta"] = self._mas_reciente(estado.get("revisado_hasta"), valor)
            else:
                actual = _fecha((estado.get("ultimo_correo") or {}).get("recibido"))
                if actual is None or actual < (_fecha(valor["recibido"]) or actual):
                    estado["ultimo_correo"] = valor
        self._mutar(email, cambio)

    def _procesar(self, email: str, estado: dict[str, Any], activado: datetime, ctx: dict[str, Any]) -> None:
        campos = self.campos_configurados(email)
        remitentes = self.tipos.remitentes(email)
        candidatos = self._candidatos(estado, activado, remitentes)
        ctx["resumen"]["correos_encontrados"] = len(candidatos)
        logger.info("Ciclo automatico correos encontrados=%d", len(candidatos))
        for message_id in candidatos:
            if self._parar.is_set():
                raise _CortarCiclo("El backend se esta apagando.")
            if not ID_DOCUMENTO_SEGURO.fullmatch(message_id):
                self._descartar(email, ctx, f"invalido:{message_id[:100]}", "id_invalido", message_id=message_id)
                continue
            mensaje = self.gmail.get_message(message_id)
            recibido = _fecha(mensaje.get("receivedAt"))
            # Solo correos que llegaron después de activar el proceso; nunca los anteriores.
            if recibido is None:
                self._descartar(email, ctx, message_id, "sin_fecha", message_id=message_id, mensaje=mensaje)
                continue
            if recibido <= activado:
                self._descartar(email, ctx, message_id, "anterior_a_activacion", message_id=message_id, mensaje=mensaje)
                continue
            if not filtro_estados.es_candidato(mensaje.get("subject", ""), mensaje.get("senderEmail", ""), remitentes):
                self._descartar(email, ctx, message_id, "asunto_no_coincide", message_id=message_id, mensaje=mensaje)
                self._avanzar(email, "revisado_hasta", _iso(recibido))
                continue
            adjuntos = list(mensaje.get("attachments") or [])
            validos = [a for a in adjuntos if filtro_estados.es_documento_extraible(a) and ID_DOCUMENTO_SEGURO.fullmatch(str(a.get("partId") or ""))]
            otros = [a for a in adjuntos if a not in validos]
            if self.recepcion is not None:
                # Con la recepción, un adjunto que no parece PDF ni imagen también se guarda y se diagnostica: si por su
                # contenido sí lo es, se extrae; si no, va a la bandeja (formato no soportado) en lugar de descartarse.
                for adjunto in list(otros):
                    part_id = str(adjunto.get("partId") or "")
                    if not ID_DOCUMENTO_SEGURO.fullmatch(part_id):
                        continue
                    otros.remove(adjunto)
                    if self._recibir_no_extraible(email, ctx, message_id, part_id, adjunto, mensaje):
                        validos.append(adjunto)
            if not validos:
                detalle = (f"{MOTIVOS['sin_adjunto_valido']} Adjuntos encontrados: {_tipos_adjuntos(adjuntos)}." if adjuntos
                           else f"{MOTIVOS['sin_adjunto_valido']} El correo no trae adjuntos (el documento puede venir como enlace o insertado en el cuerpo).")
                self._descartar(email, ctx, message_id, "sin_adjunto_valido", message_id=message_id, detalle=detalle, mensaje=mensaje)
                self._avanzar(email, "revisado_hasta", _iso(recibido))
                continue
            for adjunto in otros:
                part_id = str(adjunto.get("partId") or "")
                motivo = "adjunto_no_extraible" if not filtro_estados.es_documento_extraible(adjunto) else "id_invalido"
                clave = f"{message_id}__{part_id}" if ID_DOCUMENTO_SEGURO.fullmatch(part_id) else f"{message_id}__invalido"
                self._descartar(email, ctx, clave, motivo, message_id=message_id, part_id=part_id[:32] or None,
                                detalle=f"{MOTIVOS[motivo]} Tipo: {_tipos_adjuntos([adjunto])}.", mensaje=mensaje)
            completo = True
            for adjunto in validos:
                part_id = str(adjunto.get("partId"))
                if self._procesar_adjunto(email, message_id, part_id, adjunto, campos, ctx, mensaje) not in TERMINALES:
                    completo = False
            if completo:
                self._avanzar(email, "ultimo_correo", {"id": message_id, "recibido": _iso(recibido)})
                self._avanzar(email, "revisado_hasta", _iso(recibido))

    def _procesar_adjunto(self, email: str, message_id: str, part_id: str, adjunto: dict[str, Any], campos: list[dict[str, Any]], ctx: dict[str, Any],
                          mensaje: dict[str, Any] | None = None) -> str:
        resumen = ctx["resumen"]
        clave = f"{message_id}__{part_id}"
        entrada = self._leer(email)["adjuntos"].get(clave) or {}
        if entrada.get("estado") in TERMINALES:
            resumen["ya_revisados"] += 1
            return entrada["estado"]
        intentos = int(entrada.get("intentos") or 0)
        if intentos >= MAX_INTENTOS:
            self._anotar(email, clave, estado="error", error=entrada.get("error") or "Se agotaron los intentos.")
            resumen["errores"] += 1
            ctx["claves"]["error"].append(clave)
            logger.info("Ciclo automatico adjunto error message_id=%s part_id=%s motivo=intentos_agotados", message_id, part_id)
            return "error"
        # Una extracción guardada (o editada) por el usuario nunca se toca.
        if self.almacen.obtener(email, message_id, part_id) is not None:
            self._anotar(email, clave, estado="omitido", error=None)
            self._descartar(email, ctx, clave, "ya_tenia_extraccion", message_id=message_id, part_id=part_id, mensaje=mensaje)
            return "omitido"

        # El intento queda contado en disco antes de llamar a Gemini.
        logger.info("Ciclo automatico extrayendo message_id=%s part_id=%s intento=%d/%d", message_id, part_id, intentos + 1, MAX_INTENTOS)
        self._anotar(email, clave, estado="en_curso", intentos=intentos + 1, error=None)
        filename = str(adjunto.get("filename") or "")
        attachment_id = str(adjunto.get("id") or "")
        try:
            data, media_type, nombre = self.gmail.attachment(message_id, attachment_id)
            if self.recepcion is not None:
                documento_recibido = self._recibir(email, message_id, part_id, data, media_type, nombre or filename, attachment_id, mensaje, "automatico")
                diagnostico = documento_recibido.get("diagnostico") or {}
                if diagnostico.get("codigo") != "ok":
                    return self._a_bandeja(email, ctx, clave, diagnostico)
                media_type = diagnostico.get("mime") or media_type
            deteccion, campos_tipo, extraer = self._detectar(email, data, media_type, nombre or filename, mensaje or {}, campos)
            resultado = self.gemini.extract_document(data, media_type, nombre or filename, campos_solicitados=[campo["nombre"] for campo in campos_tipo], **extraer)
            if not deteccion.get("aseguradora") and resultado.get("aseguradora"):
                deteccion["aseguradora"] = resultado["aseguradora"]
        except (GmailRateLimitError, GmailNotConnectedError, GeminiUnavailableError) as error:
            # No es culpa del documento: el intento no cuenta y se sigue en el siguiente ciclo.
            self._anotar(email, clave, estado="pendiente", intentos=intentos, error=str(error))
            etapa = "extraccion" if isinstance(error, GeminiUnavailableError) else "lectura"
            self._evento(email, etapa, "servicio_no_disponible", str(error), message_id, part_id)
            logger.info("Ciclo automatico adjunto pendiente message_id=%s part_id=%s motivo=%s", message_id, part_id, error.__class__.__name__)
            raise _CortarCiclo(str(error)) from error
        except GeminiRequestError as error:
            estado = self._fallo(email, clave, intentos + 1, str(error), ctx, f"gemini_http_{error.status_code}")
            if error.status_code == 429:
                raise _CortarCiclo(str(error)) from error
            return estado
        except Exception as error:
            logger.exception("Extraccion automatica fallo para %s", clave)
            return self._fallo(email, clave, intentos + 1, str(error) or error.__class__.__name__, ctx, error.__class__.__name__)

        try:
            solicitud = borrador_desde_extraccion(resultado, campos_tipo, filename=nombre or filename, attachment_id=attachment_id or None, lote=uuid.uuid4().hex[:8],
                                                  tipo_documento=TipoDocumentoGuardado.model_validate(deteccion).model_dump())
            documento = self.almacen.guardar(email, message_id, part_id, solicitud)
            self._registrar_estructura(email, deteccion, resultado, data)
        except (ConflictoVersion, EnvioEnCurso):
            # El usuario guardó este documento mientras Gemini extraía: lo suyo se conserva.
            self._anotar(email, clave, estado="omitido", error=None)
            self._descartar(email, ctx, clave, "guardado_por_usuario", message_id=message_id, part_id=part_id, mensaje=mensaje)
            return "omitido"
        except Exception as error:
            logger.exception("Extraccion automatica: no se pudo guardar %s", clave)
            return self._fallo(email, clave, intentos + 1, str(error) or error.__class__.__name__, ctx, error.__class__.__name__)
        # Solo lo extraído con el envío automático encendido se envía solo.
        enviar_auto = bool(self._leer(email).get("envio_activo"))
        self._anotar(email, clave, estado="extraido", error=None, version=documento.get("version"), enviar_auto=enviar_auto)
        self._evento(email, "extraccion", "ok", f"Extraido con IA ({resultado.get('model') or 'Gemini'}).", message_id, part_id,
                     detalle={"tipo": deteccion.get("codigo"), "filas": len(documento.get("transacciones", []))})
        resumen["extraidos"] += 1
        logger.info("Ciclo automatico adjunto extraido message_id=%s part_id=%s transacciones=%d envio_auto=%s", message_id, part_id, len(documento.get("transacciones", [])), enviar_auto)
        if enviar_auto:
            self._contar_envio(email, ctx, message_id, part_id, self._enviar_auto(email, message_id, part_id))
        return "extraido"

    def _detectar(self, email: str, data: bytes, media_type: str, filename: str, mensaje: dict[str, Any], campos_ec: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
        """Tipo del adjunto (reglas; si ninguna coincide, la IA), campos que se piden y argumentos de la extracción."""
        tipos = self.tipos.leer(email)
        deteccion = detectar_tipo(tipos, remitente=mensaje.get("senderEmail", ""), asunto=mensaje.get("subject", ""),
                                  clasificar=lambda: self.gemini.clasificar_documento(data, media_type, filename, para_clasificar(tipos)))
        tipo = next((item for item in tipos if item["id"] == deteccion.get("tipo_id")), None)
        campos = campos_ec if tipo is not None and tipo.get("contable") else list((tipo or {}).get("campos") or [])
        extraer = tipo_para_extraer(tipo)
        logger.info("Ciclo automatico tipo detectado codigo=%s metodo=%s confianza=%s requiere_revision=%s", deteccion.get("codigo"), deteccion.get("metodo"), deteccion.get("confianza"), deteccion.get("requiere_revision"))
        return deteccion, campos, ({} if extraer is None else {"tipo": extraer})

    def _registrar_estructura(self, email: str, deteccion: dict[str, Any], resultado: dict[str, Any], data: bytes) -> None:
        """Avisos de cambios de estructura (datos nuevos o que dejan de aparecer). Nunca detiene la extracción."""
        try:
            self.tipos.registrar_extraccion(email, deteccion.get("tipo_id"), deteccion.get("aseguradora") or resultado.get("aseguradora") or "", resultado, huella_documento(data))
        except Exception:
            logger.exception("No se pudieron registrar los avisos de estructura")

    # --- Recepción: originales, diagnóstico, eventos y bandeja ------------------------------------

    def _evento(self, email: str, etapa: str, codigo: str, mensaje: str, message_id: str | None, part_id: str | None, *, origen: str = "automatico",
                detalle: dict[str, Any] | None = None) -> None:
        if self.recepcion is not None:
            self.recepcion.evento(email, etapa, codigo, mensaje, message_id=message_id, part_id=part_id, origen=origen, detalle=detalle)

    def _recibir(self, email: str, message_id: str, part_id: str, data: bytes, media_type: str, filename: str, attachment_id: str | None,
                 mensaje: dict[str, Any] | None, origen: str) -> dict[str, Any]:
        assert self.recepcion is not None
        mensaje = mensaje or {}
        return self.recepcion.recibir(email, message_id=message_id, part_id=part_id, data=data, mime_type=media_type, filename=filename,
                                      attachment_id=attachment_id, recibido_en=mensaje.get("receivedAt"), asunto=mensaje.get("subject"),
                                      remitente=direccion(mensaje.get("senderEmail", "")) or None, origen=origen)

    def _a_bandeja(self, email: str, ctx: dict[str, Any], clave: str, diagnostico: dict[str, Any]) -> str:
        """El diagnóstico no fue ok: el adjunto queda en la bandeja (estado terminal ``bandeja``) y no se extrae."""
        self._anotar(email, clave, estado="bandeja", error=str(diagnostico.get("mensaje") or "")[:500], diagnostico=diagnostico.get("codigo"))
        ctx["resumen"]["en_bandeja"] += 1
        ctx["claves"].setdefault("bandeja", []).append(clave)
        logger.info("Ciclo automatico adjunto a la bandeja clave=%s diagnostico=%s", clave, diagnostico.get("codigo"))
        return "bandeja"

    def _recibir_no_extraible(self, email: str, ctx: dict[str, Any], message_id: str, part_id: str, adjunto: dict[str, Any], mensaje: dict[str, Any]) -> bool:
        """Adjunto que por su tipo no parece extraíble: se guarda y diagnostica. True si en realidad es PDF o imagen."""
        clave = f"{message_id}__{part_id}"
        entrada = self._leer(email)["adjuntos"].get(clave) or {}
        if entrada.get("estado") in TERMINALES:
            ctx["resumen"]["ya_revisados"] += 1
            return False
        attachment_id = str(adjunto.get("id") or "")
        if not attachment_id:
            return False
        data, media_type, nombre = self.gmail.attachment(message_id, attachment_id)
        documento = self._recibir(email, message_id, part_id, data, media_type, nombre or str(adjunto.get("filename") or ""), attachment_id, mensaje, "automatico")
        diagnostico = documento.get("diagnostico") or {}
        if diagnostico.get("codigo") == "ok":
            return True
        self._a_bandeja(email, ctx, clave, diagnostico)
        return False

    def reprocesar_bandeja(self, email: str, message_id: str, part_id: str) -> dict[str, Any]:
        """Botón "Reprocesar" de la bandeja: vuelve a leer el original (del disco o, si no está, de Gmail), lo
        diagnostica otra vez y, si se puede, lo extrae con la IA como borrador (no lo envía solo).

        Un PDF escaneado sí se extrae aquí: la IA lo lee como imagen. Devuelve {"estado": "extraido" | "sigue_en_bandeja"
        | "ya_extraido", "documento", "diagnostico", "mensaje"}.
        """
        if self.recepcion is None:
            raise RuntimeError("La recepcion de documentos no esta configurada.")
        registro = self.recepcion.documentos.obtener(email, message_id, part_id)
        if registro is None:
            raise KeyError(f"{message_id}__{part_id}")
        clave = f"{message_id}__{part_id}"
        if self.almacen.obtener(email, message_id, part_id) is not None:
            self.recepcion.resolver(email, message_id, part_id, "ya_tenia_extraccion")
            return {"estado": "ya_extraido", "documento": self.recepcion.documentos.obtener(email, message_id, part_id),
                    "mensaje": "El documento ya tiene una extraccion guardada."}
        mensaje = {"senderEmail": registro.get("remitente") or "", "subject": registro.get("asunto") or "", "receivedAt": registro.get("recibido_en")}
        original = self.recepcion.original(email, message_id, part_id)
        if original is None:
            mensaje_gmail = self.gmail.get_message(message_id)
            adjunto = next((item for item in mensaje_gmail.get("attachments") or [] if str(item.get("partId")) == part_id), None)
            attachment_id = str((adjunto or {}).get("id") or registro.get("attachment_id") or "")
            if not attachment_id:
                raise ValueError("El original no esta en disco y no se encontro el adjunto en el correo.")
            data, media_type, nombre = self.gmail.attachment(message_id, attachment_id)
        else:
            data, media_type, nombre = original
            attachment_id = registro.get("attachment_id")
        nombre = nombre or str(registro.get("nombre") or "")
        documento_recibido = self._recibir(email, message_id, part_id, data, media_type, nombre, attachment_id, mensaje, "reprocesar")
        diagnostico = documento_recibido.get("diagnostico") or {}
        if diagnostico.get("codigo") not in {"ok", "pdf_escaneado"}:
            return {"estado": "sigue_en_bandeja", "documento": documento_recibido, "diagnostico": diagnostico, "mensaje": diagnostico.get("mensaje")}
        if not self.gemini.status().get("enabled"):
            raise GeminiUnavailableError("Gemini no esta configurado.")
        media_type = diagnostico.get("mime") or media_type
        campos = self.campos_configurados(email)
        try:
            deteccion, campos_tipo, extraer = self._detectar(email, data, media_type, nombre, mensaje, campos)
            resultado = self.gemini.extract_document(data, media_type, nombre, campos_solicitados=[campo["nombre"] for campo in campos_tipo], **extraer)
        except Exception as error:
            causa = f"gemini_http_{error.status_code}" if isinstance(error, GeminiRequestError) else error.__class__.__name__
            self._evento(email, "extraccion", causa, str(error) or causa, message_id, part_id, origen="reprocesar")
            raise
        if not deteccion.get("aseguradora") and resultado.get("aseguradora"):
            deteccion["aseguradora"] = resultado["aseguradora"]
        solicitud = borrador_desde_extraccion(resultado, campos_tipo, filename=nombre, attachment_id=attachment_id or None, lote=uuid.uuid4().hex[:8],
                                              tipo_documento=TipoDocumentoGuardado.model_validate(deteccion).model_dump())
        documento = self.almacen.guardar(email, message_id, part_id, solicitud)
        self._registrar_estructura(email, deteccion, resultado, data)
        # El proceso automático ya no lo vuelve a tomar; no se envía solo (lo revisa el usuario).
        self._anotar(email, clave, estado="extraido", error=None, version=documento.get("version"), enviar_auto=False)
        self._evento(email, "extraccion", "ok", f"Extraido con IA al reprocesar ({resultado.get('model') or 'Gemini'}).", message_id, part_id, origen="reprocesar",
                     detalle={"tipo": deteccion.get("codigo"), "filas": len(documento.get("transacciones", []))})
        self.recepcion.resolver(email, message_id, part_id, "extraido")
        return {"estado": "extraido", "documento": self.recepcion.documentos.obtener(email, message_id, part_id), "extraccion": documento,
                "diagnostico": diagnostico, "mensaje": "Extraido: revisalo en Extraccion antes de enviarlo."}

    def _fallo(self, email: str, clave: str, intentos: int, mensaje: str, ctx: dict[str, Any], causa: str = "error") -> str:
        estado = "error" if intentos >= MAX_INTENTOS else "pendiente"
        self._anotar(email, clave, estado=estado, intentos=intentos, error=mensaje[:500])
        message_id, _, part_id = clave.partition("__")
        self._evento(email, "extraccion", causa, mensaje, message_id, part_id, detalle={"intento": intentos, "de": MAX_INTENTOS})
        if estado == "error" and self.recepcion is not None:
            # Agotó sus intentos: pasa a captura manual.
            try:
                self.recepcion.a_bandeja(email, message_id, part_id, "error_extraccion", f"Se agotaron los {MAX_INTENTOS} intentos de extraccion: {mensaje}"[:500])
            except Exception:
                logger.exception("No se pudo pasar a la bandeja %s", clave)
        logger.info("Ciclo automatico adjunto fallo clave=%s intento=%d/%d causa=%s estado=%s", clave, intentos, MAX_INTENTOS, causa, estado)
        if estado == "error":
            ctx["resumen"]["errores"] += 1
            ctx["claves"]["error"].append(clave)
        return estado

    # --- Envío automático a SaveData -----------------------------------------------------------

    def _contar_envio(self, email: str, ctx: dict[str, Any], message_id: str, part_id: str, estado: str | None) -> None:
        """Suma al resumen del ciclo lo que pasó con un envío automático (y registra por qué no se envió)."""
        if estado is None:
            return
        clave = f"{message_id}__{part_id}"
        resumen, claves = ctx["resumen"], ctx["claves"]
        logger.info("Ciclo automatico envio message_id=%s part_id=%s estado=%s", message_id, part_id, estado)
        ctx.setdefault("tipo_de", {})[clave] = self._nombre_tipo(email, message_id, part_id)
        if estado == "enviado":
            resumen["enviados"] += 1
            claves["enviado"].append(clave)
        elif estado == "requiere_revision":
            resumen["requieren_revision"] += 1
            claves["requiere_revision"].append(clave)
        elif estado == "incierto":
            resumen["inciertos"] += 1
            claves["incierto"].append(clave)
        elif estado == "error":
            resumen["errores"] += 1
            claves["error"].append(clave)
        elif estado in ("omitido", "sin_savedata"):
            envio = (self._leer(email)["adjuntos"].get(clave) or {}).get("envio") or {}
            motivo = "sin_savedata" if estado == "sin_savedata" else "envio_omitido"
            detalle = f"{MOTIVOS[motivo]} {envio.get('error') or ''}".strip()
            self._descartar(email, ctx, clave, motivo, message_id=message_id, part_id=part_id, detalle=detalle)

    def registro_adjuntos(self, email: str) -> dict[str, Any]:
        """Registro del proceso por adjunto (``messageId__partId``): estado, envío automático y su origen."""
        return dict(self._leer(email).get("adjuntos") or {})

    def _nombre_tipo(self, email: str, message_id: str, part_id: str) -> str:
        """Nombre del tipo del documento, para los avisos por tipo (los documentos sin tipo son estados de cuenta)."""
        try:
            documento = self.almacen.obtener(email, message_id, part_id) or {}
        except Exception:
            return "Sin tipo"
        tipo = documento.get("tipo_documento")
        return str((tipo or {}).get("nombre") or ("Estado de cuenta" if tipo is None else "Sin tipo"))

    def _procesar_envios(self, email: str, ctx: dict[str, Any], solo_configurar: bool = False) -> None:
        """Reintenta los envíos automáticos que quedaron pendientes (o interrumpidos) en ciclos anteriores.

        Los pedidos con "extraer y enviar" al configurar se reintentan aunque el envío automático general esté apagado.
        """
        estado = self._leer(email)
        for clave, entrada in estado["adjuntos"].items():
            if entrada.get("estado") != "extraido" or not entrada.get("enviar_auto"):
                continue
            if (entrada.get("envio") or {}).get("estado") in TERMINALES_ENVIO:
                continue
            al_configurar = entrada.get("origen_envio") == "configurar"
            if solo_configurar and not al_configurar or not (al_configurar or estado.get("envio_activo")):
                continue
            message_id, _, part_id = clave.partition("__")
            self._contar_envio(email, ctx, message_id, part_id, self._enviar_auto(email, message_id, part_id))

    def _reintentar_pedidos_al_configurar(self, email: str) -> None:
        """Con la extracción automática en pausa, igual se reintentan los envíos pedidos al configurar."""
        ctx: dict[str, Any] = {"resumen": _resumen_vacio(), "descartes": [], "claves": {"enviado": [], "requiere_revision": [], "error": [], "incierto": []}}
        try:
            self._procesar_envios(email, ctx, solo_configurar=True)
        except Exception:
            logger.exception("No se pudieron reintentar los envios pedidos al configurar")
            return
        avisos = self._avisos_del_ciclo("ok", None, ctx)
        if avisos:
            self._mutar(email, lambda estado: estado.__setitem__("avisos", [*reversed(avisos), *estado["avisos"]][:MAX_AVISOS]))

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
            # "origen": "configurar" si lo pidió "extraer y enviar" al configurar (se reintenta aunque el envío automático esté apagado).
            return {**documento, "envios": envios, "envio_automatico": {k: envio.get(k) for k in ("estado", "intentos", "error", "motivos", "problemas", "actualizado", "origen")}}
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
        al_configurar = entrada.get("origen_envio") == "configurar"
        if self.envios is None or not (cuenta.get("envio_activo") or al_configurar) or not entrada.get("enviar_auto") or entrada.get("estado") != "extraido":
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
            tipo_documento = documento.get("tipo_documento") or {}
            contable = es_contable(tipo_documento)
            if tipo_documento.get("requiere_revision"):
                # Tipo sin configurar, confianza baja o tipo sin campos: se extrajo lo posible, pero nunca se envía solo.
                motivo = tipo_documento.get("motivo") or "El tipo de documento requiere revision."
                return self._terminar_envio(email, message_id, part_id, "requiere_revision", error=None, motivos=[motivo], problemas=[motivo])
            if sin_datos_extraidos(documento):
                return self._terminar_envio(email, message_id, part_id, "requiere_revision", error=None, motivos=[SIN_DATOS], problemas=[SIN_DATOS])
            motivos = motivos_sin_cuadrar(problemas, contable)
            if motivos and cuenta.get("solo_si_cuadra") is not False:
                return self._terminar_envio(email, message_id, part_id, "requiere_revision", error=None, motivos=motivos, problemas=problemas_encontrados(problemas, contable))
            try:
                revisado = self.almacen.actualizar(email, message_id, part_id, self._marcar_revisado(documento.get("version")))
            except _DocumentoTocado:
                return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito el documento.")
            version_revisada = revisado.get("version")
            self._anotar_envio(email, clave, version=version_revisada, problemas=problemas_encontrados(problemas, contable), motivos=[])
        elif documento.get("estado") != "revisado" or documento.get("version") != version_revisada:
            return self._terminar_envio(email, message_id, part_id, "omitido", error="El usuario edito el documento.")

        # El intento queda contado en disco antes de contactar SaveData.
        self._anotar_envio(email, clave, estado="en_curso", intentos=intentos + 1, error=None)
        logger.info("Ciclo automatico enviando a SaveData message_id=%s part_id=%s intento=%d/%d", message_id, part_id, intentos + 1, MAX_INTENTOS)
        return self._enviar_y_registrar(email, message_id, part_id, version_revisada, intentos + 1, propios)

    # --- "Configurar con este documento": extraer (y enviar) con la configuración nueva ----------

    def reprocesar(self, email: str, message_id: str, part_id: str, tipo_id: str, *, attachment_id: str | None = None, enviar: bool = False) -> dict[str, Any]:
        """Vuelve a extraer el documento con el tipo elegido (reemplaza la extracción guardada) y, si se pide, lo
        marca como revisado y lo envía a SaveData con el envío de siempre.

        Si la extracción tiene problemas y "Enviar solo si cuadra" está encendido, o el tipo sigue sin campos, no se
        envía: queda revisable. Devuelve {"documento", "envio": None | "enviado" | "requiere_revision" | "error" | "incierto",
        "motivos", "mensaje"}.
        """
        from .savedata import MENSAJE_SIN_CONEXION, EnvioRequest, NoSePuedeEnviar, _code_de

        tipos = self.tipos.leer(email)
        tipo = next((item for item in tipos if item["id"] == tipo_id), None)
        if tipo is None:
            raise KeyError(tipo_id)
        mensaje = self.gmail.get_message(message_id)
        if not attachment_id:
            adjunto = next((item for item in mensaje.get("attachments") or [] if str(item.get("partId")) == part_id), None)
            attachment_id = str((adjunto or {}).get("id") or "")
        if not attachment_id:
            raise ValueError("No se encontró el adjunto en el correo.")
        data, media_type, nombre = self.gmail.attachment(message_id, attachment_id)
        actual = self.almacen.obtener(email, message_id, part_id)
        aseguradora = ((actual or {}).get("tipo_documento") or {}).get("aseguradora") or ""
        deteccion = {**deteccion_manual(tipo, aseguradora), "remitente": direccion(mensaje.get("senderEmail", ""))}
        campos = self.campos_configurados(email) if tipo.get("contable") else list(tipo.get("campos") or [])
        extraer = tipo_para_extraer(tipo)
        resultado = self.gemini.extract_document(data, media_type, nombre, campos_solicitados=[campo["nombre"] for campo in campos], **({} if extraer is None else {"tipo": extraer}))
        if not deteccion.get("aseguradora") and resultado.get("aseguradora"):
            deteccion["aseguradora"] = resultado["aseguradora"]
        solicitud = borrador_desde_extraccion(resultado, campos, filename=nombre or str((actual or {}).get("filename") or ""), attachment_id=attachment_id, lote=uuid.uuid4().hex[:8],
                                              tipo_documento=TipoDocumentoGuardado.model_validate(deteccion).model_dump())
        solicitud.version_base = None if actual is None else actual.get("version")
        documento = self.almacen.guardar(email, message_id, part_id, solicitud)
        self._registrar_estructura(email, deteccion, resultado, data)
        salida: dict[str, Any] = {"documento": documento, "envio": None, "motivos": [], "mensaje": None}
        if not enviar:
            return salida
        problemas = documento.get("problemas") or {}
        motivos = [deteccion["motivo"]] if deteccion.get("requiere_revision") else [SIN_DATOS] if sin_datos_extraidos(documento) else []
        if not motivos and self._leer(email).get("solo_si_cuadra") is not False:
            motivos = motivos_sin_cuadrar(problemas, es_contable(deteccion))
        if motivos:
            self._anotar_pedido_al_configurar(email, message_id, part_id, documento.get("version"), "requiere_revision", motivos=motivos)
            return {**salida, "envio": "requiere_revision", "motivos": motivos}
        version = documento.get("version")

        def revisar(doc: dict[str, Any] | None) -> dict[str, Any]:
            if doc is None or doc.get("version") != version:
                raise _DocumentoTocado()
            ahora = _iso(self.reloj())
            return {**doc, "estado": "revisado", "version": int(version) + 1, "actualizado": ahora, "revisado_en": ahora,
                    "revisado_con_problemas": bool(problemas.get("total"))}
        try:
            revisado = self.almacen.actualizar(email, message_id, part_id, revisar)
        except _DocumentoTocado:
            return {**salida, "envio": "error", "mensaje": "El documento cambió mientras se preparaba el envío."}
        solicitud_envio = EnvioRequest.model_construct(version_base=revisado.get("version"), sucursal=None, articulo=None, carga_inicial=False, confirmar_reenvio=True, agregar_de_nuevo=False)
        try:
            respuesta, intento, enviado = self.envios.enviar(email, message_id, part_id, solicitud_envio, origen="configurar")
        except NoSePuedeEnviar as error:
            return {**salida, "documento": revisado, "envio": "error", "mensaje": str(error)}
        estado = {"exito": "enviado", "incierto": "incierto"}.get(respuesta.resultado, "error")
        # "No se pudo conectar": no se envió nada; el proceso automático lo reintenta en las siguientes revisiones.
        reintentar = respuesta.resultado == "error" and respuesta.mensaje == MENSAJE_SIN_CONEXION
        if reintentar:
            estado = "pendiente"
        self._anotar_pedido_al_configurar(email, message_id, part_id, revisado.get("version"), estado, intento=intento, error=None if estado == "enviado" else respuesta.mensaje)
        code, _ = _code_de(respuesta.respuesta or "")
        return {**salida, "documento": self.almacen.obtener(email, message_id, part_id) or enviado, "envio": estado, "mensaje": respuesta.mensaje,
                "code": code if isinstance(code, int) and not isinstance(code, bool) else None, "reintentara": reintentar}

    def _anotar_pedido_al_configurar(self, email: str, message_id: str, part_id: str, version: Any, estado: str, *, intento: dict[str, Any] | None = None,
                                     error: str | None = None, motivos: list[str] | None = None) -> None:
        """Deja el documento marcado para envío automático con origen "configurar". Si quedó pendiente (no se pudo
        conectar), el proceso automático lo reintenta hasta MAX_INTENTOS veces, aunque el envío automático general esté
        apagado. Un resultado incierto nunca se reintenta solo."""
        clave = f"{message_id}__{part_id}"
        envio = {"estado": estado, "intentos": 0, "intentos_ids": [intento["id"]] if intento else [], "version": version if estado == "pendiente" else None,
                 "error": error, "motivos": list(motivos or []), "problemas": list(motivos or []), "origen": "configurar", "actualizado": _iso(self.reloj())}

        def cambio(cuenta: dict[str, Any]) -> None:
            entrada = dict(cuenta["adjuntos"].get(clave) or {"intentos": 0})
            entrada.update(estado="extraido", error=None, version=version, enviar_auto=True, origen_envio="configurar", envio=envio)
            cuenta["adjuntos"][clave] = entrada
        try:
            self._mutar(email, cambio)
            self._reflejar_en_documento(email, message_id, part_id, envio)
        except Exception:
            logger.exception("No se pudo marcar el envio pedido al configurar %s", clave)

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
        origen = "configurar" if (self._leer(email)["adjuntos"].get(f"{message_id}__{part_id}") or {}).get("origen_envio") == "configurar" else "automatico"
        try:
            respuesta, intento, _documento = self.envios.enviar(email, message_id, part_id, solicitud, origen=origen)
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
        logger.info("Ciclo automatico respuesta SaveData message_id=%s part_id=%s resultado=%s http=%s", message_id, part_id, respuesta.resultado, respuesta.http_status)
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
        try:
            self._recuperar_al_arrancar()
        except Exception:
            logger.exception("Extraccion automatica: no se pudieron revisar los ciclos interrumpidos")
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

    def revisar_ahora(self, email: str | None = None) -> bool:
        """Adelanta la siguiente revisión. False si ya hay un ciclo en curso (en este u otro proceso).

        Con ``email`` deja la solicitud registrada en el archivo: la tarjeta la muestra pendiente hasta que empieza
        un ciclo posterior, y el ciclo queda registrado aunque termine sin poder consultar Gmail.
        """
        if self._ciclo.locked() or self._otro_proceso_en_curso() is not None:
            return False
        with self._estado_lock:
            self._manual = True
        if email:
            self._cuenta_conocida = email
            self._mutar(email, lambda estado: estado.__setitem__("revision_solicitada_en", _iso(self.reloj())))
        logger.info("Revision manual solicitada")
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
