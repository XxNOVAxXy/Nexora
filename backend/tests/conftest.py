"""Configuración común de pytest: ninguna prueba escribe en storage/ ni en backend/data reales.

La recepción de ``main`` (originales, documentos y eventos) se redirige a una carpeta temporal por prueba.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _recepcion_temporal():
    from backend.app import main

    anteriores = (main.recepcion.originales.raiz, main.recepcion.documentos.raiz, main.recepcion.eventos.raiz)
    with tempfile.TemporaryDirectory() as directorio:
        raiz = Path(directorio)
        main.recepcion.originales.raiz = raiz / "originales"
        main.recepcion.documentos.raiz = raiz / "documentos"
        main.recepcion.eventos.raiz = raiz / "eventos"
        try:
            yield raiz
        finally:
            main.recepcion.originales.raiz, main.recepcion.documentos.raiz, main.recepcion.eventos.raiz = anteriores
