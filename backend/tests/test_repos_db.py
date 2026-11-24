"""Fase 2: repositorios en base de datos con la misma interfaz y el mismo comportamiento que los de JSON.

Las mismas pruebas corren contra JSON (archivos temporales) y contra la base (SQLite en memoria). Nunca MySQL real.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from cryptography.fernet import Fernet

from backend.app.db import Base, CuentaCorreo, Documento, Envio, Evento, Usuario, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest
from backend.app.originales import AlmacenOriginales
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.repos.db import USUARIO_SISTEMA, CuentasDb, DocumentosDb, EnviosDb, EventosDb, resultado_de
from backend.app.savedata import EnvioRequest, RespuestaSaveData, ServicioEnvio
from backend.app.seguridad import Cifrador, verificar_contrasena
from backend.tests.pdf_ficticio import pdf_con_texto, pdf_protegido

EMAIL = "Cuenta@Example.com"
INICIO = datetime(2026, 11, 20, 18, 0, tzinfo=timezone.utc)
LLAVE = Fernet.generate_key().decode()


def motor_memoria() -> sa.Engine:
    motor = crear_motor("sqlite://")
    Base.metadata.create_all(motor)
    return motor


class Contrato:
    """Pruebas del contrato de los repositorios; cada subclase da la implementación (JSON o db)."""

    documentos: Any
    eventos: Any

    def reloj(self) -> datetime:
        return self.ahora

    def test_actualizar_crea_y_luego_modifica(self) -> None:
        self.assertIsNone(self.documentos.obtener(EMAIL, "m1", "1"))
        creado = self.documentos.actualizar(EMAIL, "m1", "1", lambda previo: {"nombre": "a.pdf", "sha256": "a" * 64, "ruta": "x/a.pdf", "tamano": 10,
                                                                             "recibido_en": "2026-11-20T12:00:00+00:00", "asunto": "Póliza", "remitente": "x@y.com",
                                                                             "diagnostico": {"codigo": "ok", "mensaje": "Se puede extraer."}, "previo": previo})
        self.assertEqual((creado["message_id"], creado["part_id"], creado["nombre"], creado["previo"]), ("m1", "1", "a.pdf", None))
        modificado = self.documentos.actualizar(EMAIL, "m1", "1", lambda previo: {**previo, "asunto": "Otra"})
        self.assertEqual((modificado["asunto"], modificado["sha256"], modificado["tamano"]), ("Otra", "a" * 64, 10))
        leido = self.documentos.obtener(EMAIL, "m1", "1")
        self.assertEqual((leido["asunto"], leido["diagnostico"]["codigo"], leido["recibido_en"]), ("Otra", "ok", "2026-11-20T12:00:00+00:00"))

    def test_un_error_en_el_cambio_no_guarda_nada(self) -> None:
        def falla(_previo: Any) -> dict[str, Any]:
            raise ValueError("no")
        with self.assertRaises(ValueError):
            self.documentos.actualizar(EMAIL, "m1", "1", falla)
        self.assertIsNone(self.documentos.obtener(EMAIL, "m1", "1"))

    def test_buscar_sha256_solo_con_original(self) -> None:
        self.documentos.actualizar(EMAIL, "m1", "1", lambda _p: {"nombre": "a.pdf", "sha256": "b" * 64, "ruta": None})
        self.assertIsNone(self.documentos.buscar_sha256(EMAIL, "b" * 64))
        self.documentos.actualizar(EMAIL, "m2", "1", lambda _p: {"nombre": "a.pdf", "sha256": "b" * 64, "ruta": "c/b.pdf"})
        self.assertEqual(self.documentos.buscar_sha256(EMAIL, "b" * 64)["message_id"], "m2")
        self.assertIsNone(self.documentos.buscar_sha256("otra@example.com", "b" * 64))

    def test_listar_por_estado_de_bandeja(self) -> None:
        self.documentos.actualizar(EMAIL, "m1", "1", lambda _p: {"nombre": "a", "bandeja": {"estado": "pendiente", "codigo": "pdf_protegido"}})
        self.documentos.actualizar(EMAIL, "m2", "1", lambda _p: {"nombre": "b", "bandeja": {"estado": "resuelto", "codigo": "pdf_danado"}})
        self.documentos.actualizar(EMAIL, "m3", "1", lambda _p: {"nombre": "c"})
        self.assertEqual(len(self.documentos.listar(EMAIL)), 3)
        self.assertEqual([r["message_id"] for r in self.documentos.listar(EMAIL, bandeja="pendiente")], ["m1"])
        self.assertEqual([r["message_id"] for r in self.documentos.listar(EMAIL, bandeja="resuelto")], ["m2"])
        self.assertEqual(self.documentos.listar("otra@example.com"), [])

    def test_eventos_filtros_orden_y_limite(self) -> None:
        self.documentos.actualizar(EMAIL, "m1", "1", lambda _p: {"nombre": "a"})
        self.documentos.actualizar(EMAIL, "m2", "1", lambda _p: {"nombre": "b"})
        self.eventos.registrar(EMAIL, etapa="lectura", codigo="ok", mensaje="leido", message_id="m1", part_id="1", origen="automatico")
        self.ahora += timedelta(minutes=1)
        self.eventos.registrar(EMAIL, etapa="diagnostico", codigo="pdf_protegido", mensaje="x", message_id="m1", part_id="1")
        self.ahora += timedelta(minutes=1)
        evento = self.eventos.registrar(EMAIL, etapa="extraccion", codigo="ok", mensaje="y", message_id="m2", part_id="1")
        self.assertEqual((evento["etapa"], evento["fecha"]), ("extraccion", "2026-11-20T18:02:00+00:00"))
        self.assertEqual([e["etapa"] for e in self.eventos.listar(EMAIL)], ["extraccion", "diagnostico", "lectura"])
        self.assertEqual([e["etapa"] for e in self.eventos.listar(EMAIL, message_id="m1", part_id="1")], ["diagnostico", "lectura"])
        self.assertEqual([e["codigo"] for e in self.eventos.listar(EMAIL, etapa="diagnostico")], ["pdf_protegido"])
        self.assertEqual(len(self.eventos.listar(EMAIL, desde="2026-11-20T18:01:00+00:00")), 2)
        self.assertEqual(len(self.eventos.listar(EMAIL, hasta="2026-11-20T18:00:00+00:00")), 1)
        self.assertEqual(len(self.eventos.listar(EMAIL, limite=1)), 1)
        self.assertEqual(self.eventos.listar("otra@example.com"), [])
        with self.assertRaises(ValueError):
            self.eventos.registrar(EMAIL, etapa="inventada", codigo="ok", mensaje="")

    def test_recepcion_completa_con_bandeja(self) -> None:
        recepcion = ServicioRecepcion(self.documentos, self.eventos, AlmacenOriginales(Path(self.tmp.name) / "originales"), reloj=self.reloj)
        protegido = pdf_protegido()
        recepcion.recibir(EMAIL, message_id="m1", part_id="1", data=protegido, mime_type="application/pdf", filename="p.pdf",
                          recibido_en="2026-11-20T10:00:00+00:00", asunto="Póliza", remitente="aseguradora@example.com")
        recepcion.recibir(EMAIL, message_id="m2", part_id="1", data=pdf_con_texto(), mime_type="application/pdf", filename="ok.pdf")
        self.assertEqual([r["message_id"] for r in recepcion.bandeja(EMAIL)], ["m1"])
        self.assertEqual(recepcion.bandeja(EMAIL)[0]["bandeja"]["codigo"], "pdf_protegido")
        self.assertEqual(recepcion.original(EMAIL, "m1", "1")[0], protegido)
        self.assertEqual(sorted((e["etapa"], e["codigo"]) for e in self.eventos.listar(EMAIL, message_id="m1")), [("diagnostico", "pdf_protegido"), ("lectura", "ok")])
        self.assertIsNotNone(recepcion.resolver(EMAIL, "m1", "1", "capturado_a_mano"))
        self.assertEqual(recepcion.bandeja(EMAIL), [])
        self.assertEqual(recepcion.bandeja(EMAIL, "resuelto")[0]["bandeja"]["resolucion"], "capturado_a_mano")


class ContratoJson(Contrato, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ahora = INICIO
        self.documentos = DocumentosJson(Path(self.tmp.name) / "documentos")
        self.eventos = EventosJson(Path(self.tmp.name) / "eventos", reloj=self.reloj)

    def tearDown(self) -> None:
        self.tmp.cleanup()


class ContratoDb(Contrato, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ahora = INICIO
        self.motor = motor_memoria()
        self.sesiones = fabrica_sesiones(self.motor)
        self.cuentas = CuentasDb(self.sesiones, Cifrador(LLAVE), credencial_de=lambda _email: '{"token": "ficticio"}')
        self.documentos = DocumentosDb(self.sesiones, self.cuentas)
        self.eventos = EventosDb(self.sesiones, self.cuentas, reloj=self.reloj)

    def tearDown(self) -> None:
        self.motor.dispose()
        self.tmp.cleanup()

    def filas(self, modelo: Any) -> list[Any]:
        with self.sesiones() as sesion:
            return list(sesion.scalars(sa.select(modelo).order_by(modelo.id)))

    def test_cuenta_y_usuario_sistema_se_crean_una_vez(self) -> None:
        self.documentos.actualizar(EMAIL, "m1", "1", lambda _p: {"nombre": "a"})
        self.documentos.actualizar(EMAIL.lower(), "m2", "1", lambda _p: {"nombre": "b"})
        [cuenta] = self.filas(CuentaCorreo)
        [usuario] = self.filas(Usuario)
        self.assertEqual((cuenta.correo, cuenta.proveedor, cuenta.usuario_id), ("cuenta@example.com", "gmail", usuario.id))
        # Credencial cifrada con Fernet: no está en claro y se descifra con la llave.
        self.assertNotIn("ficticio", cuenta.credencial_cifrada)
        self.assertEqual(Cifrador(LLAVE).descifrar(cuenta.credencial_cifrada), '{"token": "ficticio"}')
        self.assertEqual((usuario.usuario, usuario.activo), (USUARIO_SISTEMA, False))
        self.assertTrue(usuario.hash_contrasena.startswith("$argon2id$"))
        self.assertFalse(verificar_contrasena(usuario.hash_contrasena, ""))

    def test_leer_no_crea_cuentas(self) -> None:
        self.assertIsNone(self.documentos.obtener(EMAIL, "m1", "1"))
        self.assertEqual(self.eventos.listar(EMAIL), [])
        self.assertEqual(self.filas(CuentaCorreo), [])

    def test_columnas_del_esquema(self) -> None:
        recepcion = ServicioRecepcion(self.documentos, self.eventos, AlmacenOriginales(Path(self.tmp.name) / "originales"), reloj=self.reloj)
        protegido = pdf_protegido()
        recepcion.recibir(EMAIL, message_id="m1", part_id="1", data=protegido, mime_type="application/pdf", filename="p.pdf",
                          recibido_en="2026-11-20T04:00:00-06:00", asunto="Póliza", remitente="aseguradora@example.com", attachment_id="att-1")
        [fila] = self.filas(Documento)
        self.assertEqual((fila.estado, fila.motivo, fila.nombre_archivo, fila.tamano_bytes), ("captura_manual", "pdf_protegido", "p.pdf", len(protegido)))
        self.assertEqual(len(fila.sha256), 64)
        self.assertTrue(fila.ruta_original.endswith(".pdf"))
        # Fecha del correo en UTC (llegó con -06:00).
        self.assertEqual(fila.fecha_correo, datetime(2026, 11, 20, 10, 0))
        self.assertEqual(fila.creado, INICIO.replace(tzinfo=None))
        self.assertEqual(fila.datos["recepcion"]["attachment_id"], "att-1")
        self.assertEqual(fila.datos["recepcion"]["bandeja"]["estado"], "pendiente")
        recepcion.resolver(EMAIL, "m1", "1", "extraido")
        self.assertEqual(self.filas(Documento)[0].estado, "extraido")
        eventos = {(e.etapa, e.resultado, e.codigo, e.documento_id) for e in self.filas(Evento)}
        self.assertEqual(eventos, {("lectura", "ok", "ok", fila.id), ("diagnostico", "error", "pdf_protegido", fila.id)})

    def test_resultado_del_evento(self) -> None:
        self.assertEqual([resultado_de(c) for c in ("ok", "exito", "pdf_escaneado", "pdf_protegido", "error")], ["ok", "ok", "aviso", "error", "error"])

    def test_evento_de_cuenta_sin_documento(self) -> None:
        self.eventos.registrar(EMAIL, etapa="lectura", codigo="sin_conexion", mensaje="Gmail no responde")
        [evento] = self.filas(Evento)
        self.assertEqual((evento.documento_id, evento.resultado), (None, "error"))
        self.assertIsNotNone(evento.cuenta_id)


class EnviosEnLaBase(unittest.TestCase):
    """El envío a SaveData de siempre, con el almacén de extracciones avisando a EnviosDb."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.motor = motor_memoria()
        self.sesiones = fabrica_sesiones(self.motor)
        cuentas = CuentasDb(self.sesiones, Cifrador(LLAVE))
        self.documentos = DocumentosDb(self.sesiones, cuentas)
        self.envios = EnviosDb(self.sesiones, cuentas)
        self.almacen = AlmacenExtracciones(Path(self.tmp.name))
        self.almacen.envios = self.envios
        self.respuestas = [RespuestaSaveData("exito", 200, '{"code":200}', ""), RespuestaSaveData("incierto", None, None, "Tiempo agotado")]
        self.servicio = ServicioEnvio(self.almacen, lambda: "https://savedata.invalid/api", cliente=lambda _u, _c, _t: self.respuestas.pop(0))
        self.documentos.actualizar(EMAIL, "m1", "1", lambda _p: {"nombre": "e.pdf", "sha256": "c" * 64, "ruta": "x/e.pdf"})

    def tearDown(self) -> None:
        self.motor.dispose()
        self.tmp.cleanup()

    def filas(self) -> list[Envio]:
        with self.sesiones() as sesion:
            return list(sesion.scalars(sa.select(Envio).order_by(Envio.intento)))

    def enviar(self, confirmar: bool = False) -> None:
        version = self.almacen.leer_completo(EMAIL, "m1", "1")["version"]
        self.servicio.enviar(EMAIL, "m1", "1", EnvioRequest(version_base=version, sucursal=1, articulo="A", confirmar_reenvio=confirmar))

    def test_cada_intento_es_un_renglon_sin_duplicar(self) -> None:
        self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest(estado="revisado", filename="e.pdf", resumen={"banco": "Banco"}, confirmar_problemas=True))
        self.enviar()
        [fila] = self.filas()
        self.assertEqual((fila.intento, fila.estado, fila.origen, fila.codigo_http, fila.respuesta, fila.usuario_id), (1, "enviado", "manual", 200, '{"code":200}', None))
        self.assertIn("data", fila.datos_enviados)
        self.enviar(confirmar=True)
        self.assertEqual([(f.intento, f.estado, f.respuesta) for f in self.filas()], [(1, "enviado", '{"code":200}'), (2, "incierto", "Tiempo agotado")])
        # Volver a sincronizar lo mismo no agrega renglones.
        self.envios.sincronizar(EMAIL, "m1", "1", self.almacen.leer_completo(EMAIL, "m1", "1")["envios"])
        self.assertEqual(len(self.filas()), 2)
        # El JSON de la extracción conserva el formato de siempre.
        self.assertEqual([i["resultado"] for i in self.almacen.leer_completo(EMAIL, "m1", "1")["envios"]], ["exito", "incierto"])
        listado = self.envios.listar(EMAIL, "m1", "1")
        self.assertEqual([(i["intento"], i["accion"], i["resultado"]) for i in listado], [(1, "enviar", "exito"), (2, "enviar", "incierto")])

    def test_documento_que_no_esta_en_la_base_se_omite(self) -> None:
        self.assertEqual(self.envios.sincronizar_contando(EMAIL, "otro", "1", [{"id": "x", "resultado": "exito"}]), (0, 0))
        self.assertEqual(self.filas(), [])


if __name__ == "__main__":
    unittest.main()
