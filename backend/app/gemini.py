from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .config import settings
from .contabilidad import (
    CAMPOS_MONTO_RESUMEN,
    CAMPOS_MONTO_TRANSACCION,
    detectar_formato,
    es_fila_de_saldo,
    normalizar_monto,
    validar_contabilidad,
)


logger = logging.getLogger("nexora.gemini")


class GeminiUnavailableError(RuntimeError):
    """Gemini is not configured or cannot be used by this installation."""


class GeminiRequestError(RuntimeError):
    def __init__(self, message: str, *, code: str = "request", status_code: int = 502, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


# Cambia esta versión cada vez que cambie el prompt o el esquema: invalida los resultados en caché.
PROMPT_VERSION = "2026-11-12.1"
CACHE_MAX_ITEMS = 16
# Máximo de los modelos Flash actuales. Los tokens de razonamiento también cuentan contra este límite.
MAX_OUTPUT_TOKENS_PREDETERMINADO = 65536
# Códigos de error que indican que la respuesta no está completa: nunca se reintentan ni se guardan en caché.
CODIGOS_RESPUESTA_INCOMPLETA = {"invalid_response", "respuesta_truncada", "respuesta_incompleta"}
# Campos adicionales sugeridos por la IA (botón "+ Campo"): como máximo estos, priorizando los que tienen valor en más filas.
MAX_SUGERENCIAS_CAMPOS = 8
MAX_NOMBRE_CAMPO = 60
MAX_VALOR_CAMPO = 500
# Nombres que ya son columnas estándar del movimiento o datos del resumen: nunca se sugieren como campo adicional.
NOMBRES_ESTANDAR = {
    "fecha", "fecha de operacion", "fecha operacion", "fecha de movimiento", "concepto", "descripcion", "concepto descripcion",
    "referencia", "ref", "cargo", "cargos", "retiro", "retiros", "abono", "abonos", "deposito", "depositos", "saldo",
    "saldo final", "saldo inicial", "saldo anterior", "banco", "titular", "cuenta", "numero de cuenta", "periodo", "moneda",
    "total cargos", "total abonos", "total de cargos", "total de abonos",
}


def max_output_tokens() -> int:
    """Límite de salida de Gemini, configurable con GEMINI_MAX_OUTPUT_TOKENS (entero positivo)."""
    valor = os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "").strip()
    if not valor:
        return MAX_OUTPUT_TOKENS_PREDETERMINADO
    try:
        tokens = int(valor)
    except ValueError:
        logger.warning("GEMINI_MAX_OUTPUT_TOKENS no es un entero (%r); se usa %d.", valor, MAX_OUTPUT_TOKENS_PREDETERMINADO)
        return MAX_OUTPUT_TOKENS_PREDETERMINADO
    if tokens <= 0:
        logger.warning("GEMINI_MAX_OUTPUT_TOKENS debe ser positivo (%d); se usa %d.", tokens, MAX_OUTPUT_TOKENS_PREDETERMINADO)
        return MAX_OUTPUT_TOKENS_PREDETERMINADO
    return tokens


class ResumenExtraido(BaseModel):
    """Encabezado del estado de cuenta tal como lo devuelve Gemini (también es su esquema de salida)."""

    model_config = ConfigDict(extra="ignore")

    banco: str = ""
    titular: str = ""
    cuenta: str = ""
    periodo: str = ""
    moneda: str = ""
    saldo_inicial: str = ""
    total_cargos: str = ""
    total_abonos: str = ""
    saldo_final: str = ""


class ValorAdicional(BaseModel):
    """Valor de una columna adicional (no estándar) impresa en un movimiento."""

    model_config = ConfigDict(extra="ignore")

    campo: str = ""
    valor: str = ""


class CampoAdicional(BaseModel):
    """Dato impreso una sola vez en el documento que no está en el resumen (p. ej. "Número de crédito")."""

    model_config = ConfigDict(extra="ignore")

    nombre: str = ""
    valor_documento: str = ""


class TransaccionExtraida(BaseModel):
    """Movimiento tal como lo devuelve Gemini: los montos llegan como texto impreso en el documento."""

    model_config = ConfigDict(extra="ignore")

    fecha: str = ""
    concepto: str = ""
    referencia: str = ""
    cargo: str = ""
    abono: str = ""
    saldo: str = ""
    adicionales: list[ValorAdicional] = Field(default_factory=list)


class StatementExtraction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    resumen: ResumenExtraido = Field(default_factory=ResumenExtraido)
    transacciones: list[TransaccionExtraida] = Field(default_factory=list)
    campos_adicionales: list[CampoAdicional] = Field(default_factory=list)
    notas: list[str] = Field(default_factory=list)


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

    def extract_document(self, data: bytes, mime_type: str, filename: str, forzar: bool = False) -> dict[str, Any]:
        """Extrae el documento con Gemini.

        El resultado se guarda en caché por (documento, modelo configurado, PROMPT_VERSION). Con ``forzar``
        se ignora la caché y el resultado nuevo reemplaza la entrada anterior.
        """
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

        model = values.get("model", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"))
        document_hash = _cache_key(data, model)
        with self._lock:
            cached = None if forzar else self._cache.get(document_hash)
            if cached is not None:
                return copy.deepcopy(cached)
            # Una extracción en curso del mismo documento ya es un resultado nuevo: se comparte también al forzar.
            event = self._inflight.get(document_hash)
            owner = event is None
            if owner:
                event = threading.Event()
                self._inflight[document_hash] = event
                self._inflight_errors.pop(document_hash, None)

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
            extracted, used_model = self._generate(data, mime_type, filename, api_key, model)
            result = _build_result(filename, extracted, used_model)
            with self._lock:
                # pop + asignación: la entrada reemplazada pasa a ser la más reciente.
                self._cache.pop(document_hash, None)
                self._cache[document_hash] = copy.deepcopy(result)
                while len(self._cache) > CACHE_MAX_ITEMS:
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
                    if error.code in CODIGOS_RESPUESTA_INCOMPLETA:
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
                max_output_tokens=max_output_tokens(),
                response_mime_type="application/json",
                response_schema=StatementExtraction,
            ),
        )
        _registrar_uso(model, response)
        # Antes de leer el texto: una respuesta cortada nunca se trata como extracción completa,
        # aunque el JSON parcial se pueda leer.
        _verificar_finalizacion(response)
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


def _nombre_finalizacion(response: Any) -> str | None:
    """Nombre de ``finish_reason`` del primer candidato ("STOP", "MAX_TOKENS"…), o None si no viene."""
    candidatos = getattr(response, "candidates", None) or []
    if not candidatos:
        return None
    razon = getattr(candidatos[0], "finish_reason", None)
    if razon is None:
        return None
    nombre = getattr(razon, "name", None) or str(razon)
    return nombre.rsplit(".", 1)[-1].upper()


def _verificar_finalizacion(response: Any) -> None:
    razon = _nombre_finalizacion(response)
    if razon is None or razon in {"STOP", "FINISH_REASON_UNSPECIFIED"}:
        return
    if razon == "MAX_TOKENS":
        raise GeminiRequestError(
            "El estado de cuenta es demasiado largo: la respuesta de Gemini se corto por el limite de salida "
            f"({max_output_tokens()} tokens) y no se uso. Ninguna extraccion parcial se trata como completa.",
            code="respuesta_truncada",
            status_code=422,
        )
    raise GeminiRequestError(
        f"Gemini termino la respuesta antes de completarla (motivo: {razon}); la extraccion no se uso.",
        code="respuesta_incompleta",
        status_code=502,
    )


def _registrar_uso(model: str, response: Any) -> None:
    uso = getattr(response, "usage_metadata", None)
    logger.info(
        "Gemini response model=%s finish_reason=%s output_tokens=%s thoughts_tokens=%s limit=%d",
        model,
        _nombre_finalizacion(response),
        getattr(uso, "candidates_token_count", None),
        getattr(uso, "thoughts_token_count", None),
        max_output_tokens(),
    )


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

Devuelve unicamente un objeto JSON que cumpla el esquema recibido. Extrae el resumen del estado de cuenta y TODOS los movimientos visibles. No inventes datos, no completes texto con conocimiento externo y no conviertas un valor ilegible en cero. Usa cadenas vacias para valores no visibles o no aplicables.

Resumen: `banco`, `titular`, `cuenta`, `periodo`, `moneda`, `saldo_inicial`, `total_cargos` (cargos/retiros), `total_abonos` (abonos/depositos) y `saldo_final`, tal como aparecen en el documento.

Movimientos: para cada uno conserva `fecha`, `concepto`, `referencia`, `cargo`, `abono` y `saldo`. Copia los importes EXACTAMENTE como estan impresos, con sus separadores de miles y decimales, signos, parentesis y sufijos (CR, DR, etc.); no los reformatees ni los calcules. Un movimiento lleva importe en `cargo` o en `abono`, segun la columna donde aparece; deja vacia la otra. `saldo` es el saldo despues del movimiento, si el documento lo muestra. No conviertas la fila `SALDO INICIAL` en un movimiento: usa ese valor solo como `saldo_inicial`.

Campos adicionales: si los movimientos muestran columnas distintas de las seis anteriores (por ejemplo `VSM`, `Sucursal`, `Folio`), agrega en `adicionales` de cada movimiento un elemento por columna con `campo` (el encabezado tal como esta impreso) y `valor` (el texto impreso en esa fila). Si el documento muestra una sola vez un dato que no esta en el resumen (por ejemplo `Numero de credito`), agregalo en `campos_adicionales` con `nombre` y `valor_documento` tal como estan impresos. Solo incluye campos y valores que aparecen literalmente en el documento: nunca inventes nombres ni valores, no repitas los campos del resumen ni de los movimientos, y deja las listas vacias si no hay campos adicionales.

El documento puede tener varias paginas. Cuenta cada movimiento una sola vez. Si una fila no es legible, conserva la fila y deja vacios solo los campos ilegibles. Incluye en `notas` cualquier advertencia de lectura, pagina o discrepancia evidente."""


def _parse_extraction(value: str) -> StatementExtraction:
    try:
        return StatementExtraction.model_validate_json(_strip_json_fences(value))
    except (ValueError, TypeError) as error:
        raise GeminiRequestError("Gemini no devolvio una extraccion bancaria estructurada valida.", code="invalid_response") from error


def _cache_key(data: bytes, model: str) -> str:
    digest = hashlib.sha256(data).hexdigest()
    return f"{digest}:{model.strip()}:{PROMPT_VERSION}"


def _huella(fecha: str, concepto: str, referencia: str, cargo: str, abono: str) -> str:
    """Identifica un movimiento entre extracciones del mismo documento (se calcula antes de cualquier edición)."""
    partes = [re.sub(r"\s+", " ", valor.strip().casefold()) for valor in (fecha, concepto, referencia, cargo, abono)]
    return hashlib.sha256("|".join(partes).encode("utf-8")).hexdigest()[:16]


def _build_result(filename: str, extraction: StatementExtraction, model: str) -> dict[str, Any]:
    # El formato numérico se decide con todos los importes del documento para resolver casos como "1,234".
    textos = [getattr(extraction.resumen, campo) for campo in CAMPOS_MONTO_RESUMEN]
    textos += [getattr(item, campo) for item in extraction.transacciones for campo in CAMPOS_MONTO_TRANSACCION]
    formato, conflicto = detectar_formato(textos)
    warnings = list(extraction.notas)
    if conflicto:
        warnings.append("El documento mezcla formatos numericos (1,234.56 y 1.234,56); los importes ambiguos quedan marcados como dudosos.")

    resumen: dict[str, Any] = extraction.resumen.model_dump()
    resumen_dudosos: list[str] = []
    for campo in CAMPOS_MONTO_RESUMEN:
        original = resumen[campo]
        normalizado, _, dudoso = normalizar_monto(campo, original, formato)
        resumen[campo] = normalizado
        resumen[f"{campo}_original"] = original
        if dudoso:
            resumen_dudosos.append(campo)
    resumen["dudosos"] = resumen_dudosos

    transacciones: list[dict[str, Any]] = []
    adicionales_por_fila: list[tuple[str, list[ValorAdicional]]] = []
    dudosos_total = len(resumen_dudosos)
    filas_de_saldo_con_importe = 0
    for item in extraction.transacciones:
        fila_de_saldo = es_fila_de_saldo(item.concepto)
        if fila_de_saldo and not item.cargo.strip() and not item.abono.strip():
            # Fila informativa (SALDO INICIAL / ANTERIOR / FINAL): no es un movimiento.
            continue
        transaccion: dict[str, Any] = {
            "id": f"ia-{len(transacciones) + 1}",
            "fecha": item.fecha,
            "concepto": item.concepto,
            "referencia": item.referencia,
        }
        dudosos: list[str] = []
        for campo in CAMPOS_MONTO_TRANSACCION:
            original = getattr(item, campo)
            normalizado, _, dudoso = normalizar_monto(campo, original, formato)
            transaccion[campo] = normalizado
            transaccion[f"{campo}_original"] = original
            if dudoso:
                dudosos.append(campo)
        transaccion["origen"] = "ia"
        transaccion["dudosos"] = dudosos
        transaccion["huella"] = _huella(item.fecha, item.concepto, item.referencia, transaccion["cargo"], transaccion["abono"])
        if fila_de_saldo:
            # Una fila de saldo con importe se conserva, pero no se suma y requiere revision.
            transaccion["revision"] = "fila_de_saldo_con_importe"
            filas_de_saldo_con_importe += 1
        dudosos_total += len(dudosos)
        transacciones.append(transaccion)
        adicionales_por_fila.append((transaccion["huella"], item.adicionales))

    if dudosos_total:
        warnings.append(f"{dudosos_total} importe(s) quedaron marcados como dudosos y requieren revision.")
    if filas_de_saldo_con_importe:
        warnings.append(f"{filas_de_saldo_con_importe} fila(s) de saldo traen importe: no se suman y requieren revision.")
    validacion = validar_contabilidad(resumen, transacciones, formato)
    if validacion["cuadra"] is False:
        warnings.append("La validacion contable encontro diferencias.")
    elif validacion["cuadra"] is None:
        warnings.append("La validacion contable no pudo completarse con los datos extraidos.")
    return {
        "filename": filename,
        "model": model,
        "prompt_version": PROMPT_VERSION,
        "formato_numerico": formato,
        "resumen": resumen,
        "transacciones": transacciones,
        "validacion": validacion,
        "sugerencias_campos": _sugerencias_campos(adicionales_por_fila, extraction.campos_adicionales),
        "warnings": _unique_text(warnings),
    }


def _limpiar_texto(valor: str, maximo: int) -> str:
    return re.sub(r"\s+", " ", valor or "").strip()[:maximo].strip()


def clave_campo(nombre: str) -> str:
    """Clave estable de un campo adicional: sin acentos, minúsculas y guiones ("Número de crédito" → "numero-de-credito")."""
    sin_acentos = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", sin_acentos.casefold()).strip("-")[:64]


def _sugerencias_campos(filas: list[tuple[str, list[ValorAdicional]]], documento: list[CampoAdicional]) -> list[dict[str, Any]]:
    """Campos adicionales que la IA encontró en el documento, sin inventar ninguno.

    Se descartan los que no tienen ningún valor, los que repiten un campo estándar y los duplicados. Los valores por
    fila se asocian a la huella del movimiento (la lista conserva el orden, así dos filas con la misma huella no se
    pisan). Quedan como máximo MAX_SUGERENCIAS_CAMPOS: primero los que tienen valor en más filas; los de valor único
    del documento van después.
    """
    por_clave: dict[str, dict[str, Any]] = {}
    for huella, adicionales in filas:
        vistos: set[str] = set()
        for adicional in adicionales:
            nombre = _limpiar_texto(adicional.campo, MAX_NOMBRE_CAMPO)
            valor = _limpiar_texto(adicional.valor, MAX_VALOR_CAMPO)
            clave = clave_campo(nombre)
            if not clave or not valor or clave in vistos or clave.replace("-", " ") in NOMBRES_ESTANDAR:
                continue
            vistos.add(clave)
            sugerencia = por_clave.setdefault(clave, {"clave": clave, "nombre": nombre, "valores": []})
            sugerencia["valores"].append({"huella": huella, "valor": valor})
    por_fila = sorted(por_clave.values(), key=lambda sugerencia: -len(sugerencia["valores"]))
    unicos: list[dict[str, Any]] = []
    for campo in documento:
        nombre = _limpiar_texto(campo.nombre, MAX_NOMBRE_CAMPO)
        valor = _limpiar_texto(campo.valor_documento, MAX_VALOR_CAMPO)
        clave = clave_campo(nombre)
        if not clave or not valor or clave in por_clave or clave.replace("-", " ") in NOMBRES_ESTANDAR:
            continue
        por_clave[clave] = {"clave": clave, "nombre": nombre, "valores": [], "valor_documento": valor}
        unicos.append(por_clave[clave])
    return (por_fila + unicos)[:MAX_SUGERENCIAS_CAMPOS]


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
