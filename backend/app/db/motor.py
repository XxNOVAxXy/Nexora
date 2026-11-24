"""Motor y sesiones de la base de datos a partir de ``DATABASE_URL``.

- MySQL/MariaDB (``mysql+pymysql://...``): cada conexión fija ``time_zone = '+00:00'`` (UTC) y ``utf8mb4``.
- PostgreSQL (``postgresql+psycopg://...``): cada conexión fija ``TimeZone = 'UTC'``.
- SQLite en memoria (``sqlite://``): solo para pruebas; una sola conexión compartida entre hilos.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool


class UrlBaseDatosInvalida(ValueError):
    """DATABASE_URL falta o no es una URL de SQLAlchemy."""


def crear_motor(url: str, **opciones: Any) -> Engine:
    if not url:
        raise UrlBaseDatosInvalida("Falta DATABASE_URL en el .env (obligatoria con NEXORA_ALMACEN=db). Ejemplo: "
                                   "mysql+pymysql://nexora_app:CONTRASENA@localhost:3306/nexora?charset=utf8mb4")
    try:
        datos_url = make_url(url)
    except ArgumentError as error:
        raise UrlBaseDatosInvalida("DATABASE_URL no es una URL valida de SQLAlchemy (ejemplo: mysql+pymysql://usuario:contrasena@localhost:3306/nexora).") from error
    dialecto = datos_url.get_backend_name()
    if dialecto == "sqlite":
        motor = create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool, **opciones)

        @event.listens_for(motor, "connect")
        def _al_conectar(conexion: Any, _registro: Any) -> None:
            # Receta de SQLAlchemy para pysqlite: SQLAlchemy controla BEGIN, así funcionan los SAVEPOINT (importador).
            conexion.isolation_level = None
            cursor = conexion.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        @event.listens_for(motor, "begin")
        def _al_empezar(conexion: Any) -> None:
            conexion.exec_driver_sql("BEGIN")
        return motor

    connect_args: dict[str, Any] = {}
    if dialecto in {"mysql", "mariadb"}:
        connect_args = {"init_command": "SET time_zone = '+00:00'", "charset": datos_url.query.get("charset", "utf8mb4")}
    elif dialecto == "postgresql":
        connect_args = {"options": "-c TimeZone=UTC"}
    return create_engine(url, pool_pre_ping=True, pool_recycle=3600, connect_args=connect_args, **opciones)


def fabrica_sesiones(motor: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=motor, expire_on_commit=False, future=True)


# --- Fechas: UTC sin zona en la base; ISO con "+00:00" hacia afuera ---------------------------------

def ahora_utc() -> datetime:
    """Ahora en UTC, sin zona y sin microsegundos (DATETIME de MySQL guarda segundos)."""
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def a_utc(valor: Any) -> datetime | None:
    """datetime o texto ISO → datetime UTC sin zona (lo que se guarda). Un texto sin zona se toma como UTC."""
    if valor is None or valor == "":
        return None
    if isinstance(valor, str):
        try:
            valor = datetime.fromisoformat(valor.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(valor, datetime):
        return None
    if valor.tzinfo is not None:
        valor = valor.astimezone(timezone.utc).replace(tzinfo=None)
    return valor.replace(microsecond=0)


def a_iso(valor: datetime | None) -> str | None:
    """datetime UTC sin zona (de la base) → ISO con "+00:00", el mismo formato que la versión JSON."""
    if valor is None:
        return None
    return valor.replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
