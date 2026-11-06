"""Nombres de adjuntos: decodificación, saneamiento y cabecera Content-Disposition.

Gmail suele entregar el nombre ya decodificado, pero no siempre: puede llegar como palabra codificada
RFC 2047 (``=?UTF-8?B?...?=``), con parámetros RFC 2231 (``filename*=UTF-8''...``) solo en las cabeceras
de la parte, vacío, con caracteres de control o muy largo. Este módulo garantiza que:

- el nombre que ve la interfaz es legible y no contiene saltos de línea, controles ni separadores de ruta;
- la cabecera de descarga siempre se puede codificar (respaldo ASCII + ``filename*`` UTF-8, RFC 6266/5987),
  así que un nombre con acentos, comillas, emoji o CR/LF nunca produce un 500 ni inyecta cabeceras.
"""
from __future__ import annotations

import mimetypes
import re
import unicodedata
from email.header import decode_header, make_header
from email.message import Message
from typing import Any
from urllib.parse import quote


MAX_LONGITUD_NOMBRE = 150
MAX_LONGITUD_EXTENSION = 15
NOMBRE_BASE = "adjunto"
EXTENSIONES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
# Tipos que se listan aunque la parte no tenga nombre (un estado de cuenta sin nombre debe poder verse).
TIPOS_DOCUMENTALES = frozenset(EXTENSIONES)

_PALABRA_CODIFICADA = re.compile(r"=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=")
_VALOR_RFC2231 = re.compile(r"^([A-Za-z0-9._-]+)'[A-Za-z0-9-]*'(.*)$")


def extension_para(mime_type: str) -> str:
    tipo = (mime_type or "").split(";", 1)[0].strip().lower()
    return EXTENSIONES.get(tipo) or mimetypes.guess_extension(tipo) or ""


def decodificar_nombre(valor: str) -> str:
    """Decodifica palabras RFC 2047 y valores RFC 2231 (``UTF-8''%C3%B1.pdf``); si falla, devuelve el valor."""
    texto = valor or ""
    if _PALABRA_CODIFICADA.search(texto):
        try:
            texto = str(make_header(decode_header(texto)))
        except (LookupError, UnicodeDecodeError, ValueError):
            pass
    coincidencia = _VALOR_RFC2231.match(texto)
    if coincidencia and "%" in coincidencia.group(2):
        mensaje = Message()
        mensaje["Content-Disposition"] = f"attachment; filename*={texto}"
        decodificado = mensaje.get_filename()
        if decodificado:
            texto = decodificado
    return texto


def nombre_desde_cabeceras(cabeceras: list[dict[str, Any]] | None) -> str:
    """Nombre tomado de Content-Disposition / Content-Type de la parte (resuelve RFC 2231 y continuaciones)."""
    mensaje = Message()
    for cabecera in cabeceras or []:
        nombre = str(cabecera.get("name", ""))
        if nombre.lower() in {"content-disposition", "content-type"}:
            mensaje[nombre] = str(cabecera.get("value", ""))
    try:
        return mensaje.get_filename() or ""
    except (LookupError, UnicodeDecodeError, ValueError):
        return ""


def nombre_seguro(valor: str | None, mime_type: str = "") -> str:
    """Nombre legible y seguro: sin controles, saltos de línea ni rutas, con longitud acotada y nunca vacío."""
    texto = unicodedata.normalize("NFC", decodificar_nombre(valor or ""))
    texto = "".join(" " if unicodedata.category(c) in {"Cc", "Zl", "Zp"} else c for c in texto)
    texto = texto.replace("/", "_").replace("\\", "_")
    texto = re.sub(r"\s+", " ", texto).strip(" .")
    if not texto:
        return f"{NOMBRE_BASE}{extension_para(mime_type)}"
    if len(texto) > MAX_LONGITUD_NOMBRE:
        base, punto, extension = texto.rpartition(".")
        if punto and base and 0 < len(extension) < MAX_LONGITUD_EXTENSION:
            sufijo = f".{extension}"
            texto = texto[: MAX_LONGITUD_NOMBRE - len(sufijo)].rstrip(" .") + sufijo
        else:
            texto = texto[:MAX_LONGITUD_NOMBRE].rstrip(" .")
    return texto


def _ascii(texto: str) -> str:
    # Los acentos se reducen a su letra base (año → ano); lo que no tiene equivalente ASCII se descarta.
    ascii_ = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    ascii_ = "".join(c if 32 <= ord(c) < 127 and c not in {'"', "\\"} else "_" for c in ascii_)
    return re.sub(r"\s+", " ", ascii_).strip(" ._")


def _respaldo_ascii(nombre: str, mime_type: str) -> str:
    base, punto, extension = nombre.rpartition(".")
    if not punto or not base:
        base, extension = nombre, ""
    base_ascii, extension_ascii = _ascii(base), _ascii(extension)
    if not re.search(r"[A-Za-z0-9]", base_ascii):
        # Nada legible en ASCII (p. ej. "日本.pdf"): nombre genérico con la extensión conocida.
        return f"{NOMBRE_BASE}.{extension_ascii}" if extension_ascii else f"{NOMBRE_BASE}{extension_para(mime_type)}"
    return f"{base_ascii}.{extension_ascii}" if extension_ascii else base_ascii


def content_disposition(nombre: str | None, mime_type: str = "", disposicion: str = "inline") -> str:
    """Cabecera RFC 6266 con respaldo ASCII entre comillas y ``filename*`` UTF-8 codificado (RFC 5987).

    El resultado contiene solo ASCII imprimible, así que siempre se puede codificar en latin-1."""
    seguro = nombre_seguro(nombre, mime_type)
    respaldo = _respaldo_ascii(seguro, mime_type)
    return f"{disposicion}; filename=\"{respaldo}\"; filename*=UTF-8''{quote(seguro, safe='')}"
