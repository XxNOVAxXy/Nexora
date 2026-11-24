"""Modelos de las 5 tablas, idénticos a ``docs/db/nexora_esquema_mysql.sql`` (nombres, tipos, nulos, índices y llaves).

Solo tipos genéricos de SQLAlchemy, para que el mismo modelo sirva en MySQL y en PostgreSQL:
BIGINT → BigInteger (en SQLite de pruebas, Integer para que el id sea autoincremental), VARCHAR(n) → String(n),
CHAR(64) → CHAR(64), TEXT → Text, BOOLEAN → Boolean, DATETIME → DateTime (sin zona: siempre UTC), JSON → JSON.

Las tablas ya existen (se crearon a mano con ese script): estos modelos no las crean ni las cambian. La migración
``baseline`` de Alembic solo se marca con ``alembic stamp``; la ``0002`` agrega ``documentos.recepcion``,
``eventos.origen`` y ``eventos.detalle`` (ver ``backend/migraciones``).

Fechas: todo se guarda en UTC. Los valores los pone siempre Python (``ahora_utc``) y, además, la conexión a MySQL
usa ``time_zone = '+00:00'`` para que los ``DEFAULT CURRENT_TIMESTAMP`` del esquema también queden en UTC.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
    func,
    text,
    true,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# BIGINT AUTO_INCREMENT (PG: BIGSERIAL). SQLite solo autoincrementa INTEGER PRIMARY KEY.
IdGrande = BigInteger().with_variant(Integer(), "sqlite")
AHORA = text("CURRENT_TIMESTAMP")

NOMBRES_TABLAS: tuple[str, ...] = ("usuarios", "cuentas_correo", "documentos", "envios", "eventos")


class Base(DeclarativeBase):
    pass


class Usuario(Base):
    __tablename__ = "usuarios"
    __table_args__ = (UniqueConstraint("usuario", name="uq_usuarios_usuario"),)

    id: Mapped[int] = mapped_column(IdGrande, primary_key=True, autoincrement=True)
    usuario: Mapped[str] = mapped_column(String(80), nullable=False)
    nombre: Mapped[str] = mapped_column(String(150), nullable=False)
    correo: Mapped[str | None] = mapped_column(String(255), nullable=True)
    hash_contrasena: Mapped[str] = mapped_column(String(255), nullable=False)
    rol: Mapped[str] = mapped_column(String(20), nullable=False, server_default=text("'operador'"))
    activo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=true())
    ultimo_acceso: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    creado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA)
    actualizado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA, onupdate=func.now())


class CuentaCorreo(Base):
    __tablename__ = "cuentas_correo"
    __table_args__ = (UniqueConstraint("usuario_id", "correo", name="uq_cuentas_usuario_correo"),)

    id: Mapped[int] = mapped_column(IdGrande, primary_key=True, autoincrement=True)
    usuario_id: Mapped[int] = mapped_column(IdGrande, ForeignKey("usuarios.id", name="fk_cuentas_usuario"), nullable=False)
    proveedor: Mapped[str] = mapped_column(String(10), nullable=False)
    correo: Mapped[str] = mapped_column(String(255), nullable=False)
    servidor_imap: Mapped[str | None] = mapped_column(String(255), nullable=True)
    puerto_imap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    credencial_cifrada: Mapped[str] = mapped_column(Text, nullable=False)
    automatico_activo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    ultima_revision: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    activo: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=true())
    creado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA)
    actualizado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA, onupdate=func.now())


class Documento(Base):
    __tablename__ = "documentos"
    __table_args__ = (
        UniqueConstraint("cuenta_id", "message_id", "part_id", name="uq_documentos_adjunto"),
        Index("ix_documentos_estado", "estado"),
        Index("ix_documentos_sha256", "sha256"),
        Index("ix_documentos_tipo", "tipo", "aseguradora"),
    )

    id: Mapped[int] = mapped_column(IdGrande, primary_key=True, autoincrement=True)
    cuenta_id: Mapped[int] = mapped_column(IdGrande, ForeignKey("cuentas_correo.id", name="fk_documentos_cuenta"), nullable=False)
    message_id: Mapped[str] = mapped_column(String(255), nullable=False)
    part_id: Mapped[str] = mapped_column(String(100), nullable=False)
    remitente: Mapped[str | None] = mapped_column(String(255), nullable=True)
    asunto: Mapped[str | None] = mapped_column(String(500), nullable=True)
    fecha_correo: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    nombre_archivo: Mapped[str] = mapped_column(String(255), nullable=False)
    ruta_original: Mapped[str] = mapped_column(String(500), nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    tamano_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    tipo: Mapped[str | None] = mapped_column(String(10), nullable=True)
    aseguradora: Mapped[str | None] = mapped_column(String(150), nullable=True)
    estructura: Mapped[str | None] = mapped_column(String(150), nullable=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    modo: Mapped[str | None] = mapped_column(String(10), nullable=True)
    estado: Mapped[str] = mapped_column(String(30), nullable=False, server_default=text("'leido'"))
    motivo: Mapped[str | None] = mapped_column(String(50), nullable=True)
    datos: Mapped[Any] = mapped_column(JSON, nullable=True)
    creado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA)
    actualizado: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA, onupdate=func.now())
    # Alembic 0002: datos de la recepción (attachment_id, mime, diagnostico, bandeja); ``datos`` queda para la extracción.
    recepcion: Mapped[Any] = mapped_column(JSON, nullable=True)


class Envio(Base):
    __tablename__ = "envios"
    __table_args__ = (
        Index("ix_envios_documento", "documento_id", "fecha"),
        Index("ix_envios_estado", "estado"),
    )

    id: Mapped[int] = mapped_column(IdGrande, primary_key=True, autoincrement=True)
    documento_id: Mapped[int] = mapped_column(IdGrande, ForeignKey("documentos.id", name="fk_envios_documento"), nullable=False)
    usuario_id: Mapped[int | None] = mapped_column(IdGrande, ForeignKey("usuarios.id", name="fk_envios_usuario"), nullable=True)
    origen: Mapped[str] = mapped_column(String(15), nullable=False)
    estado: Mapped[str] = mapped_column(String(15), nullable=False)
    intento: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    codigo_http: Mapped[int | None] = mapped_column(Integer, nullable=True)
    respuesta: Mapped[str | None] = mapped_column(Text, nullable=True)
    datos_enviados: Mapped[Any] = mapped_column(JSON, nullable=True)
    fecha: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA)


class Evento(Base):
    __tablename__ = "eventos"
    __table_args__ = (
        Index("ix_eventos_documento", "documento_id", "fecha"),
        Index("ix_eventos_fecha", "fecha"),
        Index("ix_eventos_codigo", "codigo"),
    )

    id: Mapped[int] = mapped_column(IdGrande, primary_key=True, autoincrement=True)
    documento_id: Mapped[int | None] = mapped_column(IdGrande, ForeignKey("documentos.id", name="fk_eventos_documento"), nullable=True)
    cuenta_id: Mapped[int | None] = mapped_column(IdGrande, ForeignKey("cuentas_correo.id", name="fk_eventos_cuenta"), nullable=True)
    usuario_id: Mapped[int | None] = mapped_column(IdGrande, ForeignKey("usuarios.id", name="fk_eventos_usuario"), nullable=True)
    etapa: Mapped[str] = mapped_column(String(15), nullable=False)
    resultado: Mapped[str] = mapped_column(String(10), nullable=False)
    codigo: Mapped[str | None] = mapped_column(String(50), nullable=True)
    mensaje: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    fecha: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=AHORA)
    # Alembic 0002.
    origen: Mapped[str | None] = mapped_column(String(15), nullable=True)
    detalle: Mapped[Any] = mapped_column(JSON, nullable=True)
