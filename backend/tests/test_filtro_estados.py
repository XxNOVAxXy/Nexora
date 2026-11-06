from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.filtro_estados import FIRMA_FILTRO, asunto_coincide, construir_query, normalizar_asunto, tiene_pdf
from backend.app.preferencias import AlmacenClasificaciones, ConfiguracionCuenta

PDF = {"mimeType": "application/pdf", "filename": "EdoCta.pdf"}
IMAGEN = {"mimeType": "image/png", "filename": "promo.png"}


class AsuntoTests(unittest.TestCase):
    def test_normaliza_mayusculas_acentos_y_signos(self) -> None:
        self.assertEqual(normalizar_asunto("  ESTADO DE CUENTA — Octubre!! "), "estado de cuenta octubre")
        self.assertEqual(normalizar_asunto("Edo. Cta. Sept"), "edo cta sept")
        self.assertEqual(normalizar_asunto("Resúmen de cuénta"), "resumen de cuenta")

    def test_asuntos_de_distintos_bancos_coinciden(self) -> None:
        casos = {
            "Tu Estado de Cuenta de octubre": "estado de cuenta",
            "ESTADO DE CUENTA": "estado de cuenta",
            "Edo. Cta. Septiembre 2026": "edo cta",
            "Tu EdoCta ya está disponible": "edocta",
            "Resumen de cuenta Mercado Pago": "resumen de cuenta",
            "Your account statement is ready": "statement",
            "Extracto mensual": "extracto",
        }
        for asunto, esperado in casos.items():
            with self.subTest(asunto=asunto):
                self.assertEqual(asunto_coincide(asunto), esperado)

    def test_asuntos_que_no_son_estados_de_cuenta(self) -> None:
        for asunto in ["Promoción exclusiva para ti", "Comprobante de transferencia", "Tu factura de octubre", "", "Estadounidense cuenta"]:
            with self.subTest(asunto=asunto):
                self.assertIsNone(asunto_coincide(asunto))

    def test_frase_completa_no_fragmentos_de_palabra(self) -> None:
        self.assertIsNone(asunto_coincide("Statements"))  # "statement" debe ser palabra completa
        self.assertIsNone(asunto_coincide("Extractora de jugos"))

    def test_tiene_pdf(self) -> None:
        self.assertTrue(tiene_pdf([IMAGEN, PDF]))
        self.assertTrue(tiene_pdf([{"mimeType": "application/octet-stream", "filename": "doc.PDF"}]))
        self.assertFalse(tiene_pdf([IMAGEN]))
        self.assertFalse(tiene_pdf([]))

    def test_query_de_gmail(self) -> None:
        query = construir_query("inbox")
        self.assertTrue(query.startswith("in:inbox has:attachment filename:pdf subject:("))
        self.assertIn('"estado de cuenta"', query)
        self.assertIn(" OR ", query)
        self.assertTrue(construir_query("trash").startswith("in:trash "))


class FakeGmail:
    def __init__(self) -> None:
        self.consultas: list[dict[str, Any]] = []

    def profile(self) -> dict[str, Any]:
        return {"email": "a@example.com"}

    def list_messages(self, folder: str, max_results: int, page_token: str | None = None, query: str | None = None) -> dict[str, Any]:
        self.consultas.append({"folder": folder, "query": query})
        mensajes = [
            {"id": "ok-bbva", "subject": "Tu estado de cuenta", "senderEmail": "avisos@bbva.mx", "attachments": [PDF]},
            {"id": "ok-mp", "subject": "Resumen de cuenta octubre", "senderEmail": "info@mercadopago.com", "attachments": [PDF]},
            {"id": "sin-frase", "subject": "Cuenta nueva: tu estado", "senderEmail": "x@banco.com", "attachments": [PDF]},
            {"id": "sin-pdf", "subject": "Estado de cuenta", "senderEmail": "x@banco.com", "attachments": [IMAGEN]},
        ]
        return {"messages": mensajes, "nextPageToken": None}


class RutaEstadosTests(unittest.TestCase):
    def setUp(self) -> None:
        directorio = tempfile.TemporaryDirectory()
        self.addCleanup(directorio.cleanup)
        self.gmail = FakeGmail()
        reemplazos = {
            "gmail": self.gmail,
            "configuracion": ConfiguracionCuenta(Path(directorio.name, "configuracion")),
            "clasificaciones": AlmacenClasificaciones(Path(directorio.name, "clasificaciones")),
        }
        for nombre, valor in reemplazos.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        self.api = TestClient(main.app)

    def test_por_defecto_filtra_por_asunto_y_pdf_sin_remitentes_configurados(self) -> None:
        respuesta = self.api.get("/api/gmail/messages").json()
        self.assertEqual(respuesta["filtro"], "estados")
        self.assertFalse(respuesta["sinRemitentes"])
        self.assertEqual(self.gmail.consultas[0]["query"], construir_query("inbox"))
        self.assertEqual([m["id"] for m in respuesta["messages"]], ["ok-bbva", "ok-mp"])
        self.assertEqual(respuesta["descartados"], 2)
        self.assertEqual(respuesta["firmaFiltro"], FIRMA_FILTRO)
        self.assertTrue(all(m["asuntoCoincide"] for m in respuesta["messages"]))
        self.assertEqual(respuesta["messages"][1]["terminoAsunto"], "resumen de cuenta")


if __name__ == "__main__":
    unittest.main()
