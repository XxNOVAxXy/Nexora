"""Documentos recibidos: un registro por adjunto (``messageId__partId``) con su original, diagnóstico y bandeja.

Implementación JSON: ``<raiz>/<cuenta_id>.json`` = ``{"schema": 1, "documentos": {clave: registro}}`` (escritura
atómica). En la base de datos será la tabla ``documentos`` (una fila por adjunto, única por cuenta + clave).

Registro (todos los campos opcionales salvo los ids)::

    message_id, part_id, attachment_id, nombre, mime, tamano, sha256,
    ruta               ruta relativa del original en storage/originales (None si no se pudo guardar)
    recibido_en        fecha del correo; asunto y remitente (para la bandeja)
    guardado_en, actualizado
    diagnostico        {codigo, mensaje, formato, mime, paginas, caracteres}
    bandeja            None | {estado: pendiente|resuelto|descartado, codigo, mensaje, entrada_en, resuelto_en, resolucion}
    proceso            None | {estado: extraido|enviado|requiere_revision|error, motivo, mensaje, actualizado}

Estado del documento (``estado_y_motivo``; en la base son las columnas ``estado`` y ``motivo``): ``leido`` solo
mientras se procesa; al terminar un ciclo queda en extraido | enviado | requiere_revision | captura_manual | error
(o descartado si el usuario lo quitó de la bandeja).
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Protocol

from ..extracciones import cuenta_id, escribir_atomico

logger = logging.getLogger("nexora.repos.documentos")

SCHEMA = 1


ESTADOS_PROCESO = ("extraido", "enviado", "requiere_revision", "error")
# Estados que salen de la bandeja (no del proceso).
ESTADOS_BANDEJA_DOCUMENTO = ("captura_manual", "descartado")


def estado_y_motivo(registro: dict[str, Any], estado_previo: str | None = None) -> tuple[str, str | None]:
    """(estado, motivo) del documento. La bandeja pendiente o descartada manda; después, el último resultado del
    proceso; sin ninguno, ``leido`` (o el estado que ya tenía en la base, si no era de la bandeja)."""
    bandeja = registro.get("bandeja") if isinstance(registro.get("bandeja"), dict) else {}
    proceso = registro.get("proceso") if isinstance(registro.get("proceso"), dict) else {}
    if bandeja.get("estado") == "pendiente":
        return "captura_manual", bandeja.get("codigo")
    if bandeja.get("estado") == "descartado":
        return "descartado", bandeja.get("codigo")
    if proceso.get("estado") in ESTADOS_PROCESO:
        return str(proceso["estado"]), proceso.get("motivo")
    if bandeja.get("estado") == "resuelto":
        return "extraido", bandeja.get("resolucion")
    diagnostico = registro.get("diagnostico") if isinstance(registro.get("diagnostico"), dict) else {}
    codigo = diagnostico.get("codigo")
    estado = estado_previo if estado_previo and estado_previo not in ESTADOS_BANDEJA_DOCUMENTO else "leido"
    return estado, codigo if codigo and codigo != "ok" else None


def clave_documento(message_id: str, part_id: str) -> str:
    return f"{message_id}__{part_id}"


class DocumentosDanados(RuntimeError):
    """El archivo de documentos no se puede leer: nunca se sobrescribe a ciegas."""


class RepoDocumentos(Protocol):
    def obtener(self, email: str, message_id: str, part_id: str) -> dict[str, Any] | None: ...

    def actualizar(self, email: str, message_id: str, part_id: str, cambio: Callable[[dict[str, Any] | None], dict[str, Any]]) -> dict[str, Any]: ...

    def buscar_sha256(self, email: str, sha256: str) -> dict[str, Any] | None: ...

    def listar(self, email: str, *, bandeja: str | None = None) -> list[dict[str, Any]]: ...


class DocumentosJson:
    def __init__(self, raiz: Path) -> None:
        self.raiz = raiz
        self._lock = threading.RLock()

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.json"

    def _leer(self, email: str) -> dict[str, dict[str, Any]]:
        ruta = self._ruta(email)
        if not ruta.exists():
            return {}
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise DocumentosDanados(f"El registro de documentos esta danado: {ruta.name}") from error
        documentos = datos.get("documentos") if isinstance(datos, dict) else None
        return dict(documentos) if isinstance(documentos, dict) else {}

    def obtener(self, email: str, message_id: str, part_id: str) -> dict[str, Any] | None:
        with self._lock:
            registro = self._leer(email).get(clave_documento(message_id, part_id))
            return dict(registro) if isinstance(registro, dict) else None

    def actualizar(self, email: str, message_id: str, part_id: str, cambio: Callable[[dict[str, Any] | None], dict[str, Any]]) -> dict[str, Any]:
        """Lee el registro, aplica ``cambio`` (recibe None si no existe) y lo escribe, todo bajo el mismo lock."""
        clave = clave_documento(message_id, part_id)
        with self._lock:
            documentos = self._leer(email)
            previo = documentos.get(clave)
            nuevo = cambio(dict(previo) if isinstance(previo, dict) else None)
            documentos[clave] = {**nuevo, "message_id": message_id, "part_id": part_id}
            escribir_atomico(self._ruta(email), {"schema": SCHEMA, "documentos": documentos})
            return dict(documentos[clave])

    def buscar_sha256(self, email: str, sha256: str) -> dict[str, Any] | None:
        with self._lock:
            for registro in self._leer(email).values():
                if isinstance(registro, dict) and registro.get("sha256") == sha256 and registro.get("ruta"):
                    return dict(registro)
        return None

    def listar(self, email: str, *, bandeja: str | None = None) -> list[dict[str, Any]]:
        """Todos los registros, o solo los que tienen la bandeja en ese estado (``pendiente``, ``resuelto``…)."""
        with self._lock:
            registros = [dict(registro) for registro in self._leer(email).values() if isinstance(registro, dict)]
        if bandeja is not None:
            registros = [registro for registro in registros if (registro.get("bandeja") or {}).get("estado") == bandeja]
        return registros
