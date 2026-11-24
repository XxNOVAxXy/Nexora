"""Diagnóstico de SOLO LECTURA de un documento de la tabla ``documentos`` (no escribe nada, no muestra credenciales).

Muestra la fila, las cuentas con su mismo correo (para ver si hay más de una), el estado que calcula Nexora, sus
eventos, los eventos de esa cuenta que quedaron sin documento y el registro del proceso automático.

Uso (desde la carpeta del proyecto, con DATABASE_URL en el .env)::

    python scripts/diagnosticar_documento.py --id 29
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

import sqlalchemy as sa  # noqa: E402

from backend.app.db import CuentaCorreo, Documento, Evento, a_iso, crear_motor  # noqa: E402
from backend.app.extracciones import cuenta_id as hash_cuenta  # noqa: E402
from backend.app.repos.db import registro_desde_fila  # noqa: E402
from backend.app.repos.documentos import estado_y_motivo  # noqa: E402


def main(argumentos: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Diagnóstico de solo lectura de un documento.")
    parser.add_argument("--id", type=int, required=True, help="documentos.id")
    parser.add_argument("--datos", type=Path, default=RAIZ / "backend" / "data", help="Carpeta de datos JSON (registro del proceso automático).")
    opciones = parser.parse_args(argumentos)

    from backend.app.config import settings

    try:
        motor = crear_motor(settings.database_url)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        with motor.connect() as conexion:
            fila = conexion.execute(sa.select(Documento).where(Documento.id == opciones.id)).first()
            if fila is None:
                print(f"No existe documentos.id={opciones.id}")
                return 1
            documento = Documento(**dict(fila._mapping))
            registro = registro_desde_fila(documento)
            print(f"documento id={documento.id} cuenta_id={documento.cuenta_id} message_id={documento.message_id} part_id={documento.part_id}")
            print(f"  columnas: estado={documento.estado!r} motivo={documento.motivo!r} actualizado={a_iso(documento.actualizado)}")
            print(f"  estado que calcula Nexora: {estado_y_motivo(registro)}")
            print(f"  recepcion.proceso={json.dumps(registro.get('proceso'), ensure_ascii=False)}")
            print(f"  recepcion.bandeja={json.dumps(registro.get('bandeja'), ensure_ascii=False)}")

            cuenta = conexion.execute(sa.select(CuentaCorreo.correo).where(CuentaCorreo.id == documento.cuenta_id)).scalar_one()
            correo = cuenta.strip().lower()
            print(f"cuentas con el correo de esta fila (repr para ver espacios): {cuenta!r}")
            mismas = conexion.execute(sa.select(CuentaCorreo.id, CuentaCorreo.usuario_id, CuentaCorreo.activo, CuentaCorreo.correo)
                                      .where(sa.func.lower(sa.func.trim(CuentaCorreo.correo)) == correo).order_by(CuentaCorreo.activo.desc(), CuentaCorreo.id)).all()
            for indice, (id_, usuario_id, activo, texto) in enumerate(mismas):
                print(f"  {'PRINCIPAL ' if indice == 0 else '          '}cuenta id={id_} usuario_id={usuario_id} activo={bool(activo)} correo={texto!r}")
            if len(mismas) > 1 or (mismas and mismas[0][0] != documento.cuenta_id):
                print("  -> AVISO: la cuenta principal de ese correo no es la de esta fila (antes de este arreglo, Nexora no la encontraba).")

            print("eventos del documento:")
            for evento in conexion.execute(sa.select(Evento).where(Evento.documento_id == documento.id).order_by(Evento.fecha, Evento.id)):
                print(f"  {a_iso(evento.fecha)} {evento.etapa} {evento.resultado} {evento.codigo} origen={evento.origen} | {evento.mensaje}")
            sueltos = conexion.execute(sa.select(Evento).where(Evento.documento_id.is_(None), Evento.cuenta_id.in_([m[0] for m in mismas]))
                                       .order_by(Evento.fecha.desc(), Evento.id.desc()).limit(10)).scalars().all()
            if sueltos:
                print("ultimos eventos de la cuenta SIN documento ligado (si aparecen los de este documento, no se encontraba la fila):")
                for evento in sueltos:
                    print(f"  {a_iso(evento.fecha)} {evento.etapa} {evento.resultado} {evento.codigo} | {(evento.mensaje or '')[:120]}")
    finally:
        motor.dispose()

    ruta = opciones.datos / "automatico" / f"{hash_cuenta(correo)}.json"
    clave = f"{documento.message_id}__{documento.part_id}"
    try:
        entrada = (json.loads(ruta.read_text(encoding="utf-8")).get("adjuntos") or {}).get(clave)
    except (OSError, ValueError):
        entrada = None
    print(f"registro del proceso automatico ({clave}):")
    if entrada is None:
        print("  (no hay entrada)")
    else:
        visibles = {k: entrada.get(k) for k in ("estado", "intentos", "causa", "proximo_intento", "error", "enviar_auto")}
        print(f"  {json.dumps(visibles, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
