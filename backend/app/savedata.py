"""Envío de extracciones revisadas a SaveData.

- ``construir_saldos()`` concentra las reglas de conversión (provisionales): cambiarlas es tocar solo esa función.
- El cuerpo se serializa con ``json.dumps`` en los dos niveles: {"data": "<JSON interno como string>"}.
- Éxito solo si HTTP 200 y el JSON de respuesta trae ``code == 200``.
- Cada intento queda auditado en el documento (cuerpo exacto enviado, respuesta, error). Antes de enviar se
  registra como ``en_curso``; si el proceso cae a mitad, el intento queda así y exige confirmar el reenvío.
- Un timeout es "incierto": SaveData pudo haber recibido el envío, así que reenviar también exige confirmación.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .contabilidad import formatear_decimal, validar_contabilidad
from .extracciones import AlmacenExtracciones, ConflictoVersion, escribir_atomico, migrar_columnas_unicas
from .plantilla_campos import aplicar_plantilla

logger = logging.getLogger("nexora.savedata")

SAVEDATA_TIMEOUT_SECONDS = 30
MAX_RESPUESTA_GUARDADA = 10_000
ResultadoIntento = Literal["exito", "error", "incierto", "en_curso"]


# --- Conversión (reglas provisionales) ---------------------------------------------------------

@dataclass(frozen=True)
class TotalesEnvio:
    """Totales validados de las transacciones guardadas, en Decimal."""

    abonos: Decimal
    cargos: Decimal


def construir_saldos(totales: TotalesEnvio, sucursal: int, articulos: str | Sequence[str], carga_inicial: bool) -> dict[str, Any]:
    """Única función con las reglas de conversión a SaveData (provisionales).

    Por cada artículo: un renglón "H" con el total de abonos y uno "S" con el total de cargos, en ese orden.
    Hoy se envía un artículo por documento; para enviar varios basta con pasar una lista de artículos (y, si
    cambian las reglas de importes por artículo, ajustar solo esta función). Los importes pasan de Decimal a
    número únicamente aquí, al serializar; un total 0 se envía igual (Saldo 0.0).
    """
    lista = [articulos] if isinstance(articulos, str) else list(articulos)
    saldos: list[dict[str, Any]] = []
    for articulo in lista:
        saldos.append({"Sucursal": sucursal, "Articulo": articulo, "Saldo": float(totales.abonos), "Clave": "H"})
        saldos.append({"Sucursal": sucursal, "Articulo": articulo, "Saldo": float(totales.cargos), "Clave": "S"})
    return {"CargaInicial": carga_inicial, "Saldos": saldos}


def serializar_cuerpo(interno: dict[str, Any]) -> str:
    """{"data": "<JSON interno serializado>"} construido solo con json.dumps."""
    return json.dumps({"data": json.dumps(interno)})


class NoSePuedeEnviar(Exception):
    def __init__(self, code: str, message: str, status_code: int = 409, detalle: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.detalle = detalle or {}


def totales_de(documento: dict[str, Any]) -> TotalesEnvio:
    """Recalcula la validación sobre lo guardado; sin sumas válidas no hay envío."""
    validacion = validar_contabilidad(documento.get("resumen", {}), documento.get("transacciones", []), documento.get("formato_numerico"))
    if validacion["suma_abonos"] is None or validacion["suma_cargos"] is None:
        raise NoSePuedeEnviar("importes_invalidos", "Hay importes dudosos o invalidos en los movimientos: no se pueden calcular los totales a enviar.", 422)
    return TotalesEnvio(abonos=Decimal(validacion["suma_abonos"]), cargos=Decimal(validacion["suma_cargos"]))


# --- Cliente HTTP ------------------------------------------------------------------------------

@dataclass(frozen=True)
class RespuestaSaveData:
    resultado: Literal["exito", "error", "incierto"]
    http_status: int | None
    respuesta: str
    mensaje: str


class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    """Una redirección convertiría el POST en GET: se trata como error."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _leer_cuerpo(origen: Any) -> str:
    try:
        return origen.read(MAX_RESPUESTA_GUARDADA + 1).decode("utf-8", errors="replace")
    except Exception:
        return ""


def enviar_a_savedata(url: str, cuerpo: str, timeout: float = SAVEDATA_TIMEOUT_SECONDS) -> RespuestaSaveData:
    # Sin proxies del entorno (SaveData es un servidor interno) y sin seguir redirecciones.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SinRedirecciones())
    solicitud = urllib.request.Request(url, data=cuerpo.encode("utf-8"), method="POST", headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with opener.open(solicitud, timeout=timeout) as respuesta:
            status = respuesta.status
            texto = _leer_cuerpo(respuesta)
    except urllib.error.HTTPError as error:
        try:
            texto = _leer_cuerpo(error)
        finally:
            error.close()
        return RespuestaSaveData("error", error.code, texto[:MAX_RESPUESTA_GUARDADA], f"SaveData respondio HTTP {error.code}.")
    except TimeoutError:
        return RespuestaSaveData("incierto", None, "", f"SaveData no respondio en {timeout:g} s; no se sabe si recibio el envio.")
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            return RespuestaSaveData("incierto", None, "", f"SaveData no respondio en {timeout:g} s; no se sabe si recibio el envio.")
        return RespuestaSaveData("error", None, "", f"No se pudo conectar con SaveData: {error.reason}")
    except OSError as error:
        # La conexión se cortó después de enviar: SaveData pudo haber procesado el cuerpo.
        return RespuestaSaveData("incierto", None, "", f"La conexion con SaveData se interrumpio: {error}")

    texto = texto[:MAX_RESPUESTA_GUARDADA]
    if status != 200:
        return RespuestaSaveData("error", status, texto, f"SaveData respondio HTTP {status}.")
    try:
        datos = json.loads(texto)
    except ValueError:
        return RespuestaSaveData("error", status, texto, "SaveData respondio HTTP 200, pero la respuesta no es JSON.")
    code = datos.get("code") if isinstance(datos, dict) else None
    mensaje = datos.get("message") if isinstance(datos, dict) else None
    if code != 200 or isinstance(code, bool):
        return RespuestaSaveData("error", status, texto, f"SaveData respondio HTTP 200 con code={code!r}: {mensaje or 'sin mensaje'}.")
    return RespuestaSaveData("exito", status, texto, f"SaveData confirmo el envio: {mensaje or 'Exito'}.")


# --- Configuración ---------------------------------------------------------------------------------

class SaveDataConfigRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    sucursal_predeterminada: int | None = Field(default=None, ge=1, le=999_999_999)


class SaveDataConfig:
    """Sucursal predeterminada (se edita en Configuración) guardada en el backend."""

    def __init__(self, ruta: Path) -> None:
        self.ruta = ruta

    def leer(self) -> dict[str, Any]:
        try:
            datos = json.loads(self.ruta.read_text(encoding="utf-8")) if self.ruta.exists() else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            datos = {}
        sucursal = datos.get("sucursal_predeterminada")
        return {"sucursal_predeterminada": sucursal if isinstance(sucursal, int) and not isinstance(sucursal, bool) else None}

    def guardar(self, solicitud: SaveDataConfigRequest) -> dict[str, Any]:
        escribir_atomico(self.ruta, {"sucursal_predeterminada": solicitud.sucursal_predeterminada})
        return self.leer()


# --- Orquestación del envío ------------------------------------------------------------------------

class EnvioRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version_base: int = Field(ge=1)
    sucursal: int = Field(ge=1, le=999_999_999)
    articulo: str = Field(min_length=1, max_length=50)
    carga_inicial: bool = False
    confirmar_reenvio: bool = False

    @field_validator("articulo")
    @classmethod
    def _articulo_limpio(cls, valor: str) -> str:
        if valor != valor.strip() or not valor.strip():
            raise ValueError("El articulo no puede estar vacio ni tener espacios al inicio o al final.")
        return valor


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _requiere_confirmar_reenvio(documento: dict[str, Any]) -> dict[str, Any] | None:
    """Último intento que pudo llegar a SaveData (exitoso, incierto o interrumpido), si existe."""
    previos = [intento for intento in documento.get("envios", []) if intento.get("resultado") in {"exito", "incierto", "en_curso"}]
    return previos[-1] if previos else None


CAMPOS_RESUMEN = ("banco", "titular", "cuenta", "periodo", "moneda", "saldo_inicial", "total_cargos", "total_abonos", "saldo_final")
CAMPOS_TRANSACCION = ("fecha", "concepto", "referencia", "cargo", "abono", "saldo")


def _texto_o_nulo(valor: Any) -> str | None:
    texto = str(valor or "").strip()
    return texto or None


def datos_documento(documento: dict[str, Any], totales: TotalesEnvio, configurados: Sequence[dict[str, Any]] = ()) -> dict[str, Any]:
    """ÚNICA función que arma el JSON interno de SaveData (formato provisional hasta que se confirme).

    - "Resumen" y "Transacciones" como siempre: solo datos del estado de cuenta, sin campos internos de Nexora
      (id, huella, origen, dudosos, *_original) y sin filas vacías.
    - "Datos": los campos "Una vez" (datos del documento), una sola vez: {"Nombre del campo": valor}.
    - Campos "En cada movimiento": dentro de cada movimiento, con su nombre, después de los campos fijos.
    - Un campo vacío o no encontrado va como null. Los campos de la configuración (``configurados``) que el
      documento no tiene también van, como null.
    """
    # Lo mismo que ve el usuario al abrir el documento: columnas únicas migradas y campos vinculados a la
    # configuración (con su nombre actual); los configurados que faltan se agregan vacíos y salen como null.
    documento = aplicar_plantilla(migrar_columnas_unicas(documento), list(configurados))
    resumen = documento.get("resumen") or {}
    campos = list(documento.get("campos_extra") or [])
    del_documento = [campo for campo in campos if campo.get("alcance") == "documento"]
    por_movimiento = [campo for campo in campos if campo.get("alcance") != "documento"]

    transacciones = []
    for fila in documento.get("transacciones") or []:
        fijos = {campo: str(fila.get(campo) or "") for campo in CAMPOS_TRANSACCION}
        if not any(valor.strip() for valor in fijos.values()):
            continue
        extras = fila.get("extras") or {}
        transacciones.append({**fijos, **{str(campo["nombre"]): _texto_o_nulo(extras.get(campo["id"])) for campo in por_movimiento}})
    validacion = documento.get("validacion") or {}
    return {
        "Archivo": documento.get("filename"),
        "Resumen": {campo: resumen.get(campo, "") for campo in CAMPOS_RESUMEN},
        "Datos": {str(campo["nombre"]): _texto_o_nulo(campo.get("valor")) for campo in del_documento},
        "Transacciones": transacciones,
        "Validacion": {"cuadra": validacion.get("cuadra"), "suma_cargos": formatear_decimal(totales.cargos), "suma_abonos": formatear_decimal(totales.abonos)},
    }


def preparar_envio(documento: dict[str, Any], *, sucursal: int, articulo: str, carga_inicial: bool, configurados: Sequence[dict[str, Any]] = ()) -> dict[str, Any]:
    # Se envía solo nuestra extracción. construir_saldos() (formato H/S de SaveData) queda disponible pero no se usa.
    totales = totales_de(documento)
    interno = datos_documento(documento, totales, configurados)
    return {"interno": interno, "cuerpo": serializar_cuerpo(interno), "totales": {"abonos": formatear_decimal(totales.abonos), "cargos": formatear_decimal(totales.cargos)}}


def motivos_para_no_enviar(documento: dict[str, Any], sin_url: bool) -> list[str]:
    motivos = []
    if documento.get("estado") not in {"revisado", "enviado"}:
        motivos.append("Solo se pueden enviar extracciones en estado revisado. Marca el documento como revisado.")
    if sin_url:
        motivos.append("SAVEDATA_URL no esta configurada en el backend.")
    return motivos


class ServicioEnvio:
    def __init__(self, almacen: AlmacenExtracciones, url: Callable[[], str], timeout: float = SAVEDATA_TIMEOUT_SECONDS, cliente: Callable[[str, str, float], RespuestaSaveData] = enviar_a_savedata, configurados: Callable[[str], list[dict[str, Any]]] = lambda _email: []) -> None:
        self.almacen = almacen
        # Configuración de campos de la cuenta: los campos configurados que falten en el documento van como null.
        self.configurados = configurados
        self.url = url
        self.timeout = timeout
        self.cliente = cliente

    def vista_previa(self, email: str, message_id: str, part_id: str, *, sucursal: int, articulo: str, carga_inicial: bool) -> dict[str, Any]:
        documento = self.almacen.leer_completo(email, message_id, part_id)
        if documento is None:
            raise NoSePuedeEnviar("sin_extraccion", "Guarda la extraccion antes de prepararla para SaveData.", 404)
        preparado = preparar_envio(documento, sucursal=sucursal, articulo=articulo, carga_inicial=carga_inicial, configurados=self.configurados(email))
        motivos = motivos_para_no_enviar(documento, not self.url())
        previo = _requiere_confirmar_reenvio(documento)
        return {
            **preparado,
            "version": documento.get("version"),
            "estado": documento.get("estado"),
            "url_configurada": bool(self.url()),
            "puede_enviar": not motivos,
            "motivos": motivos,
            "requiere_confirmar_reenvio": previo is not None,
            "envio_previo": previo,
        }

    def enviar(self, email: str, message_id: str, part_id: str, solicitud: EnvioRequest) -> tuple[RespuestaSaveData, dict[str, Any], dict[str, Any]]:
        """Devuelve (respuesta de SaveData, intento registrado, documento actualizado)."""
        url = self.url().strip()
        if not url:
            raise NoSePuedeEnviar("savedata_sin_configurar", "SAVEDATA_URL no esta configurada en el backend.", 503)
        if not url.lower().startswith(("http://", "https://")):
            raise NoSePuedeEnviar("savedata_url_invalida", "SAVEDATA_URL debe empezar con http:// o https://.", 503)

        reserva = self.almacen.reservar_envio(email, message_id, part_id)
        try:
            intento_id = uuid.uuid4().hex
            preparado: dict[str, Any] = {}

            def registrar_inicio(documento: dict[str, Any] | None) -> dict[str, Any]:
                if documento is None:
                    raise NoSePuedeEnviar("sin_extraccion", "Guarda la extraccion antes de enviarla.", 404)
                if documento.get("version") != solicitud.version_base:
                    raise ConflictoVersion(documento)
                if documento.get("estado") not in {"revisado", "enviado"}:
                    raise NoSePuedeEnviar("no_revisado", "Solo se pueden enviar extracciones en estado revisado.")
                previo = _requiere_confirmar_reenvio(documento)
                if previo is not None and not solicitud.confirmar_reenvio:
                    raise NoSePuedeEnviar("requiere_confirmar_reenvio", "Este documento ya se envio (o su resultado es incierto). Confirma explicitamente para reenviarlo.", 409, {"envio_previo": previo})
                preparado.update(preparar_envio(documento, sucursal=solicitud.sucursal, articulo=solicitud.articulo, carga_inicial=solicitud.carga_inicial, configurados=self.configurados(email)))
                intento = {
                    "id": intento_id,
                    "iniciado_en": _ahora(),
                    "terminado_en": None,
                    "resultado": "en_curso",
                    "url": url,
                    "cuerpo": preparado["cuerpo"],
                    "http_status": None,
                    "respuesta": None,
                    "error": None,
                    "sucursal": solicitud.sucursal,
                    "articulo": solicitud.articulo,
                    "carga_inicial": solicitud.carga_inicial,
                    "totales": preparado["totales"],
                    "version_extraccion": documento.get("version"),
                    "reenvio": previo is not None,
                }
                return {**documento, "envios": [*documento.get("envios", []), intento]}

            # 1) El intento queda registrado antes de contactar SaveData.
            self.almacen.actualizar(email, message_id, part_id, registrar_inicio)
            # 2) Envío.
            respuesta = self.cliente(url, preparado["cuerpo"], self.timeout)
            logger.info("SaveData message_id=%s part_id=%s resultado=%s http=%s", message_id, part_id, respuesta.resultado, respuesta.http_status)

            # 3) Resultado auditado; solo un éxito cambia el estado a "enviado".
            def registrar_fin(documento: dict[str, Any] | None) -> dict[str, Any]:
                assert documento is not None
                terminado = _ahora()
                envios = []
                for intento in documento.get("envios", []):
                    if intento.get("id") == intento_id:
                        intento = {**intento, "terminado_en": terminado, "resultado": respuesta.resultado, "http_status": respuesta.http_status,
                                   "respuesta": respuesta.respuesta, "error": None if respuesta.resultado == "exito" else respuesta.mensaje}
                    envios.append(intento)
                actualizado = {**documento, "envios": envios}
                if respuesta.resultado == "exito":
                    actualizado["estado"] = "enviado"
                    actualizado["enviado_en"] = terminado
                return actualizado

            documento = self.almacen.actualizar(email, message_id, part_id, registrar_fin)
            intento = next(item for item in documento["envios"] if item["id"] == intento_id)
            return respuesta, intento, documento
        finally:
            self.almacen.liberar_envio(reserva)
