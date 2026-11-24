"""Interruptor de almacenamiento ``NEXORA_ALMACEN=json|db`` (por defecto json) y salud de la base de datos.

- ``json``: ``DocumentosJson``, ``EventosJson`` y ``EnviosJson`` (archivos en backend/data), como siempre.
- ``db``: ``DocumentosDb``, ``EventosDb`` y ``EnviosDb`` sobre ``DATABASE_URL``. Exige ``NEXORA_LLAVE_CIFRADO``;
  si falta (o la URL), el backend no arranca y dice qué falta.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .repos import DocumentosJson, EnviosJson, EventosJson

if TYPE_CHECKING:
    from sqlalchemy.engine import Engine

    from .extracciones import AlmacenExtracciones

logger = logging.getLogger("nexora.almacenamiento")

MODOS = ("json", "db")


class ConfiguracionAlmacenInvalida(RuntimeError):
    """La configuración del almacenamiento no permite arrancar (mensaje para la persona que lo instala)."""


@dataclass
class Repositorios:
    modo: str
    documentos: Any
    eventos: Any
    envios: Any
    motor: "Engine | None" = None


def crear_repositorios(modo: str, *, almacen: "AlmacenExtracciones", documentos_path: Path, eventos_path: Path, database_url: str = "",
                       llave_cifrado: str = "", credencial_de: Callable[[str], str | None] = lambda _email: None) -> Repositorios:
    modo = (modo or "json").strip().lower()
    if modo not in MODOS:
        raise ConfiguracionAlmacenInvalida(f"NEXORA_ALMACEN debe ser 'json' o 'db' (se recibio '{modo}').")
    if modo == "json":
        return Repositorios("json", DocumentosJson(documentos_path), EventosJson(eventos_path), EnviosJson(almacen))

    from .db import UrlBaseDatosInvalida, crear_motor, fabrica_sesiones
    from .repos.db import CuentasDb, DocumentosDb, EnviosDb, EventosDb
    from .seguridad import Cifrador, LlaveCifradoInvalida

    try:
        cifrador = Cifrador(llave_cifrado)
        motor = crear_motor(database_url)
    except (LlaveCifradoInvalida, UrlBaseDatosInvalida) as error:
        raise ConfiguracionAlmacenInvalida(f"NEXORA_ALMACEN=db: {error}") from error
    sesiones = fabrica_sesiones(motor)
    cuentas = CuentasDb(sesiones, cifrador, credencial_de)
    logger.info("Almacenamiento en base de datos (%s)", motor.dialect.name)
    return Repositorios("db", DocumentosDb(sesiones, cuentas), EventosDb(sesiones, cuentas), EnviosDb(sesiones, cuentas), motor)


def _sin_secretos(mensaje: str, url: str) -> str:
    """Quita la contraseña de DATABASE_URL de un mensaje de error, por si el controlador la repite."""
    try:
        from sqlalchemy.engine import make_url

        contrasena = make_url(url).password
    except Exception:
        contrasena = None
    if contrasena:
        mensaje = mensaje.replace(str(contrasena), "***")
    return mensaje[:300]


def salud_db(motor: "Engine | None", database_url: str = "") -> dict[str, Any]:
    """Si la base conecta y cuántos registros hay por tabla. Sin motor (modo json) usa DATABASE_URL si existe."""
    from sqlalchemy import func, inspect, select, text

    from .db import NOMBRES_TABLAS, Base, a_iso, a_utc, crear_motor

    propio = motor is None
    if propio:
        if not database_url:
            return {"conectado": False, "configurada": False, "mensaje": "DATABASE_URL no esta configurada."}
        try:
            motor = crear_motor(database_url)
        except Exception as error:
            return {"conectado": False, "configurada": True, "mensaje": _sin_secretos(str(error), database_url)}
    assert motor is not None
    try:
        with motor.connect() as conexion:
            existentes = set(inspect(conexion).get_table_names())
            tablas: dict[str, int | None] = {}
            for nombre in NOMBRES_TABLAS:
                tablas[nombre] = conexion.execute(select(func.count()).select_from(Base.metadata.tables[nombre])).scalar_one() if nombre in existentes else None
            revision = conexion.execute(text("SELECT version_num FROM alembic_version")).scalar() if "alembic_version" in existentes else None
            hora = conexion.execute(select(func.current_timestamp())).scalar()
        faltan = [nombre for nombre, cantidad in tablas.items() if cantidad is None]
        return {
            "conectado": True,
            "configurada": True,
            "motor": motor.dialect.name,
            "tablas": tablas,
            "faltan_tablas": faltan,
            "revision_alembic": revision,
            # Con la conexión en UTC, debe coincidir con la hora UTC actual.
            "hora_base_utc": a_iso(a_utc(hora)),
            "mensaje": "Conectado." if not faltan else f"Conectado, pero faltan tablas: {', '.join(faltan)}.",
        }
    except Exception as error:
        logger.warning("La base de datos no responde: %s", error.__class__.__name__)
        detalle = getattr(error, "orig", None) or error
        return {"conectado": False, "configurada": True, "motor": motor.dialect.name,
                "mensaje": _sin_secretos(f"{detalle.__class__.__name__}: {detalle}", str(motor.url.render_as_string(hide_password=False)) if not database_url else database_url)}
    finally:
        if propio:
            motor.dispose()
