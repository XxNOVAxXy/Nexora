"""Archivos originales en disco: ``storage/originales/<cuenta>/<aaaa>/<mm>/<sha256>.<ext>``.

- La carpeta de la cuenta es el hash de la cuenta (nunca el email). Año y mes salen de la fecha del correo.
- Sin duplicar: el nombre es el sha256 del contenido; si ese contenido ya está guardado (en cualquier mes) se reutiliza.
- Se escribe una sola vez y nunca se modifica (escritura atómica: temporal + ``os.replace``).
- En la base de datos solo irá la ruta relativa que devuelve ``guardar``; los archivos se quedan en disco.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .extracciones import cuenta_id

EXTENSION_SEGURA = re.compile(r"\.[a-z0-9]{1,10}")


def sha256_de(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extension_segura(extension: str | None) -> str:
    texto = (extension or "").strip().lower()
    if texto and not texto.startswith("."):
        texto = f".{texto}"
    return texto if EXTENSION_SEGURA.fullmatch(texto) else ".bin"


class AlmacenOriginales:
    def __init__(self, raiz: Path) -> None:
        self.raiz = raiz

    def _carpeta_cuenta(self, email: str) -> Path:
        return self.raiz / cuenta_id(email)

    def buscar(self, email: str, sha256: str) -> str | None:
        """Ruta relativa de un original ya guardado con ese contenido, o None."""
        carpeta = self._carpeta_cuenta(email)
        if not carpeta.is_dir():
            return None
        existente = next(iter(sorted(carpeta.glob(f"*/*/{sha256}.*"))), None)
        return existente.relative_to(self.raiz).as_posix() if existente else None

    def guardar(self, email: str, data: bytes, extension: str | None, fecha: datetime | None = None) -> tuple[str, str, bool]:
        """Guarda el contenido y devuelve (ruta relativa, sha256, si es nuevo)."""
        sha = sha256_de(data)
        existente = self.buscar(email, sha)
        if existente:
            return existente, sha, False
        momento = (fecha or datetime.now(timezone.utc)).astimezone(timezone.utc)
        destino = self._carpeta_cuenta(email) / f"{momento:%Y}" / f"{momento:%m}" / f"{sha}{extension_segura(extension)}"
        destino.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporal = tempfile.mkstemp(dir=destino.parent, prefix=f".{sha[:12]}.", suffix=".tmp")
        try:
            with os.fdopen(descriptor, "wb") as archivo:
                archivo.write(data)
                archivo.flush()
                os.fsync(archivo.fileno())
            os.replace(temporal, destino)
        except BaseException:
            try:
                os.unlink(temporal)
            except FileNotFoundError:
                pass
            raise
        return destino.relative_to(self.raiz).as_posix(), sha, True

    def leer(self, ruta_relativa: str) -> bytes:
        """Contenido de un original. Rechaza rutas que salgan de la carpeta de originales."""
        ruta = (self.raiz / ruta_relativa).resolve()
        if not ruta.is_relative_to(self.raiz.resolve()):
            raise ValueError("Ruta de original invalida.")
        return ruta.read_bytes()
