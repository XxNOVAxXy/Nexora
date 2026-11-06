"""Filtro automático de estados de cuenta: asunto + documento adjunto (PDF o imagen), de cualquier remitente.

El usuario no configura nada. Gmail recibe una búsqueda amplia (carpeta + términos en el asunto) y después el
backend vuelve a comprobar cada resultado con :func:`asunto_coincide`, porque la búsqueda de Gmail es por palabras
sueltas, y con :func:`tiene_documento`. La búsqueda no usa ``has:attachment``: Gmail no cuenta como adjunto una
imagen insertada en el cuerpo, y hay bancos que mandan el estado de cuenta solo como imagen.

Para cubrir un banco que use otra frase en el asunto, se agrega a ``TERMINOS_ASUNTO`` (y a ``TERMINOS_GMAIL``
si Gmail no la encontraría con los términos actuales).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any, Iterable

from .remitentes import CONSULTAS_CARPETA

# Frases que se buscan en el asunto ya normalizado (minúsculas, sin acentos, sin signos de puntuación).
TERMINOS_ASUNTO: tuple[str, ...] = (
    "estado de cuenta",
    "estados de cuenta",
    "edo de cuenta",
    "edo cta",
    "edocta",
    "edo cuenta",
    "resumen de cuenta",
    "resumen de movimientos",
    "extracto",
    "statement",
)

# Términos de la búsqueda en Gmail. Gmail ignora mayúsculas y signos ("Edo. Cta." coincide con "edo cta").
TERMINOS_GMAIL: tuple[str, ...] = (
    '"estado de cuenta"',
    '"estados de cuenta"',
    '"edo de cuenta"',
    '"edo cta"',
    "edocta",
    '"edo cuenta"',
    '"resumen de cuenta"',
    '"resumen de movimientos"',
    "extracto",
    "statement",
)

# Tipos que Gemini puede extraer. Cambiar esta lista o los términos cambia la firma (y se reconsulta Gmail).
TIPOS_EXTRAIBLES: tuple[str, ...] = ("application/pdf", "image/png", "image/jpeg", "image/webp")
EXTENSIONES_EXTRAIBLES: tuple[str, ...] = (".pdf", ".png", ".jpg", ".jpeg", ".webp")

FIRMA_FILTRO = "asunto-" + hashlib.sha256("\n".join((*TERMINOS_ASUNTO, *TIPOS_EXTRAIBLES)).encode("utf-8")).hexdigest()[:12]


def normalizar_asunto(asunto: str) -> str:
    """Minúsculas, sin acentos y con cualquier signo convertido en espacio: ``"Edo. Cta."`` -> ``"edo cta"``."""
    sin_acentos = "".join(c for c in unicodedata.normalize("NFD", asunto or "") if unicodedata.category(c) != "Mn")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", sin_acentos.lower()).split())


_PATRONES = [(termino, re.compile(rf"(?:^| ){re.escape(termino)}(?: |$)")) for termino in TERMINOS_ASUNTO]


def asunto_coincide(asunto: str) -> str | None:
    """Primer término de ``TERMINOS_ASUNTO`` que aparece como frase completa en el asunto, o ``None``."""
    normalizado = normalizar_asunto(asunto)
    for termino, patron in _PATRONES:
        if patron.search(normalizado):
            return termino
    return None


def tiene_pdf(adjuntos: Iterable[dict[str, Any]]) -> bool:
    return any(
        str(adjunto.get("mimeType", "")).lower() == "application/pdf" or str(adjunto.get("filename", "")).lower().endswith(".pdf")
        for adjunto in adjuntos or []
    )


def es_documento_extraible(adjunto: dict[str, Any]) -> bool:
    mime = str(adjunto.get("mimeType", "")).lower()
    return mime in TIPOS_EXTRAIBLES or str(adjunto.get("filename", "")).lower().endswith(EXTENSIONES_EXTRAIBLES)


def tiene_documento(adjuntos: Iterable[dict[str, Any]]) -> bool:
    """PDF o imagen (PNG, JPG, WebP): un estado de cuenta puede llegar solo como imagen."""
    return any(es_documento_extraible(adjunto) for adjunto in adjuntos or [])


def construir_query(folder: str) -> str:
    """Consulta de Gmail: carpeta + alguno de los términos en el asunto. El documento lo comprueba el backend."""
    return f"{CONSULTAS_CARPETA.get(folder, 'in:inbox')} subject:({' OR '.join(TERMINOS_GMAIL)})"
