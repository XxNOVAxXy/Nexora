from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import logging
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from .adjuntos import content_disposition
from .automatico import ExtractorAutomatico, intervalo_desde_entorno
from .plantilla_campos import AlmacenPlantillas, PlantillaRequest, aplicar_plantilla, comparable, deducir_campos, sugerencias_para_configurar
from .config import settings
from .preferencias import AlmacenClasificaciones, ClasificacionRequest, ConfiguracionCuenta, MigracionRequest, RemitentesRequest
from .remitentes import CONSULTAS_CARPETA, ListaRemitentesInvalida, coincide, construir_query
from . import filtro_estados
from .savedata import EnvioRequest, NoSePuedeEnviar, SaveDataConfig, SaveDataConfigRequest, ServicioEnvio, eliminar_de_savedata, historial_envios
from .tipos_documento import (
    TIPO_EC_ID,
    UMBRAL_CONFIANZA,
    AlmacenTipos,
    ConflictoTipos,
    EstructuraRequest,
    TipoRequest,
    huella_documento,
    deteccion_manual,
    detectar_tipo,
    direccion,
    para_clasificar,
    tipo_para_extraer,
)
from .plantilla_campos import CampoPlantilla
from .estado_envio import estado_envio
from .extracciones import ID_DOCUMENTO_SEGURO, AlmacenExtracciones, ConflictoVersion, EnvioEnCurso, ExtraccionDanada, GuardarExtraccionRequest, RevisionConProblemas, cuenta_id
from .gemini import GeminiRequestError, GeminiSettings, GeminiUnavailableError
from .gmail import GmailAttachmentError, GmailClient, GmailNotConfiguredError, GmailNotConnectedError, GmailRateLimitError


logger = logging.getLogger("nexora.gmail")
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # El hilo arranca con el backend; si el proceso está pausado, cada ciclo termina sin consultar nada.
    automatico.iniciar()
    try:
        yield
    finally:
        automatico.detener()


app = FastAPI(title="Nexora API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list({settings.frontend_url, "http://localhost:5173", "http://127.0.0.1:5173"}),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gmail = GmailClient()
gemini = GeminiSettings()
almacen = AlmacenExtracciones(settings.extracciones_path)
savedata_config = SaveDataConfig(settings.savedata_settings_path)
configuracion = ConfiguracionCuenta(settings.configuracion_path)
clasificaciones = AlmacenClasificaciones(settings.clasificaciones_path)
# Configuración de campos por cuenta; mientras no se guarde, se deduce de las extracciones guardadas.
plantillas = AlmacenPlantillas(settings.plantilla_campos_path, lambda email: deducir_campos(almacen, email))
# Tipos de documento; "Estado de cuenta" usa la configuración de campos de siempre.
tipos = AlmacenTipos(settings.tipos_documento_path, plantillas)


def tipo_del_documento(email: str, documento: dict[str, Any]) -> dict[str, Any] | None:
    """Tipo actual de un documento guardado. Sin ``tipo_documento`` (documentos de antes de los tipos): Estado de cuenta."""
    tipo_documento = documento.get("tipo_documento")
    if not tipo_documento:
        return tipos.obtener(email, TIPO_EC_ID)
    return tipos.obtener(email, tipo_documento.get("tipo_id")) if tipo_documento.get("tipo_id") else None


def campos_del_documento(email: str, documento: dict[str, Any]) -> list[dict[str, Any]]:
    tipo = tipo_del_documento(email, documento)
    if tipo is None:
        return []
    return plantillas.efectiva(email) if tipo.get("contable") else list(tipo.get("campos") or [])


# La URL se lee en cada envío para que las pruebas puedan sustituirla.
envios = ServicioEnvio(almacen, lambda: settings.savedata_url, configurados=lambda email: plantillas.efectiva(email), tipo_de=lambda email, documento: tipo_del_documento(email, documento))
automatico = ExtractorAutomatico(settings.automatico_path, gmail, gemini, almacen, intervalo_desde_entorno(settings.intervalo_minutos), plantillas=plantillas, envios=envios, tipos=tipos)
oauth_states: dict[str, datetime] = {}


def _rate_limited(error: GmailRateLimitError) -> HTTPException:
    return HTTPException(status_code=429, detail=str(error), headers={"Retry-After": "60"})


GEMINI_API_KEY_MIN = 10


class GeminiConfigRequest(BaseModel):
    # Vacía, solo espacios o ausente: se conserva la key guardada (p. ej. al cambiar solo el modelo).
    apiKey: str | None = Field(default=None, max_length=512)
    model: str = Field(min_length=1, max_length=200)


class GeminiExtractionRequest(BaseModel):
    messageId: str = Field(min_length=1)
    attachmentId: str = Field(min_length=1)
    # True al re-extraer: ignora la cache de Gemini y reemplaza su entrada.
    forzar: bool = False
    # Nombres de las columnas manuales que Gemini debe buscar en el documento.
    campos_solicitados: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=30)
    # Tipos de documento: ``detectar`` detecta el tipo (reglas o IA); ``tipo_id`` lo fija. Sin ninguno, estado de cuenta.
    detectar: bool = False
    tipo_id: str | None = Field(default=None, max_length=64)


class FilaParaCampo(BaseModel):
    """Movimiento ya capturado que se envía a "Llenar con IA" para que Gemini lo ubique por su índice."""

    model_config = ConfigDict(extra="ignore")

    fecha: str = Field(default="", max_length=200)
    concepto: str = Field(default="", max_length=2000)
    referencia: str = Field(default="", max_length=500)
    cargo: str = Field(default="", max_length=200)
    abono: str = Field(default="", max_length=200)


class GeminiCampoRequest(BaseModel):
    messageId: str = Field(min_length=1)
    attachmentId: str = Field(min_length=1)
    nombre: str = Field(min_length=1, max_length=200)
    filas: list[FilaParaCampo] = Field(default_factory=list, max_length=5000)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "nexora-api"}


@app.get("/api/auth/gmail/start")
def start_gmail_auth() -> RedirectResponse:
    try:
        authorization_url, state = gmail.authorization_url()
    except GmailNotConfiguredError as error:
        logger.exception("Gmail OAuth is not configured")
        raise HTTPException(status_code=503, detail=str(error)) from error
    oauth_states[state] = datetime.now(timezone.utc) + timedelta(minutes=10)
    logger.info("Gmail OAuth started with redirect_uri=%s", settings.google_redirect_uri)
    return RedirectResponse(authorization_url)


@app.get("/api/auth/callback/google")
def gmail_callback(code: str | None = None, state: str | None = None, error: str | None = None) -> RedirectResponse:
    if error:
        logger.error("Google denied Gmail OAuth: %s", error)
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError={error}")
    if not code or not state or state not in oauth_states:
        logger.error("Gmail OAuth callback has an invalid or missing state")
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_state_invalid")
    if oauth_states.pop(state) < datetime.now(timezone.utc):
        logger.error("Gmail OAuth callback state expired")
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_state_expired")
    try:
        gmail.complete_authorization(code, state)
    except Exception:
        logger.exception("Gmail OAuth token exchange failed")
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_exchange_failed")
    logger.info("Gmail OAuth completed and token saved at %s", settings.token_path)
    return RedirectResponse(f"{settings.frontend_url}/settings?gmail=connected")


@app.get("/api/gmail/status")
def gmail_status() -> dict[str, Any]:
    try:
        profile = gmail.profile()
        email = profile.get("email")
        return {"connected": True, "provider": "gmail", **profile, "cuentaId": cuenta_id(email) if email else None}
    except GmailNotConnectedError:
        return {"connected": False, "provider": "gmail", "email": None}
    except GmailRateLimitError as error:
        # The token is valid; Gmail is only throttling. Don't report the account as disconnected.
        return {"connected": True, "provider": "gmail", "email": None, "error": str(error)}
    except Exception as error:
        logger.exception("Gmail status check failed")
        return {"connected": False, "provider": "gmail", "email": None, "error": str(error)}


@app.post("/api/gmail/disconnect")
def disconnect_gmail() -> dict[str, bool]:
    gmail.disconnect()
    return {"connected": False}


@app.get("/api/gemini/status")
def gemini_status() -> dict[str, Any]:
    return gemini.status()


@app.post("/api/gemini/config")
def save_gemini_config(payload: GeminiConfigRequest) -> dict[str, Any]:
    api_key = (payload.apiKey or "").strip() or None
    model = payload.model.strip()
    if not model:
        raise HTTPException(status_code=422, detail="Selecciona un modelo de Gemini.")
    if api_key is not None and len(api_key) < GEMINI_API_KEY_MIN:
        raise HTTPException(status_code=422, detail="La API key de Gemini es demasiado corta; revisa que este completa.")
    if api_key is None and not gemini.status()["configured"]:
        raise HTTPException(status_code=422, detail="Escribe una API key de Gemini para activar la integracion.")
    logger.info("Gemini configuration saved with model=%s new_key=%s", model, api_key is not None)
    return gemini.save(api_key, model)


@app.delete("/api/gemini/config")
def disable_gemini_config() -> dict[str, Any]:
    logger.info("Gemini integration disabled")
    return gemini.disable()


@app.post("/api/gemini/extract")
def extract_gemini_document(payload: GeminiExtractionRequest) -> dict[str, Any]:
    try:
        data, media_type, filename = gmail.attachment(payload.messageId, payload.attachmentId)
        logger.info(
            "Gemini extraction input message_id=%s attachment_id=%s filename=%s size=%d mime_type=%s pdf_signature=%s",
            payload.messageId,
            payload.attachmentId,
            filename,
            len(data),
            media_type,
            data.startswith(b"%PDF-"),
        )
        if payload.detectar or payload.tipo_id:
            result = _extraer_con_tipo(payload, data, media_type, filename)
        else:
            result = gemini.extract_document(data, media_type, filename, forzar=payload.forzar, campos_solicitados=payload.campos_solicitados)
        logger.info(
            "Gemini extraction result attachment_id=%s result=success transacciones=%d cuadra=%s",
            payload.attachmentId,
            len(result.get("transacciones", [])),
            result.get("validacion", {}).get("cuadra"),
        )
        return result
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except GmailAttachmentError as error:
        logger.warning(
            "Gemini extraction input rejected message_id=%s attachment_id=%s reason=%s",
            payload.messageId,
            payload.attachmentId,
            error,
        )
        raise HTTPException(status_code=422, detail=str(error)) from error
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except GeminiRequestError as error:
        logger.exception("Gemini document extraction failed for filename=%s", payload.attachmentId)
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": str(error), "retryable": error.retryable},
        ) from error
    except Exception as error:
        logger.exception("Document extraction failed for message=%s attachment=%s", payload.messageId, payload.attachmentId)
        raise HTTPException(status_code=502, detail=f"No se pudo extraer el documento: {error}") from error


def _extraer_con_tipo(payload: GeminiExtractionRequest, data: bytes, media_type: str, filename: str) -> dict[str, Any]:
    """Extracción según el tipo de documento: el elegido (``tipo_id``) o el detectado. Estado de cuenta usa los
    campos que pide el frontend (como siempre); los demás tipos, los campos de su configuración."""
    email = _cuenta_actual()
    lista = tipos.leer(email)
    mensaje = gmail.get_message(payload.messageId)
    if payload.tipo_id:
        tipo = next((item for item in lista if item["id"] == payload.tipo_id), None)
        if tipo is None:
            raise HTTPException(status_code=404, detail="El tipo de documento no existe.")
        deteccion = {**deteccion_manual(tipo), "remitente": direccion(mensaje.get("senderEmail", ""))}
    else:
        deteccion = detectar_tipo(lista, remitente=mensaje.get("senderEmail", ""), asunto=mensaje.get("subject", ""),
                                  clasificar=lambda: gemini.clasificar_documento(data, media_type, filename, para_clasificar(lista)))
        tipo = next((item for item in lista if item["id"] == deteccion.get("tipo_id")), None)
    contable = tipo is not None and tipo.get("contable")
    campos = list(payload.campos_solicitados) if contable else [campo["nombre"] for campo in (tipo or {}).get("campos") or []]
    extraer = tipo_para_extraer(tipo)
    result = gemini.extract_document(data, media_type, filename, forzar=payload.forzar, campos_solicitados=campos, **({} if extraer is None else {"tipo": extraer}))
    if not deteccion.get("aseguradora") and result.get("aseguradora"):
        deteccion["aseguradora"] = result["aseguradora"]
    if tipo is not None and not contable:
        # Avisos de cambios de estructura: nunca detienen la extracción.
        try:
            tipos.registrar_extraccion(email, tipo["id"], deteccion.get("aseguradora") or "", result, huella_documento(data))
        except Exception:
            logger.exception("No se pudieron registrar los avisos de estructura")
    return {**result, "tipo_documento": deteccion, "campos_tipo": None if contable else list((tipo or {}).get("campos") or [])}


@app.post("/api/gemini/campos")
def fill_gemini_field(payload: GeminiCampoRequest) -> dict[str, Any]:
    """"Llenar con IA": busca una sola columna en el documento para las filas actuales, sin re-extraer."""
    try:
        data, media_type, filename = gmail.attachment(payload.messageId, payload.attachmentId)
        return gemini.fill_field(data, media_type, filename, payload.nombre, [fila.model_dump() for fila in payload.filas])
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except GmailAttachmentError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except GeminiRequestError as error:
        logger.exception("Gemini field fill failed for attachment=%s", payload.attachmentId)
        raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error), "retryable": error.retryable}) from error
    except Exception as error:
        logger.exception("Field fill failed for message=%s attachment=%s", payload.messageId, payload.attachmentId)
        raise HTTPException(status_code=502, detail=f"No se pudo buscar el campo en el documento: {error}") from error


@app.get("/api/gmail/messages")
def list_gmail_messages(
    folder: str = Query("inbox", pattern="^(inbox|sent|archive|trash)$"),
    limit: int = Query(25, ge=1, le=50),
    filtro: str = Query("estados", pattern="^(estados|remitentes|todos)$"),
    pageToken: str | None = Query(None, max_length=500, pattern=r"^[A-Za-z0-9_-]+$"),
) -> dict[str, Any]:
    """Una página de correos.

    - ``filtro=estados`` (por defecto): estados de cuenta de cualquier remitente. Gmail busca términos en el asunto,
      y aquí se descartan los que no tienen la frase completa en el asunto o no traen un PDF o una imagen.
    - ``filtro=remitentes``: búsqueda con ``from:`` y ``has:attachment``; se descartan los falsos positivos con la
      comparación exacta del remitente.
    - ``filtro=todos``: la carpeta sin filtro.
    """
    email = _cuenta_actual()
    config = configuracion.leer(email)
    reglas = config["remitentes"]
    # El filtro de documentos también toma lo que llega de los remitentes de las reglas de los tipos.
    reglas_tipos = tipos.remitentes(email) if filtro == "estados" else []
    firma = filtro_estados.firma_filtro(reglas_tipos) if filtro == "estados" else config["firma"]
    base = {"folder": folder, "filtro": filtro, "firmaFiltro": firma, "remitentes": len(reglas)}
    if filtro == "remitentes" and not reglas:
        # Sin remitentes no se consulta Gmail: la interfaz pide configurarlos o ver todos los correos.
        return {**base, "sinRemitentes": True, "messages": [], "nextPageToken": None, "descartados": 0, "count": 0}
    if filtro == "estados":
        query = filtro_estados.construir_query(folder, reglas_tipos)
    elif filtro == "remitentes":
        query = construir_query(folder, reglas)
    else:
        query = CONSULTAS_CARPETA[folder]
    try:
        pagina = gmail.list_messages(folder=folder, max_results=limit, page_token=pageToken, query=query)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except Exception as error:
        logger.exception("Gmail message listing failed for folder=%s", folder)
        raise HTTPException(status_code=502, detail=f"No se pudieron consultar los mensajes de Gmail: {error}") from error
    messages: list[dict[str, Any]] = []
    descartados = 0
    for message in pagina["messages"]:
        regla = coincide(message.get("senderEmail", ""), reglas)
        termino = filtro_estados.asunto_coincide(message.get("subject", ""))
        if filtro == "remitentes" and regla is None:
            descartados += 1  # Gmail lo devolvió (p. ej. por el nombre visible) pero la dirección no coincide.
            continue
        candidato = filtro_estados.es_candidato(message.get("subject", ""), message.get("senderEmail", ""), reglas_tipos)
        if filtro == "estados" and (not candidato or not filtro_estados.tiene_documento(message.get("attachments", []))):
            descartados += 1  # Gmail coincide por palabras sueltas; aquí se exige la frase completa y un PDF o imagen.
            continue
        messages.append({**message, "remitenteCoincide": regla is not None, "reglaRemitente": regla, "asuntoCoincide": termino is not None, "terminoAsunto": termino})
    return {**base, "sinRemitentes": False, "messages": messages, "nextPageToken": pagina["nextPageToken"], "descartados": descartados, "count": len(messages)}


@app.get("/api/gmail/messages/{message_id}")
def get_gmail_message(message_id: str) -> dict[str, Any]:
    try:
        return gmail.get_message(message_id)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo leer el mensaje: {error}") from error


@app.get("/api/gmail/messages/{message_id}/attachments/{attachment_id}")
def download_gmail_attachment(message_id: str, attachment_id: str) -> StreamingResponse:
    try:
        data, media_type, filename = gmail.attachment(message_id, attachment_id)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except GmailAttachmentError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo descargar el adjunto: {error}") from error
    try:
        disposicion = content_disposition(filename, media_type)
    except Exception:
        # Último recurso: un nombre que no se pudo procesar nunca debe producir un 500.
        logger.exception("No se pudo construir Content-Disposition para el adjunto %s", attachment_id)
        disposicion = content_disposition("", media_type)
    return StreamingResponse(
        iter([data]),
        media_type=media_type,
        headers={"Content-Disposition": disposicion},
    )


# --- Extracciones guardadas --------------------------------------------------------------------

def _cuenta_actual() -> str:
    """Email de la cuenta conectada, según el token del backend (nunca según datos del cliente)."""
    try:
        email = gmail.profile().get("email")
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail="Conecta Gmail para guardar o consultar extracciones.") from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except Exception as error:
        logger.exception("No se pudo identificar la cuenta de Gmail")
        raise HTTPException(status_code=502, detail=f"No se pudo identificar la cuenta de Gmail: {error}") from error
    if not email:
        raise HTTPException(status_code=503, detail="No se pudo identificar la cuenta de Gmail conectada.")
    return email


def _ids_validos(message_id: str, part_id: str) -> None:
    if not ID_DOCUMENTO_SEGURO.fullmatch(message_id) or not ID_DOCUMENTO_SEGURO.fullmatch(part_id):
        raise HTTPException(status_code=400, detail="Identificador de documento invalido.")


@app.get("/api/extracciones")
def listar_extracciones() -> dict[str, Any]:
    email = _cuenta_actual()
    return {"cuentaId": cuenta_id(email), "extracciones": almacen.listar(email)}


@app.get("/api/extracciones/{message_id}/{part_id}")
def obtener_extraccion(message_id: str, part_id: str) -> dict[str, Any]:
    _ids_validos(message_id, part_id)
    email = _cuenta_actual()
    try:
        documento = almacen.obtener(email, message_id, part_id)
    except ExtraccionDanada as error:
        logger.exception("Extraccion guardada danada")
        raise HTTPException(status_code=500, detail=str(error)) from error
    if documento is None:
        raise HTTPException(status_code=404, detail="Este documento no tiene una extraccion guardada.")
    # Campos de la configuración: los vinculados toman su nombre actual y los que faltan llegan vacíos. No se escribe
    # en disco; queda así cuando el usuario guarde.
    return aplicar_plantilla(documento, campos_del_documento(email, documento))


@app.put("/api/extracciones/{message_id}/{part_id}")
def guardar_extraccion(message_id: str, part_id: str, payload: GuardarExtraccionRequest) -> dict[str, Any]:
    _ids_validos(message_id, part_id)
    email = _cuenta_actual()
    try:
        documento = almacen.guardar(email, message_id, part_id, payload)
    except ConflictoVersion as conflicto:
        actual = conflicto.actual
        raise HTTPException(status_code=409, detail={
            "code": "conflicto_version",
            "message": "Otra pestaña o sesión guardó una versión más nueva de esta extracción." if actual else "La extracción guardada ya no existe.",
            "version_actual": None if actual is None else actual.get("version"),
            "actualizado": None if actual is None else actual.get("actualizado"),
        }) from conflicto
    except EnvioEnCurso as error:
        raise HTTPException(status_code=409, detail={"code": "envio_en_curso", "message": "Hay un envio a SaveData en curso para este documento; espera a que termine."}) from error
    except RevisionConProblemas as error:
        raise HTTPException(status_code=422, detail={
            "code": "revision_con_problemas",
            "message": str(error),
            "problemas": error.problemas,
        }) from error
    except ExtraccionDanada as error:
        logger.exception("Extraccion guardada danada")
        raise HTTPException(status_code=500, detail=str(error)) from error
    except OSError as error:
        logger.exception("No se pudo escribir la extraccion")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la extraccion en disco: {error}") from error
    logger.info("Extraccion guardada message_id=%s part_id=%s version=%s estado=%s", message_id, part_id, documento["version"], documento["estado"])
    return documento


# --- SaveData ----------------------------------------------------------------------------------

class VistaPreviaEnvioRequest(BaseModel):
    sucursal: int = Field(ge=1, le=999_999_999)
    articulo: str = Field(min_length=1, max_length=50)
    carga_inicial: bool = False


def _error_envio(error: NoSePuedeEnviar) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error), **error.detalle})


@app.get("/api/savedata/config")
def obtener_config_savedata() -> dict[str, Any]:
    return {**savedata_config.leer(), "url_configurada": bool(settings.savedata_url.strip()), "url": settings.savedata_url.strip() or None}


@app.put("/api/savedata/config")
def guardar_config_savedata(payload: SaveDataConfigRequest) -> dict[str, Any]:
    savedata_config.guardar(payload)
    return obtener_config_savedata()


class EliminarRequest(BaseModel):
    # Confirmación explícita del usuario: borra el registro en la base de datos de SaveData.
    confirmar: bool = False


@app.post("/api/extracciones/{message_id}/{part_id}/eliminar")
def eliminar_envio(message_id: str, part_id: str, payload: EliminarRequest) -> dict[str, Any]:
    """Pide a SaveData borrar el registro de este documento (mismo Id). El documento y su historial siguen en Nexora."""
    _ids_validos(message_id, part_id)
    if not payload.confirmar:
        raise HTTPException(status_code=400, detail={"code": "requiere_confirmar", "message": "Confirma que quieres eliminar el registro de SaveData."})
    email = _cuenta_actual()
    try:
        respuesta, intento, documento = eliminar_de_savedata(envios, email, message_id, part_id)
    except NoSePuedeEnviar as error:
        raise _error_envio(error) from error
    except EnvioEnCurso as error:
        raise HTTPException(status_code=409, detail={"code": "envio_en_curso", "message": "Ya hay un envio a SaveData en curso para este documento."}) from error
    except ExtraccionDanada as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    except OSError as error:
        logger.exception("No se pudo registrar la eliminacion en SaveData")
        raise HTTPException(status_code=500, detail=f"No se pudo registrar la eliminacion en disco: {error}") from error
    if respuesta.resultado not in {"exito", "no_existe"}:
        raise HTTPException(status_code=502, detail={
            "code": "savedata_incierto" if respuesta.resultado == "incierto" else "savedata_error",
            "message": respuesta.mensaje,
            "intento": intento,
            "extraccion": documento,
        })
    mensaje = "SaveData elimino el registro." if respuesta.resultado == "exito" else "SaveData ya no tenia el registro; queda como eliminado."
    return {"resultado": "eliminado", "mensaje": mensaje, "intento": intento, "extraccion": documento}


@app.get("/api/envios")
def listar_envios() -> dict[str, Any]:
    """Historial de todos los documentos enviados a SaveData, con lo que faltó en cada intento."""
    return {"documentos": historial_envios(almacen, _cuenta_actual())}


@app.post("/api/extracciones/{message_id}/{part_id}/enviar/vista-previa")
def vista_previa_envio(message_id: str, part_id: str, payload: VistaPreviaEnvioRequest) -> dict[str, Any]:
    """Cuerpo exacto que se enviaría a SaveData. No contacta SaveData."""
    _ids_validos(message_id, part_id)
    email = _cuenta_actual()
    try:
        return envios.vista_previa(email, message_id, part_id, sucursal=payload.sucursal, articulo=payload.articulo.strip(), carga_inicial=payload.carga_inicial)
    except NoSePuedeEnviar as error:
        raise _error_envio(error) from error
    except ExtraccionDanada as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/extracciones/{message_id}/{part_id}/enviar")
def enviar_extraccion(message_id: str, part_id: str, payload: EnvioRequest) -> dict[str, Any]:
    """Envía la extracción revisada a SaveData. Éxito solo con HTTP 200 y code 200; cualquier otro caso queda auditado."""
    _ids_validos(message_id, part_id)
    email = _cuenta_actual()
    try:
        respuesta, intento, documento = envios.enviar(email, message_id, part_id, payload)
    except NoSePuedeEnviar as error:
        raise _error_envio(error) from error
    except EnvioEnCurso as error:
        raise HTTPException(status_code=409, detail={"code": "envio_en_curso", "message": "Ya hay un envio a SaveData en curso para este documento."}) from error
    except ConflictoVersion as conflicto:
        actual = conflicto.actual
        raise HTTPException(status_code=409, detail={
            "code": "conflicto_version",
            "message": "La extraccion guardada cambio desde la vista previa; revisala antes de enviar.",
            "version_actual": None if actual is None else actual.get("version"),
        }) from conflicto
    except ExtraccionDanada as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    except OSError as error:
        logger.exception("No se pudo registrar el envio a SaveData")
        raise HTTPException(status_code=500, detail=f"No se pudo registrar el envio en disco: {error}") from error
    if respuesta.resultado == "no_existe":
        # 409: alguien borró el registro en SaveData. El usuario decide si agregarlo de nuevo (agregar_de_nuevo=true).
        raise HTTPException(status_code=409, detail={"code": "savedata_no_existe", "message": respuesta.mensaje, "intento": intento, "extraccion": documento})
    if respuesta.resultado != "exito":
        # 502: SaveData no confirmó el envío. El intento queda auditado y el documento sigue revisado.
        raise HTTPException(status_code=502, detail={
            "code": "savedata_incierto" if respuesta.resultado == "incierto" else "savedata_error",
            "message": respuesta.mensaje,
            "intento": intento,
            "extraccion": documento,
        })
    return {"resultado": "exito", "mensaje": respuesta.mensaje, "intento": intento, "extraccion": documento}



# --- Remitentes y clasificaciones manuales (por cuenta, en el backend) ---------------------------

@app.get("/api/configuracion/remitentes")
def obtener_remitentes() -> dict[str, Any]:
    return configuracion.leer(_cuenta_actual())


@app.put("/api/configuracion/remitentes")
def guardar_remitentes(payload: RemitentesRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        return configuracion.guardar_remitentes(email, payload.remitentes)
    except ListaRemitentesInvalida as error:
        raise HTTPException(status_code=422, detail={"code": "remitentes_invalidos", "message": "Revisa la lista de remitentes.", "errores": error.errores}) from error


@app.get("/api/clasificaciones")
def obtener_clasificaciones() -> dict[str, Any]:
    return clasificaciones.leer(_cuenta_actual())


@app.put("/api/clasificaciones/{message_id}")
def poner_clasificacion(message_id: str, payload: ClasificacionRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        return clasificaciones.poner(email, message_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.delete("/api/clasificaciones/{message_id}")
def quitar_clasificacion(message_id: str) -> dict[str, bool]:
    """Vuelve a la clasificación automática."""
    email = _cuenta_actual()
    try:
        clasificaciones.quitar(email, message_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"automatica": True}


@app.post("/api/clasificaciones/migrar")
def migrar_clasificaciones(payload: MigracionRequest) -> dict[str, Any]:
    """Migración única desde el navegador: no sobrescribe y un segundo intento no cambia nada."""
    email = _cuenta_actual()
    try:
        return clasificaciones.migrar(email, payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


# --- Extracción automática -----------------------------------------------------------------------

class AutomaticoRequest(BaseModel):
    activo: bool


@app.get("/api/automatico/estado")
def estado_automatico() -> dict[str, Any]:
    return automatico.estado(_cuenta_actual())


@app.put("/api/automatico")
def configurar_automatico(payload: AutomaticoRequest) -> dict[str, Any]:
    """Activa o pausa la extracción automática. La primera activación fija desde cuándo se procesan correos."""
    email = _cuenta_actual()
    try:
        return automatico.configurar(email, payload.activo)
    except OSError as error:
        logger.exception("No se pudo guardar el estado de la extraccion automatica")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la configuracion: {error}") from error


class EnvioAutomaticoRequest(BaseModel):
    envio_activo: bool
    solo_si_cuadra: bool = True


@app.put("/api/automatico/envio")
def configurar_envio_automatico(payload: EnvioAutomaticoRequest) -> dict[str, Any]:
    """Envío automático a SaveData de lo que extraiga el proceso automático. Encenderlo exige SAVEDATA_URL."""
    email = _cuenta_actual()
    try:
        return automatico.configurar_envio(email, payload.envio_activo, payload.solo_si_cuadra)
    except ValueError as error:
        raise HTTPException(status_code=409, detail={"code": "savedata_sin_configurar", "message": str(error)}) from error
    except OSError as error:
        logger.exception("No se pudo guardar la configuracion del envio automatico")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la configuracion: {error}") from error


@app.post("/api/automatico/revisar")
def revisar_automatico() -> dict[str, Any]:
    """"Revisar ahora": adelanta la siguiente revisión. Nunca envía nada a SaveData."""
    email = _cuenta_actual()
    if not automatico.revisar_ahora(email):
        raise HTTPException(status_code=409, detail={"code": "revision_en_curso", "message": "Ya hay una revision en curso."})
    return automatico.estado(email)


class AvisosLeidosRequest(BaseModel):
    # Sin ids se marcan todos.
    ids: list[str] | None = None


@app.post("/api/automatico/avisos/leidos")
def marcar_avisos_leidos(payload: AvisosLeidosRequest) -> dict[str, Any]:
    """Marca como leídos los avisos de la extracción automática (campanita)."""
    email = _cuenta_actual()
    try:
        return automatico.marcar_avisos_leidos(email, payload.ids)
    except OSError as error:
        logger.exception("No se pudieron marcar los avisos")
        raise HTTPException(status_code=500, detail=f"No se pudieron marcar los avisos: {error}") from error


# --- Configuración de campos (se define una vez por cuenta) --------------------------------------

MAX_ARCHIVO_EJEMPLO = 20 * 1024 * 1024


@app.get("/api/configuracion/campos")
def obtener_campos_configurados() -> dict[str, Any]:
    return plantillas.leer(_cuenta_actual())


@app.put("/api/configuracion/campos")
def guardar_campos_configurados(payload: PlantillaRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        return plantillas.guardar(email, payload)
    except OSError as error:
        logger.exception("No se pudo guardar la configuracion de campos")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar la configuracion de campos: {error}") from error


@app.post("/api/configuracion/campos/sugerir")
async def sugerir_campos(request: Request, filename: str = Query("ejemplo.pdf", max_length=255), tipo: str = Query("", max_length=100)) -> dict[str, Any]:
    """Sugerencias de campos a partir de un estado de cuenta de ejemplo (PDF o imagen) enviado como cuerpo binario.

    Se reutilizan las sugerencias de la extracción (las mismas de "+ Campo"); la IA nunca inventa campos. El archivo
    solo vive en memoria durante la petición: no se escribe en disco ni se envía a SaveData.
    """
    await run_in_threadpool(_cuenta_actual)
    declarado = request.headers.get("content-length")
    if declarado and declarado.isdigit() and int(declarado) > MAX_ARCHIVO_EJEMPLO:
        raise HTTPException(status_code=413, detail="El archivo de ejemplo admite hasta 20 MB.")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=422, detail="Elige un estado de cuenta de ejemplo (PDF o imagen).")
    if len(data) > MAX_ARCHIVO_EJEMPLO:
        raise HTTPException(status_code=413, detail="El archivo de ejemplo admite hasta 20 MB.")
    media_type = (tipo or request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip().lower()
    try:
        resultado = await run_in_threadpool(gemini.extract_document, data, media_type, filename)
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except GeminiRequestError as error:
        raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error), "retryable": error.retryable}) from error
    except Exception as error:
        logger.exception("No se pudieron sugerir campos del archivo de ejemplo")
        raise HTTPException(status_code=502, detail=f"No se pudo leer el archivo de ejemplo: {error}") from error
    return {"sugerencias": sugerencias_para_configurar(resultado)}


# --- Tipos de documento ---------------------------------------------------------------------------

def _conteos(email: str) -> tuple[dict[str, int], dict[str, int]]:
    por_tipo: dict[str, int] = {}
    por_estructura: dict[str, int] = {}
    for entrada in almacen.listar(email):
        tipo_documento = entrada.get("tipo_documento") or {"tipo_id": TIPO_EC_ID}
        if tipo_documento.get("tipo_id"):
            por_tipo[tipo_documento["tipo_id"]] = por_tipo.get(tipo_documento["tipo_id"], 0) + 1
        if tipo_documento.get("estructura_id"):
            por_estructura[tipo_documento["estructura_id"]] = por_estructura.get(tipo_documento["estructura_id"], 0) + 1
    return por_tipo, por_estructura


DIAS_RESUMEN = 30


def _documentos_con_envio(email: str) -> list[dict[str, Any]]:
    """Documentos guardados con su tipo y su estado de envío (etiqueta y motivo), más recientes primero."""
    ec = tipos.obtener(email, TIPO_EC_ID) or {}
    try:
        registro = automatico.registro_adjuntos(email)
    except Exception:
        logger.exception("No se pudo leer el registro del proceso automatico")
        registro = {}
    documentos = []
    for entrada in almacen.listar(email):
        tipo_documento = entrada.get("tipo_documento") or {
            "tipo_id": TIPO_EC_ID, "codigo": ec.get("codigo"), "nombre": ec.get("nombre"), "color": ec.get("color"), "contable": True,
            "metodo": None, "confianza": None, "requiere_revision": False, "motivo": None,
        }
        try:
            completo = almacen.leer_completo(email, entrada["messageId"], entrada["partId"]) or {}
        except Exception:
            completo = {}
        clave = f"{entrada['messageId']}__{entrada['partId']}"
        documentos.append({**entrada, "tipo_documento": tipo_documento, "estado_envio": estado_envio({**completo, "tipo_documento": tipo_documento}, registro.get(clave))})
    documentos.sort(key=lambda item: item.get("creado") or item.get("actualizado") or "", reverse=True)
    return documentos


def _resumen_por_tipo(documentos: list[dict[str, Any]], dias: int = DIAS_RESUMEN, ahora: datetime | None = None) -> dict[str, dict[str, int]]:
    """Últimos ``dias`` días por tipo: recibidos, enviados (automáticamente, al configurar, a mano), pendientes,
    no enviados (requieren revisión) y con error."""
    desde = (ahora or datetime.now(timezone.utc)) - timedelta(days=dias)
    resumen: dict[str, dict[str, int]] = {}
    for documento in documentos:
        try:
            fecha = datetime.fromisoformat(str(documento.get("creado") or documento.get("actualizado") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if fecha.tzinfo is None:
            fecha = fecha.replace(tzinfo=timezone.utc)
        if fecha < desde or (ahora is not None and fecha > ahora):
            continue
        cuenta = resumen.setdefault(documento["tipo_documento"].get("tipo_id") or "", {
            "recibidos": 0, "enviados_automatico": 0, "enviados_configurar": 0, "enviados_manual": 0, "pendientes": 0, "no_enviados": 0, "con_error": 0})
        cuenta["recibidos"] += 1
        envio = documento["estado_envio"]
        if envio["estado"] == "enviado":
            cuenta[f"enviados_{envio.get('origen') or 'manual'}"] += 1
        else:
            cuenta[envio["filtro"]] += 1
    return resumen


def _tipos_publicos(email: str) -> dict[str, Any]:
    por_tipo, por_estructura = _conteos(email)
    resumen = _resumen_por_tipo(_documentos_con_envio(email))
    vacio = {"recibidos": 0, "enviados_automatico": 0, "enviados_configurar": 0, "enviados_manual": 0, "pendientes": 0, "no_enviados": 0, "con_error": 0}
    lista = [{
        **tipo,
        "documentos": por_tipo.get(tipo["id"], 0),
        "estructuras": [{**estructura, "documentos": por_estructura.get(estructura["id"], 0)} for estructura in tipo.get("estructuras") or []],
        "resumen_envios": {"dias": DIAS_RESUMEN, **(resumen.get(tipo["id"]) or vacio)},
    } for tipo in tipos.leer(email)]
    return {"tipos": lista, "umbral_confianza": UMBRAL_CONFIANZA}


def _error_tipos(error: Exception) -> HTTPException:
    if isinstance(error, KeyError):
        return HTTPException(status_code=404, detail="El tipo o la estructura no existe.")
    return HTTPException(status_code=409, detail={"code": "conflicto_tipos", "message": str(error)})


@app.get("/api/tipos")
def listar_tipos() -> dict[str, Any]:
    return _tipos_publicos(_cuenta_actual())


@app.post("/api/tipos")
def crear_tipo(payload: TipoRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        tipo = tipos.guardar_tipo(email, payload)
    except ConflictoTipos as error:
        raise _error_tipos(error) from error
    return {"tipo": tipo, **_tipos_publicos(email)}


@app.put("/api/tipos/{tipo_id}")
def editar_tipo(tipo_id: str, payload: TipoRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        tipo = tipos.guardar_tipo(email, payload, tipo_id)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    return {"tipo": tipo, **_tipos_publicos(email)}


@app.post("/api/tipos/{tipo_id}/estructuras")
def crear_estructura(tipo_id: str, payload: EstructuraRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        tipos.guardar_estructura(email, tipo_id, payload)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    return _tipos_publicos(email)


@app.put("/api/tipos/{tipo_id}/estructuras/{estructura_id}")
def editar_estructura(tipo_id: str, estructura_id: str, payload: EstructuraRequest) -> dict[str, Any]:
    email = _cuenta_actual()
    try:
        tipos.guardar_estructura(email, tipo_id, payload, estructura_id)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    return _tipos_publicos(email)


@app.post("/api/tipos/{tipo_id}/restaurar-plantilla")
def restaurar_plantilla(tipo_id: str) -> dict[str, Any]:
    """Restaurar campos predeterminados: agrega los campos de la plantilla que falten, sin borrar ni renombrar."""
    email = _cuenta_actual()
    try:
        tipo, agregados = tipos.restaurar_plantilla(email, tipo_id)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    return {"tipo": tipo, "agregados": agregados, **_tipos_publicos(email)}


class SugerenciaEstructuraRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    aseguradora: str = Field(min_length=1, max_length=120)
    clave: str = Field(min_length=1, max_length=200)


@app.post("/api/tipos/{tipo_id}/sugerencias/{accion}")
def resolver_sugerencia_estructura(tipo_id: str, accion: str, payload: SugerenciaEstructuraRequest) -> dict[str, Any]:
    """Aviso de estructura: "agregar" pone el dato en el tipo; "ignorar" no lo vuelve a sugerir para esa aseguradora."""
    if accion not in ("agregar", "ignorar"):
        raise HTTPException(status_code=404, detail="Acción desconocida.")
    email = _cuenta_actual()
    try:
        tipo = tipos.resolver_sugerencia(email, tipo_id, payload.aseguradora, payload.clave, accion)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"tipo": tipo, **_tipos_publicos(email)}


@app.get("/api/tipos/documentos")
def documentos_recibidos(limit: int = Query(50, ge=1, le=200)) -> dict[str, Any]:
    """Últimos documentos guardados con su tipo detectado, cómo se detectó y su estado (más recientes primero)."""
    email = _cuenta_actual()
    # Cada documento trae su estado de envío ("Enviado automáticamente", "Pendiente de envío…", "No se envió: …").
    return {"documentos": _documentos_con_envio(email)[:limit], "umbral_confianza": UMBRAL_CONFIANZA}


class SugerirTipoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    messageId: str = Field(min_length=1, max_length=200)
    attachmentId: str = Field(min_length=1, max_length=4000)
    nombre_tipo: str = Field(default="Documento", max_length=80)
    seccion: str | None = Field(default=None, max_length=60)
    # Campos que ya tiene el tipo (su plantilla): la IA los busca y solo sugiere los que no estén.
    campos: list[str] = Field(default_factory=list, max_length=30)


@app.post("/api/tipos/sugerir")
def sugerir_campos_tipo(payload: SugerirTipoRequest) -> dict[str, Any]:
    """La IA lee el documento y propone campos con un ejemplo de su valor y si van "Una vez" o en la sección."""
    _cuenta_actual()
    try:
        data, media_type, filename = gmail.attachment(payload.messageId, payload.attachmentId)
        resultado = gemini.extract_document(data, media_type, filename, campos_solicitados=payload.campos, tipo={"nombre": payload.nombre_tipo or "Documento", "seccion": payload.seccion or ""})
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except GmailRateLimitError as error:
        raise _rate_limited(error) from error
    except GmailAttachmentError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except GeminiUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except GeminiRequestError as error:
        raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error), "retryable": error.retryable}) from error
    ya = {comparable(nombre) for nombre in payload.campos}
    sugerencias = [item for item in sugerencias_para_configurar(resultado) if comparable(item["nombre"]) not in ya]
    return {"sugerencias": sugerencias, "aseguradora": resultado.get("aseguradora") or None}


class TipoNuevoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    nombre: str = Field(min_length=1, max_length=80)
    codigo: str = Field(min_length=1, max_length=5)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    seccion: str | None = Field(default=None, max_length=60)


class ReglasDocumentoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    remitente: str | None = Field(default=None, max_length=254)
    aseguradora: str | None = Field(default=None, max_length=120)


class ConfigurarDocumentoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    messageId: str = Field(min_length=1, max_length=200)
    partId: str = Field(min_length=1, max_length=200)
    attachmentId: str | None = Field(default=None, max_length=4000)
    # Paso 1: un tipo existente o uno nuevo.
    tipo_id: str | None = Field(default=None, max_length=64)
    nuevo: TipoNuevoRequest | None = None
    # Paso 2: reglas para reconocerlo la próxima vez; la estructura toma el nombre de la aseguradora.
    reglas: ReglasDocumentoRequest = Field(default_factory=ReglasDocumentoRequest)
    nombre_estructura: str | None = Field(default=None, max_length=120)
    # Paso 3: la lista final de campos del tipo.
    campos: list[CampoPlantilla] = Field(default_factory=list, max_length=30)
    extraer_y_enviar: bool = False


@app.post("/api/tipos/configurar-documento")
def configurar_con_documento(payload: ConfigurarDocumentoRequest) -> dict[str, Any]:
    """Crea o actualiza el tipo, agrega las reglas a su estructura y guarda los campos. Con ``extraer_y_enviar``
    vuelve a extraer el documento con la configuración nueva y lo envía a SaveData; si no, solo le asigna el tipo."""
    _ids_validos(payload.messageId, payload.partId)
    email = _cuenta_actual()
    try:
        if payload.nuevo is not None:
            seccion = {"nombre": payload.nuevo.seccion} if payload.nuevo.seccion and payload.nuevo.seccion.strip() else None
            campos = payload.campos if seccion else [campo.model_copy(update={"alcance": "documento"}) for campo in payload.campos]
            tipo = tipos.guardar_tipo(email, TipoRequest(nombre=payload.nuevo.nombre, codigo=payload.nuevo.codigo, color=payload.nuevo.color or tipos.color_libre(email), seccion=seccion, campos=campos))
        else:
            actual = tipos.obtener(email, payload.tipo_id)
            if actual is None:
                raise KeyError(payload.tipo_id)
            tipo = tipos.guardar_tipo(email, TipoRequest(nombre=actual["nombre"], codigo=actual["codigo"], color=actual.get("color") or "#7c3aed", seccion=actual.get("seccion"), campos=payload.campos), actual["id"])
        remitente = payload.reglas.remitente.strip().lower() if payload.reglas.remitente else None
        aseguradora = (payload.reglas.aseguradora or "").strip() or None
        nombre_estructura = (payload.nombre_estructura or aseguradora or (remitente.split("@", 1)[-1] if remitente else "") or "Predeterminada").strip()
        estructura = tipos.agregar_reglas(email, tipo["id"], nombre_estructura=nombre_estructura, remitente=remitente, aseguradora=aseguradora)
    except (ConflictoTipos, KeyError) as error:
        raise _error_tipos(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    tipo = tipos.obtener(email, tipo["id"]) or tipo
    resultado: dict[str, Any] = {"tipo": tipo, "estructura": estructura, "documento": None, "envio": None, "motivos": [], "mensaje": None}
    if payload.extraer_y_enviar:
        try:
            resultado.update(automatico.reprocesar(email, payload.messageId, payload.partId, tipo["id"], attachment_id=payload.attachmentId, enviar=True))
        except GmailNotConnectedError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        except GmailRateLimitError as error:
            raise _rate_limited(error) from error
        except GeminiUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except GeminiRequestError as error:
            raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": str(error), "retryable": error.retryable}) from error
        except (ConflictoVersion, EnvioEnCurso) as error:
            raise HTTPException(status_code=409, detail="El documento cambió o se está enviando; vuelve a intentarlo.") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    else:
        resultado["documento"] = _asignar_tipo(email, payload.messageId, payload.partId, tipo, estructura)
    return {**resultado, **_tipos_publicos(email)}


def _asignar_tipo(email: str, message_id: str, part_id: str, tipo: dict[str, Any], estructura: dict[str, Any] | None) -> dict[str, Any] | None:
    """Asigna el tipo elegido a la extracción guardada (sin volver a extraer): deja de pedir configuración."""
    def cambio(documento: dict[str, Any] | None) -> dict[str, Any]:
        if documento is None:
            raise KeyError("sin_documento")
        anterior = documento.get("tipo_documento") or {}
        deteccion = deteccion_manual(tipo, anterior.get("aseguradora") or "")
        if estructura is not None:
            deteccion.update(estructura_id=estructura["id"], estructura=estructura["nombre"], estructura_version=estructura.get("version"))
        deteccion["remitente"] = anterior.get("remitente")
        return {**documento, "tipo_documento": deteccion, "version": int(documento.get("version") or 0) + 1, "actualizado": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    try:
        return almacen.actualizar(email, message_id, part_id, cambio)
    except KeyError:
        return None
