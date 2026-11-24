"""Configuración común de pytest: ninguna prueba escribe en storage/ ni en backend/data reales.

La recepción de ``main`` (originales, documentos y eventos) se redirige a una carpeta temporal por prueba.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# Las pruebas nunca usan la base de datos real: aunque el .env diga NEXORA_ALMACEN=db, aquí todo es JSON y sin
# DATABASE_URL (python-dotenv no sobrescribe variables que ya existen). Las pruebas de db usan SQLite en memoria.
os.environ["NEXORA_ALMACEN"] = "json"
os.environ["DATABASE_URL"] = ""
os.environ["NEXORA_LLAVE_CIFRADO"] = ""
# Las pruebas de antes de la Fase 3 prueban el flujo con IA (Gemini doble de prueba): sus tipos usan modo "ia".
# Las del modo manual (el predeterminado de verdad) lo fijan en cada tipo; test_reglas_sin_ia revisa el predeterminado.
os.environ["NEXORA_MODO_PREDETERMINADO"] = "ia"


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
