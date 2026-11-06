"""Bloque 6: una respuesta de Gemini cortada nunca se trata como extracción completa."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient
from google import genai
from google.genai import types

from backend.app import main
from backend.app.gemini import (
    MAX_OUTPUT_TOKENS_PREDETERMINADO,
    GeminiRequestError,
    GeminiSettings,
    _call_gemini_sdk,
    max_output_tokens,
)


JSON_COMPLETO = '{"resumen": {"saldo_inicial": "100.00", "saldo_final": "90.00"}, "transacciones": [{"fecha": "01/10/2026", "concepto": "PAGO", "cargo": "10.00"}], "notas": []}'
# Corte a mitad de un movimiento, como ocurre al agotar max_output_tokens.
JSON_CORTADO = '{"resumen": {"saldo_inicial": "100.00"}, "transacciones": [{"fecha": "01/10/2026", "concepto": "PA'


def respuesta(texto: str, finish_reason: Any) -> SimpleNamespace:
    return SimpleNamespace(
        text=texto,
        candidates=[SimpleNamespace(finish_reason=finish_reason)],
        usage_metadata=SimpleNamespace(candidates_token_count=65000, thoughts_token_count=500),
    )


class ClienteFalso:
    def __init__(self, *respuestas: SimpleNamespace) -> None:
        self.respuestas = list(respuestas)
        self.llamadas: list[dict[str, Any]] = []
        self.models = self

    def generate_content(self, **kwargs: Any) -> SimpleNamespace:
        self.llamadas.append(kwargs)
        return self.respuestas[min(len(self.llamadas), len(self.respuestas)) - 1]


def gemini_configurado(directorio: str) -> GeminiSettings:
    ajustes = GeminiSettings(Path(directorio) / "gemini.json")
    ajustes.save("clave-de-prueba-123456", "gemini-prueba")
    return ajustes


class DeteccionDeTruncamientoTests(unittest.TestCase):
    def test_max_tokens_con_json_cortado_es_respuesta_truncada(self) -> None:
        cliente = ClienteFalso(respuesta(JSON_CORTADO, types.FinishReason.MAX_TOKENS))
        with patch.object(genai, "Client", return_value=cliente):
            with self.assertRaises(GeminiRequestError) as contexto:
                _call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf")
        self.assertEqual(contexto.exception.code, "respuesta_truncada")
        self.assertEqual(contexto.exception.status_code, 422)
        self.assertFalse(contexto.exception.retryable)
        self.assertIn("demasiado largo", str(contexto.exception))

    def test_max_tokens_con_json_valido_tampoco_se_acepta(self) -> None:
        # Aunque el corte deje un JSON legible, faltan movimientos: nunca es una extracción completa.
        cliente = ClienteFalso(respuesta(JSON_COMPLETO, types.FinishReason.MAX_TOKENS))
        with patch.object(genai, "Client", return_value=cliente):
            with self.assertRaises(GeminiRequestError) as contexto:
                _call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf")
        self.assertEqual(contexto.exception.code, "respuesta_truncada")

    def test_finish_reason_como_texto_tambien_se_detecta(self) -> None:
        cliente = ClienteFalso(respuesta(JSON_COMPLETO, "FinishReason.MAX_TOKENS"))
        with patch.object(genai, "Client", return_value=cliente):
            with self.assertRaises(GeminiRequestError) as contexto:
                _call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf")
        self.assertEqual(contexto.exception.code, "respuesta_truncada")

    def test_otros_motivos_de_corte_son_respuesta_incompleta(self) -> None:
        for motivo in (types.FinishReason.SAFETY, types.FinishReason.RECITATION, types.FinishReason.OTHER):
            with self.subTest(motivo=motivo):
                cliente = ClienteFalso(respuesta(JSON_COMPLETO, motivo))
                with patch.object(genai, "Client", return_value=cliente):
                    with self.assertRaises(GeminiRequestError) as contexto:
                        _call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf")
                self.assertEqual(contexto.exception.code, "respuesta_incompleta")
                self.assertIn(motivo.name, str(contexto.exception))

    def test_stop_se_acepta(self) -> None:
        cliente = ClienteFalso(respuesta(JSON_COMPLETO, types.FinishReason.STOP))
        with patch.object(genai, "Client", return_value=cliente):
            self.assertEqual(_call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf"), JSON_COMPLETO)

    def test_truncada_no_se_guarda_en_cache_ni_se_reintenta_con_otro_modelo(self) -> None:
        cliente = ClienteFalso(
            respuesta(JSON_CORTADO, types.FinishReason.MAX_TOKENS),
            respuesta(JSON_COMPLETO, types.FinishReason.STOP),
        )
        with tempfile.TemporaryDirectory() as directorio, patch.object(genai, "Client", return_value=cliente):
            ajustes = gemini_configurado(directorio)
            with self.assertRaises(GeminiRequestError) as contexto:
                ajustes.extract_document(b"%PDF-1.7 largo", "application/pdf", "estado.pdf")
            self.assertEqual(contexto.exception.code, "respuesta_truncada")
            # Una sola llamada: ni reintento ni modelo de respaldo con la respuesta cortada.
            self.assertEqual(len(cliente.llamadas), 1)
            self.assertEqual(ajustes._cache, {})
            # La siguiente extracción vuelve a llamar a Gemini (no hay resultado parcial en caché).
            resultado = ajustes.extract_document(b"%PDF-1.7 largo", "application/pdf", "estado.pdf")
        self.assertEqual(len(cliente.llamadas), 2)
        self.assertEqual(len(resultado["transacciones"]), 1)

    def test_endpoint_devuelve_el_codigo_de_truncamiento(self) -> None:
        class GmailFalso:
            def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
                return b"%PDF-1.7 largo", "application/pdf", "estado.pdf"

        cliente = ClienteFalso(respuesta(JSON_CORTADO, types.FinishReason.MAX_TOKENS))
        with tempfile.TemporaryDirectory() as directorio, patch.object(genai, "Client", return_value=cliente):
            with patch.object(main, "gmail", GmailFalso()), patch.object(main, "gemini", gemini_configurado(directorio)):
                r = TestClient(main.app).post("/api/gemini/extract", json={"messageId": "m", "attachmentId": "a"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["detail"]["code"], "respuesta_truncada")
        self.assertNotIn("transacciones", r.json())


class LimiteDeSalidaTests(unittest.TestCase):
    def test_valor_predeterminado_y_variable_de_entorno(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GEMINI_MAX_OUTPUT_TOKENS", None)
            self.assertEqual(max_output_tokens(), 65536)
            self.assertEqual(MAX_OUTPUT_TOKENS_PREDETERMINADO, 65536)
        with patch.dict(os.environ, {"GEMINI_MAX_OUTPUT_TOKENS": "16384"}):
            self.assertEqual(max_output_tokens(), 16384)
        for invalido in ("abc", "0", "-5", "  "):
            with self.subTest(invalido=invalido), patch.dict(os.environ, {"GEMINI_MAX_OUTPUT_TOKENS": invalido}):
                self.assertEqual(max_output_tokens(), 65536)

    def test_el_limite_llega_a_la_llamada_del_sdk(self) -> None:
        cliente = ClienteFalso(respuesta(JSON_COMPLETO, types.FinishReason.STOP))
        with patch.dict(os.environ, {"GEMINI_MAX_OUTPUT_TOKENS": "32000"}), patch.object(genai, "Client", return_value=cliente):
            _call_gemini_sdk("k", "m", b"%PDF-1.7", "application/pdf", "estado.pdf")
        self.assertEqual(cliente.llamadas[0]["config"].max_output_tokens, 32000)


if __name__ == "__main__":
    unittest.main()
