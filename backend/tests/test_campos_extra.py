"""Columnas adicionales de la tabla de Movimientos (botón "+ Campo"): sugerencias de la IA y persistencia."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest, cuenta_id
from backend.app.gemini import MAX_SUGERENCIAS_CAMPOS, StatementExtraction, _build_result
from backend.app.savedata import datos_documento, totales_de

EMAIL = "a@example.com"


def _extraccion(transacciones: list[dict[str, Any]], campos_adicionales: list[dict[str, Any]] | None = None) -> StatementExtraction:
    return StatementExtraction.model_validate({
        "resumen": {"saldo_inicial": "1,000.00", "saldo_final": "800.00"},
        "transacciones": transacciones,
        "campos_adicionales": campos_adicionales or [],
    })


def _fila(concepto: str, cargo: str, adicionales: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"fecha": "02/10", "concepto": concepto, "cargo": cargo, "adicionales": adicionales or []}


class SugerenciasGeminiTests(unittest.TestCase):
    def test_asocia_valores_por_fila_a_la_huella(self) -> None:
        resultado = _build_result("estado.pdf", _extraccion([
            _fila("PAGO A", "100.00", [{"campo": "VSM", "valor": "12.5"}]),
            _fila("PAGO B", "100.00", [{"campo": "VSM", "valor": "13"}]),
        ]), "m")
        [sugerencia] = resultado["sugerencias_campos"]
        self.assertEqual(sugerencia["clave"], "vsm")
        self.assertEqual(sugerencia["nombre"], "VSM")
        huellas = [transaccion["huella"] for transaccion in resultado["transacciones"]]
        self.assertEqual(sugerencia["valores"], [{"huella": huellas[0], "valor": "12.5"}, {"huella": huellas[1], "valor": "13"}])
        self.assertNotIn("valor_documento", sugerencia)

    def test_descarta_sin_valor_estandar_y_duplicados(self) -> None:
        resultado = _build_result("estado.pdf", _extraccion([
            _fila("PAGO", "100.00", [
                {"campo": "Folio", "valor": "  "},
                {"campo": "Concepto", "valor": "otro"},
                {"campo": "Fecha de operación", "valor": "01/10"},
                {"campo": "Sucursal", "valor": "Centro"},
                {"campo": "sucursal", "valor": "Repetida"},
            ]),
        ], [{"nombre": "Saldo final", "valor_documento": "800.00"}, {"nombre": "Sucursal", "valor_documento": "X"}, {"nombre": "Sin valor", "valor_documento": ""}]), "m")
        self.assertEqual([(s["nombre"], [v["valor"] for v in s["valores"]]) for s in resultado["sugerencias_campos"]], [("Sucursal", ["Centro"])])

    def test_valor_unico_del_documento(self) -> None:
        resultado = _build_result("estado.pdf", _extraccion([_fila("PAGO", "100.00")], [{"nombre": "Número de crédito", "valor_documento": "CR-778"}]), "m")
        self.assertEqual(resultado["sugerencias_campos"], [{"clave": "numero-de-credito", "nombre": "Número de crédito", "valores": [], "valor_documento": "CR-778"}])

    def test_limita_a_ocho_priorizando_los_de_mas_filas(self) -> None:
        filas = [_fila(f"PAGO {i}", "1.00", [{"campo": f"C{n}", "valor": "x"} for n in range(10) if n >= i]) for i in range(10)]
        resultado = _build_result("estado.pdf", _extraccion(filas, [{"nombre": "Contrato", "valor_documento": "K-1"}]), "m")
        sugerencias = resultado["sugerencias_campos"]
        self.assertEqual(len(sugerencias), MAX_SUGERENCIAS_CAMPOS)
        # C9 aparece en 10 filas, C0 en una sola; el valor único del documento queda fuera.
        self.assertEqual([s["nombre"] for s in sugerencias], [f"C{n}" for n in range(9, 1, -1)])

    def test_sin_campos_adicionales(self) -> None:
        self.assertEqual(_build_result("estado.pdf", _extraccion([_fila("PAGO", "100.00")]), "m")["sugerencias_campos"], [])


TRANSACCION = {"id": "ia-1", "fecha": "02/10", "concepto": "PAGO", "referencia": "", "cargo": "200.00", "abono": "", "saldo": "800.00", "origen": "ia", "dudosos": [], "huella": "h1"}


def _cuerpo(**cambios: Any) -> dict[str, Any]:
    base = {
        "version_base": None, "estado": "borrador", "formato_numerico": "us", "filename": "estado.pdf",
        "resumen": {"saldo_inicial": "1000.00", "saldo_final": "800.00"},
        "transacciones": [{**TRANSACCION, "extras": {"c1": "12.5", "huerfano": "x", "c2": ""}}],
        "campos_extra": [{"id": "c1", "nombre": "  VSM ", "origen": "ia", "clave": "vsm"}, {"id": "c2", "nombre": "Notas", "origen": "manual"}],
        "sugerencias_campos": [{"clave": "vsm", "nombre": "VSM", "valores": [{"huella": "h1", "valor": "12.5"}]}],
    }
    base.update(cambios)
    return base


class PersistenciaCamposTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        self.almacen = AlmacenExtracciones(Path(self.directorio.name))

    def test_guarda_y_recarga_columnas_y_valores(self) -> None:
        guardado = self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate(_cuerpo()))
        recargado = self.almacen.obtener(EMAIL, "m1", "1")
        for documento in (guardado, recargado):
            self.assertEqual(documento["campos_extra"], [{"id": "c1", "nombre": "VSM", "origen": "ia", "clave": "vsm"}, {"id": "c2", "nombre": "Notas", "origen": "manual"}])
            self.assertEqual(documento["sugerencias_campos"][0]["clave"], "vsm")
            # Se descartan el valor de una columna inexistente y los vacíos.
            self.assertEqual(documento["transacciones"][0]["extras"], {"c1": "12.5"})
        # Las columnas no entran en la validación contable.
        self.assertTrue(guardado["validacion"]["cuadra"])

    def test_fila_sin_extras_no_guarda_la_clave(self) -> None:
        guardado = self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate(_cuerpo(transacciones=[{**TRANSACCION, "extras": {"huerfano": "x"}}])))
        self.assertNotIn("extras", guardado["transacciones"][0])

    def test_documento_antiguo_sin_campos_abre_y_se_vuelve_a_guardar(self) -> None:
        carpeta = Path(self.directorio.name, cuenta_id(EMAIL))
        carpeta.mkdir(parents=True)
        antiguo = {"schema": 1, "cuenta": EMAIL, "messageId": "m1", "partId": "1", "estado": "borrador", "version": 1, "resumen": {}, "transacciones": [TRANSACCION], "validacion": {}, "problemas": {}}
        (carpeta / "m1__1.json").write_text(json.dumps(antiguo), encoding="utf-8")
        self.assertNotIn("campos_extra", self.almacen.obtener(EMAIL, "m1", "1"))
        cuerpo = _cuerpo(version_base=1, transacciones=[TRANSACCION])
        del cuerpo["campos_extra"], cuerpo["sugerencias_campos"]
        guardado = self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate(cuerpo))
        self.assertEqual((guardado["version"], guardado["campos_extra"], guardado["sugerencias_campos"]), (2, [], []))

    def test_rechaza_ids_repetidos_nombres_vacios_y_limites(self) -> None:
        for cambios in (
            {"campos_extra": [{"id": "c1", "nombre": "A", "origen": "manual"}, {"id": "c1", "nombre": "B", "origen": "manual"}]},
            {"campos_extra": [{"id": "c1", "nombre": "   ", "origen": "manual"}]},
            {"campos_extra": [{"id": "c1", "nombre": "x" * 61, "origen": "manual"}]},
            {"campos_extra": [{"id": f"c{n}", "nombre": f"C{n}", "origen": "manual"} for n in range(31)]},
            {"transacciones": [{**TRANSACCION, "extras": {"c1": "x" * 501}}]},
        ):
            with self.subTest(cambios=list(cambios)), self.assertRaises(ValidationError):
                GuardarExtraccionRequest.model_validate(_cuerpo(**cambios))

    def test_savedata_no_envia_columnas_adicionales(self) -> None:
        guardado = self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate(_cuerpo()))
        datos = datos_documento(guardado, totales_de(guardado))
        self.assertEqual(list(datos["Transacciones"][0]), ["fecha", "concepto", "referencia", "cargo", "abono", "saldo"])
        self.assertNotIn("12.5", json.dumps(datos))
        self.assertNotIn("campos_extra", datos)


if __name__ == "__main__":
    unittest.main()
