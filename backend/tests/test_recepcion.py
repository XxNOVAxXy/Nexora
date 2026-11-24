"""Fase 1: originales en disco, diagnóstico, eventos por etapa y Bandeja de captura manual.

Solo PDFs ficticios generados aquí (``pdf_ficticio``); Gmail, Gemini y SaveData son dobles de prueba.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.automatico import ExtractorAutomatico, MAX_INTENTOS
from backend.app.diagnostico import diagnosticar
from backend.app.extracciones import AlmacenExtracciones, cuenta_id
from backend.app.gemini import GeminiRequestError
from backend.app.originales import AlmacenOriginales
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.savedata import RespuestaSaveData, ServicioEnvio
from backend.tests.pdf_ficticio import pdf_con_texto, pdf_danado, pdf_protegido, pdf_sin_texto, pdf_solo_permisos, png_minimo
from backend.tests.test_automatico import EMAIL, INICIO, GeminiFalso, GmailFalso


class Diagnostico(unittest.TestCase):
    def test_los_cinco_codigos(self) -> None:
        casos = {
            "ok": (pdf_con_texto(), "application/pdf", "p.pdf"),
            "pdf_protegido": (pdf_protegido(), "application/pdf", "p.pdf"),
            "pdf_danado": (pdf_danado(), "application/pdf", "p.pdf"),
            "pdf_escaneado": (pdf_sin_texto(2), "application/pdf", "p.pdf"),
            "formato_no_soportado": (b"PK\x03\x04contenido-ficticio", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "carta.docx"),
        }
        for esperado, (data, mime, nombre) in casos.items():
            with self.subTest(esperado):
                self.assertEqual(diagnosticar(data, mime, nombre)["codigo"], esperado)

    def test_por_contenido_y_no_por_lo_que_dice_gmail(self) -> None:
        # PDF e imagen que llegan como octet-stream sin extensión: se reconocen y se pasan con su tipo real.
        pdf = diagnosticar(pdf_con_texto(), "application/octet-stream", "adjunto")
        self.assertEqual((pdf["codigo"], pdf["mime"], pdf["extension"]), ("ok", "application/pdf", ".pdf"))
        imagen = diagnosticar(png_minimo(), "application/octet-stream", "")
        self.assertEqual((imagen["codigo"], imagen["mime"]), ("ok", "image/png"))
        # Dice ser PDF pero no empieza con %PDF-.
        self.assertEqual(diagnosticar(b"<html>no es un pdf</html>", "application/pdf", "p.pdf")["codigo"], "pdf_danado")
        self.assertEqual(diagnosticar(b"", "application/pdf", "p.pdf")["codigo"], "pdf_danado")

    def test_contrasena_solo_de_permisos_se_abre(self) -> None:
        self.assertEqual(diagnosticar(pdf_solo_permisos(), "application/pdf", "p.pdf")["codigo"], "ok")

    def test_el_mensaje_dice_el_tipo_recibido(self) -> None:
        mensaje = diagnosticar(b"BEGIN:VCALENDAR", "text/calendar", "invitacion.ics")["mensaje"]
        self.assertIn("text/calendar", mensaje)
        self.assertIn(".ics", mensaje)


class Originales(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.almacen = AlmacenOriginales(self.raiz)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ruta_por_cuenta_anio_mes_y_sha256(self) -> None:
        data = pdf_con_texto()
        ruta, sha, nuevo = self.almacen.guardar(EMAIL, data, ".pdf", datetime(2026, 3, 9, tzinfo=timezone.utc))
        self.assertTrue(nuevo)
        self.assertEqual(ruta, f"{cuenta_id(EMAIL)}/2026/03/{sha}.pdf")
        self.assertEqual(self.almacen.leer(ruta), data)
        self.assertNotIn(EMAIL, ruta)

    def test_sin_duplicar_aunque_llegue_otro_mes(self) -> None:
        data = pdf_con_texto()
        primera, _, _ = self.almacen.guardar(EMAIL, data, ".pdf", datetime(2026, 3, 9, tzinfo=timezone.utc))
        segunda, _, nuevo = self.almacen.guardar(EMAIL, data, ".pdf", datetime(2026, 7, 1, tzinfo=timezone.utc))
        self.assertEqual((segunda, nuevo), (primera, False))
        self.assertEqual(len(list(self.raiz.rglob("*.pdf"))), 1)

    def test_rechaza_rutas_fuera_de_la_carpeta(self) -> None:
        with self.assertRaises(ValueError):
            self.almacen.leer("../../secreto.txt")

    def test_extension_no_segura_se_guarda_como_bin(self) -> None:
        ruta, _, _ = self.almacen.guardar(EMAIL, b"datos", "../../x", None)
        self.assertTrue(ruta.endswith(".bin"))


class Eventos(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ahora = INICIO
        self.eventos = EventosJson(Path(self.tmp.name), reloj=lambda: self.ahora)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_registra_y_filtra(self) -> None:
        self.eventos.registrar(EMAIL, etapa="lectura", codigo="ok", mensaje="leido", message_id="m1", part_id="1", origen="automatico")
        self.ahora += timedelta(minutes=1)
        self.eventos.registrar(EMAIL, etapa="extraccion", codigo="ok", mensaje="extraido", message_id="m1", part_id="1")
        self.eventos.registrar(EMAIL, etapa="lectura", codigo="pdf_protegido", mensaje="x", message_id="m2", part_id="1")
        todos = self.eventos.listar(EMAIL)
        self.assertEqual([e["codigo"] for e in todos], ["pdf_protegido", "ok", "ok"])  # del más reciente al más antiguo
        self.assertEqual([e["etapa"] for e in self.eventos.listar(EMAIL, message_id="m1")], ["extraccion", "lectura"])
        self.assertEqual(len(self.eventos.listar(EMAIL, etapa="lectura")), 2)
        self.assertEqual(len(self.eventos.listar(EMAIL, desde=(INICIO + timedelta(seconds=30)).isoformat())), 2)
        self.assertEqual(todos[-1]["fecha"], INICIO.isoformat(timespec="seconds"))

    def test_solo_agrega_y_tolera_una_linea_cortada(self) -> None:
        self.eventos.registrar(EMAIL, etapa="envio", codigo="exito", mensaje="ok")
        ruta = Path(self.tmp.name) / f"{cuenta_id(EMAIL)}.jsonl"
        with ruta.open("a", encoding="utf-8") as archivo:
            archivo.write('{"id": "cortado", "fe')
        self.eventos.registrar(EMAIL, etapa="envio", codigo="error", mensaje="x")
        self.assertEqual([e["codigo"] for e in self.eventos.listar(EMAIL)], ["error", "exito"])

    def test_etapa_desconocida(self) -> None:
        with self.assertRaises(ValueError):
            self.eventos.registrar(EMAIL, etapa="otra", codigo="x", mensaje="x")


class GmailConArchivos(GmailFalso):
    """Gmail falso que devuelve un archivo distinto por attachmentId."""

    def __init__(self) -> None:
        super().__init__()
        self.archivos: dict[str, tuple[bytes, str, str]] = {}

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        self.descargas += 1
        return self.archivos[attachment_id]

    def correo_con(self, message_id: str, archivos: list[tuple[str, bytes, str, str]], asunto: str = "Estado de cuenta noviembre") -> None:
        adjuntos = []
        for indice, (attachment_id, data, mime, nombre) in enumerate(archivos, start=1):
            self.archivos[attachment_id] = (data, mime, nombre)
            adjuntos.append({"id": attachment_id, "filename": nombre, "mimeType": mime, "size": len(data), "partId": str(indice)})
        self.agregar(message_id, INICIO + timedelta(minutes=5), asunto=asunto, adjuntos=adjuntos)


class GeminiQueClasifica(GeminiFalso):
    """Gemini falso que además clasifica (para correos que ninguna regla reconoce)."""

    def clasificar_documento(self, data: bytes, mime_type: str, filename: str, tipos: list[dict[str, Any]]) -> dict[str, Any]:
        return {"codigo": "EC", "confianza": 0.95, "aseguradora": "", "motivo": "ficticio"}


class BaseRecepcion(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.ahora = INICIO
        self.gmail = GmailConArchivos()
        self.gemini = GeminiFalso()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        self.recepcion = ServicioRecepcion(DocumentosJson(self.raiz / "documentos"), EventosJson(self.raiz / "eventos", reloj=lambda: self.ahora),
                                           AlmacenOriginales(self.raiz / "originales"), reloj=lambda: self.ahora)
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=self.recepcion)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()

    def estado_adjunto(self, message_id: str, part_id: str = "1") -> dict[str, Any]:
        return self.extractor.registro_adjuntos(EMAIL).get(f"{message_id}__{part_id}", {})

    def eventos(self, message_id: str) -> list[tuple[str, str]]:
        return [(e["etapa"], e["codigo"]) for e in reversed(self.recepcion.eventos.listar(EMAIL, message_id=message_id))]


class CicloAutomatico(BaseRecepcion):
    def test_pdf_legible_se_guarda_y_registra_lectura_y_extraccion(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_con_texto(), "application/pdf", "estado.pdf")])
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        registro = self.recepcion.documentos.obtener(EMAIL, "m1", "1")
        self.assertEqual(registro["diagnostico"]["codigo"], "ok")
        self.assertIsNone(registro.get("bandeja"))
        self.assertTrue(registro["ruta"].startswith(f"{cuenta_id(EMAIL)}/2026/11/"))
        self.assertEqual(self.recepcion.originales.leer(registro["ruta"]), pdf_con_texto())
        self.assertEqual(self.eventos("m1"), [("lectura", "ok"), ("diagnostico", "ok"), ("extraccion", "ok")])

    def test_no_ok_van_a_la_bandeja_sin_llamar_a_la_ia(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_protegido(), "application/pdf", "protegido.pdf")])
        self.gmail.correo_con("m2", [("a2", pdf_danado(), "application/pdf", "danado.pdf")])
        self.gmail.correo_con("m3", [("a3", pdf_sin_texto(), "application/pdf", "escaneado.pdf")])
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["en_bandeja"]), (0, 3))
        self.assertEqual(self.gemini.llamadas, [])
        bandeja = {(r["message_id"], r["bandeja"]["codigo"]) for r in self.recepcion.bandeja(EMAIL)}
        self.assertEqual(bandeja, {("m1", "pdf_protegido"), ("m2", "pdf_danado"), ("m3", "pdf_escaneado")})
        self.assertEqual(self.estado_adjunto("m1")["estado"], "bandeja")
        self.assertEqual(self.eventos("m1"), [("lectura", "ok"), ("diagnostico", "pdf_protegido")])
        avisos = self.extractor.estado(EMAIL)["avisos"]
        self.assertTrue(any(aviso["tipo"] == "bandeja" and "3 documentos" in aviso["texto"] for aviso in avisos))
        # El siguiente ciclo no los vuelve a descargar ni a registrar.
        descargas = self.gmail.descargas
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.gmail.descargas, descargas)
        self.assertEqual(self.eventos("m1"), [("lectura", "ok"), ("diagnostico", "pdf_protegido")])

    def test_formato_no_soportado_va_a_la_bandeja_y_el_pdf_del_mismo_correo_se_extrae(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_con_texto(), "application/pdf", "poliza.pdf"),
                                     ("a2", b"PK\x03\x04ficticio", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "carta.docx")])
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["en_bandeja"]), (1, 1))
        registro = self.recepcion.documentos.obtener(EMAIL, "m1", "2")
        self.assertEqual(registro["bandeja"]["codigo"], "formato_no_soportado")
        self.assertTrue(registro["ruta"].endswith(".docx"))
        self.assertEqual(self.extractor.estado(EMAIL)["descartados"], [])

    def test_pdf_que_gmail_manda_como_octet_stream_se_extrae(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_con_texto(), "application/octet-stream", "documento.bin")])
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        self.assertEqual(self.recepcion.documentos.obtener(EMAIL, "m1", "1")["mime"], "application/pdf")

    def test_mismo_archivo_en_dos_correos_se_guarda_una_vez(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_con_texto(), "application/pdf", "a.pdf")])
        self.gmail.correo_con("m2", [("a2", pdf_con_texto(), "application/pdf", "b.pdf")])
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.recepcion.documentos.obtener(EMAIL, "m1", "1")["ruta"], self.recepcion.documentos.obtener(EMAIL, "m2", "1")["ruta"])
        self.assertEqual(len(list((self.raiz / "originales").rglob("*.pdf"))), 1)

    def test_intentos_agotados_pasan_a_la_bandeja(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_con_texto(), "application/pdf", "estado.pdf")])
        self.gemini.fallar = GeminiRequestError("respuesta invalida", code="invalid_response", status_code=502)
        for _ in range(MAX_INTENTOS):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estado_adjunto("m1")["estado"], "error")
        self.assertEqual(self.recepcion.documentos.obtener(EMAIL, "m1", "1")["bandeja"]["codigo"], "error_extraccion")
        self.assertEqual([codigo for etapa, codigo in self.eventos("m1") if etapa == "extraccion"], ["gemini_http_502"] * MAX_INTENTOS)


class Reprocesar(BaseRecepcion):
    def test_escaneado_se_extrae_con_la_ia_y_sale_de_la_bandeja(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_sin_texto(), "application/pdf", "escaneado.pdf")])
        self.extractor.ejecutar_ciclo()
        resultado = self.extractor.reprocesar_bandeja(EMAIL, "m1", "1")
        self.assertEqual(resultado["estado"], "extraido")
        self.assertEqual(len(self.gemini.llamadas), 1)
        self.assertEqual(self.almacen.obtener(EMAIL, "m1", "1")["estado"], "borrador")
        self.assertEqual(self.recepcion.bandeja(EMAIL), [])
        self.assertEqual(self.recepcion.documentos.obtener(EMAIL, "m1", "1")["bandeja"]["resolucion"], "extraido")
        self.assertEqual(self.estado_adjunto("m1")["estado"], "extraido")
        self.assertEqual(self.eventos("m1")[-1], ("extraccion", "ok"))

    def test_lee_el_original_del_disco_sin_pedirlo_a_gmail(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_sin_texto(), "application/pdf", "escaneado.pdf")])
        self.extractor.ejecutar_ciclo()
        descargas = self.gmail.descargas
        self.extractor.reprocesar_bandeja(EMAIL, "m1", "1")
        self.assertEqual(self.gmail.descargas, descargas)

    def test_sin_original_en_disco_lo_pide_a_gmail(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_sin_texto(), "application/pdf", "escaneado.pdf")])
        self.extractor.ejecutar_ciclo()
        for archivo in (self.raiz / "originales").rglob("*.pdf"):
            archivo.unlink()
        descargas = self.gmail.descargas
        self.assertEqual(self.extractor.reprocesar_bandeja(EMAIL, "m1", "1")["estado"], "extraido")
        self.assertEqual(self.gmail.descargas, descargas + 1)

    def test_protegido_sigue_en_la_bandeja(self) -> None:
        self.gmail.correo_con("m1", [("a1", pdf_protegido(), "application/pdf", "protegido.pdf")])
        self.extractor.ejecutar_ciclo()
        resultado = self.extractor.reprocesar_bandeja(EMAIL, "m1", "1")
        self.assertEqual((resultado["estado"], resultado["diagnostico"]["codigo"]), ("sigue_en_bandeja", "pdf_protegido"))
        self.assertEqual(self.gemini.llamadas, [])
        self.assertEqual(len(self.recepcion.bandeja(EMAIL)), 1)
        self.assertEqual(self.eventos("m1"), [("lectura", "ok"), ("diagnostico", "pdf_protegido")] * 2)
        self.assertEqual(self.recepcion.eventos.listar(EMAIL, message_id="m1")[0]["origen"], "reprocesar")

    def test_documento_desconocido(self) -> None:
        with self.assertRaises(KeyError):
            self.extractor.reprocesar_bandeja(EMAIL, "nada", "1")


class EventoDeEnvio(unittest.TestCase):
    def test_cada_envio_registra_su_evento(self) -> None:
        from backend.app.extracciones import GuardarExtraccionRequest
        from backend.app.savedata import EnvioRequest

        with tempfile.TemporaryDirectory() as directorio:
            raiz = Path(directorio)
            almacen = AlmacenExtracciones(raiz / "extracciones")
            eventos = EventosJson(raiz / "eventos")
            recepcion = ServicioRecepcion(DocumentosJson(raiz / "documentos"), eventos, AlmacenOriginales(raiz / "originales"))
            respuesta = RespuestaSaveData("exito", 200, json.dumps({"code": 200}), "SaveData recibio el documento.")
            servicio = ServicioEnvio(almacen, lambda: "http://savedata.invalid/SaveData", cliente=lambda url, cuerpo, timeout: respuesta,
                                     registrar_evento=recepcion.evento)
            solicitud = GuardarExtraccionRequest.model_validate({"estado": "revisado", "confirmar_problemas": True, "filename": "e.pdf",
                                                                 "resumen": {"saldo_inicial": "1.00", "saldo_final": "1.00"}})
            documento = almacen.guardar(EMAIL, "m1", "1", solicitud)
            servicio.enviar(EMAIL, "m1", "1", EnvioRequest.model_construct(version_base=documento["version"], sucursal=None, articulo=None, carga_inicial=False,
                                                                            confirmar_reenvio=False, agregar_de_nuevo=False))
            evento = eventos.listar(EMAIL, etapa="envio")[0]
            self.assertEqual((evento["codigo"], evento["origen"], evento["message_id"]), ("exito", "manual", "m1"))
            self.assertEqual(evento["detalle"]["http_status"], 200)


class ApiBandeja(unittest.TestCase):
    """Endpoints con el ``main`` real (su recepción ya apunta a una carpeta temporal, ver conftest)."""

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

    def recibir(self, message_id: str, data: bytes, nombre: str = "doc.pdf") -> None:
        self.gmail.correo_con(message_id, [(f"att-{message_id}", data, "application/pdf", nombre)])
        main.recepcion.recibir(EMAIL, message_id=message_id, part_id="1", data=data, mime_type="application/pdf", filename=nombre,
                               attachment_id=f"att-{message_id}", recibido_en=INICIO.isoformat(), asunto="Poliza ficticia")

    def test_listar_reprocesar_descartar_eventos_y_original(self) -> None:
        self.recibir("m1", pdf_sin_texto(), "escaneado.pdf")
        self.recibir("m2", pdf_protegido(), "protegido.pdf")
        bandeja = self.api.get("/api/bandeja").json()
        self.assertEqual({d["message_id"]: d["bandeja"]["codigo"] for d in bandeja["documentos"]}, {"m1": "pdf_escaneado", "m2": "pdf_protegido"})
        self.assertTrue(all(d["tiene_original"] for d in bandeja["documentos"]))
        self.assertNotIn("ruta", bandeja["documentos"][0])
        self.assertIn("pdf_protegido", bandeja["motivos"])

        original = self.api.get("/api/documentos/m2/1/original")
        self.assertEqual(original.status_code, 200)
        self.assertTrue(original.content.startswith(b"%PDF-"))

        reproceso = self.api.post("/api/bandeja/m1/1/reprocesar").json()
        self.assertEqual(reproceso["estado"], "extraido")
        self.assertEqual(self.api.post("/api/bandeja/m2/1/reprocesar").json()["estado"], "sigue_en_bandeja")

        self.assertEqual(self.api.post("/api/bandeja/m2/1/descartar").status_code, 200)
        self.assertEqual(self.api.post("/api/bandeja/m2/1/descartar").status_code, 404)
        self.assertEqual(self.api.get("/api/bandeja").json()["documentos"], [])
        self.assertEqual(len(self.api.get("/api/bandeja", params={"estado": "descartado"}).json()["documentos"]), 1)

        eventos = self.api.get("/api/documentos/m1/1/eventos").json()["eventos"]
        self.assertEqual([(e["etapa"], e["codigo"]) for e in eventos][:3], [("extraccion", "ok"), ("diagnostico", "pdf_escaneado"), ("lectura", "ok")])
        # 2 recibidos + 2 reprocesos + 1 descartado.
        self.assertEqual(len(self.api.get("/api/eventos", params={"etapa": "lectura"}).json()["eventos"]), 5)

    def test_reprocesar_sin_gemini_responde_503(self) -> None:
        self.recibir("m1", pdf_sin_texto())
        self.gemini.habilitado = False
        self.assertEqual(self.api.post("/api/bandeja/m1/1/reprocesar").status_code, 503)

    def test_guardar_a_mano_saca_el_documento_de_la_bandeja(self) -> None:
        self.recibir("m1", pdf_protegido())
        respuesta = self.api.put("/api/extracciones/m1/1", json={"estado": "borrador", "filename": "protegido.pdf", "resumen": {}})
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(self.api.get("/api/bandeja").json()["documentos"], [])
        registro = main.recepcion.documentos.obtener(EMAIL, "m1", "1")
        self.assertEqual(registro["bandeja"]["resolucion"], "capturado_a_mano")

    def test_extraer_a_mano_un_pdf_protegido_no_llama_a_la_ia(self) -> None:
        self.gmail.correo_con("m1", [("att-1", pdf_protegido(), "application/pdf", "protegido.pdf")])
        with patch.object(self.gmail, "profile", return_value={"email": EMAIL}):
            respuesta = self.api.post("/api/gemini/extract", json={"messageId": "m1", "attachmentId": "att-1"})
        self.assertEqual(respuesta.status_code, 422)
        self.assertEqual(respuesta.json()["detail"]["code"], "pdf_protegido")
        self.assertEqual(self.gemini.llamadas, [])
        self.assertEqual(main.recepcion.bandeja(EMAIL)[0]["part_id"], "1")

    def test_extraer_a_mano_un_escaneado_si_usa_la_ia(self) -> None:
        self.gmail.correo_con("m1", [("att-1", pdf_sin_texto(), "application/pdf", "escaneado.pdf")])
        with patch.object(self.gmail, "profile", return_value={"email": EMAIL}), \
                patch.object(self.gemini, "extract_document", wraps=self.gemini.extract_document, create=True) as extraer:
            respuesta = self.api.post("/api/gemini/extract", json={"messageId": "m1", "attachmentId": "att-1", "partId": "1"})
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(extraer.call_count, 1)
        eventos = [(e["etapa"], e["codigo"], e["origen"]) for e in main.recepcion.eventos.listar(EMAIL, message_id="m1")]
        self.assertEqual(eventos, [("extraccion", "ok", "manual"), ("diagnostico", "pdf_escaneado", "manual"), ("lectura", "ok", "manual")])


if __name__ == "__main__":
    unittest.main()
