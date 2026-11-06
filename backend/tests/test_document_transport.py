from __future__ import annotations

import base64
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from google import genai
from google.genai import types

from backend.app import main
from backend.app.gemini import StatementExtraction, _build_result, _call_gemini_sdk
from backend.app.gmail import GmailAttachmentError, validate_attachment_payload


# Estado de cuenta ficticio versionado en el repo (lo genera fixtures/generar_pdf_prueba.py).
REAL_PDF = Path(__file__).parent / "fixtures" / "estado_cuenta_ficticio.pdf"


class DocumentTransportTests(unittest.TestCase):
    def test_real_pdf_has_pdf_signature_and_is_forced_to_pdf_mime(self) -> None:
        self.assertTrue(REAL_PDF.exists(), f"Falta el fixture {REAL_PDF}")
        data = REAL_PDF.read_bytes()
        validated, mime_type = validate_attachment_payload(data, "application/octet-stream", REAL_PDF.name)
        self.assertEqual(validated[:5], b"%PDF-")
        self.assertEqual(mime_type, "application/pdf")
        self.assertGreater(len(validated), 1000)

    def test_fixture_pdf_is_structurally_valid_and_matches_generator(self) -> None:
        import importlib.util

        spec = importlib.util.spec_from_file_location("generar_pdf_prueba", REAL_PDF.with_name("generar_pdf_prueba.py"))
        assert spec is not None and spec.loader is not None
        generador = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generador)
        construir_pdf = generador.construir_pdf

        data = REAL_PDF.read_bytes()
        # Si git hubiera convertido saltos de línea, los offsets de la tabla xref dejarían de apuntar a los objetos.
        self.assertEqual(data, construir_pdf())
        inicio_xref = int(data.rsplit(b"startxref", 1)[1].split()[0])
        self.assertTrue(data[inicio_xref:].startswith(b"xref"))
        entradas = data[inicio_xref:].splitlines()[3:9]
        for numero, entrada in enumerate(entradas, start=1):
            offset = int(entrada.split()[0])
            self.assertTrue(data[offset:].startswith(b"%d 0 obj" % numero), numero)
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))

    def test_pdf_signature_wins_when_gmail_metadata_is_generic(self) -> None:
        validated, mime_type = validate_attachment_payload(b"%PDF-1.7\nbody", "application/octet-stream", "attachment")
        self.assertEqual(validated[:5], b"%PDF-")
        self.assertEqual(mime_type, "application/pdf")

    def test_pdf_declared_without_signature_is_rejected(self) -> None:
        with self.assertRaises(GmailAttachmentError):
            validate_attachment_payload(b"not-a-pdf", "application/pdf", "statement.pdf")

    def test_selected_gmail_ids_are_forwarded_without_replacing_document(self) -> None:
        selected: dict[str, str] = {}
        expected_bytes = b"%PDF-1.7\nselected-document"

        class FakeGmail:
            def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
                selected.update(message_id=message_id, attachment_id=attachment_id)
                return expected_bytes, "application/pdf", "Estado_de_Cuenta_Prueba_Nexora.pdf"

        class FakeGemini:
            def extract_document(self, data: bytes, mime_type: str, filename: str, forzar: bool = False) -> dict[str, object]:
                self.received = (data, mime_type, filename)
                return {"filename": filename, "transacciones": [], "validacion": {"cuadra": None}}

        fake_gemini = FakeGemini()
        with patch.object(main, "gmail", FakeGmail()), patch.object(main, "gemini", fake_gemini):
            response = TestClient(main.app).post(
                "/api/gemini/extract",
                json={"messageId": "message-selected", "attachmentId": "attachment-selected"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(selected, {"message_id": "message-selected", "attachment_id": "attachment-selected"})
        self.assertEqual(fake_gemini.received, (expected_bytes, "application/pdf", "Estado_de_Cuenta_Prueba_Nexora.pdf"))

    def test_sdk_receives_pdf_as_document_part_not_prompt_text(self) -> None:
        captured: dict[str, object] = {}
        response = type("Response", (), {"text": '{"resumen": {}, "transacciones": [], "notas": []}'})()

        class FakeModels:
            def generate_content(self, **kwargs: object) -> object:
                captured.update(kwargs)
                return response

        fake_client = type("Client", (), {"models": FakeModels()})()
        with patch.object(genai, "Client", return_value=fake_client):
            _call_gemini_sdk("test-key", "gemini-2.5-flash-lite", b"%PDF-1.7", "application/pdf", "statement.pdf")

        contents = captured["contents"]
        self.assertIsInstance(contents, list)
        document_part = contents[0]
        self.assertIsInstance(document_part, types.Part)
        assert isinstance(document_part, types.Part)
        self.assertEqual(document_part.inline_data.mime_type, "application/pdf")
        self.assertEqual(bytes(document_part.inline_data.data), b"%PDF-1.7")
        self.assertIsInstance(contents[1], str)
        self.assertNotIn("%PDF-1.7", contents[1])
        self.assertNotIn(base64.b64encode(b"%PDF-1.7").decode("ascii"), contents[1])

    def test_opening_balance_row_is_not_counted_as_movement(self) -> None:
        extraction = StatementExtraction.model_validate(
            {
                "resumen": {
                    "saldo_inicial": "25,000.00",
                    "total_abonos": "18,750.00",
                    "total_cargos": "9,425.50",
                    "saldo_final": "34,324.50",
                },
                "transacciones": [
                    {"fecha": "01/10/2026", "concepto": "SALDO INICIAL", "saldo": "25,000.00"},
                    {"fecha": "03/10/2026", "concepto": "TRANSFERENCIA RECIBIDA", "abono": "12,000.00"},
                    {"fecha": "07/10/2026", "concepto": "PAGO A PROVEEDOR", "cargo": "4,250.00"},
                    {"fecha": "12/10/2026", "concepto": "DEPOSITO REFERENCIADO", "abono": "6,750.00"},
                    {"fecha": "18/10/2026", "concepto": "PAGO SERVICIOS", "cargo": "1,875.50"},
                    {"fecha": "24/10/2026", "concepto": "TRANSFERENCIA SALIENTE", "cargo": "3,300.00"},
                ],
            }
        )
        result = _build_result("Estado_de_Cuenta_Prueba_Nexora.pdf", extraction, "test-model")
        self.assertEqual(len(result["transacciones"]), 5)
        saldo_final = next(item for item in result["validacion"]["comprobaciones"] if item["id"] == "saldo_final")
        self.assertEqual(saldo_final["diferencia"], "0.00")
        self.assertTrue(result["validacion"]["cuadra"])


if __name__ == "__main__":
    unittest.main()
