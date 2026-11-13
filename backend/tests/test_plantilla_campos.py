"""Configuración de campos: guardar y cargar, sugerencias desde un ejemplo, vínculo con los documentos y SaveData.

Nunca se contacta Gmail, Gemini ni SaveData reales.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import main
from backend.app.automatico import ExtractorAutomatico
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest, cuenta_id
from backend.app.plantilla_campos import AlmacenPlantillas, PlantillaRequest, aplicar_plantilla, deducir_campos, sugerencias_para_configurar
from backend.app.savedata import preparar_envio

EMAIL = "a@example.com"
PDF = b"%PDF-1.7\nejemplo"
RFC = {"id": "pl-rfc", "nombre": "RFC", "origen": "ia", "alcance": "documento", "clave": "rfc"}
FOLIO = {"id": "pl-folio", "nombre": "Folio", "origen": "manual", "alcance": "movimiento"}


def _fila(id_: str, extras: dict[str, str] | None = None) -> dict[str, Any]:
    fila: dict[str, Any] = {"id": id_, "fecha": "02/10/2026", "concepto": f"PAGO {id_}", "cargo": "10.00", "origen": "ia", "dudosos": [], "huella": f"h{id_}"}
    if extras:
        fila["extras"] = extras
    return fila


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.raiz = Path(self.tmp.name)
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        self.plantillas = AlmacenPlantillas(self.raiz / "plantillas", lambda email: deducir_campos(self.almacen, email))

    def guardar_doc(self, message_id: str = "m1", **cambios: Any) -> dict[str, Any]:
        cuerpo = {"estado": "borrador", "transacciones": [_fila("1"), _fila("2", {"x": "B"})], **cambios}
        return self.almacen.guardar(EMAIL, message_id, "1", GuardarExtraccionRequest.model_validate(cuerpo))


class GuardarYCargar(Base):
    def test_guarda_y_carga_por_cuenta_con_escritura_atomica(self) -> None:
        guardada = self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": [RFC, FOLIO]}))
        self.assertTrue(guardada["configurada"])
        self.assertEqual(self.plantillas.leer(EMAIL)["campos"], [RFC, FOLIO])
        self.assertEqual(self.plantillas.leer("otra@example.com")["campos"], [])
        archivos = list((self.raiz / "plantillas").iterdir())
        self.assertEqual([a.name for a in archivos], [f"{cuenta_id(EMAIL)}.json"])  # sin temporales a medias

    def test_valida_nombres_repetidos_fijos_y_maximo(self) -> None:
        for campos in (
            [RFC, {**FOLIO, "nombre": "rfc"}],
            [{**FOLIO, "nombre": "Concepto"}],
            [{**FOLIO, "nombre": "  "}],
            [{**FOLIO, "id": f"c{i}", "nombre": f"Campo {i}"} for i in range(31)],
        ):
            with self.subTest(campos=campos[:2]):
                with self.assertRaises(ValidationError):
                    PlantillaRequest.model_validate({"campos": campos})

    def test_primera_vez_precarga_lo_deducido_de_las_extracciones_guardadas(self) -> None:
        self.guardar_doc(campos_extra=[{"id": "x", "nombre": "Sucursal", "origen": "manual"}, {"id": "r", "nombre": "RFC", "origen": "ia", "clave": "rfc", "alcance": "documento", "valor": "XAXX"}],
                         sugerencias_campos=[{"clave": "plaza", "nombre": "Plaza", "valores": []}])
        leida = self.plantillas.leer(EMAIL)
        self.assertFalse(leida["configurada"])
        self.assertEqual(leida["campos"], [
            {"id": "pl-sucursal", "nombre": "Sucursal", "origen": "manual", "alcance": "movimiento"},
            {"id": "pl-rfc", "nombre": "RFC", "origen": "ia", "alcance": "documento", "clave": "rfc"},
        ])
        # Al guardarla por primera vez deja de deducirse.
        self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": leida["campos"][:1]}))
        self.assertEqual([c["nombre"] for c in self.plantillas.efectiva(EMAIL)], ["Sucursal"])


class VinculoConDocumentos(Base):
    def test_documento_viejo_conserva_sus_campos_y_recibe_los_nuevos_vacios(self) -> None:
        documento = self.guardar_doc(campos_extra=[{"id": "x", "nombre": "Notas", "origen": "manual"}])
        aplicado = aplicar_plantilla(documento, [RFC, FOLIO])
        self.assertEqual(aplicado["campos_extra"], [
            {"id": "x", "nombre": "Notas", "origen": "manual"},
            {"id": "pl-rfc", "nombre": "RFC", "origen": "ia", "plantilla_id": "pl-rfc", "clave": "rfc", "alcance": "documento", "valor": ""},
            {"id": "pl-folio", "nombre": "Folio", "origen": "manual", "plantilla_id": "pl-folio"},
        ])
        self.assertEqual(aplicado["transacciones"], documento["transacciones"])
        self.assertIs(aplicar_plantilla(aplicado, [RFC, FOLIO]), aplicado)  # ya aplicado: no cambia nada

    def test_renombrar_en_la_configuracion_renombra_los_campos_vinculados(self) -> None:
        documento = self.guardar_doc(campos_extra=[
            {"id": "pl-folio", "nombre": "Folio", "origen": "manual", "plantilla_id": "pl-folio"},
            {"id": "solo", "nombre": "Notas", "origen": "manual"},
        ], transacciones=[_fila("1", {"pl-folio": "F-1", "solo": "n"}), _fila("2")])
        renombrado = aplicar_plantilla(documento, [{**FOLIO, "nombre": "Folio interno"}])
        self.assertEqual([(c["nombre"], c.get("plantilla_id")) for c in renombrado["campos_extra"]], [("Folio interno", "pl-folio"), ("Notas", None)])
        # El valor sigue en su lugar: no se crea un campo vacío junto al viejo.
        self.assertEqual(renombrado["transacciones"][0]["extras"], {"pl-folio": "F-1", "solo": "n"})

    def test_un_campo_del_documento_con_el_mismo_nombre_queda_vinculado(self) -> None:
        documento = self.guardar_doc(campos_extra=[{"id": "c1", "nombre": "folio", "origen": "manual"}])
        aplicado = aplicar_plantilla(documento, [FOLIO])
        self.assertEqual(aplicado["campos_extra"], [{"id": "c1", "nombre": "Folio", "origen": "manual", "plantilla_id": "pl-folio"}])


class Endpoints(Base):
    def setUp(self) -> None:
        super().setUp()
        for nombre, valor in {"almacen": self.almacen, "plantillas": self.plantillas}.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        perfil = patch.object(main.gmail, "profile", return_value={"email": EMAIL})
        perfil.start()
        self.addCleanup(perfil.stop)
        self.api = TestClient(main.app)

    def test_get_y_put_de_la_configuracion(self) -> None:
        self.assertEqual(self.api.get("/api/configuracion/campos").json(), {"configurada": False, "campos": [], "actualizado": None})
        respuesta = self.api.put("/api/configuracion/campos", json={"campos": [RFC, FOLIO]})
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(self.api.get("/api/configuracion/campos").json()["campos"], [RFC, FOLIO])
        self.assertEqual(self.api.put("/api/configuracion/campos", json={"campos": [RFC, {**FOLIO, "nombre": "RFC"}]}).status_code, 422)

    def test_al_abrir_un_documento_guardado_se_aplica_la_configuracion(self) -> None:
        self.guardar_doc(campos_extra=[{"id": "x", "nombre": "Notas", "origen": "manual"}])
        self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": [RFC]}))
        documento = self.api.get("/api/extracciones/m1/1").json()
        self.assertEqual([c["nombre"] for c in documento["campos_extra"]], ["Notas", "RFC"])
        # No se escribe en disco al abrir.
        self.assertEqual(self.almacen.leer_completo(EMAIL, "m1", "1")["campos_extra"], [{"id": "x", "nombre": "Notas", "origen": "manual"}])

    def test_sugerencias_desde_un_documento_de_ejemplo_sin_guardarlo(self) -> None:
        resultado = {"sugerencias_campos": [
            {"clave": "rfc", "nombre": "RFC", "valores": [], "valor_documento": "XAXX010101000"},
            {"clave": "folio", "nombre": "Folio", "valores": [{"huella": "h1", "valor": "F-1"}, {"huella": "h2", "valor": "F-2"}]},
        ]}
        antes = sorted(str(p) for p in self.raiz.rglob("*"))
        with patch.object(main.gemini, "extract_document", return_value=resultado) as extraer:
            respuesta = self.api.post("/api/configuracion/campos/sugerir?filename=ejemplo.pdf&tipo=application/pdf", content=PDF)
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(respuesta.json()["sugerencias"], [
            {"clave": "rfc", "nombre": "RFC", "ejemplo": "XAXX010101000", "alcance": "documento", "filas": 0},
            {"clave": "folio", "nombre": "Folio", "ejemplo": "F-1", "alcance": "movimiento", "filas": 2},
        ])
        self.assertEqual(extraer.call_args.args, (PDF, "application/pdf", "ejemplo.pdf"))
        # El archivo de ejemplo no se guarda en ningún lado.
        self.assertEqual(sorted(str(p) for p in self.raiz.rglob("*")), antes)

    def test_sugerir_rechaza_vacio_y_demasiado_grande(self) -> None:
        with patch.object(main.gemini, "extract_document") as extraer:
            self.assertEqual(self.api.post("/api/configuracion/campos/sugerir?filename=e.pdf", content=b"").status_code, 422)
            with patch.object(main, "MAX_ARCHIVO_EJEMPLO", 4):
                self.assertEqual(self.api.post("/api/configuracion/campos/sugerir?filename=e.pdf", content=PDF).status_code, 413)
        extraer.assert_not_called()

    def test_las_sugerencias_nunca_inventan_campos(self) -> None:
        self.assertEqual(sugerencias_para_configurar({"sugerencias_campos": [{"clave": "x", "nombre": "X", "valores": []}]}), [])
        self.assertEqual(sugerencias_para_configurar({}), [])


class SaveDataConCampos(Base):
    def test_datos_una_sola_vez_null_para_los_no_encontrados_y_campos_por_movimiento(self) -> None:
        documento = self.guardar_doc(
            estado="revisado", confirmar_problemas=True,
            campos_extra=[
                {"id": "pl-rfc", "nombre": "RFC", "origen": "ia", "alcance": "documento", "valor": "", "plantilla_id": "pl-rfc"},
                {"id": "num", "nombre": "Número de cliente", "origen": "manual", "alcance": "documento", "valor": "CLI-0001"},
                {"id": "pl-folio", "nombre": "Folio", "origen": "manual", "plantilla_id": "pl-folio"},
            ],
            transacciones=[_fila("1", {"pl-folio": "F-0001"}), _fila("2")],
        )
        plaza = {"id": "pl-plaza", "nombre": "Plaza", "origen": "manual", "alcance": "documento"}
        canal = {"id": "pl-canal", "nombre": "Canal", "origen": "manual", "alcance": "movimiento"}
        envio = preparar_envio(documento, sucursal=3102, articulo="10000453", carga_inicial=False, configurados=[RFC, FOLIO, plaza, canal])
        interno = envio["interno"]
        self.assertEqual(list(interno), ["Archivo", "Resumen", "Datos", "Transacciones", "Validacion"])
        # "Plaza" está configurado y el documento no lo tiene: va como null.
        self.assertEqual(interno["Datos"], {"RFC": None, "Número de cliente": "CLI-0001", "Plaza": None})
        self.assertEqual([(f["Folio"], f["Canal"]) for f in interno["Transacciones"]], [("F-0001", None), (None, None)])
        self.assertEqual(list(interno["Transacciones"][0])[:6], ["fecha", "concepto", "referencia", "cargo", "abono", "saldo"])
        # Envoltorio intacto: {"data": "<JSON como texto>"}, y el dato del documento una sola vez.
        externo = json.loads(envio["cuerpo"])
        self.assertEqual(list(externo), ["data"])
        self.assertEqual(json.loads(externo["data"]), interno)
        self.assertEqual(envio["cuerpo"].count("CLI-0001"), 1)

    def test_un_campo_renombrado_en_la_configuracion_sale_con_su_nombre_nuevo(self) -> None:
        documento = self.guardar_doc(campos_extra=[{"id": "pl-folio", "nombre": "Folio", "origen": "manual", "plantilla_id": "pl-folio"}], transacciones=[_fila("1", {"pl-folio": "F-1"})])
        interno = preparar_envio(documento, sucursal=1, articulo="A", carga_inicial=False, configurados=[{**FOLIO, "nombre": "Folio interno"}])["interno"]
        self.assertEqual(interno["Transacciones"][0]["Folio interno"], "F-1")
        self.assertNotIn("Folio", interno["Transacciones"][0])


class ExtraccionAutomaticaUsaLaConfiguracion(Base):
    def test_pide_y_crea_los_campos_configurados_no_los_deducidos(self) -> None:
        self.guardar_doc("previo", campos_extra=[{"id": "x", "nombre": "Deducido", "origen": "manual"}])
        self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": [RFC, FOLIO]}))
        ahora = datetime(2026, 11, 1, tzinfo=timezone.utc)

        class Gmail:
            def profile(self) -> dict[str, Any]:
                return {"email": EMAIL}

            def buscar_ids(self, query: str, max_results: int = 100) -> list[str]:
                return ["m9"]

            def get_message(self, message_id: str) -> dict[str, Any]:
                return {"id": message_id, "subject": "Estado de cuenta", "receivedAt": (ahora + timedelta(minutes=5)).isoformat(), "attachments": [{"id": "a", "filename": "e.pdf", "mimeType": "application/pdf", "partId": "1"}]}

            def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
                return PDF, "application/pdf", "e.pdf"

        pedidos: list[list[str]] = []

        class Gemini:
            def status(self) -> dict[str, Any]:
                return {"enabled": True}

            def extract_document(self, data: bytes, mime: str, filename: str, forzar: bool = False, campos_solicitados: Any = ()) -> dict[str, Any]:
                pedidos.append(list(campos_solicitados))
                return {"model": "m", "resumen": {}, "transacciones": [_fila("1")], "resultados_campos": [
                    {"nombre": "RFC", "clave": "rfc", "encontrado": True, "valores": [], "valor_documento": "XAXX010101000"},
                ]}

        extractor = ExtractorAutomatico(self.raiz / "automatico", Gmail(), Gemini(), self.almacen, reloj=lambda: ahora, plantillas=self.plantillas)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            extractor.configurar(EMAIL, True)
        self.assertEqual(extractor.ejecutar_ciclo()["extraidos"], 1)
        self.assertEqual(pedidos, [["RFC", "Folio"]])
        guardado = self.almacen.obtener(EMAIL, "m9", "1")
        self.assertEqual([(c["nombre"], c["plantilla_id"]) for c in guardado["campos_extra"]], [("RFC", "pl-rfc"), ("Folio", "pl-folio")])
        self.assertEqual(guardado["campos_extra"][0]["valor"], "XAXX010101000")
        self.assertEqual(extractor.estado(EMAIL)["campos"], ["RFC", "Folio"])


if __name__ == "__main__":
    unittest.main()
