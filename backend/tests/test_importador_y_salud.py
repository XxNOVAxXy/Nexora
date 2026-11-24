"""Fase 2: importador JSON → base (repetible, --simular), interruptor NEXORA_ALMACEN, cifrado y /api/salud/db.

Todo con SQLite en memoria y datos ficticios escritos en carpetas temporales.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import sqlalchemy as sa
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.almacenamiento import ConfiguracionAlmacenInvalida, Repositorios, _sin_secretos, crear_repositorios, salud_db
from backend.app.db import Base, Documento, Envio, Evento, Usuario, CuentaCorreo, crear_motor
from backend.app.extracciones import AlmacenExtracciones, cuenta_id
from backend.app.repos import DocumentosJson, EnviosJson, EventosJson
from backend.app.repos.db import DocumentosDb, EnviosDb, EventosDb
from backend.app.seguridad import Cifrador, CredencialIlegible, LlaveCifradoInvalida, hash_contrasena, verificar_contrasena
from scripts.importar_json_a_db import importar
from scripts.importar_json_a_db import main as importar_main

EMAIL = "cuenta@example.com"
LLAVE = Fernet.generate_key().decode()


def motor_memoria() -> sa.Engine:
    motor = crear_motor("sqlite://")
    Base.metadata.create_all(motor)
    return motor


def contar(motor: sa.Engine) -> dict[str, int]:
    with motor.connect() as conexion:
        return {modelo.__tablename__: conexion.execute(sa.select(sa.func.count()).select_from(modelo)).scalar_one()
                for modelo in (Usuario, CuentaCorreo, Documento, Envio, Evento)}


def escribir_datos_ficticios(raiz: Path) -> None:
    """backend/data de mentira: 1 documento recibido (en la bandeja), 2 extracciones (una con 2 envíos) y 3 eventos."""
    cuenta = cuenta_id(EMAIL)
    (raiz / "documentos").mkdir(parents=True)
    (raiz / "documentos" / f"{cuenta}.json").write_text(json.dumps({"schema": 1, "documentos": {
        "m1__1": {"message_id": "m1", "part_id": "1", "nombre": "poliza.pdf", "sha256": "d" * 64, "ruta": f"{cuenta}/2026/11/{'d' * 64}.pdf",
                  "tamano": 1234, "recibido_en": "2026-11-20T10:00:00+00:00", "diagnostico": {"codigo": "pdf_protegido", "mensaje": "Protegido."},
                  "bandeja": {"estado": "pendiente", "codigo": "pdf_protegido", "motivo": "PDF con contrasena", "entrada_en": "2026-11-20T10:00:05+00:00"}},
    }}), encoding="utf-8")
    (raiz / "extracciones" / cuenta).mkdir(parents=True)
    cuerpo = json.dumps({"data": json.dumps({"Id": "m2__1", "Tipo": "EC"})})
    (raiz / "extracciones" / cuenta / "m2__1.json").write_text(json.dumps({
        "cuenta": EMAIL, "messageId": "m2", "partId": "1", "filename": "estado.pdf", "estado": "enviado", "version": 2,
        "creado": "2026-10-01T15:00:00+00:00", "actualizado": "2026-10-02T15:00:00+00:00",
        "tipo_documento": {"codigo": "F", "aseguradora": "Afianzadora Ficticia", "estructura": "Predeterminada", "estructura_version": 1},
        "envios": [
            {"id": "a", "accion": "enviar", "iniciado_en": "2026-10-02T15:00:00+00:00", "resultado": "error", "http_status": 500, "respuesta": None, "error": "Falla", "cuerpo": cuerpo, "origen": "manual"},
            {"id": "b", "accion": "enviar", "iniciado_en": "2026-10-02T15:05:00+00:00", "resultado": "exito", "http_status": 200, "respuesta": '{"code":200}', "cuerpo": cuerpo, "origen": "automatico"},
        ],
    }), encoding="utf-8")
    (raiz / "extracciones" / cuenta / "m3__1.json").write_text(json.dumps({"cuenta": EMAIL, "messageId": "m3", "partId": "1", "filename": "b.pdf", "estado": "borrador"}), encoding="utf-8")
    (raiz / "eventos").mkdir(parents=True)
    eventos = [
        {"fecha": "2026-11-20T10:00:00+00:00", "etapa": "lectura", "codigo": "ok", "mensaje": "Leido.", "message_id": "m1", "part_id": "1"},
        {"fecha": "2026-11-20T10:00:00+00:00", "etapa": "diagnostico", "codigo": "pdf_protegido", "mensaje": "Protegido.", "message_id": "m1", "part_id": "1"},
        {"fecha": "2026-11-20T10:05:00+00:00", "etapa": "envio", "codigo": "exito", "mensaje": "Enviado.", "message_id": "m2", "part_id": "1"},
    ]
    (raiz / "eventos" / f"{cuenta}.jsonl").write_text("\n".join(json.dumps(e) for e in eventos) + "\n{linea cortada", encoding="utf-8")
    # Carpeta de otra cuenta sin extracciones: no se sabe su correo.
    (raiz / "eventos" / "0123456789abcdef.jsonl").write_text(json.dumps(eventos[0]) + "\n", encoding="utf-8")


class Importador(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.datos = Path(self.tmp.name)
        escribir_datos_ficticios(self.datos)
        self.motor = motor_memoria()
        self.cifrador = Cifrador(LLAVE)

    def tearDown(self) -> None:
        self.motor.dispose()
        self.tmp.cleanup()

    def test_simular_no_escribe_nada(self) -> None:
        resultado = importar(self.motor, self.cifrador, self.datos, simular=True)
        self.assertTrue(resultado["simulado"])
        self.assertEqual(resultado["conteo"]["documentos_nuevos"], 1)
        self.assertEqual(resultado["conteo"]["envios_nuevos"], 2)
        self.assertEqual(contar(self.motor), {"usuarios": 0, "cuentas_correo": 0, "documentos": 0, "envios": 0, "eventos": 0})

    def test_importa_y_repetir_no_duplica(self) -> None:
        primero = importar(self.motor, self.cifrador, self.datos)
        self.assertEqual(primero["conteo"], {"cuentas_nuevas": 1, "documentos_nuevos": 1, "documentos_sin_original": 2, "envios_nuevos": 2,
                                             "envios_actualizados": 0, "eventos_nuevos": 3, "eventos_ilegibles": 1})
        self.assertEqual(primero["carpetas_sin_correo"], ["0123456789abcdef"])
        esperado = {"usuarios": 1, "cuentas_correo": 1, "documentos": 3, "envios": 2, "eventos": 3}
        self.assertEqual(contar(self.motor), esperado)

        segundo = importar(self.motor, self.cifrador, self.datos)
        self.assertEqual(contar(self.motor), esperado)
        self.assertEqual((segundo["conteo"]["documentos_actualizados"], segundo["conteo"]["eventos_ya_importados"], segundo["conteo"]["envios_nuevos"]), (1, 3, 0))

        with self.motor.connect() as conexion:
            documentos = {fila.message_id: fila for fila in conexion.execute(sa.select(Documento))}
            envios = conexion.execute(sa.select(Envio.intento, Envio.estado, Envio.origen, Envio.codigo_http).order_by(Envio.intento)).all()
            ligados = conexion.execute(sa.select(sa.func.count()).select_from(Evento).where(Evento.documento_id.is_not(None))).scalar_one()
        self.assertEqual((documentos["m1"].estado, documentos["m1"].motivo), ("captura_manual", "pdf_protegido"))
        self.assertEqual((documentos["m2"].estado, documentos["m2"].tipo, documentos["m2"].aseguradora, documentos["m2"].version), ("enviado", "F", "Afianzadora Ficticia", 1))
        self.assertEqual((documentos["m2"].ruta_original, documentos["m2"].datos["recepcion"]["sin_original"]), ("", True))
        self.assertEqual(documentos["m3"].estado, "extraido")
        self.assertEqual([tuple(e) for e in envios], [(1, "error", "manual", 500), (2, "enviado", "automatico", 200)])
        self.assertEqual(ligados, 3)

    def test_correo_explicito_importa_la_carpeta_sin_extracciones(self) -> None:
        resultado = importar(self.motor, self.cifrador, self.datos, correos_extra=["otra@example.com"])
        self.assertEqual(resultado["carpetas_sin_correo"], ["0123456789abcdef"])  # el hash de "otra" no es ese
        self.assertEqual(contar(self.motor)["cuentas_correo"], 2)

    def test_un_error_deshace_todo(self) -> None:
        with patch.object(EventosDb, "insertar", side_effect=RuntimeError("falla a la mitad")):
            with self.assertRaises(RuntimeError):
                importar(self.motor, self.cifrador, self.datos)
        self.assertEqual(contar(self.motor)["documentos"], 0)

    def test_linea_de_comandos_pide_la_configuracion(self) -> None:
        from backend.app.config import Settings

        with patch("backend.app.config.settings", Settings(llave_cifrado="", database_url="")):
            self.assertEqual(importar_main(["--simular", "--datos", str(self.datos)]), 2)


class Seguridad(unittest.TestCase):
    def test_fernet(self) -> None:
        cifrador = Cifrador(LLAVE)
        token = cifrador.cifrar("secreto ficticio")
        self.assertNotIn("secreto", token)
        self.assertEqual(cifrador.descifrar(token), "secreto ficticio")
        with self.assertRaises(CredencialIlegible):
            Cifrador(Fernet.generate_key().decode()).descifrar(token)

    def test_llave_faltante_o_invalida(self) -> None:
        with self.assertRaisesRegex(LlaveCifradoInvalida, "NEXORA_LLAVE_CIFRADO"):
            Cifrador("")
        with self.assertRaisesRegex(LlaveCifradoInvalida, "no es una llave Fernet"):
            Cifrador("no-es-una-llave")

    def test_hash_argon2(self) -> None:
        guardado = hash_contrasena("contrasena-ficticia")
        self.assertTrue(guardado.startswith("$argon2id$"))
        self.assertNotIn("contrasena-ficticia", guardado)
        self.assertNotEqual(guardado, hash_contrasena("contrasena-ficticia"))  # con sal
        self.assertTrue(verificar_contrasena(guardado, "contrasena-ficticia"))
        self.assertFalse(verificar_contrasena(guardado, "otra"))
        self.assertFalse(verificar_contrasena("no-es-un-hash", "x"))


class Interruptor(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def crear(self, modo: str, **opciones: Any) -> Repositorios:
        return crear_repositorios(modo, almacen=self.almacen, documentos_path=self.raiz / "d", eventos_path=self.raiz / "e", **opciones)

    def test_por_defecto_json(self) -> None:
        for modo in ("json", "", "JSON"):
            repos = self.crear(modo)
            self.assertEqual(repos.modo, "json")
            self.assertIsInstance(repos.documentos, DocumentosJson)
            self.assertIsInstance(repos.eventos, EventosJson)
            self.assertIsInstance(repos.envios, EnviosJson)
            self.assertIsNone(repos.motor)
        self.assertEqual(main.repositorios.modo, "json")

    def test_db_sin_llave_no_arranca(self) -> None:
        with self.assertRaisesRegex(ConfiguracionAlmacenInvalida, "NEXORA_LLAVE_CIFRADO"):
            self.crear("db", database_url="sqlite://", llave_cifrado="")

    def test_db_sin_url_no_arranca(self) -> None:
        with self.assertRaisesRegex(ConfiguracionAlmacenInvalida, "DATABASE_URL"):
            self.crear("db", database_url="", llave_cifrado=LLAVE)

    def test_modo_desconocido(self) -> None:
        with self.assertRaisesRegex(ConfiguracionAlmacenInvalida, "json' o 'db'"):
            self.crear("mysql")

    def test_db_usa_los_tres_repositorios_db(self) -> None:
        repos = self.crear("db", database_url="sqlite://", llave_cifrado=LLAVE)
        try:
            self.assertIsInstance(repos.documentos, DocumentosDb)
            self.assertIsInstance(repos.eventos, EventosDb)
            self.assertIsInstance(repos.envios, EnviosDb)
        finally:
            repos.motor.dispose()


class SaludDb(unittest.TestCase):
    def test_sin_url(self) -> None:
        self.assertEqual(salud_db(None, "")["configurada"], False)

    def test_cuenta_registros_por_tabla(self) -> None:
        motor = motor_memoria()
        try:
            with motor.begin() as conexion:
                conexion.execute(sa.text("INSERT INTO usuarios (usuario, nombre, hash_contrasena) VALUES ('u', 'U', 'x')"))
            salud = salud_db(motor)
        finally:
            motor.dispose()
        self.assertTrue(salud["conectado"])
        self.assertEqual(salud["tablas"], {"usuarios": 1, "cuentas_correo": 0, "documentos": 0, "envios": 0, "eventos": 0})
        self.assertEqual(salud["faltan_tablas"], [])
        self.assertTrue(salud["hora_base_utc"].endswith("+00:00"))

    def test_avisa_si_faltan_tablas(self) -> None:
        motor = crear_motor("sqlite://")
        try:
            salud = salud_db(motor)
        finally:
            motor.dispose()
        self.assertTrue(salud["conectado"])
        self.assertEqual(len(salud["faltan_tablas"]), 5)

    def test_no_conecta(self) -> None:
        salud = salud_db(None, "sqlite:///Z:/no/existe/carpeta/nexora.db")
        self.assertEqual((salud["conectado"], salud["configurada"]), (False, True))

    def test_nunca_muestra_la_contrasena(self) -> None:
        texto = _sin_secretos("Access denied for nexora_app (password secreto123)", "mysql+pymysql://nexora_app:secreto123@localhost:3306/nexora")
        self.assertNotIn("secreto123", texto)

    def test_endpoint(self) -> None:
        motor = motor_memoria()
        repos = Repositorios("db", main.repositorios.documentos, main.repositorios.eventos, main.repositorios.envios, motor)
        try:
            with patch.object(main, "repositorios", repos):
                respuesta = TestClient(main.app).get("/api/salud/db")
        finally:
            motor.dispose()
        self.assertEqual(respuesta.status_code, 200)
        cuerpo = respuesta.json()
        self.assertEqual((cuerpo["almacen"], cuerpo["conectado"], cuerpo["tablas"]["documentos"]), ("db", True, 0))
        self.assertNotIn("url", json.dumps(cuerpo).lower().replace("configurada", ""))

    def test_endpoint_en_json_sin_base(self) -> None:
        cuerpo = TestClient(main.app).get("/api/salud/db").json()
        self.assertEqual((cuerpo["almacen"], cuerpo["conectado"], cuerpo["configurada"]), ("json", False, False))


if __name__ == "__main__":
    unittest.main()
