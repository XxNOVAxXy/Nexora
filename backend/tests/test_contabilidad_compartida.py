"""Ejecuta los casos compartidos con el frontend (src/services/contabilidad.test.ts)."""

from __future__ import annotations

import json
import unittest
from decimal import Decimal
from pathlib import Path

from backend.app.contabilidad import es_fila_de_saldo, parse_money, validar_contabilidad

CASOS = json.loads((Path(__file__).parent / "fixtures" / "contabilidad_casos.json").read_text(encoding="utf-8"))


class CasosCompartidosTests(unittest.TestCase):
    def test_parse_money(self) -> None:
        for caso in CASOS["parse_money"]:
            with self.subTest(texto=caso["texto"], formato=caso["formato"]):
                resultado = parse_money(caso["texto"], caso["formato"])
                esperado = None if caso["valor"] is None else Decimal(caso["valor"])
                self.assertEqual(resultado.valor, esperado)
                self.assertEqual(resultado.dudoso, caso["dudoso"])
                self.assertEqual(resultado.indicador, caso["indicador"])

    def test_fila_de_saldo(self) -> None:
        for caso in CASOS["fila_de_saldo"]:
            with self.subTest(concepto=caso["concepto"]):
                self.assertEqual(es_fila_de_saldo(caso["concepto"]), caso["esperado"])

    def test_validacion(self) -> None:
        for caso in CASOS["validacion"]:
            with self.subTest(caso=caso["nombre"]):
                resultado = validar_contabilidad(caso["resumen"], caso["transacciones"], caso["formato"])
                esperado = caso["esperado"]
                self.assertEqual(resultado["cuadra"], esperado["cuadra"])
                self.assertEqual(resultado["suma_cargos"], esperado["suma_cargos"])
                self.assertEqual(resultado["suma_abonos"], esperado["suma_abonos"])
                comprobaciones = {item["id"]: {"estado": item["estado"], "diferencia": item["diferencia"]} for item in resultado["comprobaciones"]}
                self.assertEqual(comprobaciones, esperado["comprobaciones"])
                self.assertEqual(resultado["filas_discontinuas"], esperado["filas_discontinuas"])
                self.assertEqual(resultado["filas_excluidas"], esperado["filas_excluidas"])
                self.assertEqual(resultado["importes_invalidos"], esperado["importes_invalidos"])
                self.assertEqual(resultado["tolerancia"], "0.01")


if __name__ == "__main__":
    unittest.main()
