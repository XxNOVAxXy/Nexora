"""Datos del documento (una sola vez) frente a campos por movimiento, migración al leer y orden por fecha."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from backend.app.automatico import borrador_desde_extraccion
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest, cuenta_id
from backend.app.orden_fechas import leer_fecha, ordenar_por_fecha
from backend.app.savedata import datos_documento, preparar_envio, totales_de

EMAIL = "a@example.com"


def _fila(id_: str, fecha: str = "02/10/2026", extras: dict[str, str] | None = None, extras_ia: list[str] | None = None) -> dict[str, Any]:
    fila: dict[str, Any] = {"id": id_, "fecha": fecha, "concepto": f"PAGO {id_}", "cargo": "100.00", "origen": "ia", "dudosos": [], "huella": f"h{id_}"}
    if extras:
        fila["extras"] = extras
    if extras_ia:
        fila["extras_ia"] = extras_ia
    return fila


def _cuerpo(**cambios: Any) -> dict[str, Any]:
    base = {"estado": "borrador", "formato_numerico": "us", "filename": "estado.pdf", "resumen": {"saldo_inicial": "1000.00", "saldo_final": "800.00"}, "transacciones": [_fila("1"), _fila("2")]}
    base.update(cambios)
    return base


class Almacen(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        self.almacen = AlmacenExtracciones(Path(self.directorio.name))

    def guardar(self, **cambios: Any) -> dict[str, Any]:
        return self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate(_cuerpo(**cambios)))

    def archivo(self) -> dict[str, Any]:
        return json.loads((Path(self.directorio.name) / cuenta_id(EMAIL) / "m1__1.json").read_text(encoding="utf-8"))


class DatosDelDocumento(Almacen):
    def test_un_dato_del_documento_se_guarda_una_sola_vez(self) -> None:
        guardado = self.guardar(
            transacciones=[_fila("1", extras={"c1": "12.5", "rfc": "XAXX010101000"}, extras_ia=["rfc"]), _fila("2", extras={"c1": "13"})],
            campos_extra=[
                {"id": "c1", "nombre": "VSM", "origen": "ia", "clave": "vsm"},
                {"id": "rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento", "valor": " XAXX010101000 ", "valor_ia": True},
                {"id": "c3", "nombre": "Folio", "origen": "manual", "alcance": "movimiento", "valor": "no se guarda", "valor_ia": True},
            ],
        )
        for documento in (guardado, self.almacen.obtener(EMAIL, "m1", "1")):
            self.assertEqual(documento["campos_extra"], [
                {"id": "c1", "nombre": "VSM", "origen": "ia", "clave": "vsm"},
                {"id": "rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento", "valor": "XAXX010101000", "valor_ia": True},
                {"id": "c3", "nombre": "Folio", "origen": "manual"},
            ])
            # El valor del documento nunca se repite en los movimientos.
            self.assertEqual([t.get("extras") for t in documento["transacciones"]], [{"c1": "12.5"}, {"c1": "13"}])
            self.assertTrue(all("extras_ia" not in t for t in documento["transacciones"]))

    def test_savedata_no_cambia_con_datos_del_documento(self) -> None:
        sin_campos = self.guardar()
        self.almacen.guardar(EMAIL, "m2", "1", GuardarExtraccionRequest.model_validate(_cuerpo(campos_extra=[{"id": "rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento", "valor": "XAXX010101000"}])))
        con_campos = self.almacen.obtener(EMAIL, "m2", "1")
        self.assertEqual(datos_documento(con_campos, totales_de(con_campos)), datos_documento(sin_campos, totales_de(sin_campos)))
        cuerpo = preparar_envio(con_campos, sucursal=3102, articulo="10000453", carga_inicial=False)
        self.assertEqual(cuerpo, preparar_envio(sin_campos, sucursal=3102, articulo="10000453", carga_inicial=False))
        self.assertNotIn("XAXX010101000", json.dumps(cuerpo))


class MigracionAlLeer(Almacen):
    def test_columna_con_el_mismo_valor_en_todas_las_filas_pasa_a_dato_del_documento(self) -> None:
        self.guardar(
            transacciones=[_fila("1", extras={"c1": "XAXX", "c2": "A"}, extras_ia=["c1"]), _fila("2", extras={"c1": " XAXX ", "c2": "B"}, extras_ia=["c1"])],
            campos_extra=[{"id": "c1", "nombre": "RFC", "origen": "manual"}, {"id": "c2", "nombre": "Folio", "origen": "manual"}],
        )
        leido = self.almacen.obtener(EMAIL, "m1", "1")
        self.assertEqual(leido["campos_extra"], [
            {"id": "c1", "nombre": "RFC", "origen": "manual", "alcance": "documento", "valor": "XAXX", "valor_ia": True},
            {"id": "c2", "nombre": "Folio", "origen": "manual"},
        ])
        self.assertEqual([t.get("extras") for t in leido["transacciones"]], [{"c2": "A"}, {"c2": "B"}])
        self.assertTrue(all("extras_ia" not in t for t in leido["transacciones"]))
        # No reescribe el archivo: se guarda así cuando el usuario guarde.
        self.assertEqual(self.archivo()["transacciones"][0]["extras"], {"c1": "XAXX", "c2": "A"})
        self.assertEqual(self.archivo()["version"], 1)

    def test_no_migra_valores_distintos_vacios_ni_un_solo_movimiento(self) -> None:
        casos = [
            [_fila("1", extras={"c1": "A"}), _fila("2", extras={"c1": "B"})],
            [_fila("1", extras={"c1": "A"}), _fila("2")],
            [_fila("1", extras={"c1": "A"})],
        ]
        for transacciones in casos:
            with self.subTest(transacciones=transacciones):
                self.almacen = AlmacenExtracciones(Path(tempfile.mkdtemp(dir=self.directorio.name)))
                self.guardar(transacciones=transacciones, campos_extra=[{"id": "c1", "nombre": "Folio", "origen": "manual"}])
                self.assertEqual(self.almacen.obtener(EMAIL, "m1", "1")["campos_extra"], [{"id": "c1", "nombre": "Folio", "origen": "manual"}])


class OrdenPorFecha(unittest.TestCase):
    def ids(self, transacciones: list[dict[str, Any]], periodo: str = "") -> str:
        return "".join(t["id"] for t in ordenar_por_fecha(transacciones, periodo))

    def test_lee_formatos_habituales(self) -> None:
        self.assertEqual(leer_fecha("02/11/2026"), (2026, 11, 2))
        self.assertEqual(leer_fecha("2026-11-02"), (2026, 11, 2))
        self.assertEqual(leer_fecha("15 DIC"), (None, 12, 15))
        self.assertEqual(leer_fecha("3-ene-26"), (2026, 1, 3))
        self.assertIsNone(leer_fecha("SALDO"))
        self.assertIsNone(leer_fecha("45/13"))

    def test_ordena_estable_y_deja_en_su_lugar_las_fechas_ilegibles(self) -> None:
        filas = [{"id": "a", "fecha": "05/11/2026"}, {"id": "b", "fecha": "02/11/2026"}, {"id": "x", "fecha": "?"}, {"id": "c", "fecha": "02/11/2026"}, {"id": "d", "fecha": "01/11/2026"}]
        self.assertEqual(self.ids(filas), "dbxca")

    def test_sin_anio_usa_el_periodo_y_el_cruce_de_anio(self) -> None:
        filas = [{"id": "e", "fecha": "03/01"}, {"id": "d", "fecha": "28/12"}, {"id": "n", "fecha": "20/12"}]
        self.assertEqual(self.ids(filas, "15/12/2025 al 14/01/2026"), "nde")
        self.assertEqual(self.ids(filas), "nde")
        self.assertEqual(self.ids([{"id": "b", "fecha": "10/03"}, {"id": "a", "fecha": "02/03"}], "Marzo 2026"), "ab")


class ExtraccionAutomatica(unittest.TestCase):
    def resultado(self, campos: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "model": "m", "prompt_version": "p", "formato_numerico": "us",
            "resumen": {"periodo": "01/11/2026 al 30/11/2026", "dudosos": []},
            "transacciones": [_fila("1", "20/11/2026"), _fila("2", "05/11/2026")],
            "sugerencias_campos": [], "resultados_campos": campos,
        }

    def test_ordena_por_fecha_y_decide_el_tipo_de_cada_campo(self) -> None:
        solicitud = borrador_desde_extraccion(self.resultado([
            {"nombre": "RFC", "clave": "rfc", "encontrado": True, "valores": [], "valor_documento": "XAXX010101000"},
            {"nombre": "Folio", "clave": "folio", "encontrado": True, "valores": [{"huella": "h1", "valor": "F-1"}]},
            {"nombre": "Cliente", "clave": "cliente", "encontrado": False, "valores": []},
        ]), ["RFC", "Folio", "Cliente", "Sucursal"], filename="e.pdf", attachment_id=None, lote="L", alcances={"cliente": "documento", "sucursal": "movimiento"})
        self.assertEqual([t.concepto for t in solicitud.transacciones], ["PAGO 2", "PAGO 1"])
        self.assertEqual([t.id for t in solicitud.transacciones], ["ia-L-1", "ia-L-2"])
        campos = {campo.nombre: campo for campo in solicitud.campos_extra}
        self.assertEqual((campos["RFC"].alcance, campos["RFC"].valor, campos["RFC"].valor_ia), ("documento", "XAXX010101000", True))
        self.assertIsNone(campos["Folio"].alcance)
        # No encontrado: conserva el tipo que tenía en la extracción de la que salió.
        self.assertEqual((campos["Cliente"].alcance, campos["Cliente"].valor), ("documento", ""))
        self.assertIsNone(campos["Sucursal"].alcance)
        folio = campos["Folio"].id
        self.assertEqual([t.extras for t in solicitud.transacciones], [None, {folio: "F-1"}])
        # El RFC nunca se repite en los movimientos.
        self.assertTrue(all(campos["RFC"].id not in (t.extras or {}) for t in solicitud.transacciones))


if __name__ == "__main__":
    unittest.main()
