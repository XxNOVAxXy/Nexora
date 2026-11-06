from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import settings
from .preferencias import AlmacenClasificaciones, ClasificacionRequest, ConfiguracionCuenta, MigracionRequest, RemitentesRequest
from .remitentes import CONSULTAS_CARPETA, ListaRemitentesInvalida, coincide, construir_query
from .savedata import EnvioRequest, NoSePuedeEnviar, SaveDataConfig, SaveDataConfigRequest, ServicioEnvio
from .extracciones import ID_DOCUMENTO_SEGURO, AlmacenExtracciones, ConflictoVersion, EnvioEnCurso, ExtraccionDanada, GuardarExtraccionRequest, RevisionConProblemas, cuenta_id
from .gemini import GeminiRequestError, GeminiSettings, GeminiUnavailableError
from .gmail import GmailAttachmentError, GmailClient, GmailNotConfiguredError, GmailNotConnectedError, GmailRateLimitError


logger = logging.getLogger("nexora.gmail")
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")
app = FastAPI(title="Nexora API", version="0.1.0")
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
# La URL se lee en cada envío para que las pruebas puedan sustituirla.
envios = ServicioEnvio(almacen, lambda: settings.savedata_url)
oauth_states: dict[str, datetime] = {}


def _rate_limited(error: GmailRateLimitError) -> HTTPException:
    return HTTPException(status_code=429, detail=str(error), headers={"Retry-After": "60"})


class GeminiConfigRequest(BaseModel):
    apiKey: str | None = Field(default=None, min_length=10)
    model: str = Field(min_length=1)


class GeminiExtractionRequest(BaseModel):
    messageId: str = Field(min_length=1)
    attachmentId: str = Field(min_length=1)
    # True al re-extraer: ignora la cache de Gemini y reemplaza su entrada.
    forzar: bool = False


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
    logger.info("Gemini configuration saved with model=%s", payload.model)
    return gemini.save(payload.apiKey, payload.model)


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
        result = gemini.extract_document(data, media_type, filename, forzar=payload.forzar)
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


@app.get("/api/gmail/messages")
def list_gmail_messages(
    folder: str = Query("inbox", pattern="^(inbox|sent|archive|trash)$"),
    limit: int = Query(25, ge=1, le=50),
    filtro: str = Query("remitentes", pattern="^(remitentes|todos)$"),
    pageToken: str | None = Query(None, max_length=500, pattern=r"^[A-Za-z0-9_-]+$"),
) -> dict[str, Any]:
    """Una página de correos. Con ``filtro=remitentes`` la búsqueda se hace en Gmail con ``from:`` y
    ``has:attachment``; después se descartan los falsos positivos con la comparación exacta del remitente."""
    email = _cuenta_actual()
    config = configuracion.leer(email)
    reglas = config["remitentes"]
    base = {"folder": folder, "filtro": filtro, "firmaFiltro": config["firma"], "remitentes": len(reglas)}
    if filtro == "remitentes" and not reglas:
        # Sin remitentes no se consulta Gmail: la interfaz pide configurarlos o ver todos los correos.
        return {**base, "sinRemitentes": True, "messages": [], "nextPageToken": None, "descartados": 0, "count": 0}
    query = construir_query(folder, reglas) if filtro == "remitentes" else CONSULTAS_CARPETA[folder]
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
        if filtro == "remitentes" and regla is None:
            descartados += 1  # Gmail lo devolvió (p. ej. por el nombre visible) pero la dirección no coincide.
            continue
        messages.append({**message, "remitenteCoincide": regla is not None, "reglaRemitente": regla})
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
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo descargar el adjunto: {error}") from error
    return StreamingResponse(
        iter([data]),
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
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
    return documento


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
