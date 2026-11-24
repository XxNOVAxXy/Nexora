"""Diagnóstico de un archivo antes de extraer: ``ok | pdf_protegido | pdf_danado | pdf_escaneado | formato_no_soportado``.

El tipo se decide por el contenido (la firma del archivo), no por lo que dice Gmail: un PDF o una imagen que llega como
``application/octet-stream`` se reconoce igual, y un "PDF" que no empieza con ``%PDF-`` está dañado.

- PDF: se abre con pypdf (BSD). Con contraseña de apertura → ``pdf_protegido`` (uno que solo tiene contraseña de
  permisos se abre sin ella y sigue). Si no se puede leer o no tiene páginas → ``pdf_danado``. Si casi no trae texto
  (menos de ``MIN_CARACTERES_POR_PAGINA`` por página en las primeras ``PAGINAS_REVISADAS``) → ``pdf_escaneado``; el
  texto se cuenta con pdfplumber (MIT) y, si falla, con pypdf.
- Imagen PNG, JPEG o WebP con su firma válida → ``ok``.
- Cualquier otra cosa → ``formato_no_soportado``.

Nunca lanza excepciones: cualquier fallo al leer es un diagnóstico.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Any, Literal

logger = logging.getLogger("nexora.diagnostico")

Codigo = Literal["ok", "pdf_protegido", "pdf_danado", "pdf_escaneado", "formato_no_soportado"]
CODIGOS: tuple[str, ...] = ("ok", "pdf_protegido", "pdf_danado", "pdf_escaneado", "formato_no_soportado")

# Igual que ``tieneCapaDeTexto`` del frontend.
MIN_CARACTERES_POR_PAGINA = 20
PAGINAS_REVISADAS = 5

MENSAJES: dict[str, str] = {
    "ok": "Archivo legible.",
    "pdf_protegido": "El PDF esta protegido con contrasena: no se puede abrir sin ella.",
    "pdf_danado": "El PDF esta danado o incompleto: no se pudo leer.",
    "pdf_escaneado": "El PDF no tiene texto (parece escaneado): hay que leerlo como imagen.",
    "formato_no_soportado": "El archivo no es PDF ni imagen (PNG, JPG o WebP).",
}

EXTENSIONES = {"pdf": ".pdf", "png": ".png", "jpeg": ".jpg", "webp": ".webp"}
MIMES = {"pdf": "application/pdf", "png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}


def formato_por_firma(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _declarado(mime_type: str, filename: str) -> str | None:
    """Formato que dicen Gmail o el nombre del archivo."""
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    extension = Path(filename or "").suffix.lower()
    if mime == "application/pdf" or extension == ".pdf":
        return "pdf"
    if mime in {"image/png", "image/jpeg", "image/jpg", "image/webp"} or extension in {".png", ".jpg", ".jpeg", ".webp"}:
        return "imagen"
    return None


def _resultado(codigo: str, *, formato: str | None, mensaje: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "codigo": codigo,
        "mensaje": mensaje or MENSAJES[codigo],
        "formato": formato,
        "mime": MIMES.get(formato or ""),
        "extension": EXTENSIONES.get(formato or ""),
        **extra,
    }


def _caracteres(data: bytes, lector: Any, paginas: int) -> int:
    """Caracteres visibles (sin espacios) en las primeras páginas."""
    revisar = min(paginas, PAGINAS_REVISADAS)
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data), password="") as pdf:
            return sum(sum(1 for caracter in pagina.chars if str(caracter.get("text") or "").strip()) for pagina in pdf.pages[:revisar])
    except Exception as error:
        logger.info("pdfplumber no pudo contar el texto (%s); se usa pypdf", error.__class__.__name__)
    total = 0
    for indice in range(revisar):
        try:
            total += len("".join((lector.pages[indice].extract_text() or "").split()))
        except Exception:
            continue
    return total


def diagnosticar_pdf(data: bytes) -> dict[str, Any]:
    try:
        from pypdf import PasswordType, PdfReader
    except ImportError:  # pragma: no cover - pypdf está en requirements.txt
        logger.warning("pypdf no esta instalado: el PDF no se diagnostica")
        return _resultado("ok", formato="pdf", mensaje="Sin diagnostico: pypdf no esta instalado.")
    try:
        lector = PdfReader(io.BytesIO(data), strict=False)
        if lector.is_encrypted:
            try:
                abierto = lector.decrypt("")
            except Exception:
                abierto = PasswordType.NOT_DECRYPTED
            if abierto == PasswordType.NOT_DECRYPTED:
                return _resultado("pdf_protegido", formato="pdf")
        paginas = len(lector.pages)
    except Exception as error:
        return _resultado("pdf_danado", formato="pdf", detalle_tecnico=f"{error.__class__.__name__}: {error}"[:300])
    if paginas == 0:
        return _resultado("pdf_danado", formato="pdf", mensaje="El PDF no tiene paginas.", paginas=0)
    caracteres = _caracteres(data, lector, paginas)
    if caracteres < MIN_CARACTERES_POR_PAGINA * min(paginas, PAGINAS_REVISADAS):
        return _resultado("pdf_escaneado", formato="pdf", paginas=paginas, caracteres=caracteres)
    return _resultado("ok", formato="pdf", paginas=paginas, caracteres=caracteres)


def diagnosticar(data: bytes, mime_type: str = "", filename: str = "") -> dict[str, Any]:
    """Diagnóstico del archivo; ``mime`` y ``extension`` son los del formato reconocido por su contenido."""
    declarado = _declarado(mime_type, filename)
    if not data:
        codigo = "pdf_danado" if declarado == "pdf" else "formato_no_soportado"
        return _resultado(codigo, formato="pdf" if declarado == "pdf" else None, mensaje="El archivo esta vacio.")
    formato = formato_por_firma(data)
    if formato == "pdf":
        return diagnosticar_pdf(data)
    if formato in {"png", "jpeg", "webp"}:
        return _resultado("ok", formato=formato)
    if declarado == "pdf":
        return _resultado("pdf_danado", formato="pdf", mensaje="El PDF esta danado: no comienza con la firma %PDF-.")
    if declarado == "imagen":
        return _resultado("formato_no_soportado", formato=None, mensaje="La imagen esta danada o no es PNG, JPG ni WebP.")
    extension = Path(filename or "").suffix.lower()[:10]
    detalle = f" Tipo recibido: {(mime_type or 'desconocido')[:60]}{f' ({extension})' if extension else ''}."
    return _resultado("formato_no_soportado", formato=None, mensaje=MENSAJES["formato_no_soportado"] + detalle)
