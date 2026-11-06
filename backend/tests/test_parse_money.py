from __future__ import annotations

import unittest
from decimal import Decimal

from backend.app.contabilidad import detectar_formato as _detectar_formato, parse_money as _parse_money
from backend.app.gemini import StatementExtraction, _build_result


class ParseMoneyFormatTests(unittest.TestCase):
    def assertMonto(self, texto: str, esperado: str, formato: str | None = None, indicador: str | None = None) -> None:
        resultado = _parse_money(texto, formato)  # type: ignore[arg-type]
        self.assertEqual(resultado.valor, Decimal(esperado), texto)
        self.assertFalse(resultado.dudoso, f"{texto}: {resultado.motivo}")
        self.assertEqual(resultado.indicador, indicador, texto)

    def assertDudoso(self, texto: str, formato: str | None = None) -> None:
        resultado = _parse_money(texto, formato)  # type: ignore[arg-type]
        self.assertTrue(resultado.dudoso, texto)

    def test_formato_mexicano_us(self) -> None:
        self.assertMonto("1,234.56", "1234.56")
        self.assertMonto("1,234,567.89", "1234567.89")
        self.assertMonto("$1,234.56 MXN", "1234.56")
        self.assertMonto("USD 99.90", "99.90")

    def test_formato_europeo(self) -> None:
        self.assertMonto("1.234,56", "1234.56")
        self.assertMonto("1.234.567,89", "1234567.89")
        self.assertMonto("€ 12,50", "12.50")

    def test_espacios_como_separador_de_miles(self) -> None:
        self.assertMonto("1 234,56", "1234.56")
        self.assertMonto("1\u00a0234,56", "1234.56")
        self.assertMonto("1\u202f234\u202f567.89", "1234567.89")
        self.assertMonto("12 345", "12345")
        self.assertDudoso("12 34,56")

    def test_signo_negativo_al_inicio_al_final_y_parentesis(self) -> None:
        self.assertMonto("-1,234.56", "-1234.56")
        self.assertMonto("1,234.56-", "-1234.56")
        self.assertMonto("1.234,56-", "-1234.56")
        self.assertMonto("(1,234.56)", "-1234.56")
        self.assertMonto("($1,234.56)", "-1234.56")
        self.assertMonto("-$1,234.56", "-1234.56")
        self.assertMonto("\u22121,234.56", "-1234.56")
        self.assertDudoso("(-1,234.56)")

    def test_sufijos_cr_dr_cargo_abono(self) -> None:
        self.assertMonto("1,234.56 CR", "1234.56", indicador="abono")
        self.assertMonto("1,234.56CR", "1234.56", indicador="abono")
        self.assertMonto("500.00 DR", "500.00", indicador="cargo")
        self.assertMonto("500.00 cargo", "500.00", indicador="cargo")
        self.assertMonto("1.234,56 ABONO", "1234.56", indicador="abono")
        self.assertDudoso("-500.00 CR")

    def test_enteros_y_decimales_sin_ambiguedad(self) -> None:
        self.assertMonto("1500", "1500")
        self.assertMonto("1,234,567", "1234567")
        self.assertMonto("1.234.567", "1234567")
        self.assertMonto("1,5", "1.5")
        self.assertMonto("12.50", "12.50")
        self.assertMonto("0,500", "0.500")
        self.assertMonto("1234.567", "1234.567")

    def test_separador_ambiguo_sin_formato_queda_dudoso(self) -> None:
        for texto in ("1,234", "1.234", "-1,234", "1,234 CR"):
            resultado = _parse_money(texto)
            self.assertIsNone(resultado.valor, texto)
            self.assertTrue(resultado.dudoso, texto)

    def test_separador_ambiguo_se_resuelve_con_formato(self) -> None:
        self.assertMonto("1,234", "1234", formato="us")
        self.assertMonto("1.234", "1.234", formato="us")
        self.assertMonto("1.234", "1234", formato="eu")
        self.assertMonto("1,234", "1.234", formato="eu")

    def test_texto_invalido_o_vacio(self) -> None:
        self.assertEqual(_parse_money("").valor, None)
        self.assertFalse(_parse_money("   ").dudoso)
        for texto in ("N/D", "12abc", "1,23,456", "1.234,56,7", "--"):
            self.assertDudoso(texto)


class FormatoDelDocumentoTests(unittest.TestCase):
    def test_detecta_formato_por_importes_inequivocos(self) -> None:
        self.assertEqual(_detectar_formato(["1,234", "25,000.00"]), ("us", False))
        self.assertEqual(_detectar_formato(["1.234", "25.000,00"]), ("eu", False))
        self.assertEqual(_detectar_formato(["1,234", "500", ""]), (None, False))
        self.assertEqual(_detectar_formato(["1,234.56", "1.234,56"]), (None, True))

    def _resultado(self, resumen: dict[str, str], transacciones: list[dict[str, str]]) -> dict:
        extraccion = StatementExtraction.model_validate({"resumen": resumen, "transacciones": transacciones})
        return _build_result("estado.pdf", extraccion, "test-model")

    def test_ambiguo_se_resuelve_con_formato_us_del_documento(self) -> None:
        resultado = self._resultado(
            {"saldo_inicial": "10,000.00", "total_cargos": "1,234", "total_abonos": "0.00", "saldo_final": "8,766.00"},
            [{"fecha": "02/10", "concepto": "PAGO", "cargo": "1,234", "saldo": "8,766.00"}],
        )
        transaccion = resultado["transacciones"][0]
        self.assertEqual(transaccion["cargo"], "1234.00")
        self.assertEqual(transaccion["cargo_original"], "1,234")
        self.assertEqual(transaccion["dudosos"], [])
        self.assertEqual(resultado["resumen"]["dudosos"], [])
        self.assertTrue(resultado["validacion"]["cuadra"])

    def test_ambiguo_se_resuelve_con_formato_europeo_del_documento(self) -> None:
        resultado = self._resultado(
            {"saldo_inicial": "1.000,00", "total_cargos": "0,00", "total_abonos": "2.500", "saldo_final": "3.500,00"},
            [{"fecha": "02/10", "concepto": "DEPOSITO", "abono": "2.500"}],
        )
        self.assertEqual(resultado["transacciones"][0]["abono"], "2500.00")
        self.assertEqual(resultado["resumen"]["total_abonos"], "2500.00")
        self.assertTrue(resultado["validacion"]["cuadra"])

    def test_ambiguo_sin_pistas_queda_dudoso_y_conserva_texto(self) -> None:
        resultado = self._resultado(
            {"saldo_inicial": "5,000", "total_cargos": "1,234", "total_abonos": "", "saldo_final": "3,766"},
            [{"fecha": "02/10", "concepto": "PAGO", "cargo": "1,234"}],
        )
        transaccion = resultado["transacciones"][0]
        self.assertEqual(transaccion["cargo"], "1,234")
        self.assertEqual(transaccion["dudosos"], ["cargo"])
        self.assertIn("total_cargos", resultado["resumen"]["dudosos"])
        self.assertIsNone(resultado["validacion"]["cuadra"])
        self.assertTrue(any("dudosos" in warning for warning in resultado["warnings"]))

    def test_formatos_contradictorios_no_resuelven_ambiguos(self) -> None:
        resultado = self._resultado(
            {"saldo_inicial": "1,234.56", "saldo_final": "1.234,56"},
            [{"fecha": "02/10", "concepto": "PAGO", "cargo": "1,234"}],
        )
        self.assertEqual(resultado["transacciones"][0]["dudosos"], ["cargo"])
        self.assertTrue(any("mezcla formatos" in warning for warning in resultado["warnings"]))

    def test_normalizacion_por_tipo_de_campo(self) -> None:
        resultado = self._resultado(
            {"saldo_inicial": "1,000.00"},
            [
                {"concepto": "PAGO", "cargo": "-500.00", "saldo": "500.00"},
                {"concepto": "COMISION", "cargo": "25.00", "saldo": "1,234.56 DR"},
                {"concepto": "DEPOSITO", "abono": "500.00 DR"},
            ],
        )
        pago, comision, deposito = resultado["transacciones"]
        self.assertEqual((pago["cargo"], pago["dudosos"]), ("500.00", []))
        self.assertEqual((comision["saldo"], comision["dudosos"]), ("-1234.56", []))
        self.assertEqual(comision["saldo_original"], "1,234.56 DR")
        self.assertEqual(deposito["dudosos"], ["abono"])
        self.assertEqual({t["origen"] for t in resultado["transacciones"]}, {"ia"})


if __name__ == "__main__":
    unittest.main()
