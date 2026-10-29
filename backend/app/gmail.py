from __future__ import annotations

import base64
import binascii
import html
import re
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import Resource, build

from .config import settings


GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


class GmailNotConfiguredError(RuntimeError):
    pass


class GmailNotConnectedError(RuntimeError):
    pass


def _client_config() -> dict[str, Any]:
    if not settings.google_client_id or not settings.google_client_secret:
        raise GmailNotConfiguredError(
            "GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET no están configurados."
        )
    return {
        "web": {
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [settings.google_redirect_uri],
        }
    }


class GmailClient:
    def __init__(self, token_path: Path | None = None) -> None:
        self.token_path = token_path or settings.token_path

    def create_flow(self, state: str | None = None) -> Flow:
        flow = Flow.from_client_config(
            _client_config(), scopes=GMAIL_SCOPES, state=state
        )
        flow.redirect_uri = settings.google_redirect_uri
        return flow

    def authorization_url(self) -> tuple[str, str]:
        flow = self.create_flow()
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )
        return authorization_url, state

    def complete_authorization(self, code: str, state: str) -> None:
        flow = self.create_flow(state=state)
        flow.fetch_token(code=code)
        self._save_credentials(flow.credentials)

    def disconnect(self) -> None:
        if self.token_path.exists():
            self.token_path.unlink()

    def credentials(self) -> Credentials:
        if not self.token_path.exists():
            raise GmailNotConnectedError("La cuenta de Gmail no está conectada.")

        credentials = Credentials.from_authorized_user_file(
            str(self.token_path), GMAIL_SCOPES
        )
        if credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
            self._save_credentials(credentials)
        if not credentials.valid:
            raise GmailNotConnectedError(
                "La sesión de Gmail expiró. Vuelve a conectar la cuenta."
            )
        return credentials

    def service(self) -> Resource:
        return build(
            "gmail",
            "v1",
            credentials=self.credentials(),
            cache_discovery=False,
        )

    def profile(self) -> dict[str, Any]:
        response = self.service().users().getProfile(userId="me").execute()
        return {
            "email": response.get("emailAddress"),
            "messagesTotal": response.get("messagesTotal", 0),
            "threadsTotal": response.get("threadsTotal", 0),
        }

    def list_messages(self, folder: str, max_results: int = 25) -> list[dict[str, Any]]:
        service = self.service()
        query = {
            "inbox": "in:inbox",
            "sent": "in:sent",
            "archive": "-in:inbox -in:sent -in:trash",
            "trash": "in:trash",
        }.get(folder, "in:inbox")
        response = (
            service.users()
            .messages()
            .list(userId="me", q=query, maxResults=min(max_results, 50))
            .execute()
        )
        messages = []
        for message in response.get("messages", []):
            raw_message = (
                service.users()
                .messages()
                .get(userId="me", id=message["id"], format="full")
                .execute()
            )
            messages.append(self._serialize_message(raw_message))
        return messages

    def get_message(self, message_id: str) -> dict[str, Any]:
        raw_message = (
            self.service()
            .users()
            .messages()
            .get(userId="me", id=message_id, format="full")
            .execute()
        )
        return self._serialize_message(raw_message)

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str]:
        response = (
            self.service()
            .users()
            .messages()
            .attachments()
            .get(userId="me", messageId=message_id, id=attachment_id)
            .execute()
        )
        data = response.get("data", "")
        try:
            return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)), "application/octet-stream"
        except (binascii.Error, ValueError) as error:
            raise GmailNotConnectedError("Gmail devolvió un adjunto inválido.") from error

    def _save_credentials(self, credentials: Credentials) -> None:
        self.token_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text(credentials.to_json(), encoding="utf-8")

    def _serialize_message(self, raw: dict[str, Any]) -> dict[str, Any]:
        payload = raw.get("payload", {})
        headers = {
            item.get("name", "").lower(): item.get("value", "")
            for item in payload.get("headers", [])
        }
        sender_name, sender_email = parseaddr(headers.get("from", ""))
        return {
            "id": raw.get("id"),
            "threadId": raw.get("threadId"),
            "sender": sender_name or sender_email or "Remitente desconocido",
            "senderEmail": sender_email,
            "to": headers.get("to", ""),
            "subject": headers.get("subject", "(Sin asunto)"),
            "snippet": raw.get("snippet", ""),
            "body": _plain_text(payload),
            "receivedAt": _received_at(raw.get("internalDate")),
            "unread": "UNREAD" in raw.get("labelIds", []),
            "attachments": _attachments(payload),
            "labels": raw.get("labelIds", []),
        }


def _received_at(timestamp: str | None) -> str | None:
    if not timestamp:
        return None
    return datetime.fromtimestamp(int(timestamp) / 1000, tz=timezone.utc).isoformat()


def _decode_body(data: str | None) -> str:
    if not data:
        return ""
    try:
        decoded = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        return decoded.decode("utf-8", errors="replace")
    except (binascii.Error, UnicodeDecodeError):
        return ""


def _plain_text(payload: dict[str, Any]) -> str:
    candidates: list[tuple[str, str]] = []

    def collect(part: dict[str, Any]) -> None:
        mime_type = part.get("mimeType", "")
        body = _decode_body(part.get("body", {}).get("data"))
        if body:
            candidates.append((mime_type, body))
        for child in part.get("parts", []):
            collect(child)

    collect(payload)
    plain = next((body for mime, body in candidates if mime == "text/plain"), "")
    if plain:
        return plain.strip()
    html_body = next((body for mime, body in candidates if mime == "text/html"), "")
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", html_body))).strip()


def _attachments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []

    def collect(part: dict[str, Any]) -> None:
        filename = part.get("filename")
        body = part.get("body", {})
        if filename and body.get("attachmentId"):
            result.append(
                {
                    "id": body["attachmentId"],
                    "filename": filename,
                    "mimeType": part.get("mimeType", "application/octet-stream"),
                    "size": body.get("size", 0),
                }
            )
        for child in part.get("parts", []):
            collect(child)

    collect(payload)
    return result
