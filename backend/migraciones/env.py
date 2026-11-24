"""Entorno de Alembic: la URL sale de DATABASE_URL (.env), nunca de alembic.ini.

Las pruebas pasan su propia conexión en ``config.attributes["connection"]`` (SQLite en memoria).
"""

from __future__ import annotations

from alembic import context

from backend.app.config import settings
from backend.app.db import Base, crear_motor

config = context.config
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    if not settings.database_url:
        raise SystemExit("Falta DATABASE_URL en el .env.")
    context.configure(url=settings.database_url, target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def _migrar(conexion) -> None:  # type: ignore[no-untyped-def]
    context.configure(connection=conexion, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    conexion = config.attributes.get("connection")
    if conexion is not None:
        _migrar(conexion)
        return
    if not settings.database_url:
        raise SystemExit("Falta DATABASE_URL en el .env.")
    motor = crear_motor(settings.database_url)
    try:
        with motor.connect() as conexion:
            _migrar(conexion)
    finally:
        motor.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
