"""baseline: las 5 tablas de docs/db/nexora_esquema_mysql.sql

En la base que ya existe (tablas creadas a mano) esta migración NO se ejecuta: se marca con
``alembic -c backend/alembic.ini stamp head``. ``upgrade`` solo sirve para una base vacía (p. ej. PostgreSQL nuevo)
y se niega a correr si encuentra alguna de las tablas; ``downgrade`` nunca borra tablas.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-11-24
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLAS = ("usuarios", "cuentas_correo", "documentos", "envios", "eventos")


def upgrade() -> None:
    bind = op.get_bind()
    existentes = sorted(set(sa.inspect(bind).get_table_names()) & set(TABLAS))
    if existentes:
        raise RuntimeError(
            f"Ya existen las tablas {', '.join(existentes)}. La migracion baseline no recrea ni borra tablas: "
            "marca la base con 'alembic -c backend/alembic.ini stamp head'.")

    mysql = bind.dialect.name in {"mysql", "mariadb"}
    id_grande = sa.BigInteger().with_variant(sa.Integer(), "sqlite")
    ahora = sa.text("CURRENT_TIMESTAMP")
    # En MySQL, "actualizado" se pone solo al modificar el renglón (igual que el script original).
    ahora_al_cambiar = sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP") if mysql else ahora

    op.create_table(
        "usuarios",
        sa.Column("id", id_grande, primary_key=True, autoincrement=True),
        sa.Column("usuario", sa.String(80), nullable=False),
        sa.Column("nombre", sa.String(150), nullable=False),
        sa.Column("correo", sa.String(255), nullable=True),
        sa.Column("hash_contrasena", sa.String(255), nullable=False),
        sa.Column("rol", sa.String(20), nullable=False, server_default=sa.text("'operador'")),
        sa.Column("activo", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("ultimo_acceso", sa.DateTime(), nullable=True),
        sa.Column("creado", sa.DateTime(), nullable=False, server_default=ahora),
        sa.Column("actualizado", sa.DateTime(), nullable=False, server_default=ahora_al_cambiar),
        sa.UniqueConstraint("usuario", name="uq_usuarios_usuario"),
    )
    op.create_table(
        "cuentas_correo",
        sa.Column("id", id_grande, primary_key=True, autoincrement=True),
        sa.Column("usuario_id", id_grande, nullable=False),
        sa.Column("proveedor", sa.String(10), nullable=False),
        sa.Column("correo", sa.String(255), nullable=False),
        sa.Column("servidor_imap", sa.String(255), nullable=True),
        sa.Column("puerto_imap", sa.Integer(), nullable=True),
        sa.Column("credencial_cifrada", sa.Text(), nullable=False),
        sa.Column("automatico_activo", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("ultima_revision", sa.DateTime(), nullable=True),
        sa.Column("activo", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("creado", sa.DateTime(), nullable=False, server_default=ahora),
        sa.Column("actualizado", sa.DateTime(), nullable=False, server_default=ahora_al_cambiar),
        sa.ForeignKeyConstraint(["usuario_id"], ["usuarios.id"], name="fk_cuentas_usuario"),
        sa.UniqueConstraint("usuario_id", "correo", name="uq_cuentas_usuario_correo"),
    )
    op.create_table(
        "documentos",
        sa.Column("id", id_grande, primary_key=True, autoincrement=True),
        sa.Column("cuenta_id", id_grande, nullable=False),
        sa.Column("message_id", sa.String(255), nullable=False),
        sa.Column("part_id", sa.String(100), nullable=False),
        sa.Column("remitente", sa.String(255), nullable=True),
        sa.Column("asunto", sa.String(500), nullable=True),
        sa.Column("fecha_correo", sa.DateTime(), nullable=True),
        sa.Column("nombre_archivo", sa.String(255), nullable=False),
        sa.Column("ruta_original", sa.String(500), nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.Column("tamano_bytes", sa.BigInteger(), nullable=True),
        sa.Column("tipo", sa.String(10), nullable=True),
        sa.Column("aseguradora", sa.String(150), nullable=True),
        sa.Column("estructura", sa.String(150), nullable=True),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("modo", sa.String(10), nullable=True),
        sa.Column("estado", sa.String(30), nullable=False, server_default=sa.text("'leido'")),
        sa.Column("motivo", sa.String(50), nullable=True),
        sa.Column("datos", sa.JSON(), nullable=True),
        sa.Column("creado", sa.DateTime(), nullable=False, server_default=ahora),
        sa.Column("actualizado", sa.DateTime(), nullable=False, server_default=ahora_al_cambiar),
        sa.ForeignKeyConstraint(["cuenta_id"], ["cuentas_correo.id"], name="fk_documentos_cuenta"),
        sa.UniqueConstraint("cuenta_id", "message_id", "part_id", name="uq_documentos_adjunto"),
    )
    op.create_index("ix_documentos_estado", "documentos", ["estado"])
    op.create_index("ix_documentos_sha256", "documentos", ["sha256"])
    op.create_index("ix_documentos_tipo", "documentos", ["tipo", "aseguradora"])
    op.create_table(
        "envios",
        sa.Column("id", id_grande, primary_key=True, autoincrement=True),
        sa.Column("documento_id", id_grande, nullable=False),
        sa.Column("usuario_id", id_grande, nullable=True),
        sa.Column("origen", sa.String(15), nullable=False),
        sa.Column("estado", sa.String(15), nullable=False),
        sa.Column("intento", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("codigo_http", sa.Integer(), nullable=True),
        sa.Column("respuesta", sa.Text(), nullable=True),
        sa.Column("datos_enviados", sa.JSON(), nullable=True),
        sa.Column("fecha", sa.DateTime(), nullable=False, server_default=ahora),
        sa.ForeignKeyConstraint(["documento_id"], ["documentos.id"], name="fk_envios_documento"),
        sa.ForeignKeyConstraint(["usuario_id"], ["usuarios.id"], name="fk_envios_usuario"),
    )
    op.create_index("ix_envios_documento", "envios", ["documento_id", "fecha"])
    op.create_index("ix_envios_estado", "envios", ["estado"])
    op.create_table(
        "eventos",
        sa.Column("id", id_grande, primary_key=True, autoincrement=True),
        sa.Column("documento_id", id_grande, nullable=True),
        sa.Column("cuenta_id", id_grande, nullable=True),
        sa.Column("usuario_id", id_grande, nullable=True),
        sa.Column("etapa", sa.String(15), nullable=False),
        sa.Column("resultado", sa.String(10), nullable=False),
        sa.Column("codigo", sa.String(50), nullable=True),
        sa.Column("mensaje", sa.String(1000), nullable=True),
        sa.Column("fecha", sa.DateTime(), nullable=False, server_default=ahora),
        sa.ForeignKeyConstraint(["documento_id"], ["documentos.id"], name="fk_eventos_documento"),
        sa.ForeignKeyConstraint(["cuenta_id"], ["cuentas_correo.id"], name="fk_eventos_cuenta"),
        sa.ForeignKeyConstraint(["usuario_id"], ["usuarios.id"], name="fk_eventos_usuario"),
    )
    op.create_index("ix_eventos_documento", "eventos", ["documento_id", "fecha"])
    op.create_index("ix_eventos_fecha", "eventos", ["fecha"])
    op.create_index("ix_eventos_codigo", "eventos", ["codigo"])


def downgrade() -> None:
    raise RuntimeError("La migracion baseline no se deshace: nunca se borran las tablas.")
