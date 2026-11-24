"""Eventos del proceso: un registro por etapa (lectura, diagnostico, extraccion, envio) con código, mensaje y fecha y hora.

Solo se agregan, nunca se editan ni se borran: es la bitácora auditable. Implementación JSON Lines (una línea por
evento) en ``<raiz>/<cuenta_id>.jsonl``. En la base de datos será la tabla ``eventos`` (solo inserción, índice por
documento y por fecha).

Evento::

    id, fecha (ISO UTC), etapa (lectura | diagnostico | extraccion | envio), codigo, mensaje,
    message_id, part_id, origen (automatico | manual | reprocesar | configurar), detalle (dict pequeño)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Protocol

from ..extracciones import cuenta_id

logger = logging.getLogger("nexora.repos.eventos")

Etapa = Literal["lectura", "diagnostico", "extraccion", "envio"]
ETAPAS: tuple[str, ...] = ("lectura", "diagnostico", "extraccion", "envio")
MAX_MENSAJE = 500
MAX_LISTADO = 500


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


class RepoEventos(Protocol):
    def registrar(self, email: str, *, etapa: str, codigo: str, mensaje: str, message_id: str | None = None, part_id: str | None = None,
                  origen: str | None = None, detalle: dict[str, Any] | None = None) -> dict[str, Any]: ...

    def listar(self, email: str, *, message_id: str | None = None, part_id: str | None = None, etapa: str | None = None,
               desde: str | None = None, hasta: str | None = None, limite: int = 200) -> list[dict[str, Any]]: ...


class EventosJson:
    def __init__(self, raiz: Path, reloj: Callable[[], datetime] = _ahora) -> None:
        self.raiz = raiz
        self.reloj = reloj
        self._lock = threading.Lock()

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.jsonl"

    def registrar(self, email: str, *, etapa: str, codigo: str, mensaje: str, message_id: str | None = None, part_id: str | None = None,
                  origen: str | None = None, detalle: dict[str, Any] | None = None) -> dict[str, Any]:
        if etapa not in ETAPAS:
            raise ValueError(f"Etapa desconocida: {etapa}")
        evento = {
            "id": uuid.uuid4().hex[:16],
            "fecha": self.reloj().astimezone(timezone.utc).isoformat(timespec="seconds"),
            "etapa": etapa,
            "codigo": str(codigo)[:64],
            "mensaje": str(mensaje or "")[:MAX_MENSAJE],
            "message_id": message_id,
            "part_id": part_id,
            "origen": origen,
            "detalle": detalle or None,
        }
        linea = json.dumps(evento, ensure_ascii=False) + "\n"
        ruta = self._ruta(email)
        with self._lock:
            ruta.parent.mkdir(parents=True, exist_ok=True)
            # Si una escritura anterior quedó cortada (sin salto de línea), el evento nuevo empieza en su propia línea.
            cortada = False
            if ruta.exists() and ruta.stat().st_size > 0:
                with ruta.open("rb") as previo:
                    previo.seek(-1, os.SEEK_END)
                    cortada = previo.read(1) != b"\n"
            with ruta.open("a", encoding="utf-8") as archivo:
                archivo.write(("\n" if cortada else "") + linea)
                archivo.flush()
                os.fsync(archivo.fileno())
        return evento

    def listar(self, email: str, *, message_id: str | None = None, part_id: str | None = None, etapa: str | None = None,
               desde: str | None = None, hasta: str | None = None, limite: int = 200) -> list[dict[str, Any]]:
        """Eventos que cumplen los filtros, del más reciente al más antiguo. ``desde``/``hasta``: fechas ISO."""
        ruta = self._ruta(email)
        if not ruta.exists():
            return []
        with self._lock:
            lineas = ruta.read_text(encoding="utf-8").splitlines()
        eventos: list[dict[str, Any]] = []
        for linea in lineas:
            try:
                evento = json.loads(linea)
            except ValueError:
                # Una línea a medias (corte de luz al escribir) no invalida las demás.
                logger.warning("Evento ilegible omitido en %s", ruta.name)
                continue
            if not isinstance(evento, dict):
                continue
            if message_id is not None and evento.get("message_id") != message_id:
                continue
            if part_id is not None and evento.get("part_id") != part_id:
                continue
            if etapa is not None and evento.get("etapa") != etapa:
                continue
            fecha = str(evento.get("fecha") or "")
            if desde is not None and fecha < desde:
                continue
            if hasta is not None and fecha > hasta:
                continue
            eventos.append(evento)
        # Del archivo salen en orden de escritura: al invertir primero, los del mismo segundo quedan del último al primero.
        eventos.reverse()
        eventos.sort(key=lambda evento: str(evento.get("fecha") or ""), reverse=True)
        return eventos[: max(1, min(limite, MAX_LISTADO))]
