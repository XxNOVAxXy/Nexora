"""Repositorios: todo lo nuevo guarda y lee a través de estas clases, nunca directo a archivos.

Hoy escriben JSON en ``backend/data``. Cuando entre la base de datos (MySQL, portable a PostgreSQL) se agrega una
implementación con la misma interfaz (``RepoDocumentos``, ``RepoEventos``, ``RepoEnvios``) y se cambia en ``main.py``;
el resto del código no se toca.
"""

from .documentos import DocumentosJson, RepoDocumentos
from .envios import EnviosJson, RepoEnvios
from .eventos import EventosJson, RepoEventos

__all__ = ["DocumentosJson", "EnviosJson", "EventosJson", "RepoDocumentos", "RepoEnvios", "RepoEventos"]
