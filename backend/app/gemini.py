from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import threading
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .config import settings


logger = logging.getLogger("nexora.gemini")


class GeminiUnavailableError(RuntimeError):
    """Gemini is not configured or cannot be used by this installation."""


class GeminiRequestError(RuntimeError):
    def __init__(self, message: str, *, code: str = "request", status_code: int = 502, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


class StatementMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    bank: str = ""
    account_holder: str = ""
    account_number: str = ""
    statement_period: str = ""
    currency: str = ""
    opening_balance: str = ""
    closing_balance: str = ""
    total_credits: str = ""
    total_debits: str = ""


class ExtractedTransaction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    date: str = ""
    bank: str = ""
    sender: str = ""
    beneficiary: str = ""
    origin: str = ""
    destination: str = ""
    reference: str = ""
    concept: str = ""
    operation: str = ""
    amount: str = ""
    debit: str = ""
    credit: str = ""
    balance: str = ""
    currency: str = ""


class StatementExtraction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    statement: StatementMetadata = Field(default_factory=StatementMetadata)
    transactions: list[ExtractedTransaction] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class GeminiSettings:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or settings.gemini_settings_path
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, Any]] = {}
        self._inflight: dict[str, threading.Event] = {}
        self._inflight_errors: dict[str, GeminiRequestError] = {}

    def status(self) -> dict[str, Any]:
        values = self._read()
        api_key = values.get("apiKey", "")
        return {
            "configured": bool(api_key),
            "enabled": bool(api_key) and bool(values.get("enabled", False)),
            "model": values.get("model", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")),
            "maskedKey": f"....{api_key[-4:]}" if api_key else None,
        }

    def save(self, api_key: str | None, model: str) -> dict[str, Any]:
        values = self._read()
        key = api_key.strip() if api_key and api_key.strip() else values.get("apiKey", "")
        self._write({"apiKey": key, "model": model.strip(), "enabled": True})
        return self.status()

    def disable(self) -> dict[str, Any]:
        values = self._read()
        values["enabled"] = False
        self._write(values)
        return self.status()

    def extract_document(self, data: bytes, mime_type: str, filename: str) -> dict[str, Any]:
        values = self._read()
        api_key = values.get("apiKey", "")
        if not api_key or not values.get("enabled", False):
            raise GeminiUnavailableError("Gemini no esta conectado o habilitado en FastAPI.")
        if not data:
            raise GeminiRequestError("El documento adjunto esta vacio.", code="empty_document", status_code=400)
        data, mime_type = _validate_document_input(data, mime_type, filename)
        logger.info(
            "Gemini document validated filename=%s size=%d mime_type=%s pdf_signature=%s",
            filename,
            len(data),
            mime_type,
            data.startswith(b"%PDF-"),
        )

        document_hash = hashlib.sha256(data).hexdigest()
        with self._lock:
            cached = self._cache.get(document_hash)
            if cached is not None:
                return copy.deepcopy(cached)
            event = self._inflight.get(document_hash)
            owner = event is None
            if owner:
                event = threading.Event()
                self._inflight[document_hash] = event

        if not owner:
            if not event.wait(timeout=120):
                raise GeminiRequestError("La extraccion anterior agoto el tiempo de espera.", code="timeout", status_code=504, retryable=True)
            with self._lock:
                cached = self._cache.get(document_hash)
                error = self._inflight_errors.pop(document_hash, None)
            if cached is not None:
                return copy.deepcopy(cached)
            if error is not None:
                raise error
            raise GeminiRequestError("Gemini no produjo un resultado reutilizable.", code="invalid_response")

        try:
            model = values.get("model", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"))
            extracted, used_model = self._generate(data, mime_type, filename, api_key, model)
            result = _build_result(filename, extracted, used_model)
            with self._lock:
                self._cache[document_hash] = copy.deepcopy(result)
                if len(self._cache) > 16:
                    self._cache.pop(next(iter(self._cache)))
            return result
        except GeminiRequestError as error:
            with self._lock:
                self._inflight_errors[document_hash] = error
            raise
        finally:
            with self._lock:
                current_event = self._inflight.pop(document_hash, None)
                if current_event is not None:
                    current_event.set()

    def _generate(self, data: bytes, mime_type: str, filename: str, api_key: str, model: str) -> tuple[StatementExtraction, str]:
        candidates = _model_candidates(model)
        last_error: GeminiRequestError | None = None
        for candidate in candidates:
            for attempt in range(2):
                try:
                    text = _call_gemini_sdk(api_key, candidate, data, mime_type, filename)
                    return _parse_extraction(text), candidate
                except GeminiRequestError as error:
                    last_error = error
                    if error.code == "invalid_response":
                        raise
                    if not error.retryable:
                        if _is_model_error(str(error)) and candidate != candidates[-1]:
                            break
                        raise
                    if attempt == 0:
                        time.sleep(0.5)
        raise last_error or GeminiRequestError("Gemini no devolvio una respuesta valida.", code="invalid_response")

    def _read(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return {}
        return {
            "apiKey": os.getenv("GOOGLE_GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", "")),
            "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"),
            "enabled": False,
        }

    def _write(self, values: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(values, indent=2), encoding="utf-8")


def _call_gemini_sdk(api_key: str, model: str, data: bytes, mime_type: str, filename: str) -> str:
    try:
        from google import genai
        from google.genai import types
    except ImportError as error:
        raise GeminiRequestError(
            "Falta la dependencia google-genai en el backend.",
            code="sdk_missing",
            status_code=503,
        ) from error

    try:
        client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=90000))
        response = client.models.generate_content(
            model=model,
            contents=[
                types.Part.from_bytes(data=data, mime_type=mime_type),
                _extraction_prompt(filename),
            ],
            config=types.GenerateContentConfig(
                temperature=0,
                max_output_tokens=8192,
                response_mime_type="application/json",
                response_schema=StatementExtraction,
            ),
        )
        text = getattr(response, "text", None)
        if not isinstance(text, str) or not text.strip():
            raise GeminiRequestError("Gemini devolvio una respuesta vacia.", code="invalid_response")
        return text
    except GeminiRequestError:
        raise
    except Exception as error:
        message = str(error) or "Error no especificado"
        lowered = message.lower()
        if "401" in lowered or "403" in lowered or "api key" in lowered or "permission" in lowered:
            raise GeminiRequestError("La API key de Gemini no es valida o no tiene permisos.", code="authentication", status_code=502) from error
        if "429" in lowered or "quota" in lowered or "rate limit" in lowered:
            raise GeminiRequestError("Gemini rechazo la solicitud por cuota o limite de velocidad.", code="quota", status_code=429, retryable=True) from error
        if "timeout" in lowered or "deadline" in lowered or "timed out" in lowered:
            raise GeminiRequestError("Gemini agoto el tiempo de espera.", code="timeout", status_code=504, retryable=True) from error
        if "404" in lowered or "not found" in lowered or "model" in lowered and "not" in lowered:
            raise GeminiRequestError(f"El modelo de Gemini no esta disponible: {model}.", code="model_unavailable", status_code=502, retryable=False) from error
        raise GeminiRequestError(f"No se pudo completar la solicitud a Gemini: {message}", code="request", retryable=True) from error


def _validate_document_input(data: bytes, mime_type: str, filename: str) -> tuple[bytes, str]:
    if not data:
        raise GeminiRequestError("El documento esta vacio.", code="empty_document", status_code=400)
    has_pdf_signature = data.startswith(b"%PDF-")
    is_pdf = filename.lower().endswith(".pdf") or mime_type == "application/pdf" or has_pdf_signature
    if is_pdf and not data.startswith(b"%PDF-"):
        raise GeminiRequestError("El documento no comienza con la firma %PDF- esperada.", code="invalid_document", status_code=422)
    if is_pdf:
        return data, "application/pdf"
    if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise GeminiRequestError(f"Tipo MIME no soportado para Gemini: {mime_type}.", code="unsupported_mime", status_code=415)
    return data, mime_type


def _extraction_prompt(filename: str) -> str:
    return f"""Analiza el estado de cuenta bancario adjunto llamado {filename!r}.

Devuelve unicamente un objeto JSON que cumpla el esquema recibido. Extrae el encabezado del estado de cuenta y TODOS los movimientos visibles. No inventes datos, no completes texto con conocimiento externo y no conviertas un valor ilegible en cero. Usa cadenas vacias para valores no visibles o no aplicables.

Para cada movimiento conserva exactamente la fecha, concepto, referencia, cargo, abono, saldo, moneda, ordenante, beneficiario, cuentas y tipo de operacion tal como aparecen. No conviertas la fila `SALDO INICIAL` en un movimiento: usa ese valor solo como `opening_balance`. Para el encabezado conserva el banco, titular, cuenta, periodo, saldos y totales visibles. `total_credits` representa abonos/depositos y `total_debits` representa cargos/retiros.

El documento puede tener varias paginas. Cuenta cada movimiento una sola vez. Si una fila no es legible, conserva la fila y deja vacios solo los campos ilegibles. Incluye en notes cualquier advertencia de lectura, pagina o discrepancia evidente."""


def _parse_extraction(value: str) -> StatementExtraction:
    try:
        return StatementExtraction.model_validate_json(_strip_json_fences(value))
    except (ValueError, TypeError) as error:
        raise GeminiRequestError("Gemini no devolvio una extraccion bancaria estructurada valida.", code="invalid_response") from error


def _build_result(filename: str, extraction: StatementExtraction, model: str) -> dict[str, Any]:
    statement = extraction.statement.model_dump()
    transactions: list[dict[str, str]] = []
    movement_index = 0
    for item in extraction.transactions:
        if _is_opening_balance_row(item):
            continue
        transaction = item.model_dump()
        transaction["bank"] = transaction["bank"] or statement["bank"]
        transaction["currency"] = transaction["currency"] or statement["currency"]
        movement_index += 1
        transaction["id"] = f"gemini-{movement_index}"
        transaction["status"] = "Revisar"
        transactions.append(transaction)

    validation = _validate_balances(statement)
    warnings = list(extraction.notes)
    if validation["consistent"] is False:
        warnings.append(validation["message"])
    if validation["consistent"] is None:
        warnings.append(validation["message"])
    return {
        "filename": filename,
        "model": model,
        "statement": statement,
        "transactions": transactions,
        "balanceValidation": validation,
        "warnings": _unique_text(warnings),
    }


def _is_opening_balance_row(item: ExtractedTransaction) -> bool:
    concept = re.sub(r"\s+", " ", item.concept.strip().casefold())
    return concept in {"saldo inicial", "saldo inicial del periodo", "saldo inicial del período"}


def _validate_balances(statement: dict[str, str]) -> dict[str, Any]:
    opening = _parse_money(statement.get("opening_balance", ""))
    credits = _parse_money(statement.get("total_credits", ""))
    debits = _parse_money(statement.get("total_debits", ""))
    closing = _parse_money(statement.get("closing_balance", ""))
    if None in (opening, credits, debits, closing):
        return {"consistent": None, "difference": "", "message": "No se pudo validar el saldo: falta uno o mas totales en el documento."}
    difference = closing - (opening + credits - debits)
    rounded = difference.quantize(Decimal("0.01"))
    consistent = abs(rounded) <= Decimal("0.01")
    message = "Los saldos y totales son consistentes." if consistent else f"La conciliacion presenta una diferencia de {rounded:.2f}."
    return {"consistent": consistent, "difference": f"{rounded:.2f}", "message": message}


def _parse_money(value: Any) -> Decimal | None:
    if not isinstance(value, str) or not value.strip():
        return None
    cleaned = value.strip().replace(",", "")
    cleaned = re.sub(r"[^0-9.\-()]", "", cleaned)
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = f"-{cleaned[1:-1]}"
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _model_candidates(model: str) -> list[str]:
    configured = [model.strip()] if model.strip() else []
    fallbacks = [value.strip() for value in os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash,gemini-2.5-flash-lite").split(",")]
    return list(dict.fromkeys(value for value in configured + fallbacks if value))


def _is_model_error(message: str) -> bool:
    lowered = message.lower()
    return "modelo" in lowered or "model" in lowered or "not found" in lowered


def _strip_json_fences(value: str) -> str:
    cleaned = value.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()


def _unique_text(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))
