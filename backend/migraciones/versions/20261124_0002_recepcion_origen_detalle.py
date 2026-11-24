"""columnas documentos.recepcion, eventos.origen y eventos.detalle

Solo agrega columnas que admiten NULL: no cambia ni borra nada de lo existente. Además mueve a
``documentos.recepcion`` lo que la versión anterior guardaba en ``datos["recepcion"]``; ``datos`` queda solo para la
extracción (si no tenía nada más, queda en NULL).

Aplicar: ``alembic -c backend/alembic.ini upgrade head``.

Revision ID: 0002_recepcion_origen_detalle
Revises: 0001_baseline
Create Date: 2026-11-24
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import context, op

revision: str = "0002_recepcion_origen_detalle"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

documentos = sa.table("documentos", sa.column("id", sa.BigInteger()), sa.column("datos", sa.JSON(none_as_null=True)), sa.column("recepcion", sa.JSON(none_as_null=True)))


def upgrade() -> None:
    op.add_column("documentos", sa.Column("recepcion", sa.JSON(), nullable=True))
    op.add_column("eventos", sa.Column("origen", sa.String(15), nullable=True))
    op.add_column("eventos", sa.Column("detalle", sa.JSON(), nullable=True))

    # Datos: datos["recepcion"] → recepcion. Con --sql (vista previa sin conexión) no hay datos que leer.
    if context.is_offline_mode():
        op.execute("-- (al aplicarla de verdad, mueve datos.recepcion a la columna recepcion)")
        return
    bind = op.get_bind()
    for id_, datos in bind.execute(sa.select(documentos.c.id, documentos.c.datos).where(documentos.c.datos.is_not(None))).all():
        if not isinstance(datos, dict) or "recepcion" not in datos:
            continue
        resto = {clave: valor for clave, valor in datos.items() if clave != "recepcion"}
        bind.execute(documentos.update().where(documentos.c.id == id_).values(recepcion=datos["recepcion"], datos=resto or None))


def downgrade() -> None:
    # Devuelve la recepción a datos["recepcion"] antes de quitar las columnas nuevas (las tablas no se tocan).
    if not context.is_offline_mode():
        _devolver_recepcion_a_datos()
    op.drop_column("eventos", "detalle")
    op.drop_column("eventos", "origen")
    op.drop_column("documentos", "recepcion")


def _devolver_recepcion_a_datos() -> None:
    bind = op.get_bind()
    for id_, datos, recepcion in bind.execute(sa.select(documentos.c.id, documentos.c.datos, documentos.c.recepcion).where(documentos.c.recepcion.is_not(None))).all():
        bind.execute(documentos.update().where(documentos.c.id == id_).values(datos={**(datos if isinstance(datos, dict) else {}), "recepcion": recepcion}))
