"""La IA llena las columnas manuales: al extraer (campos_solicitados) y con "Llenar con IA" (/api/gemini/campos)."""

from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.extracciones import GuardarExtraccionRequest
from backend.app.gemini import CampoLlenado, GeminiSettings, StatementExtraction, _build_result, _cache_key, _extraction_prompt, _prompt_llenar_campo, resultado_llenado

PDF = b"%PDF-1.7\ncontenido"


def _extraccion(transacciones: list[dict[str, Any]], solicitados: list[dict[str, Any]]) -> StatementExtraction:
    return StatementExtraction.model_validate({"resumen": {"saldo_inicial": "1,000.00", "saldo_final": "800.00"}, "transacciones": transacciones, "campos_solicitados": solicitados})


def _fila(concepto: str, adicionales: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"fecha": "02/10", "concepto": concepto, "cargo": "100.00", "adicionales": adicionales or []}


class CamposSolicitadosTests(unittest.TestCase):
    def test_el_prompt_y_la_cache_incluyen_las_columnas_pedidas(self) -> None:
        self.assertIn('"Nombre"', _extraction_prompt("e.pdf", ["Nombre"]))
        self.assertNotIn("Columnas pedidas", _extraction_prompt("e.pdf"))
        self.assertNotEqual(_cache_key(PDF, "m"), _cache_key(PDF, "m", ["Nombre"]))
        self.assertEqual(_cache_key(PDF, "m", ["Nombre", "Folio"]), _cache_key(PDF, "m", ["folio", "nombre"]))

    def test_valores_por_fila_asociados_a_la_huella_y_fuera_de_las_sugerencias(self) -> None:
        resultado = _build_result("e.pdf", _extraccion(
            [_fila("PAGO A", [{"campo": "Nombre", "valor": "Juan"}]), _fila("PAGO B", [{"campo": "nombre", "valor": "Ana"}])],
            [{"nombre": "Nombre", "encontrado": True}],
        ), "m", ["Nombre"])
        huellas = [t["huella"] for t in resultado["transacciones"]]
        self.assertEqual(resultado["resultados_campos"], [{"nombre": "Nombre", "clave": "nombre", "encontrado": True, "valores": [{"huella": huellas[0], "valor": "Juan"}, {"huella": huellas[1], "valor": "Ana"}]}])
        self.assertEqual(resultado["sugerencias_campos"], [])

    def test_valor_unico_del_documento(self) -> None:
        resultado = _build_result("e.pdf", _extraccion([_fila("PAGO")], [{"nombre": "Titular", "encontrado": True, "valor_documento": "Persona Prueba"}]), "m", ["Titular"])
        self.assertEqual(resultado["resultados_campos"][0], {"nombre": "Titular", "clave": "titular", "encontrado": True, "valores": [], "valor_documento": "Persona Prueba"})

    def test_no_encontrado_descarta_cualquier_valor(self) -> None:
        for solicitados in (
            [{"nombre": "Nombre", "encontrado": False, "valor_documento": "inventado"}],
            [{"nombre": "Nombre", "encontrado": True, "valor_documento": "  "}],
            [],
        ):
            with self.subTest(solicitados=solicitados):
                transacciones = [_fila("PAGO", [{"campo": "Nombre", "valor": "x"}])] if solicitados and not solicitados[0]["encontrado"] else [_fila("PAGO")]
                resultado = _build_result("e.pdf", _extraccion(transacciones, solicitados), "m", ["Nombre"])
                self.assertEqual(resultado["resultados_campos"], [{"nombre": "Nombre", "clave": "nombre", "encontrado": False, "valores": []}])

    def test_extract_document_pasa_las_columnas_a_gemini(self) -> None:
        ajustes = GeminiSettings()
        recibido: dict[str, Any] = {}

        def generar(data: bytes, mime: str, filename: str, api_key: str, model: str, campos=()):
            recibido["campos"] = list(campos)
            return _extraccion([_fila("PAGO")], []), model

        with patch.object(ajustes, "_read", return_value={"apiKey": "k" * 12, "enabled": True, "model": "m"}), patch.object(ajustes, "_generate", side_effect=generar):
            resultado = ajustes.extract_document(PDF, "application/pdf", "e.pdf", campos_solicitados=[" Nombre ", "nombre", ""])
        self.assertEqual(recibido["campos"], ["Nombre"])
        self.assertEqual(resultado["resultados_campos"][0]["encontrado"], False)


class LlenarCampoTests(unittest.TestCase):
    def test_valida_indices_y_descarta_si_no_se_encontro(self) -> None:
        respuesta = CampoLlenado.model_validate({"encontrado": True, "valores": [{"indice": 0, "valor": "Juan"}, {"indice": 0, "valor": "otra"}, {"indice": 7, "valor": "fuera"}, {"indice": 1, "valor": " "}]})
        self.assertEqual(resultado_llenado("Nombre", respuesta, 2), {"nombre": "Nombre", "clave": "nombre", "encontrado": True, "valores": [{"indice": 0, "valor": "Juan"}]})
        no = CampoLlenado.model_validate({"encontrado": False, "valor_documento": "x", "valores": [{"indice": 0, "valor": "y"}]})
        self.assertEqual(resultado_llenado("Nombre", no, 2)["encontrado"], False)
        unico = CampoLlenado.model_validate({"encontrado": True, "valor_documento": "Persona Prueba"})
        self.assertEqual(resultado_llenado("Titular", unico, 2)["valor_documento"], "Persona Prueba")

    def test_el_prompt_lista_las_filas_con_su_indice(self) -> None:
        prompt = _prompt_llenar_campo("e.pdf", "Nombre", [{"fecha": "02/10", "concepto": "PAGO", "referencia": "", "cargo": "1.00", "abono": ""}])
        self.assertIn('{"indice": 0, "fecha": "02/10"', prompt)
        self.assertIn("Nunca inventes", prompt)

    def test_endpoint_llama_a_fill_field_con_las_filas(self) -> None:
        recibido: dict[str, Any] = {}

        class FakeGmail:
            def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
                return PDF, "application/pdf", "e.pdf"

        class FakeGemini:
            def fill_field(self, data: bytes, mime: str, filename: str, nombre: str, filas: list[dict[str, str]]) -> dict[str, Any]:
                recibido.update(nombre=nombre, filas=filas)
                return {"nombre": nombre, "clave": "nombre", "encontrado": False, "valores": []}

        with patch.object(main, "gmail", FakeGmail()), patch.object(main, "gemini", FakeGemini()):
            respuesta = TestClient(main.app).post("/api/gemini/campos", json={"messageId": "m", "attachmentId": "a", "nombre": "Nombre", "filas": [{"fecha": "02/10", "concepto": "PAGO", "extra": "ignorado"}]})
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(respuesta.json()["encontrado"], False)
        self.assertEqual(recibido["filas"], [{"fecha": "02/10", "concepto": "PAGO", "referencia": "", "cargo": "", "abono": ""}])

    def test_fill_field_usa_su_propio_esquema_sin_cache(self) -> None:
        ajustes = GeminiSettings()
        llamadas: list[Any] = []

        def sdk(api_key, model, data, mime, filename, prompt=None, schema=None):
            llamadas.append(schema)
            return '{"encontrado": true, "valores": [{"indice": 0, "valor": "Juan"}]}'

        with patch.object(ajustes, "_read", return_value={"apiKey": "k" * 12, "enabled": True, "model": "m"}), patch("backend.app.gemini._call_gemini_sdk", side_effect=sdk):
            primero = ajustes.fill_field(PDF, "application/pdf", "e.pdf", "Nombre", [{"fecha": "", "concepto": "", "referencia": "", "cargo": "", "abono": ""}])
            ajustes.fill_field(PDF, "application/pdf", "e.pdf", "Nombre", [{"fecha": "", "concepto": "", "referencia": "", "cargo": "", "abono": ""}])
        self.assertEqual(primero["valores"], [{"indice": 0, "valor": "Juan"}])
        self.assertEqual(llamadas, [CampoLlenado, CampoLlenado])


class MarcaDeIaTests(unittest.TestCase):
    def test_extras_ia_solo_marca_celdas_existentes_con_valor(self) -> None:
        solicitud = GuardarExtraccionRequest.model_validate({
            "estado": "borrador",
            "campos_extra": [{"id": "c1", "nombre": "Nombre", "origen": "manual"}, {"id": "c2", "nombre": "Folio", "origen": "manual"}],
            "transacciones": [
                {"id": "a", "origen": "ia", "extras": {"c1": "Juan", "c2": "F1"}, "extras_ia": ["c1", "c1", "c3", "c2"]},
                {"id": "b", "origen": "ia", "extras": {"c2": ""}, "extras_ia": ["c2"]},
            ],
        })
        self.assertEqual(solicitud.transacciones[0].extras_ia, ["c1", "c2"])
        self.assertIsNone(solicitud.transacciones[1].extras_ia)


if __name__ == "__main__":
    unittest.main()
