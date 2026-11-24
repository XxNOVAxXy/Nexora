"""El caso del id=29 (GNP GMM.pdf) en modo db: "en espera de reintento" pero la fila seguía en 'leido'.

SQLite en un archivo temporal y un SEGUNDO motor para leer la fila: así se comprueba que el repositorio db hizo
commit (otra conexión ve el cambio). Gemini y Gmail son dobles; los PDFs son ficticios. Nunca MySQL real.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import sqlalchemy as sa
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.automatico import ESPERAS_REINTENTO, HORA_MEXICO, MAX_INTENTOS, ExtractorAutomatico
from backend.app.db import Base, CuentaCorreo, Documento, Evento, a_utc, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones
from backend.app.originales import AlmacenOriginales
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos.db import CuentasDb, DocumentosDb, EventosDb
from backend.app.seguridad import Cifrador
from backend.tests.pdf_ficticio import pdf_con_texto
from backend.tests.test_automatico import EMAIL, INICIO
from backend.tests.test_error_extraccion import ERROR_502
from backend.tests.test_recepcion import GeminiQueClasifica, GmailConArchivos


class Caso29(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        url = f"sqlite:///{(self.raiz / 'nexora.db').as_posix()}"
        self.motor = crear_motor(url)
        Base.metadata.create_all(self.motor)
        # Otra conexión, como la de tu cliente de MySQL: solo ve lo que se confirmó (commit).
        self.otro = crear_motor(url)
        self.ahora = INICIO
        sesiones = fabrica_sesiones(self.motor)
        self.cuentas = CuentasDb(sesiones, Cifrador(Fernet.generate_key().decode()))
        self.recepcion = ServicioRecepcion(DocumentosDb(sesiones, self.cuentas), EventosDb(sesiones, self.cuentas, reloj=lambda: self.ahora),
                                           AlmacenOriginales(self.raiz / "originales"), reloj=lambda: self.ahora)
        self.gmail = GmailConArchivos()
        self.gemini = GeminiQueClasifica()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=self.recepcion,
                                             plantillas=main.AlmacenPlantillas(self.raiz / "plantillas"))
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)
        self.gmail.correo_con("m29", [("att-29", pdf_con_texto(), "application/pdf", "GNP GMM.pdf")])

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.motor.dispose()
        self.otro.dispose()
        self.tmp.cleanup()

    def fila(self) -> Any:
        with self.otro.connect() as conexion:
            return conexion.execute(sa.select(Documento.id, Documento.estado, Documento.motivo).where(Documento.message_id == "m29")).one()

    def eventos(self) -> list[tuple[str, str, str]]:
        with self.otro.connect() as conexion:
            return [tuple(fila) for fila in conexion.execute(sa.select(Evento.codigo, Evento.resultado, Evento.mensaje).order_by(Evento.id))]

    def quedo_en_leido_y_en_espera(self) -> None:
        """Lo que se vio en MySQL: el 502 programó el reintento, pero el estado no llegó a la fila."""
        self.gemini.fallar = ERROR_502
        with patch.object(ServicioRecepcion, "marcar", return_value=None):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.fila()[1:], ("leido", None))
        self.assertEqual(self.extractor.registro_adjuntos(EMAIL)["m29__1"]["estado"], "pendiente")

    def test_en_espera_deja_la_fila_en_error_con_el_ultimo_codigo(self) -> None:
        self.quedo_en_leido_y_en_espera()
        llamadas = len(self.gemini.llamadas)
        self.ahora += timedelta(minutes=5)
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["en_espera"], 1)
        # No hubo intento nuevo con la IA (se salta por la espera)...
        self.assertEqual(len(self.gemini.llamadas), llamadas)
        # ...pero la FILA ya dice error con el último código, y lo ve otra conexión (commit).
        self.assertEqual(self.fila()[1:], ("error", "gemini_http_502"))
        espera = [evento for evento in self.eventos() if evento[0] == "reintento_en_espera"]
        self.assertEqual(len(espera), 1)
        self.assertEqual(espera[0][1], "aviso")
        hora = (INICIO + ESPERAS_REINTENTO[0]).astimezone(HORA_MEXICO).strftime("%H:%M")
        self.assertIn(f"{hora} (hora de Mexico)", espera[0][2])
        self.assertIn("intento 2 de 3", espera[0][2])
        # Nunca "sin_estado_final" por esperar.
        self.assertNotIn("sin_estado_final", [evento[0] for evento in self.eventos()])

    def test_con_error_muestra_intentos_y_siguiente_intento(self) -> None:
        self.quedo_en_leido_y_en_espera()
        documentos = self.listar_con_error()
        self.assertEqual(len(documentos), 1)
        documento = documentos[0]
        self.assertEqual((documento["message_id"], documento["nombre"]), ("m29", "GNP GMM.pdf"))
        self.assertEqual((documento["reintento"]["intentos"], documento["reintento"]["max"]), (1, MAX_INTENTOS))
        self.assertEqual(a_utc(documento["reintento"]["proximo_intento"]), a_utc(INICIO + ESPERAS_REINTENTO[0]))
        self.assertEqual(documento["reintento"]["causa"], "gemini_http_502")

    def test_reintentar_ignora_la_espera(self) -> None:
        self.quedo_en_leido_y_en_espera()
        llamadas = len(self.gemini.llamadas)
        self.gemini.fallar = None
        resultado = self.extractor.reprocesar_bandeja(EMAIL, "m29", "1")
        self.assertEqual(resultado["estado"], "extraido")
        self.assertEqual(len(self.gemini.llamadas), llamadas + 1)
        self.assertEqual(self.fila()[1:], ("extraido", None))
        self.assertEqual(self.listar_con_error(), [])

    def test_documento_en_otra_cuenta_con_el_mismo_correo(self) -> None:
        # La fila quedó en una cuenta y después la cuenta "principal" de ese correo es otra (p. ej. una creada a mano).
        self.gemini.fallar = ERROR_502
        self.extractor.ejecutar_ciclo()
        with self.otro.begin() as conexion:
            cuenta_original = conexion.execute(sa.select(Documento.cuenta_id).where(Documento.message_id == "m29")).scalar_one()
            usuario = conexion.execute(sa.select(CuentaCorreo.usuario_id).where(CuentaCorreo.id == cuenta_original)).scalar_one()
            conexion.execute(sa.update(CuentaCorreo).where(CuentaCorreo.id == cuenta_original).values(activo=False))
            conexion.execute(sa.insert(CuentaCorreo).values(usuario_id=usuario, proveedor="gmail", correo=f" {EMAIL.upper()} ",
                                                            credencial_cifrada="x", activo=True))
        self.cuentas._ids.clear()  # como un backend reiniciado
        self.assertNotEqual(self.cuentas.id_de(EMAIL, crear=False), cuenta_original)
        # Se sigue encontrando, se lista y se puede marcar.
        self.assertIsNotNone(self.recepcion.documentos.obtener(EMAIL, "m29", "1"))
        self.assertEqual([d["message_id"] for d in self.listar_con_error()], ["m29"])
        self.recepcion.marcar(EMAIL, "m29", "1", "error", "gemini_http_503", "otra vez")
        self.assertEqual(self.fila()[1:], ("error", "gemini_http_503"))

    def test_documento_terminado_con_el_codigo_anterior_no_se_marca_como_error(self) -> None:
        # Extraído antes de que existiera "proceso" (fila en leido, adjunto extraido): la red toma su estado real.
        self.extractor.ejecutar_ciclo()
        with self.otro.begin() as conexion:
            conexion.execute(sa.update(Documento).where(Documento.message_id == "m29").values(estado="leido", motivo=None, recepcion=sa.func.json_remove(Documento.recepcion, "$.proceso")))
        self.assertEqual(self.fila()[1:], ("leido", None))
        self.ahora += timedelta(minutes=20)
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.fila()[1:], ("extraido", None))
        self.assertNotIn("sin_estado_final", [evento[0] for evento in self.eventos()])
        self.assertIn("estado_recuperado", [evento[0] for evento in self.eventos()])

    def listar_con_error(self) -> list[dict[str, Any]]:
        with patch.object(main, "recepcion", self.recepcion), patch.object(main, "automatico", self.extractor), patch.object(main, "almacen", self.almacen), \
                patch.object(main, "_cuenta_actual", return_value=EMAIL):
            respuesta = TestClient(main.app).get("/api/bandeja", params={"estado": "error"})
        self.assertEqual(respuesta.status_code, 200)
        return respuesta.json()["documentos"]


if __name__ == "__main__":
    unittest.main()
