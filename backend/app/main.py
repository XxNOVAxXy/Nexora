from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import settings
from .gemini import GeminiRequestError, GeminiSettings, GeminiUnavailableError
from .gmail import GmailAttachmentError, GmailClient, GmailNotConfiguredError, GmailNotConnectedError


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
oauth_states: dict[str, datetime] = {}


class GeminiConfigRequest(BaseModel):
    apiKey: str | None = Field(default=None, min_length=10)
    model: str = Field(min_length=1)


class GeminiExtractionRequest(BaseModel):
    messageId: str = Field(min_length=1)
    attachmentId: str = Field(min_length=1)


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
        return {"connected": True, "provider": "gmail", **profile}
    except GmailNotConnectedError:
        return {"connected": False, "provider": "gmail", "email": None}
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
        result = gemini.extract_document(data, media_type, filename)
        logger.info(
            "Gemini extraction result attachment_id=%s result=success transactions=%d balance_consistent=%s",
            payload.attachmentId,
            len(result.get("transactions", [])),
            result.get("balanceValidation", {}).get("consistent"),
        )
        return result
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
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
) -> dict[str, Any]:
    try:
        messages = gmail.list_messages(folder=folder, max_results=limit)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except Exception as error:
        logger.exception("Gmail message listing failed for folder=%s", folder)
        raise HTTPException(status_code=502, detail=f"No se pudieron consultar los mensajes de Gmail: {error}") from error
    return {"folder": folder, "messages": messages, "count": len(messages)}


@app.get("/api/gmail/messages/{message_id}")
def get_gmail_message(message_id: str) -> dict[str, Any]:
    try:
        return gmail.get_message(message_id)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo leer el mensaje: {error}") from error


@app.get("/api/gmail/messages/{message_id}/attachments/{attachment_id}")
def download_gmail_attachment(message_id: str, attachment_id: str) -> StreamingResponse:
    try:
        data, media_type, filename = gmail.attachment(message_id, attachment_id)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo descargar el adjunto: {error}") from error
    return StreamingResponse(
        iter([data]),
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )
