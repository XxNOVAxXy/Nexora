from __future__ import annotations

import base64
import binascii
import html
import mimetypes
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from email.utils import parseaddr
import logging
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

from .config import settings


logger = logging.getLogger("nexora.gmail")
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
# googleapiclient retries 429 and 403 rateLimitExceeded/userRateLimitExceeded with exponential backoff.
GMAIL_NUM_RETRIES = 3
RATE_LIMIT_REASONS = {"rateLimitExceeded", "userRateLimitExceeded"}
PROFILE_TTL_SECONDS = 60
MESSAGE_CACHE_ITEMS = 500
ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024


class GmailNotConfiguredError(RuntimeError):
    pass


class GmailNotConnectedError(RuntimeError):
    pass


class GmailAttachmentError(RuntimeError):
    pass


class GmailRateLimitError(RuntimeError):
    pass


def _is_rate_limited(error: HttpError) -> bool:
    status = getattr(error.resp, "status", None)
    if status == 429:
        return True
    if status != 403:
        return False
    details = error.error_details if isinstance(error.error_details, list) else []
    reasons = {detail.get("reason") for detail in details if isinstance(detail, dict)}
    return bool(reasons & RATE_LIMIT_REASONS) or "Quota exceeded" in str(error)


def _execute(request: Any) -> Any:
    try:
        return request.execute(num_retries=GMAIL_NUM_RETRIES)
    except HttpError as error:
        if _is_rate_limited(error):
            logger.warning("Gmail rate limit reached after retries: %s", error)
            raise GmailRateLimitError(
                "Gmail está limitando las consultas de esta cuenta. Espera un minuto e inténtalo de nuevo."
            ) from error
        raise


class _LruCache:
    """Thread-safe LRU bounded by item count and/or total size."""

    def __init__(self, max_items: int | None = None, max_bytes: int | None = None) -> None:
        self._items: OrderedDict[Any, tuple[Any, int]] = OrderedDict()
        self._max_items = max_items
        self._max_bytes = max_bytes
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key: Any) -> Any:
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return None
            self._items.move_to_end(key)
            return entry[0]

    def put(self, key: Any, value: Any, size: int = 0) -> None:
        with self._lock:
            if key in self._items:
                self._bytes -= self._items.pop(key)[1]
            self._items[key] = (value, size)
            self._bytes += size
            while self._items and (
                (self._max_items is not None and len(self._items) > self._max_items)
                or (self._max_bytes is not None and self._bytes > self._max_bytes)
            ):
                _, (_, evicted_size) = self._items.popitem(last=False)
                self._bytes -= evicted_size

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._bytes = 0


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
        self._messages = _LruCache(max_items=MESSAGE_CACHE_ITEMS)
        self._attachments = _LruCache(max_bytes=ATTACHMENT_CACHE_BYTES)
        self._profile: tuple[float, dict[str, Any]] | None = None
        self._cache_lock = threading.Lock()
        # Striped locks so concurrent requests for the same message/attachment hit Gmail once.
        self._stripes = [threading.Lock() for _ in range(64)]

    def create_flow(self, state: str | None = None) -> Flow:
        flow = Flow.from_client_config(
            _client_config(),
            scopes=GMAIL_SCOPES,
            state=state,
            # This is a confidential web client; do not generate a verifier
            # that would need to be persisted between the two OAuth requests.
            autogenerate_code_verifier=False,
        )
        flow.redirect_uri = settings.google_redirect_uri
        return flow

    def authorization_url(self) -> tuple[str, str]:
        flow = self.create_flow()
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="select_account consent",
        )
        return authorization_url, state

    def complete_authorization(self, code: str, state: str) -> None:
        flow = self.create_flow(state=state)
        flow.fetch_token(code=code)
        self._save_credentials(flow.credentials)
        self.clear_cache()

    def disconnect(self) -> None:
        if self.token_path.exists():
            self.token_path.unlink()
        self.clear_cache()

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
        with self._cache_lock:
            if self._profile and time.monotonic() - self._profile[0] < PROFILE_TTL_SECONDS:
                return self._profile[1]
        try:
            response = _execute(self.service().users().getProfile(userId="me"))
        except GmailRateLimitError:
            # Prefer a slightly stale profile over reporting the account as disconnected.
            with self._cache_lock:
                if self._profile:
                    return self._profile[1]
            raise
        profile = {
            "email": response.get("emailAddress"),
            "messagesTotal": response.get("messagesTotal", 0),
            "threadsTotal": response.get("threadsTotal", 0),
        }
        with self._cache_lock:
            self._profile = (time.monotonic(), profile)
        return profile

    def list_messages(self, folder: str, max_results: int = 25) -> list[dict[str, Any]]:
        """List a folder spending ~10 quota units once its messages are cached.

        Message content never changes, so each message is fetched once (5 units) and reused.
        The UNREAD flag does change, so it is refreshed with a second id-only listing
        restricted to ``is:unread``: any unread message among the newest ``limit`` has
        at most ``limit - 1`` newer unread messages, so the same limit is exact.
        """
        service = self.service()
        query = {
            "inbox": "in:inbox",
            "sent": "in:sent",
            "archive": "-in:inbox -in:sent -in:trash",
            "trash": "in:trash",
        }.get(folder, "in:inbox")
        limit = min(max_results, 50)
        listing = _execute(service.users().messages().list(userId="me", q=query, maxResults=limit))
        message_ids = [item["id"] for item in listing.get("messages", [])]
        if not message_ids:
            return []
        unread_listing = _execute(
            service.users().messages().list(userId="me", q=f"{query} is:unread", maxResults=limit)
        )
        unread_ids = {item["id"] for item in unread_listing.get("messages", [])}
        return [
            _with_unread(self._message(service, message_id), message_id in unread_ids)
            for message_id in message_ids
        ]

    def get_message(self, message_id: str) -> dict[str, Any]:
        return self._message(self.service(), message_id)

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        key = (message_id, attachment_id)
        cached = self._attachments.get(key)
        if cached is not None:
            return cached
        service = self.service()
        # Resolved before taking the attachment lock so the two lock kinds never nest.
        message = self._message(service, message_id)
        with self._key_lock(("attachment", *key)):
            cached = self._attachments.get(key)
            if cached is not None:
                return cached
            attachment_info = next(
                (item for item in message.get("attachments", []) if item["id"] == attachment_id),
                None,
            )
            response = _execute(
                service.users().messages().attachments().get(userId="me", messageId=message_id, id=attachment_id)
            )
            data = response.get("data", "")
            try:
                filename = attachment_info["filename"] if attachment_info else "attachment"
                declared_type = attachment_info["mimeType"] if attachment_info else ""
                document = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
                media_type = _media_type_for(filename, declared_type)
                document, media_type = validate_attachment_payload(document, media_type, filename)
            except (binascii.Error, ValueError) as error:
                raise GmailAttachmentError("Gmail devolvio un adjunto invalido.") from error
            logger.info(
                "Gmail attachment validated message_id=%s attachment_id=%s size=%d mime_type=%s pdf_signature=%s",
                message_id,
                attachment_id,
                len(document),
                media_type,
                document.startswith(b"%PDF-"),
            )
            result = (document, media_type, filename)
            self._attachments.put(key, result, size=len(document))
            return result

    def clear_cache(self) -> None:
        self._messages.clear()
        self._attachments.clear()
        with self._cache_lock:
            self._profile = None

    def _message(self, service: Resource, message_id: str) -> dict[str, Any]:
        cached = self._messages.get(message_id)
        if cached is not None:
            return cached
        with self._key_lock(("message", message_id)):
            cached = self._messages.get(message_id)
            if cached is not None:
                return cached
            raw = _execute(service.users().messages().get(userId="me", id=message_id, format="full"))
            message = self._serialize_message(raw)
            self._messages.put(message_id, message)
            return message

    def _key_lock(self, key: tuple[str, ...]) -> threading.Lock:
        return self._stripes[hash(key) % len(self._stripes)]

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


def _with_unread(message: dict[str, Any], unread: bool) -> dict[str, Any]:
    labels = [label for label in message.get("labels", []) if label != "UNREAD"]
    if unread:
        labels.append("UNREAD")
    return {**message, "unread": unread, "labels": labels}


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
                    "mimeType": _media_type_for(filename, part.get("mimeType", "")),
                    "size": body.get("size", 0),
                }
            )
        for child in part.get("parts", []):
            collect(child)

    collect(payload)
    return result


def _media_type_for(filename: str, declared_type: str) -> str:
    guessed_type, _ = mimetypes.guess_type(filename)
    if declared_type and declared_type != "application/octet-stream":
        return declared_type
    return guessed_type or "application/octet-stream"


def validate_attachment_payload(data: bytes, media_type: str, filename: str) -> tuple[bytes, str]:
    """Validate the bytes received from Gmail before passing them to Gemini."""
    if not data:
        raise GmailAttachmentError("Gmail devolvio un adjunto vacio.")
    has_pdf_signature = data.startswith(b"%PDF-")
    is_pdf = filename.lower().endswith(".pdf") or media_type == "application/pdf" or has_pdf_signature
    if is_pdf:
        if not data.startswith(b"%PDF-"):
            raise GmailAttachmentError("El adjunto se anuncio como PDF, pero no comienza con la firma %PDF-.")
        return data, "application/pdf"
    return data, media_type
