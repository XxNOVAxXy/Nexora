"""Un documento nunca se queda en 'leido': el caso real del 502 de Gemini, en modo json y en modo db (SQLite).

Gemini, Gmail y SaveData son dobles de prueba; los PDFs son ficticios. Nunca MySQL real.
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

from backend.app import gemini as modulo_gemini
from backend.app import main
from backend.app.automatico import ESPERAS_REINTENTO, MAX_INTENTOS, ExtractorAutomatico, _resumen_vacio, es_error_temporal
from backend.app.db import Base, Documento, Evento, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones
from backend.app.gemini import GeminiRequestError
from backend.app.originales import AlmacenOriginales
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.repos.db import CuentasDb, DocumentosDb, EventosDb
from backend.app.seguridad import Cifrador
from backend.tests.pdf_ficticio import pdf_con_texto
from backend.tests.test_automatico import EMAIL, INICIO, GeminiFalso
from backend.tests.test_recepcion import GeminiQueClasifica, GmailConArchivos

# El error que se vio en MySQL: el último modelo de respaldo también respondió 502.
ERROR_502 = GeminiRequestError("El modelo de Gemini no esta disponible: gemini-2.5-flash-lite", code="model_unavailable", status_code=502)


class Caso502:
    """Mismas pruebas para json y db; cada subclase arma ``self.recepcion``."""

    def armar(self) -> None:
        self.ahora = INICIO
        self.gmail = GmailConArchivos()
        self.gemini = GeminiFalso()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=self.recepcion)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)
        self.gmail.correo_con("m29", [("att-29", pdf_con_texto(), "application/pdf", "GNP GMM.pdf")])

    def estado(self) -> tuple[str, str | None]:
        return self.recepcion.estado(self.recepcion.documentos.obtener(EMAIL, "m29", "1"))

    def eventos(self) -> list[tuple[str, str]]:
        return [(e["etapa"], e["codigo"]) for e in reversed(self.recepcion.eventos.listar(EMAIL, message_id="m29"))]

    def test_502_deja_el_documento_en_error_y_cuenta_en_el_resumen(self) -> None:
        self.gemini.fallar = ERROR_502
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["correos_encontrados"], resumen["extraidos"], resumen["errores"]), (1, 0, 1))
        self.assertEqual(self.estado(), ("error", "gemini_http_502"))
        self.assertEqual(self.eventos(), [("lectura", "ok"), ("diagnostico", "ok"), ("extraccion", "gemini_http_502"), ("extraccion", "reintento_programado")])
        # Aviso rojo del ciclo y texto del resumen.
        avisos = self.extractor.estado(EMAIL)["avisos"]
        self.assertTrue(any(aviso["tipo"] == "error" and "1 documento con error" in aviso["texto"] for aviso in avisos))
        self.assertEqual(self.extractor.estado(EMAIL)["ultimo_ciclo"]["errores"], 1)

    def test_se_reintenta_con_espera_creciente_y_pasa_a_la_bandeja(self) -> None:
        self.gemini.fallar = ERROR_502
        self.extractor.ejecutar_ciclo()
        # Antes de la espera no se vuelve a llamar a la IA; el documento sigue en error (no en leido).
        self.extractor.ejecutar_ciclo()
        self.assertEqual((len(self.gemini.llamadas), self.estado()[0]), (1, "error"))
        for espera in ESPERAS_REINTENTO:
            self.ahora += espera
            self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.gemini.llamadas), MAX_INTENTOS)
        self.assertEqual(self.estado(), ("captura_manual", "ia_no_disponible"))
        bandeja = self.recepcion.bandeja(EMAIL)
        self.assertEqual([(r["message_id"], r["bandeja"]["codigo"]) for r in bandeja], [("m29", "ia_no_disponible")])
        self.assertEqual([codigo for _etapa, codigo in self.eventos() if codigo.startswith("gemini_")], ["gemini_http_502"] * MAX_INTENTOS)
        # Dos reintentos programados (antes del 2.º y del 3.er intento) y la espera del ciclo que no llamó a la IA.
        self.assertEqual([codigo for _etapa, codigo in self.eventos()].count("reintento_programado"), 2)
        self.assertIn(("extraccion", "reintento_en_espera"), self.eventos())

    def test_si_la_ia_vuelve_se_extrae_en_el_siguiente_intento(self) -> None:
        self.gemini.fallar = ERROR_502
        self.extractor.ejecutar_ciclo()
        self.gemini.fallar = None
        self.ahora += ESPERAS_REINTENTO[0]
        self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)
        self.assertEqual(self.estado(), ("extraido", None))

    def test_reintentar_a_mano(self) -> None:
        self.gemini.fallar = ERROR_502
        self.extractor.ejecutar_ciclo()
        # Sigue fallando: el reintento a mano lo dice y el documento sigue en error con su motivo.
        with self.assertRaises(GeminiRequestError):
            self.extractor.reprocesar_bandeja(EMAIL, "m29", "1")
        self.assertEqual(self.estado(), ("error", "gemini_http_502"))
        self.gemini.fallar = None
        self.assertEqual(self.extractor.reprocesar_bandeja(EMAIL, "m29", "1")["estado"], "extraido")
        self.assertEqual(self.estado()[0], "extraido")
        # El proceso automático ya no lo vuelve a tomar.
        self.ahora += timedelta(hours=1)
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.gemini.llamadas), 3)

    def test_ningun_documento_se_queda_en_leido(self) -> None:
        # Aunque un paso no deje estado (aquí se apaga a propósito), la red de seguridad lo toma del registro del proceso.
        with patch.object(ExtractorAutomatico, "_marcar", lambda *_args, **_kwargs: None):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estado(), ("extraido", None))
        self.assertIn(("extraccion", "estado_recuperado"), self.eventos())

    def test_sin_forma_de_saber_el_estado_queda_en_error(self) -> None:
        with patch.object(ExtractorAutomatico, "_marcar", lambda *_args, **_kwargs: None), patch.object(ExtractorAutomatico, "_estado_final", return_value=None):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estado(), ("error", "sin_estado_final"))
        self.assertIn(("extraccion", "sin_estado_final"), self.eventos())

    def test_corte_a_mitad_deja_error_y_evento(self) -> None:
        with patch.object(self.gemini, "extract_document", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ctx = {"resumen": _resumen_vacio(), "descartes": [], "claves": {"enviado": [], "requiere_revision": [], "error": [], "incierto": []}}
                self.extractor._procesar(EMAIL, self.extractor._leer(EMAIL), INICIO - timedelta(days=1), ctx)
        self.assertEqual(self.estado(), ("error", "proceso_interrumpido"))


class Caso502Json(Caso502, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.recepcion = ServicioRecepcion(DocumentosJson(self.raiz / "documentos"), EventosJson(self.raiz / "eventos", reloj=lambda: self.ahora),
                                           AlmacenOriginales(self.raiz / "originales"), reloj=lambda: self.ahora)
        self.armar()

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()


class Caso502Db(Caso502, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.motor = crear_motor("sqlite://")
        Base.metadata.create_all(self.motor)
        self.sesiones = fabrica_sesiones(self.motor)
        cuentas = CuentasDb(self.sesiones, Cifrador(Fernet.generate_key().decode()))
        self.recepcion = ServicioRecepcion(DocumentosDb(self.sesiones, cuentas), EventosDb(self.sesiones, cuentas, reloj=lambda: self.ahora),
                                           AlmacenOriginales(self.raiz / "originales"), reloj=lambda: self.ahora)
        self.armar()

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.motor.dispose()
        self.tmp.cleanup()

    def fila(self) -> Documento:
        with self.sesiones() as sesion:
            return sesion.scalars(sa.select(Documento).where(Documento.message_id == "m29")).one()

    def test_columnas_estado_y_motivo_en_la_base(self) -> None:
        self.gemini.fallar = ERROR_502
        self.extractor.ejecutar_ciclo()
        fila = self.fila()
        self.assertEqual((fila.nombre_archivo, fila.estado, fila.motivo), ("GNP GMM.pdf", "error", "gemini_http_502"))
        with self.sesiones() as sesion:
            evento = sesion.scalars(sa.select(Evento).where(Evento.codigo == "gemini_http_502")).one()
            programado = sesion.scalars(sa.select(Evento).where(Evento.codigo == "reintento_programado")).one()
        self.assertEqual((evento.resultado, evento.codigo, evento.documento_id, evento.origen), ("error", "gemini_http_502", fila.id, "automatico"))
        self.assertEqual(evento.detalle["temporal"], True)
        # Aviso con la hora del siguiente intento (UTC en detalle, hora de México en el mensaje).
        self.assertEqual((programado.resultado, programado.documento_id), ("aviso", fila.id))
        self.assertEqual(programado.detalle["proximo_intento"], (INICIO + ESPERAS_REINTENTO[0]).isoformat(timespec="seconds"))
        self.assertIn("(hora de Mexico)", programado.mensaje)
        for espera in ESPERAS_REINTENTO:
            self.ahora += espera
            self.extractor.ejecutar_ciclo()
        self.assertEqual((self.fila().estado, self.fila().motivo), ("captura_manual", "ia_no_disponible"))


class ErroresTemporales(unittest.TestCase):
    def test_cuales_son_temporales(self) -> None:
        temporales = [GeminiRequestError("x", status_code=codigo) for codigo in (429, 500, 502, 503, 504)] + [GeminiRequestError("x", code="timeout", status_code=504)]
        self.assertTrue(all(es_error_temporal(error) for error in temporales))
        self.assertFalse(es_error_temporal(GeminiRequestError("x", code="authentication", status_code=502)))
        self.assertFalse(es_error_temporal(GeminiRequestError("x", code="invalid_document", status_code=422)))
        self.assertFalse(es_error_temporal(ValueError("x")))

    def test_un_503_del_sdk_es_temporal_y_no_modelo_inexistente(self) -> None:
        class ErrorSdk(Exception):
            code = 503

        with patch("google.genai.Client", side_effect=ErrorSdk("503 UNAVAILABLE. The model is overloaded. Please try again later.")):
            with self.assertRaises(GeminiRequestError) as capturado:
                modulo_gemini._call_gemini_sdk("clave-ficticia", "gemini-ficticio", b"%PDF-1.4", "application/pdf", "a.pdf")
        self.assertEqual((capturado.exception.code, capturado.exception.status_code, capturado.exception.retryable), ("unavailable", 503, True))

    def test_primero_prueba_los_modelos_de_respaldo(self) -> None:
        llamados: list[str] = []

        def llamar(modelo: str) -> str:
            llamados.append(modelo)
            if modelo != "respaldo-2":
                raise GeminiRequestError("caido", code="unavailable", status_code=502, retryable=True)
            return "ok"

        with patch.dict("os.environ", {"GEMINI_FALLBACK_MODELS": "respaldo-1,respaldo-2"}), patch.object(modulo_gemini.time, "sleep"):
            self.assertEqual(modulo_gemini._con_reintentos("principal", llamar), ("ok", "respaldo-2"))
        self.assertEqual(llamados, ["principal", "principal", "respaldo-1", "respaldo-1", "respaldo-2"])

    def test_si_todos_los_modelos_fallan_sale_el_ultimo_error(self) -> None:
        def llamar(_modelo: str) -> str:
            raise GeminiRequestError("caido", code="unavailable", status_code=502, retryable=True)

        with patch.dict("os.environ", {"GEMINI_FALLBACK_MODELS": "respaldo-1"}), patch.object(modulo_gemini.time, "sleep"):
            with self.assertRaises(GeminiRequestError) as capturado:
                modulo_gemini._con_reintentos("principal", llamar)
        self.assertEqual(capturado.exception.status_code, 502)


class ApiDocumentosConError(unittest.TestCase):
    """GET /api/bandeja?estado=error y POST /api/documentos/{id}/reintentar con el main real (recepción temporal)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        raiz = Path(self.tmp.name)
        self.gmail = GmailConArchivos()
        self.gemini = GeminiQueClasifica()
        self.almacen = AlmacenExtracciones(raiz / "extracciones")
        self.extractor = ExtractorAutomatico(raiz / "automatico", self.gmail, self.gemini, self.almacen, recepcion=main.recepcion,
                                             plantillas=main.AlmacenPlantillas(raiz / "plantillas"))
        self.parches = [patch.object(main, "gmail", self.gmail), patch.object(main, "gemini", self.gemini), patch.object(main, "almacen", self.almacen),
                        patch.object(main, "automatico", self.extractor), patch.object(main, "_cuenta_actual", return_value=EMAIL)]
        for parche in self.parches:
            parche.start()
        self.api = TestClient(main.app)

    def tearDown(self) -> None:
        for parche in reversed(self.parches):
            parche.stop()
        self.tmp.cleanup()

    def test_lista_los_que_estan_en_error_o_en_leido_y_los_reintenta(self) -> None:
        # Como el id=29: recibido y diagnosticado, pero sin terminar (leido).
        self.gmail.correo_con("m29", [("att-29", pdf_con_texto(), "application/pdf", "GNP GMM.pdf")])
        main.recepcion.recibir(EMAIL, message_id="m29", part_id="1", data=pdf_con_texto(), mime_type="application/pdf", filename="GNP GMM.pdf", attachment_id="att-29")
        main.recepcion.recibir(EMAIL, message_id="m30", part_id="1", data=pdf_con_texto(), mime_type="application/pdf", filename="otro.pdf", attachment_id="att-30")
        main.recepcion.marcar(EMAIL, "m30", "1", "error", "gemini_http_502", "caido")
        documentos = self.api.get("/api/bandeja", params={"estado": "error"}).json()["documentos"]
        self.assertEqual({(d["message_id"], d["estado"], d["motivo"]) for d in documentos}, {("m29", "leido", None), ("m30", "error", "gemini_http_502")})

        self.gemini.fallar = ERROR_502
        respuesta = self.api.post("/api/documentos/m29/1/reintentar")
        self.assertEqual(respuesta.status_code, 502)
        self.assertEqual(main.recepcion.estado(main.recepcion.documentos.obtener(EMAIL, "m29", "1")), ("error", "gemini_http_502"))

        self.gemini.fallar = None
        respuesta = self.api.post("/api/documentos/m29/1/reintentar")
        self.assertEqual((respuesta.status_code, respuesta.json()["estado"], respuesta.json()["documento"]["estado"]), (200, "extraido", "extraido"))
        restantes = self.api.get("/api/bandeja", params={"estado": "error"}).json()["documentos"]
        self.assertEqual([d["message_id"] for d in restantes], ["m30"])


if __name__ == "__main__":
    unittest.main()
