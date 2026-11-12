from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.app import gemini as gemini_module
from backend.app.gemini import GeminiSettings, StatementExtraction, _build_result

PDF = b"%PDF-1.7\ncontenido"


def _extraccion(cargo: str = "500.00") -> StatementExtraction:
    return StatementExtraction.model_validate({
        "resumen": {"saldo_inicial": "1,000.00", "total_cargos": cargo, "saldo_final": "500.00"},
        "transacciones": [{"fecha": "02/10", "concepto": "PAGO", "cargo": cargo, "saldo": "500.00"}],
    })


class BuildResultTests(unittest.TestCase):
    def test_respuesta_incluye_validacion_formato_y_huella(self) -> None:
        resultado = _build_result("estado.pdf", _extraccion(), "modelo")
        self.assertEqual(resultado["formato_numerico"], "us")
        self.assertTrue(resultado["validacion"]["cuadra"])
        self.assertNotIn("balanceValidation", resultado)
        transaccion = resultado["transacciones"][0]
        self.assertEqual(len(transaccion["huella"]), 16)
        self.assertNotIn("revision", transaccion)

    def test_huella_estable_entre_extracciones_y_distinta_por_movimiento(self) -> None:
        a = _build_result("estado.pdf", _extraccion(), "m")["transacciones"][0]["huella"]
        b = _build_result("estado.pdf", _extraccion(), "m")["transacciones"][0]["huella"]
        c = _build_result("estado.pdf", _extraccion("600.00"), "m")["transacciones"][0]["huella"]
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_filas_de_saldo_sin_importe_se_quitan_y_con_importe_se_marcan(self) -> None:
        extraccion = StatementExtraction.model_validate({
            "resumen": {"saldo_inicial": "1,000.00", "total_abonos": "200.00", "saldo_final": "1,200.00"},
            "transacciones": [
                {"concepto": "SALDO ANTERIOR", "saldo": "1,000.00"},
                {"concepto": "Saldo anterior al 30/09", "abono": "1,000.00"},
                {"concepto": "DEPOSITO", "abono": "200.00", "saldo": "1,200.00"},
            ],
        })
        resultado = _build_result("estado.pdf", extraccion, "m")
        conceptos = [t["concepto"] for t in resultado["transacciones"]]
        self.assertEqual(conceptos, ["Saldo anterior al 30/09", "DEPOSITO"])
        self.assertEqual(resultado["transacciones"][0]["revision"], "fila_de_saldo_con_importe")
        # La fila de saldo con importe no se suma: la conciliación cuadra con el depósito real.
        self.assertTrue(resultado["validacion"]["cuadra"])
        self.assertEqual(resultado["validacion"]["suma_abonos"], "200.00")
        self.assertTrue(any("fila(s) de saldo" in w for w in resultado["warnings"]))


class CacheExtraccionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = GeminiSettings()
        self.valores = {"apiKey": "k" * 12, "enabled": True, "model": "modelo-a"}
        read = patch.object(self.settings, "_read", side_effect=lambda: dict(self.valores))
        read.start()
        self.addCleanup(read.stop)
        self.llamadas = 0

        def generar(data: bytes, mime: str, filename: str, api_key: str, model: str, campos=()):
            self.llamadas += 1
            return _extraccion(f"{100 * self.llamadas}.00"), model

        gen = patch.object(self.settings, "_generate", side_effect=generar)
        gen.start()
        self.addCleanup(gen.stop)

    def extraer(self, forzar: bool = False) -> dict:
        return self.settings.extract_document(PDF, "application/pdf", "estado.pdf", forzar=forzar)

    def test_reutiliza_cache_y_forzar_reemplaza_la_entrada(self) -> None:
        primero = self.extraer()
        self.assertEqual(self.extraer(), primero)
        self.assertEqual(self.llamadas, 1)
        forzado = self.extraer(forzar=True)
        self.assertEqual(self.llamadas, 2)
        self.assertNotEqual(forzado["transacciones"][0]["cargo"], primero["transacciones"][0]["cargo"])
        # Sin forzar, ahora se obtiene el resultado nuevo, no el viejo.
        self.assertEqual(self.extraer()["transacciones"][0]["cargo"], forzado["transacciones"][0]["cargo"])
        self.assertEqual(self.llamadas, 2)

    def test_cambiar_modelo_o_version_del_prompt_invalida_la_cache(self) -> None:
        self.extraer()
        self.valores["model"] = "modelo-b"
        self.extraer()
        self.assertEqual(self.llamadas, 2)
        with patch.object(gemini_module, "PROMPT_VERSION", "otra-version"):
            self.extraer()
        self.assertEqual(self.llamadas, 3)
        self.valores["model"] = "modelo-a"
        self.extraer()  # modelo-a con la versión vigente sigue en caché
        self.assertEqual(self.llamadas, 3)


if __name__ == "__main__":
    unittest.main()
