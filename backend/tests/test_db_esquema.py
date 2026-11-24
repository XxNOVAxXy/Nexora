"""Fase 2: los modelos coinciden EXACTAMENTE con docs/db/nexora_esquema_mysql.sql y la migración baseline.

El script SQL se lee y se compara columna por columna (tipo, longitud, nulos, default), con sus restricciones
únicas, llaves foráneas e índices. Alembic se prueba sobre SQLite en memoria (nunca la base real).
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext

from backend.app.db import NOMBRES_TABLAS, Base, crear_motor

RAIZ = Path(__file__).resolve().parents[2]
ESQUEMA = RAIZ / "docs" / "db" / "nexora_esquema_mysql.sql"
HEAD = "0002_recepcion_origen_detalle"

TIPOS = {"BIGINT": sa.BigInteger, "VARCHAR": sa.String, "CHAR": sa.CHAR, "TEXT": sa.Text, "BOOLEAN": sa.Boolean,
         "DATETIME": sa.DateTime, "INT": sa.Integer, "JSON": sa.JSON}


def leer_esquema() -> dict[str, dict]:
    """{tabla: {columnas: [(nombre, tipo, longitud, nulo, default)], unicas: {...}, foraneas: {...}, indices: {...}}}."""
    sql = re.sub(r"--[^\n]*", "", ESQUEMA.read_text(encoding="utf-8"))
    tablas: dict[str, dict] = {}
    for nombre, cuerpo in re.findall(r"CREATE TABLE (\w+) \((.*?)\n\);", sql, flags=re.S):
        tabla = {"columnas": [], "unicas": {}, "foraneas": {}, "indices": {}}
        for linea in (parte.strip().rstrip(",") for parte in cuerpo.strip().split("\n")):
            if not linea:
                continue
            if linea.startswith("CONSTRAINT"):
                if unica := re.match(r"CONSTRAINT\s+(\w+)\s+UNIQUE\s*\(([^)]*)\)", linea):
                    tabla["unicas"][unica[1]] = [c.strip() for c in unica[2].split(",")]
                elif foranea := re.match(r"CONSTRAINT\s+(\w+)\s+FOREIGN KEY\s*\((\w+)\)\s+REFERENCES\s+(\w+)\((\w+)\)", linea):
                    tabla["foraneas"][foranea[1]] = (foranea[2], f"{foranea[3]}.{foranea[4]}")
                else:
                    raise AssertionError(f"Restriccion no reconocida: {linea}")
                continue
            columna = re.match(r"(\w+)\s+([A-Z]+)(?:\((\d+)\))?\s*(.*)$", linea)
            assert columna, linea
            resto = columna[4]
            nulo = not ("NOT NULL" in resto or "PRIMARY KEY" in resto)
            default = re.search(r"DEFAULT (\S+)", resto)
            tabla["columnas"].append((columna[1], columna[2], int(columna[3]) if columna[3] else None, nulo, default[1] if default else None))
        tablas[nombre] = tabla
    for nombre, tabla, columnas in re.findall(r"CREATE INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\);", sql):
        tablas[tabla]["indices"][nombre] = [c.strip() for c in columnas.split(",")]
    return tablas


class ModelosIgualAlEsquema(unittest.TestCase):
    def setUp(self) -> None:
        self.esquema = leer_esquema()

    def test_mismas_tablas(self) -> None:
        self.assertEqual(sorted(self.esquema), sorted(NOMBRES_TABLAS))
        self.assertEqual(sorted(Base.metadata.tables), sorted(NOMBRES_TABLAS))

    def test_columnas_tipos_longitudes_nulos_y_defaults(self) -> None:
        for nombre, tabla in self.esquema.items():
            modelo = Base.metadata.tables[nombre]
            with self.subTest(tabla=nombre):
                self.assertEqual([c[0] for c in tabla["columnas"]], [c.name for c in modelo.columns], "mismas columnas y en el mismo orden")
            for columna, tipo, longitud, nulo, default in tabla["columnas"]:
                definida = modelo.columns[columna]
                with self.subTest(tabla=nombre, columna=columna):
                    self.assertIsInstance(definida.type, TIPOS[tipo])
                    if tipo in {"VARCHAR", "CHAR"}:
                        self.assertEqual(definida.type.length, longitud)
                    self.assertEqual(definida.nullable, nulo)
                    if columna == "id":
                        self.assertTrue(definida.primary_key and definida.autoincrement)
                        continue
                    self.assertEqual(definida.server_default is not None, default is not None, "default del servidor")
                    if default is not None:
                        esperado = {"TRUE": "true", "FALSE": "false"}.get(default, default)
                        texto = str(getattr(definida.server_default.arg, "text", definida.server_default.arg)).lower()
                        self.assertIn(esperado.lower().strip("'"), texto)

    def test_unicas_foraneas_e_indices(self) -> None:
        for nombre, tabla in self.esquema.items():
            modelo = Base.metadata.tables[nombre]
            with self.subTest(tabla=nombre):
                unicas = {r.name: [c.name for c in r.columns] for r in modelo.constraints if isinstance(r, sa.UniqueConstraint)}
                self.assertEqual(unicas, tabla["unicas"])
                foraneas = {f.constraint.name: (f.parent.name, f.target_fullname) for f in modelo.foreign_keys}
                self.assertEqual(foraneas, tabla["foraneas"])
                indices = {i.name: [c.name for c in i.columns] for i in modelo.indexes}
                self.assertEqual(indices, tabla["indices"])

    def test_solo_tipos_genericos(self) -> None:
        # Nada de tipos de un dialecto (mysql.TINYINT, postgresql.JSONB...): el mismo modelo sirve en MySQL y PostgreSQL.
        for tabla in Base.metadata.tables.values():
            for columna in tabla.columns:
                tipos = [columna.type, *getattr(columna.type, "_variant_mapping", {}).values()]
                for tipo in tipos:
                    with self.subTest(columna=f"{tabla.name}.{columna.name}"):
                        self.assertTrue(type(tipo).__module__.startswith("sqlalchemy.sql"), type(tipo).__module__)


def configuracion_alembic(conexion: sa.Connection) -> Config:
    config = Config(str(RAIZ / "backend" / "alembic.ini"))
    config.attributes["connection"] = conexion
    return config


class MigracionBaseline(unittest.TestCase):
    def setUp(self) -> None:
        self.motor = crear_motor("sqlite://")

    def tearDown(self) -> None:
        self.motor.dispose()

    def test_en_base_vacia_crea_lo_mismo_que_los_modelos(self) -> None:
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
            diferencias = compare_metadata(MigrationContext.configure(conexion, opts={"compare_type": True}), Base.metadata)
            self.assertEqual(diferencias, [])
            self.assertEqual(conexion.execute(sa.text("SELECT version_num FROM alembic_version")).scalar(), HEAD)

    def test_con_tablas_existentes_no_recrea_ni_borra(self) -> None:
        Base.metadata.create_all(self.motor)
        with self.motor.begin() as conexion:
            conexion.execute(sa.text("INSERT INTO usuarios (usuario, nombre, hash_contrasena) VALUES ('u', 'U', 'x')"))
        with self.motor.begin() as conexion:
            with self.assertRaisesRegex(RuntimeError, "stamp head"):
                command.upgrade(configuracion_alembic(conexion), "head")
        with self.motor.connect() as conexion:
            self.assertEqual(conexion.execute(sa.text("SELECT COUNT(*) FROM usuarios")).scalar(), 1)

    def test_stamp_solo_marca_la_version(self) -> None:
        Base.metadata.create_all(self.motor)
        with self.motor.begin() as conexion:
            conexion.execute(sa.text("INSERT INTO usuarios (usuario, nombre, hash_contrasena) VALUES ('u', 'U', 'x')"))
            command.stamp(configuracion_alembic(conexion), "head")
        with self.motor.connect() as conexion:
            self.assertEqual(conexion.execute(sa.text("SELECT version_num FROM alembic_version")).scalar(), HEAD)
            self.assertEqual(conexion.execute(sa.text("SELECT COUNT(*) FROM usuarios")).scalar(), 1)
            self.assertEqual(sorted(set(sa.inspect(conexion).get_table_names()) - {"alembic_version"}), sorted(NOMBRES_TABLAS))

    def test_downgrade_nunca_borra_tablas(self) -> None:
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
        with self.motor.begin() as conexion:
            with self.assertRaisesRegex(RuntimeError, "no se deshace"):
                command.downgrade(configuracion_alembic(conexion), "base")
        with self.motor.connect() as conexion:
            self.assertTrue(set(NOMBRES_TABLAS) <= set(sa.inspect(conexion).get_table_names()))


class Migracion0002(unittest.TestCase):
    """Tu base: tablas creadas a mano (= baseline), marcada con stamp, con datos de la Fase 2; luego upgrade head."""

    def setUp(self) -> None:
        self.motor = crear_motor("sqlite://")
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "0001_baseline")
            conexion.execute(sa.text("INSERT INTO usuarios (id, usuario, nombre, hash_contrasena) VALUES (1, 'sistema', 'S', 'x')"))
            conexion.execute(sa.text("INSERT INTO cuentas_correo (id, usuario_id, proveedor, correo, credencial_cifrada) VALUES (1, 1, 'gmail', 'a@example.com', 'c')"))
            conexion.execute(sa.text("INSERT INTO documentos (id, cuenta_id, message_id, part_id, nombre_archivo, ruta_original, sha256, estado, datos) "
                                     "VALUES (1, 1, 'm1', '1', 'a.pdf', 'r', :sha, 'captura_manual', :datos)"),
                             {"sha": "a" * 64, "datos": json.dumps({"recepcion": {"mime": "application/pdf", "bandeja": {"estado": "pendiente"}}})})
            conexion.execute(sa.text("INSERT INTO documentos (id, cuenta_id, message_id, part_id, nombre_archivo, ruta_original, sha256, datos) "
                                     "VALUES (2, 1, 'm2', '1', 'b.pdf', 'r', :sha, :datos)"),
                             {"sha": "b" * 64, "datos": json.dumps({"recepcion": {"mime": "image/png"}, "Id": "m2__1"})})
            conexion.execute(sa.text("INSERT INTO eventos (documento_id, cuenta_id, etapa, resultado, codigo, mensaje) VALUES (1, 1, 'lectura', 'ok', 'ok', 'x')"))

    def tearDown(self) -> None:
        self.motor.dispose()

    def columnas(self, conexion: sa.Connection, tabla: str) -> list[str]:
        return [columna["name"] for columna in sa.inspect(conexion).get_columns(tabla)]

    def test_agrega_columnas_y_mueve_la_recepcion_sin_perder_nada(self) -> None:
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
        with self.motor.connect() as conexion:
            self.assertEqual(conexion.execute(sa.text("SELECT version_num FROM alembic_version")).scalar(), HEAD)
            self.assertEqual(self.columnas(conexion, "documentos")[-1], "recepcion")
            self.assertEqual(self.columnas(conexion, "eventos")[-2:], ["origen", "detalle"])
            filas = {fila.id: (json.loads(fila.datos) if fila.datos else None, json.loads(fila.recepcion)) for fila in conexion.execute(sa.text("SELECT id, datos, recepcion FROM documentos"))}
            self.assertEqual(filas[1], (None, {"mime": "application/pdf", "bandeja": {"estado": "pendiente"}}))
            # Lo que no era de la recepción se queda en datos.
            self.assertEqual(filas[2], ({"Id": "m2__1"}, {"mime": "image/png"}))
            self.assertEqual(conexion.execute(sa.text("SELECT estado FROM documentos WHERE id = 1")).scalar(), "captura_manual")
            self.assertEqual(conexion.execute(sa.text("SELECT COUNT(*), MAX(origen) FROM eventos")).one(), (1, None))
            diferencias = compare_metadata(MigrationContext.configure(conexion, opts={"compare_type": True}), Base.metadata)
            self.assertEqual(diferencias, [])

    def test_aplicarla_dos_veces_no_hace_nada(self) -> None:
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
            self.assertEqual(self.columnas(conexion, "eventos").count("origen"), 1)

    def test_downgrade_a_la_baseline_devuelve_la_recepcion_a_datos(self) -> None:
        with self.motor.begin() as conexion:
            command.upgrade(configuracion_alembic(conexion), "head")
        with self.motor.begin() as conexion:
            command.downgrade(configuracion_alembic(conexion), "0001_baseline")
        with self.motor.connect() as conexion:
            self.assertNotIn("recepcion", self.columnas(conexion, "documentos"))
            self.assertNotIn("origen", self.columnas(conexion, "eventos"))
            datos = json.loads(conexion.execute(sa.text("SELECT datos FROM documentos WHERE id = 2")).scalar())
            self.assertEqual(datos, {"Id": "m2__1", "recepcion": {"mime": "image/png"}})


if __name__ == "__main__":
    unittest.main()
