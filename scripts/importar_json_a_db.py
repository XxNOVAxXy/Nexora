"""Importa a la base de datos lo que hoy está en JSON (backend/data): documentos, envíos y eventos.

Se puede repetir sin duplicar:
- documentos: uno por cuenta + message_id + part_id (si ya existe, se actualiza);
- envíos: uno por documento + número de intento;
- eventos: se omite uno idéntico ya importado (misma cuenta, documento, etapa, código, fecha y mensaje).

Todo va en una sola transacción: si algo falla no queda nada a medias. Con ``--simular`` hace todo el trabajo,
muestra qué haría y al final deshace la transacción (no queda nada escrito).

Los archivos JSON se guardan por un hash del correo; el correo se toma de las extracciones guardadas. Si una
carpeta no tiene extracciones, pasa el correo con ``--correo``.

Uso (desde la carpeta del proyecto, con DATABASE_URL y NEXORA_LLAVE_CIFRADO en el .env)::

    python scripts/importar_json_a_db.py --simular
    python scripts/importar_json_a_db.py
    python scripts/importar_json_a_db.py --correo cuenta@ejemplo.com --datos backend/data
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any

RAIZ = Path(__file__).resolve().parents[1]
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

from sqlalchemy.engine import Engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.app.db import crear_motor  # noqa: E402
from backend.app.extracciones import cuenta_id  # noqa: E402
from backend.app.repos.db import CuentasDb, DocumentosDb, EnviosDb, EventosDb  # noqa: E402
from backend.app.seguridad import Cifrador  # noqa: E402

logger = logging.getLogger("nexora.importar")


def _leer_json(ruta: Path) -> Any:
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("Archivo ilegible omitido: %s", ruta.name)
        return None


def correos_conocidos(datos: Path, extra: list[str]) -> dict[str, str]:
    """hash de la cuenta → correo, a partir de las extracciones guardadas y de ``--correo``."""
    correos: dict[str, str] = {}
    for carpeta in sorted((datos / "extracciones").glob("*")) if (datos / "extracciones").is_dir() else []:
        for ruta in sorted(carpeta.glob("*.json")):
            documento = _leer_json(ruta)
            correo = documento.get("cuenta") if isinstance(documento, dict) else None
            if isinstance(correo, str) and correo.strip() and cuenta_id(correo) == carpeta.name:
                correos[carpeta.name] = correo.strip().lower()
                break
    for correo in extra:
        correos[cuenta_id(correo)] = correo.strip().lower()
    return correos


def hashes_con_datos(datos: Path) -> set[str]:
    hashes = {ruta.stem for ruta in (datos / "documentos").glob("*.json")} | {ruta.stem for ruta in (datos / "eventos").glob("*.jsonl")}
    if (datos / "extracciones").is_dir():
        hashes |= {carpeta.name for carpeta in (datos / "extracciones").iterdir() if carpeta.is_dir()}
    return hashes


def importar(motor: Engine, cifrador: Cifrador, datos: Path, *, correos_extra: list[str] | None = None, simular: bool = False) -> dict[str, Any]:
    cuentas_por_hash = correos_conocidos(datos, correos_extra or [])
    conteo: Counter[str] = Counter()
    sin_correo = sorted(hashes_con_datos(datos) - set(cuentas_por_hash))

    with motor.connect() as conexion:
        transaccion = conexion.begin()
        # Cada repositorio abre y cierra sus propias "transacciones": aquí son puntos de guardado dentro de la única
        # transacción del importador, que al final se confirma (o se deshace con --simular).
        sesiones = sessionmaker(bind=conexion, expire_on_commit=False, join_transaction_mode="create_savepoint")
        cuentas = CuentasDb(sesiones, cifrador)
        documentos = DocumentosDb(sesiones, cuentas)
        envios = EnviosDb(sesiones, cuentas)
        eventos = EventosDb(sesiones, cuentas)
        try:
            for hash_cuenta, correo in sorted(cuentas_por_hash.items()):
                existia = cuentas.id_de(correo, crear=False) is not None
                cuentas.id_de(correo)
                conteo["cuentas_existentes" if existia else "cuentas_nuevas"] += 1

                # 1) Documentos recibidos (recepción, diagnóstico y bandeja).
                archivo = _leer_json(datos / "documentos" / f"{hash_cuenta}.json") if (datos / "documentos" / f"{hash_cuenta}.json").exists() else None
                registros = (archivo or {}).get("documentos") if isinstance(archivo, dict) else None
                for registro in (registros or {}).values():
                    if not isinstance(registro, dict) or not registro.get("message_id") or not registro.get("part_id"):
                        continue
                    mid, pid = str(registro["message_id"]), str(registro["part_id"])
                    previo = documentos.obtener(correo, mid, pid)
                    documentos.actualizar(correo, mid, pid, lambda actual, registro=registro: {**(actual or {}), **registro})
                    conteo["documentos_actualizados" if previo else "documentos_nuevos"] += 1

                # 2) Extracciones: documentos de antes de la recepción (sin original), su tipo/estado y sus envíos.
                carpeta = datos / "extracciones" / hash_cuenta
                for ruta in sorted(carpeta.glob("*.json")) if carpeta.is_dir() else []:
                    extraccion = _leer_json(ruta)
                    if not isinstance(extraccion, dict) or not extraccion.get("messageId") or not extraccion.get("partId"):
                        continue
                    mid, pid = str(extraccion["messageId"]), str(extraccion["partId"])
                    if documentos.obtener(correo, mid, pid) is None:
                        documentos.actualizar(correo, mid, pid, lambda _actual, extraccion=extraccion: {
                            "nombre": extraccion.get("filename") or "", "attachment_id": extraccion.get("attachmentId"), "sin_original": True,
                            "guardado_en": extraccion.get("creado"), "actualizado": extraccion.get("actualizado")})
                        conteo["documentos_sin_original"] += 1
                    documentos.anotar_extraccion(correo, mid, pid, extraccion)
                    nuevos, actualizados = envios.sincronizar_contando(correo, mid, pid, list(extraccion.get("envios") or []))
                    conteo["envios_nuevos"] += nuevos
                    conteo["envios_actualizados"] += actualizados

                # 3) Eventos (bitácora JSON Lines).
                ruta_eventos = datos / "eventos" / f"{hash_cuenta}.jsonl"
                lineas = ruta_eventos.read_text(encoding="utf-8").splitlines() if ruta_eventos.exists() else []
                for linea in lineas:
                    try:
                        evento = json.loads(linea)
                    except ValueError:
                        conteo["eventos_ilegibles"] += 1
                        continue
                    if not isinstance(evento, dict) or not evento.get("etapa"):
                        continue
                    try:
                        insertado = eventos.insertar(correo, etapa=str(evento["etapa"]), codigo=str(evento.get("codigo") or ""), mensaje=str(evento.get("mensaje") or ""),
                                                     message_id=evento.get("message_id"), part_id=evento.get("part_id"), fecha=evento.get("fecha"), omitir_repetido=True)
                    except ValueError:
                        conteo["eventos_etapa_desconocida"] += 1
                        continue
                    conteo["eventos_nuevos" if insertado else "eventos_ya_importados"] += 1
        except BaseException:
            transaccion.rollback()
            raise
        if simular:
            transaccion.rollback()
        else:
            transaccion.commit()
    return {"simulado": simular, "conteo": dict(sorted(conteo.items())), "carpetas_sin_correo": sin_correo}


def main(argumentos: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Importa backend/data (JSON) a la base de datos de DATABASE_URL.")
    parser.add_argument("--simular", action="store_true", help="Hace todo y lo deshace al final: muestra qué haría sin escribir nada.")
    parser.add_argument("--datos", type=Path, default=RAIZ / "backend" / "data", help="Carpeta de datos JSON (por defecto backend/data).")
    parser.add_argument("--correo", action="append", default=[], help="Correo de una cuenta cuya carpeta no tiene extracciones (se puede repetir).")
    opciones = parser.parse_args(argumentos)
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    from backend.app.config import settings

    if not opciones.datos.is_dir():
        print(f"No existe la carpeta de datos: {opciones.datos}", file=sys.stderr)
        return 2
    try:
        cifrador = Cifrador(settings.llave_cifrado)
        motor = crear_motor(settings.database_url)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        resultado = importar(motor, cifrador, opciones.datos, correos_extra=opciones.correo, simular=opciones.simular)
    finally:
        motor.dispose()
    print(("SIMULACION (no se escribio nada)" if resultado["simulado"] else "IMPORTACION TERMINADA"))
    for clave, valor in resultado["conteo"].items():
        print(f"  {clave}: {valor}")
    if resultado["carpetas_sin_correo"]:
        print(f"  carpetas sin correo conocido (usa --correo): {len(resultado['carpetas_sin_correo'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
