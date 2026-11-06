from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest, cuenta_id
from backend.app.gmail import _attachments

TRANSACCIONES = [
    {
        "id": "ia-a-1", "fecha": "02/10/2026", "concepto": "DEPOSITO", "referencia": "REF-1",
        "cargo": "", "abono": "2000.00", "saldo": "12000.00",
        "cargo_original": "", "abono_original": "2,000.00", "saldo_original": "12,000.00",
        "origen": "ia_editada", "dudosos": [], "huella": "a1b2c3d4e5f60718",
    },
    {
        "id": "ia-a-2", "fecha": "05/10/2026", "concepto": "PAGO", "referencia": "",
        "cargo": "2000.00", "abono": "", "saldo": "10000.00",
        "cargo_original": "2,000", "abono_original": "", "saldo_original": "10,000.00",
        "origen": "ia", "dudosos": ["cargo"], "huella": "0011223344556677", "revision": "no_aparece_en_extraccion",
    },
    {"id": "manual-1", "fecha": "06/10/2026", "concepto": "COMISION", "referencia": "", "cargo": "0.00", "abono": "", "saldo": "10000.00", "origen": "manual", "dudosos": []},
]
RESUMEN = {
    "banco": "Banco Ejemplo", "titular": "Persona Prueba", "cuenta": "****1234", "periodo": "Octubre 2026", "moneda": "MXN",
    "saldo_inicial": "10000.00", "total_cargos": "2000.00", "total_abonos": "2000.00", "saldo_final": "10000.00",
    "saldo_inicial_original": "10,000.00", "dudosos": [],
}


def cuerpo(**cambios: Any) -> dict[str, Any]:
    base = {
        "version_base": None, "estado": "borrador", "resumen": RESUMEN, "transacciones": TRANSACCIONES,
        "formato_numerico": "us", "modelo": "gemini-x", "prompt_version": "2026-11-05.2",
        "filename": "estado.pdf", "attachmentId": "ANGjdJ-largo",
    }
    base.update(cambios)
    return base


class ApiExtraccionesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        self.email = "a@example.com"
        almacen = patch.object(main, "almacen", AlmacenExtracciones(Path(self.directorio.name)))
        almacen.start()
        self.addCleanup(almacen.stop)
        perfil = patch.object(main.gmail, "profile", side_effect=lambda: {"email": self.email})
        perfil.start()
        self.addCleanup(perfil.stop)
        self.api = TestClient(main.app)

    def put(self, datos: dict[str, Any], message_id: str = "18f2a", part_id: str = "1.2"):
        return self.api.put(f"/api/extracciones/{message_id}/{part_id}", json=datos)

    def test_guardar_y_cargar_ida_y_vuelta_sin_perder_campos(self) -> None:
        guardado = self.put(cuerpo())
        self.assertEqual(guardado.status_code, 200, guardado.text)
        cargado = self.api.get("/api/extracciones/18f2a/1.2")
        self.assertEqual(cargado.status_code, 200)
        documento = cargado.json()
        self.assertEqual(documento["transacciones"], TRANSACCIONES)
        self.assertEqual(documento["resumen"], RESUMEN)
        for campo, valor in {"messageId": "18f2a", "partId": "1.2", "estado": "borrador", "version": 1, "modelo": "gemini-x",
                             "prompt_version": "2026-11-05.2", "formato_numerico": "us", "filename": "estado.pdf",
                             "attachmentId": "ANGjdJ-largo", "enviado_en": None, "revisado_en": None}.items():
            self.assertEqual(documento[campo], valor, campo)
        self.assertEqual(documento["creado"], documento["actualizado"])
        self.assertIn("validacion", documento)
        self.assertNotIn("cuenta", documento)

    def test_version_vieja_responde_409_y_no_sobrescribe(self) -> None:
        self.assertEqual(self.put(cuerpo()).json()["version"], 1)
        self.assertEqual(self.put(cuerpo()).status_code, 409)  # crear algo que ya existe
        segunda = self.put(cuerpo(version_base=1, transacciones=TRANSACCIONES[:1]))
        self.assertEqual(segunda.json()["version"], 2)
        conflicto = self.put(cuerpo(version_base=1))
        self.assertEqual(conflicto.status_code, 409)
        self.assertEqual(conflicto.json()["detail"]["code"], "conflicto_version")
        self.assertEqual(conflicto.json()["detail"]["version_actual"], 2)
        self.assertEqual(len(self.api.get("/api/extracciones/18f2a/1.2").json()["transacciones"]), 1)

    def test_revalida_contabilidad_en_backend_e_ignora_la_del_cliente(self) -> None:
        mentira = {"cuadra": True, "comprobaciones": [], "filas_discontinuas": []}
        respuesta = self.put(cuerpo(resumen={**RESUMEN, "saldo_final": "9999.00"}, validacion=mentira))
        self.assertEqual(respuesta.status_code, 200)
        validacion = respuesta.json()["validacion"]
        self.assertFalse(validacion["cuadra"])
        saldo_final = next(item for item in validacion["comprobaciones"] if item["id"] == "saldo_final")
        self.assertEqual(saldo_final["diferencia"], "1.00")

    def test_revisado_con_problemas_exige_confirmacion(self) -> None:
        sin_confirmar = self.put(cuerpo(estado="revisado"))
        self.assertEqual(sin_confirmar.status_code, 422)
        problemas = sin_confirmar.json()["detail"]["problemas"]
        self.assertEqual((problemas["dudosos"], problemas["en_revision"]), (1, 1))
        self.assertFalse(Path(self.directorio.name, cuenta_id(self.email), "18f2a__1.2.json").exists())
        confirmado = self.put(cuerpo(estado="revisado", confirmar_problemas=True))
        self.assertEqual(confirmado.status_code, 200)
        self.assertEqual(confirmado.json()["estado"], "revisado")
        self.assertTrue(confirmado.json()["revisado_con_problemas"])
        self.assertIsNotNone(confirmado.json()["revisado_en"])

    def test_estado_enviado_reservado_y_ids_inseguros_rechazados(self) -> None:
        self.assertEqual(self.put(cuerpo(estado="enviado")).status_code, 422)
        self.assertEqual(self.put(cuerpo(), part_id=".oculto").status_code, 400)
        self.assertGreaterEqual(self.put(cuerpo(), part_id="..").status_code, 400)  # el cliente normaliza la ruta: nunca 2xx
        self.assertEqual(self.put(cuerpo(transacciones=[TRANSACCIONES[0], TRANSACCIONES[0]])).status_code, 422)

    def test_aislamiento_por_cuenta_de_gmail(self) -> None:
        self.put(cuerpo())
        self.assertEqual(len(self.api.get("/api/extracciones").json()["extracciones"]), 1)
        self.email = "b@example.com"
        self.assertEqual(self.api.get("/api/extracciones/18f2a/1.2").status_code, 404)
        self.assertEqual(self.api.get("/api/extracciones").json()["extracciones"], [])
        self.assertEqual(self.put(cuerpo(transacciones=[])).json()["version"], 1)  # la cuenta B crea la suya
        self.email = "A@Example.com"  # misma cuenta A (mayúsculas no cuentan)
        self.assertEqual(len(self.api.get("/api/extracciones/18f2a/1.2").json()["transacciones"]), 3)

    def test_listado_con_estado_por_documento(self) -> None:
        self.put(cuerpo())
        self.put(cuerpo(estado="revisado", confirmar_problemas=True), message_id="18f2b", part_id="2")
        listado = {item["messageId"]: item for item in self.api.get("/api/extracciones").json()["extracciones"]}
        self.assertEqual(listado["18f2a"]["estado"], "borrador")
        self.assertEqual(listado["18f2b"]["estado"], "revisado")
        self.assertEqual(listado["18f2b"]["partId"], "2")

    def test_sin_gmail_conectado_no_se_guarda(self) -> None:
        with patch.object(main.gmail, "profile", side_effect=main.GmailNotConnectedError("no")):
            self.assertEqual(self.put(cuerpo()).status_code, 401)


class EscrituraAtomicaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        self.almacen = AlmacenExtracciones(Path(self.directorio.name))
        self.almacen.guardar("a@example.com", "m1", "1", GuardarExtraccionRequest.model_validate(cuerpo()))
        self.carpeta = Path(self.directorio.name, cuenta_id("a@example.com"))
        self.original = (self.carpeta / "m1__1.json").read_bytes()

    def _sin_temporales(self) -> None:
        self.assertEqual([p.name for p in self.carpeta.iterdir()], ["m1__1.json"])

    def test_fallo_al_reemplazar_deja_el_archivo_anterior_intacto(self) -> None:
        with patch("backend.app.extracciones.os.replace", side_effect=OSError("disco lleno")):
            with self.assertRaises(OSError):
                self.almacen.guardar("a@example.com", "m1", "1", GuardarExtraccionRequest.model_validate(cuerpo(version_base=1, transacciones=[])))
        self.assertEqual((self.carpeta / "m1__1.json").read_bytes(), self.original)
        self._sin_temporales()

    def test_fallo_a_mitad_de_escritura_no_corrompe(self) -> None:
        def dump_a_medias(datos: Any, archivo: Any, **_: Any) -> None:
            archivo.write('{"schema": 1, "transacciones": [')
            raise RuntimeError("proceso interrumpido")

        with patch("backend.app.extracciones.json.dump", side_effect=dump_a_medias):
            with self.assertRaises(RuntimeError):
                self.almacen.guardar("a@example.com", "m1", "1", GuardarExtraccionRequest.model_validate(cuerpo(version_base=1)))
        self.assertEqual(json.loads((self.carpeta / "m1__1.json").read_text(encoding="utf-8"))["version"], 1)
        self._sin_temporales()


class PartIdTests(unittest.TestCase):
    def test_adjuntos_exponen_part_id_estable(self) -> None:
        payload = {"parts": [{"partId": "0", "mimeType": "text/plain", "body": {}}, {"partId": "1", "filename": "estado.pdf", "mimeType": "application/pdf", "body": {"attachmentId": "rotativo", "size": 10}}]}
        self.assertEqual(_attachments(payload)[0]["partId"], "1")


if __name__ == "__main__":
    unittest.main()
