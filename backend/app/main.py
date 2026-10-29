from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse

from .config import settings
from .gmail import GmailClient, GmailNotConfiguredError, GmailNotConnectedError


app = FastAPI(title="Nexora API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gmail = GmailClient()
oauth_states: dict[str, datetime] = {}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "nexora-api"}


@app.get("/api/auth/gmail/start")
def start_gmail_auth() -> RedirectResponse:
    try:
        authorization_url, state = gmail.authorization_url()
    except GmailNotConfiguredError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    oauth_states[state] = datetime.now(timezone.utc) + timedelta(minutes=10)
    return RedirectResponse(authorization_url)


@app.get("/api/auth/callback/google")
def gmail_callback(code: str | None = None, state: str | None = None, error: str | None = None) -> RedirectResponse:
    if error:
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError={error}")
    if not code or not state or state not in oauth_states:
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_state_invalid")
    if oauth_states.pop(state) < datetime.now(timezone.utc):
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_state_expired")
    try:
        gmail.complete_authorization(code, state)
    except Exception:
        return RedirectResponse(f"{settings.frontend_url}/settings?gmailError=oauth_exchange_failed")
    return RedirectResponse(f"{settings.frontend_url}/settings?gmail=connected")


@app.get("/api/gmail/status")
def gmail_status() -> dict[str, Any]:
    try:
        profile = gmail.profile()
        return {"connected": True, "provider": "gmail", **profile}
    except GmailNotConnectedError:
        return {"connected": False, "provider": "gmail", "email": None}
    except Exception as error:
        return {"connected": False, "provider": "gmail", "email": None, "error": str(error)}


@app.post("/api/gmail/disconnect")
def disconnect_gmail() -> dict[str, bool]:
    gmail.disconnect()
    return {"connected": False}


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
        data, media_type = gmail.attachment(message_id, attachment_id)
    except GmailNotConnectedError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"No se pudo descargar el adjunto: {error}") from error
    return StreamingResponse(iter([data]), media_type=media_type)
