"""Envío de extracciones revisadas a SaveData.

- ``construir_saldos()`` concentra las reglas de conversión (provisionales): cambiarlas es tocar solo esa función.
- El cuerpo se serializa con ``json.dumps`` en los dos niveles: {"data": "<JSON interno como string>"}.
- Éxito solo si HTTP 200 y el JSON de respuesta trae ``code == 200``.
- Cada intento queda auditado en el documento (cuerpo exacto enviado, respuesta, error). Antes de enviar se
  registra como ``en_curso``; si el proceso cae a mitad, el intento queda así y exige confirmar el reenvío.
- Un timeout es "incierto": SaveData pudo haber recibido el envío, así que reenviar también exige confirmación.
  Si la conexión nunca se abrió es "error" ("No se pudo conectar con SaveData; no se envió nada."): se puede reintentar.
- Cada documento va con un "Id" fijo. Una actualización ("Actualizacion": true) de un registro que alguien
  borró en SaveData regresa ``code == 404``: queda como ``no_existe`` y el usuario decide si agregarlo de nuevo
  (se reenvía con el mismo Id y "Actualizacion": false).
- "Eliminar de SaveData" manda {"Id": ..., "Eliminar": true}. code 200 (borrado) o 404 (ya no existía) dejan el
  documento como eliminado; el documento sigue en Nexora y puede enviarse de nuevo como alta nueva.
"""

from __future__ import annotations

import http.client
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
from .extracciones import AlmacenExtracciones, ConflictoVersion, es_contable, escribir_atomico, migrar_columnas_unicas
from .plantilla_campos import aplicar_plantilla

logger = logging.getLogger("nexora.savedata")

SAVEDATA_TIMEOUT_SECONDS = 30
MAX_RESPUESTA_GUARDADA = 10_000
ResultadoIntento = Literal["exito", "error", "incierto", "en_curso", "no_existe"]
# code que SaveData responde cuando se actualiza un Id que ya no existe (lo borraron).
CODE_NO_EXISTE = 404
MENSAJE_NO_EXISTE = "SaveData indica que el registro ya no existe (lo borraron)."


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
    resultado: Literal["exito", "error", "incierto", "no_existe"]
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


def _code_de(texto: str) -> tuple[Any, Any]:
    """(code, message) del JSON de SaveData; (None, None) si no es JSON con esa forma."""
    try:
        datos = json.loads(texto)
    except ValueError:
        return None, None
    if not isinstance(datos, dict):
        return None, None
    return datos.get("code"), datos.get("message")


def _es_no_existe(code: Any) -> bool:
    return code == CODE_NO_EXISTE and not isinstance(code, bool)


def _no_existe(status: int | None, texto: str, mensaje: Any) -> RespuestaSaveData:
    return RespuestaSaveData("no_existe", status, texto, f"{MENSAJE_NO_EXISTE} {mensaje}" if mensaje else MENSAJE_NO_EXISTE)


MENSAJE_SIN_CONEXION = "No se pudo conectar con SaveData; no se envió nada."


class _SinConexion(OSError):
    """La conexión con SaveData nunca se abrió (ni TCP ni TLS): no se mandó ningún byte del cuerpo."""


class _ConexionHTTP(http.client.HTTPConnection):
    def connect(self) -> None:
        try:
            super().connect()
        except OSError as error:
            raise _SinConexion(str(error) or error.__class__.__name__) from error


class _ConexionHTTPS(http.client.HTTPSConnection):
    def connect(self) -> None:
        try:
            super().connect()
        except OSError as error:
            raise _SinConexion(str(error) or error.__class__.__name__) from error


class _ManejadorHTTP(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_ConexionHTTP, req)


class _ManejadorHTTPS(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_ConexionHTTPS, req, context=self._context)


def _sin_conexion(error: BaseException) -> bool:
    return isinstance(error, _SinConexion) or isinstance(getattr(error, "reason", None), _SinConexion)


def enviar_a_savedata(url: str, cuerpo: str, timeout: float = SAVEDATA_TIMEOUT_SECONDS) -> RespuestaSaveData:
    """Envía el cuerpo. "error" si SaveData respondió con error o si la conexión nunca se abrió (no se envió nada:
    se puede reintentar); "incierto" solo si la conexión se abrió y no llegó una respuesta completa."""
    # Sin proxies del entorno (SaveData es un servidor interno) y sin seguir redirecciones.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SinRedirecciones(), _ManejadorHTTP(), _ManejadorHTTPS())
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
        texto = texto[:MAX_RESPUESTA_GUARDADA]
        code, mensaje = _code_de(texto)
        if _es_no_existe(code):
            return _no_existe(error.code, texto, mensaje)
        return RespuestaSaveData("error", error.code, texto, f"SaveData respondio HTTP {error.code}.")
    except OSError as error:
        # URLError, TimeoutError y cortes de conexión. HTTPError (SaveData sí respondió) ya se atendió arriba.
        if _sin_conexion(error):
            return RespuestaSaveData("error", None, "", MENSAJE_SIN_CONEXION)
        motivo = error.reason if isinstance(error, urllib.error.URLError) else error
        if isinstance(motivo, TimeoutError):
            return RespuestaSaveData("incierto", None, "", f"SaveData no respondio en {timeout:g} s; no se sabe si recibio el envio.")
        if isinstance(error, urllib.error.URLError) and not isinstance(motivo, OSError):
            return RespuestaSaveData("error", None, "", f"No se pudo conectar con SaveData: {motivo}")
        # La conexión se abrió y se cortó: SaveData pudo haber procesado el cuerpo.
        return RespuestaSaveData("incierto", None, "", f"La conexion con SaveData se interrumpio: {motivo}")

    texto = texto[:MAX_RESPUESTA_GUARDADA]
    if status != 200:
        return RespuestaSaveData("error", status, texto, f"SaveData respondio HTTP {status}.")
    try:
        datos = json.loads(texto)
    except ValueError:
        return RespuestaSaveData("error", status, texto, "SaveData respondio HTTP 200, pero la respuesta no es JSON.")
    code = datos.get("code") if isinstance(datos, dict) else None
    mensaje = datos.get("message") if isinstance(datos, dict) else None
    if _es_no_existe(code):
        return _no_existe(status, texto, mensaje)
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
    # Solo después de que SaveData respondió que el registro ya no existe: se envía como alta nueva.
    agregar_de_nuevo: bool = False

    @field_validator("articulo")
    @classmethod
    def _articulo_limpio(cls, valor: str) -> str:
        if valor != valor.strip() or not valor.strip():
            raise ValueError("El articulo no puede estar vacio ni tener espacios al inicio o al final.")
        return valor


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


EstadoEnSaveData = Literal["nunca", "presente", "borrado", "eliminado"]


def estado_en_savedata(documento: dict[str, Any]) -> EstadoEnSaveData:
    """Lo que SaveData tiene de este documento según el historial (los errores no cambian nada).

    - presente: algún envío pudo llegar (éxito, incierto o interrumpido) y no se ha eliminado.
    - borrado: alguien lo borró en SaveData (una actualización respondió code 404).
    - eliminado: lo eliminamos nosotros desde Nexora ("Eliminar de SaveData").
    """
    estado: EstadoEnSaveData = "nunca"
    for intento in documento.get("envios") or []:
        resultado = intento.get("resultado")
        if intento.get("accion", "enviar") == "eliminar":
            if resultado in {"exito", "no_existe"}:
                estado = "eliminado"
        elif resultado in {"exito", "incierto", "en_curso"}:
            estado = "presente"
        elif resultado == "no_existe":
            estado = "borrado"
    return estado


def _requiere_confirmar_reenvio(documento: dict[str, Any]) -> dict[str, Any] | None:
    """Último envío que pudo llegar a SaveData (exitoso, incierto o interrumpido), si existe y no se eliminó."""
    if estado_en_savedata(documento) == "eliminado":
        return None
    previos = [intento for intento in documento.get("envios", []) if intento.get("accion", "enviar") == "enviar" and intento.get("resultado") in {"exito", "incierto", "en_curso"}]
    return previos[-1] if previos else None


def borrado_en_savedata(documento: dict[str, Any]) -> bool:
    """True si SaveData respondió que el registro ya no existe (alguien lo borró allá)."""
    return estado_en_savedata(documento) == "borrado"


def eliminado_de_savedata(documento: dict[str, Any]) -> bool:
    """True si lo eliminamos de SaveData desde Nexora."""
    return estado_en_savedata(documento) == "eliminado"


def documento_id(documento: dict[str, Any]) -> str | None:
    """Id fijo del documento: no cambia aunque se edite o se reenvíe."""
    message_id, part_id = documento.get("messageId"), documento.get("partId")
    return f"{message_id}__{part_id}" if message_id and part_id else None


CAMPOS_RESUMEN = ("banco", "titular", "cuenta", "periodo", "moneda", "saldo_inicial", "total_cargos", "total_abonos", "saldo_final")
CAMPOS_TRANSACCION = ("fecha", "concepto", "referencia", "cargo", "abono", "saldo")


def _texto_o_nulo(valor: Any) -> str | None:
    texto = str(valor or "").strip()
    return texto or None


def _aseguradora(documento: dict[str, Any], contable: bool) -> str | None:
    """Aseguradora (o banco) del documento: la detectada; si no, la de la estructura. En un estado de cuenta, el banco."""
    tipo_documento = documento.get("tipo_documento") or {}
    if contable:
        banco = _texto_o_nulo((documento.get("resumen") or {}).get("banco"))
        if banco:
            return banco
    estructura = tipo_documento.get("estructura")
    return _texto_o_nulo(tipo_documento.get("aseguradora")) or (_texto_o_nulo(estructura) if estructura != "Predeterminada" else None)


def datos_documento(documento: dict[str, Any], totales: TotalesEnvio, configurados: Sequence[dict[str, Any]] = (), actualizacion: bool | None = None,
                    tipo: dict[str, Any] | None = None) -> dict[str, Any]:
    """ÚNICA función que arma el JSON interno de SaveData (formato provisional hasta que se confirme).

    - "Tipo": código del tipo de documento (``tipo`` es su configuración actual; sin ella, el código guardado en el
      documento; un documento de antes de los tipos es un estado de cuenta: "EC").
    - "Aseguradora": la detectada en el documento o la de su estructura. En un estado de cuenta solo va si se conoce
      el banco (o la aseguradora).
    - Tipos que no son estado de cuenta (provisional, por confirmar): sin "Resumen", "Transacciones" ni "Validacion";
      la sección repetible va con su nombre (p. ej. "Incisos": [{campo: valor}]).

    - "Resumen" y "Transacciones" como siempre: solo datos del estado de cuenta, sin campos internos de Nexora
      (id, huella, origen, dudosos, *_original) y sin filas vacías.
    - "Datos": los campos "Una vez" (datos del documento), una sola vez: {"Nombre del campo": valor}.
    - Campos "En cada movimiento": dentro de cada movimiento, con su nombre, después de los campos fijos.
    - Un campo vacío o no encontrado va como null. Los campos de la configuración (``configurados``) que el
      documento no tiene también van, como null.
    - "Id": identificador fijo del documento (``messageId__partId``); es el mismo en cada reenvío, para que
      SaveData actualice ese registro en lugar de crear otro.
    - "Actualizacion": true si el documento ya se había enviado antes (éxito, incierto o interrumpido);
      ``actualizacion`` lo fuerza (False al agregarlo de nuevo después de que lo borraron en SaveData).
    """
    identificador = documento_id(documento)
    if actualizacion is None:
        actualizacion = _requiere_confirmar_reenvio(documento) is not None
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
    tipo_documento = documento.get("tipo_documento") or {}
    contable = es_contable(tipo_documento)
    codigo = (tipo or {}).get("codigo") or tipo_documento.get("codigo") or ("EC" if contable else None)
    aseguradora = _aseguradora(documento, contable)
    cabecera: dict[str, Any] = {"Id": identificador, "Actualizacion": actualizacion, "Tipo": codigo}
    if aseguradora or not contable:
        cabecera["Aseguradora"] = aseguradora
    if not contable:
        nombre_seccion = ((tipo or {}).get("seccion") or {}).get("nombre")
        interno = {**cabecera, "Archivo": documento.get("filename"), "Datos": {str(campo["nombre"]): _texto_o_nulo(campo.get("valor")) for campo in del_documento}}
        if nombre_seccion or (tipo is None and por_movimiento):
            filas = []
            for fila in documento.get("transacciones") or []:
                extras = fila.get("extras") or {}
                valores = {str(campo["nombre"]): _texto_o_nulo(extras.get(campo["id"])) for campo in por_movimiento}
                if any(valor is not None for valor in valores.values()):
                    filas.append(valores)
            interno[nombre_seccion or "Filas"] = filas
        return interno
    validacion = documento.get("validacion") or {}
    return {
        **cabecera,
        "Archivo": documento.get("filename"),
        "Resumen": {campo: resumen.get(campo, "") for campo in CAMPOS_RESUMEN},
        "Datos": {str(campo["nombre"]): _texto_o_nulo(campo.get("valor")) for campo in del_documento},
        "Transacciones": transacciones,
        "Validacion": {"cuadra": validacion.get("cuadra"), "suma_cargos": formatear_decimal(totales.cargos), "suma_abonos": formatear_decimal(totales.abonos)},
    }


def preparar_envio(documento: dict[str, Any], *, sucursal: int, articulo: str, carga_inicial: bool, configurados: Sequence[dict[str, Any]] = (), actualizacion: bool | None = None,
                   tipo: dict[str, Any] | None = None) -> dict[str, Any]:
    # Se envía solo nuestra extracción. construir_saldos() (formato H/S de SaveData) queda disponible pero no se usa.
    totales = totales_de(documento)
    interno = datos_documento(documento, totales, configurados, actualizacion, tipo)
    return {"interno": interno, "cuerpo": serializar_cuerpo(interno), "totales": {"abonos": formatear_decimal(totales.abonos), "cargos": formatear_decimal(totales.cargos)}}


def motivos_para_no_enviar(documento: dict[str, Any], sin_url: bool) -> list[str]:
    motivos = []
    if documento.get("estado") not in {"revisado", "enviado"}:
        motivos.append("Solo se pueden enviar extracciones en estado revisado. Marca el documento como revisado.")
    if sin_url:
        motivos.append("SAVEDATA_URL no esta configurada en el backend.")
    return motivos


class ServicioEnvio:
    def __init__(self, almacen: AlmacenExtracciones, url: Callable[[], str], timeout: float = SAVEDATA_TIMEOUT_SECONDS, cliente: Callable[[str, str, float], RespuestaSaveData] = enviar_a_savedata, configurados: Callable[[str], list[dict[str, Any]]] = lambda _email: [],
                 tipo_de: Callable[[str, dict[str, Any]], dict[str, Any] | None] = lambda _email, _documento: None) -> None:
        self.almacen = almacen
        # Configuración de campos de la cuenta: los campos configurados que falten en el documento van como null.
        self.configurados = configurados
        # Tipo de documento actual de un documento (código, sección y campos); None: estado de cuenta de siempre.
        self.tipo_de = tipo_de
        self.url = url
        self.timeout = timeout
        self.cliente = cliente

    def _armado(self, email: str, documento: dict[str, Any]) -> dict[str, Any]:
        """Campos configurados y tipo con que se arma el JSON: los del estado de cuenta, o los del tipo del documento."""
        tipo = self.tipo_de(email, documento)
        if tipo is None or tipo.get("contable"):
            return {"configurados": self.configurados(email), "tipo": tipo}
        return {"configurados": list(tipo.get("campos") or []), "tipo": tipo}

    def vista_previa(self, email: str, message_id: str, part_id: str, *, sucursal: int, articulo: str, carga_inicial: bool) -> dict[str, Any]:
        documento = self.almacen.leer_completo(email, message_id, part_id)
        if documento is None:
            raise NoSePuedeEnviar("sin_extraccion", "Guarda la extraccion antes de prepararla para SaveData.", 404)
        borrado = borrado_en_savedata(documento)
        preparado = preparar_envio(documento, sucursal=sucursal, articulo=articulo, carga_inicial=carga_inicial, **self._armado(email, documento), actualizacion=False if borrado else None)
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
            # El último envío regresó que SaveData ya no tiene el registro: el siguiente sería "agregar de nuevo".
            "borrado_en_savedata": borrado,
            "eliminado_de_savedata": eliminado_de_savedata(documento),
            # Hay algo en SaveData que se puede eliminar.
            "puede_eliminar": estado_en_savedata(documento) == "presente",
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
                agregar = solicitud.agregar_de_nuevo
                borrado = borrado_en_savedata(documento)
                if agregar and not borrado:
                    raise NoSePuedeEnviar("agregar_no_permitido", "Solo se puede agregar de nuevo un documento que SaveData reporto como borrado.")
                if borrado and not agregar:
                    raise NoSePuedeEnviar("savedata_no_existe", "SaveData ya no tiene este documento (lo borraron). Confirma si quieres agregarlo de nuevo.", 409, {"envio_previo": documento["envios"][-1]})
                if previo is not None and not solicitud.confirmar_reenvio and not agregar:
                    raise NoSePuedeEnviar("requiere_confirmar_reenvio", "Este documento ya se envio (o su resultado es incierto). Confirma explicitamente para reenviarlo.", 409, {"envio_previo": previo})
                preparado.update(preparar_envio(documento, sucursal=solicitud.sucursal, articulo=solicitud.articulo, carga_inicial=solicitud.carga_inicial, **self._armado(email, documento), actualizacion=False if agregar else None))
                intento = {
                    "id": intento_id,
                    "accion": "enviar",
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
                    "actualizacion": preparado["interno"]["Actualizacion"],
                    "agregado_de_nuevo": agregar,
                }
                return {**documento, "envios": [*documento.get("envios", []), intento]}

            # 1) El intento queda registrado antes de contactar SaveData.
            self.almacen.actualizar(email, message_id, part_id, registrar_inicio)
            # 2) Envío.
            respuesta = self.cliente(url, preparado["cuerpo"], self.timeout)
            if respuesta.resultado == "no_existe" and not preparado["interno"]["Actualizacion"]:
                # Un alta nueva no puede "no existir": es un error de SaveData, no un registro borrado.
                respuesta = RespuestaSaveData("error", respuesta.http_status, respuesta.respuesta, f"SaveData respondio code=404 a un alta nueva: {respuesta.mensaje}")
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
                elif respuesta.resultado == "no_existe" and actualizado.get("estado") == "enviado":
                    # Ya no está en SaveData: vuelve a revisado hasta que se agregue de nuevo.
                    actualizado["estado"] = "revisado"
                return actualizado

            documento = self.almacen.actualizar(email, message_id, part_id, registrar_fin)
            intento = next(item for item in documento["envios"] if item["id"] == intento_id)
            return respuesta, intento, documento
        finally:
            self.almacen.liberar_envio(reserva)


# --- Eliminar de SaveData --------------------------------------------------------------------------

def cuerpo_eliminar(documento: dict[str, Any]) -> str:
    """{"data": "{\"Id\": ..., \"Eliminar\": true}"}: mismo formato de siempre, solo el Id y la orden."""
    return serializar_cuerpo({"Id": documento_id(documento), "Eliminar": True})


def eliminar_de_savedata(servicio: "ServicioEnvio", email: str, message_id: str, part_id: str) -> tuple[RespuestaSaveData, dict[str, Any], dict[str, Any]]:
    """Pide a SaveData borrar el registro con el Id del documento. Devuelve (respuesta, intento, documento).

    code 200 (lo borró) o 404 (ya no existía) cuentan como eliminado; cualquier otro resultado queda auditado y no
    cambia nada. El documento sigue en Nexora: vuelve a "revisado" y el siguiente envío es un alta nueva.
    """
    url = servicio.url().strip()
    if not url:
        raise NoSePuedeEnviar("savedata_sin_configurar", "SAVEDATA_URL no esta configurada en el backend.", 503)
    if not url.lower().startswith(("http://", "https://")):
        raise NoSePuedeEnviar("savedata_url_invalida", "SAVEDATA_URL debe empezar con http:// o https://.", 503)

    reserva = servicio.almacen.reservar_envio(email, message_id, part_id)
    try:
        intento_id = uuid.uuid4().hex
        cuerpo: dict[str, str] = {}

        def registrar_inicio(documento: dict[str, Any] | None) -> dict[str, Any]:
            if documento is None:
                raise NoSePuedeEnviar("sin_extraccion", "Este documento no tiene una extraccion guardada.", 404)
            if estado_en_savedata(documento) != "presente":
                raise NoSePuedeEnviar("nada_que_eliminar", "SaveData no tiene este documento: no se ha enviado, ya se elimino o lo borraron alla.")
            if not documento_id(documento):
                raise NoSePuedeEnviar("sin_id", "El documento no tiene Id; no se puede eliminar de SaveData.", 422)
            cuerpo["valor"] = cuerpo_eliminar(documento)
            intento = {
                "id": intento_id,
                "accion": "eliminar",
                "iniciado_en": _ahora(),
                "terminado_en": None,
                "resultado": "en_curso",
                "url": url,
                "cuerpo": cuerpo["valor"],
                "http_status": None,
                "respuesta": None,
                "error": None,
                "sucursal": None,
                "articulo": None,
                "carga_inicial": None,
                "totales": None,
                "version_extraccion": documento.get("version"),
                "reenvio": False,
            }
            return {**documento, "envios": [*documento.get("envios", []), intento]}

        servicio.almacen.actualizar(email, message_id, part_id, registrar_inicio)
        respuesta = servicio.cliente(url, cuerpo["valor"], servicio.timeout)
        logger.info("SaveData eliminar message_id=%s part_id=%s resultado=%s http=%s", message_id, part_id, respuesta.resultado, respuesta.http_status)

        def registrar_fin(documento: dict[str, Any] | None) -> dict[str, Any]:
            assert documento is not None
            terminado = _ahora()
            envios = []
            for intento in documento.get("envios", []):
                if intento.get("id") == intento_id:
                    intento = {**intento, "terminado_en": terminado, "resultado": respuesta.resultado, "http_status": respuesta.http_status,
                               "respuesta": respuesta.respuesta, "error": None if respuesta.resultado in {"exito", "no_existe"} else respuesta.mensaje}
                envios.append(intento)
            actualizado = {**documento, "envios": envios}
            if respuesta.resultado in {"exito", "no_existe"}:
                actualizado["eliminado_en"] = terminado
                if actualizado.get("estado") == "enviado":
                    actualizado["estado"] = "revisado"
            return actualizado

        documento = servicio.almacen.actualizar(email, message_id, part_id, registrar_fin)
        intento = next(item for item in documento["envios"] if item["id"] == intento_id)
        return respuesta, intento, documento
    finally:
        servicio.almacen.liberar_envio(reserva)


# --- Historial de envíos (todas las extracciones enviadas) ----------------------------------------

def faltantes_de_cuerpo(cuerpo: str | None) -> list[str]:
    """Campos que se enviaron vacíos (null) en un intento: los "Datos" y los campos por movimiento."""
    try:
        interno = json.loads(json.loads(cuerpo or "")["data"])
    except (ValueError, KeyError, TypeError):
        return []
    if not isinstance(interno, dict):
        return []
    faltantes = [str(nombre) for nombre, valor in (interno.get("Datos") or {}).items() if valor is None]
    vacios: dict[str, int] = {}
    for fila in interno.get("Transacciones") or []:
        if not isinstance(fila, dict):
            continue
        for nombre, valor in fila.items():
            if nombre not in CAMPOS_TRANSACCION and valor is None:
                vacios[nombre] = vacios.get(nombre, 0) + 1
    faltantes.extend(f"{nombre} ({cantidad} mov.)" for nombre, cantidad in vacios.items())
    return faltantes


def _resumen_intento(intento: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": intento.get("id"),
        "iniciado_en": intento.get("iniciado_en"),
        "terminado_en": intento.get("terminado_en"),
        "resultado": intento.get("resultado"),
        "sucursal": intento.get("sucursal"),
        "articulo": intento.get("articulo"),
        "error": intento.get("error"),
        "accion": intento.get("accion", "enviar"),
        "reenvio": bool(intento.get("reenvio")),
        "agregado_de_nuevo": bool(intento.get("agregado_de_nuevo")),
        "version_extraccion": intento.get("version_extraccion"),
        "faltantes": faltantes_de_cuerpo(intento.get("cuerpo")),
        # Lo envió el proceso automático (lo marca automatico.py).
        "automatico": bool(intento.get("automatico")),
    }


def historial_envios(almacen: AlmacenExtracciones, email: str) -> list[dict[str, Any]]:
    """Documentos con al menos un intento de envío, el más reciente primero, con lo que faltó en cada intento."""
    resultado = []
    for entrada in almacen.listar(email):
        try:
            documento = almacen.leer_completo(email, entrada["messageId"], entrada["partId"])
        except Exception:
            logger.warning("No se pudo leer el historial de %s/%s", entrada.get("messageId"), entrada.get("partId"))
            continue
        envios = (documento or {}).get("envios") or []
        # El envío automático también lista lo que no se envió ("Requiere revisión", "Sin SaveData").
        automatico = (documento or {}).get("envio_automatico")
        if not documento or (not envios and not automatico):
            continue
        intentos = [_resumen_intento(intento) for intento in envios]
        ultimo = intentos[-1] if intentos else None
        resultado.append({
            "id": documento_id(documento),
            "messageId": documento.get("messageId"),
            "partId": documento.get("partId"),
            "filename": documento.get("filename", ""),
            "estado": documento.get("estado"),
            "version": documento.get("version"),
            "enviado_en": documento.get("enviado_en"),
            # Se editó después del último intento: hay cambios que SaveData aún no tiene.
            "modificado_tras_envio": ultimo is not None and (documento.get("version") or 0) > (ultimo.get("version_extraccion") or 0),
            # presente | borrado (lo borraron en SaveData) | eliminado (lo eliminamos desde Nexora) | nunca
            "en_savedata": estado_en_savedata(documento),
            "ultimo": ultimo,
            "intentos": intentos,
            # Estado del envío automático (enviado, requiere_revision, error, incierto, ...) o None.
            "envio_automatico": automatico,
        })
    resultado.sort(key=lambda item: (item["ultimo"] or {}).get("terminado_en") or (item["ultimo"] or {}).get("iniciado_en") or (item["envio_automatico"] or {}).get("actualizado") or "", reverse=True)
    return resultado
