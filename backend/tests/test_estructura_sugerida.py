"""Avisos de cambios de estructura: datos nuevos que se repiten y campos que dejan de aparecer, por aseguradora.

Sin Gmail, Gemini ni SaveData reales y sin datos reales: aseguradoras y valores ficticios.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import gemini as modulo_gemini
from backend.app import main
from backend.app.automatico import ExtractorAutomatico
from backend.app.extracciones import AlmacenExtracciones
from backend.app.gemini import CampoSolicitadoExtraido, DatoGenerico, DocumentoGenerico
from backend.app.plantilla_campos import AlmacenPlantillas
from backend.app.tipos_documento import AlmacenTipos
from backend.tests.test_automatico import EMAIL, INICIO, GmailFalso
from backend.tests.test_plantillas_tipos import GeminiFianza

NORTE = "ASEGURADORA EJEMPLO NORTE"
SUR = "ASEGURADORA EJEMPLO SUR"


def _resultado(nuevos: dict[str, str] | None = None, vacios: tuple[str, ...] = (), llenos: tuple[str, ...] = ("Número de póliza",)) -> dict[str, Any]:
    """Resultado de extracción como el de Gemini: sugerencias (datos que no están en el tipo) y resultado por campo."""
    return {
        "sugerencias_campos": [{"clave": nombre.lower(), "nombre": nombre, "valores": [], "valor_documento": valor} for nombre, valor in (nuevos or {}).items()],
        "resultados_campos": [{"nombre": nombre, "clave": nombre.lower(), "encontrado": False, "valores": []} for nombre in vacios]
        + [{"nombre": nombre, "clave": nombre.lower(), "encontrado": True, "valores": [], "valor_documento": "X"} for nombre in llenos],
    }


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.raiz = Path(self.tmp.name)
        self.plantillas = AlmacenPlantillas(self.raiz / "plantillas")
        self.tipos = AlmacenTipos(self.raiz / "tipos", self.plantillas)
        self.autos = self.tipos.por_codigo(EMAIL, "A")

    def autos_ahora(self) -> dict[str, Any]:
        return self.tipos.obtener(EMAIL, self.autos["id"])


class DatoNuevoRepetido(Base):
    def test_se_sugiere_con_cuantas_veces_aparecio_y_se_agrega_solo_si_el_usuario_lo_decide(self) -> None:
        campos_antes = [campo["nombre"] for campo in self.autos["campos"]]
        for n in range(5):
            nuevos = {"Uso del vehículo": "Particular"} if n != 2 else {}
            self.assertTrue(self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado(nuevos), f"doc-{n}"))
        # El mismo documento no cuenta dos veces.
        self.assertFalse(self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado({"Uso del vehículo": "Particular"}), "doc-0"))
        # Un dato visto una sola vez todavía no se sugiere.
        self.tipos.registrar_extraccion(EMAIL, self.autos["id"], SUR, _resultado({"Clave agente": "123"}), "sur-1")
        autos = self.autos_ahora()
        self.assertEqual(autos["sugerencias_estructura"], [{"aseguradora": NORTE, "clave": "uso del vehiculo", "nombre": "Uso del vehículo", "alcance": "documento",
                                                             "veces": 4, "documentos": 5, "ejemplo": "Particular"}])
        self.assertEqual([campo["nombre"] for campo in autos["campos"]], campos_antes)  # nunca cambia la plantilla solo
        self.assertNotIn("estructura_sugerida", autos)  # lo interno no se publica
        # Agregar: el dato entra al tipo ("Una vez") y la sugerencia desaparece.
        autos = self.tipos.resolver_sugerencia(EMAIL, self.autos["id"], NORTE, "uso del vehiculo", "agregar")
        agregado = autos["campos"][-1]
        self.assertEqual((agregado["nombre"], agregado["alcance"], agregado["origen"]), ("Uso del vehículo", "documento", "ia"))
        self.assertEqual(autos["sugerencias_estructura"], [])

    def test_ignorar_no_lo_vuelve_a_sugerir_para_esa_aseguradora(self) -> None:
        for n in range(2):
            self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado({"Color": "Blanco"}), f"n-{n}")
            self.tipos.registrar_extraccion(EMAIL, self.autos["id"], SUR, _resultado({"Color": "Rojo"}), f"s-{n}")
        self.assertEqual({item["aseguradora"] for item in self.autos_ahora()["sugerencias_estructura"]}, {NORTE, SUR})
        self.tipos.resolver_sugerencia(EMAIL, self.autos["id"], NORTE, "color", "ignorar")
        for n in range(2, 5):
            self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado({"Color": "Blanco"}), f"n-{n}")
        restantes = self.autos_ahora()["sugerencias_estructura"]
        self.assertEqual([(item["aseguradora"], item["nombre"]) for item in restantes], [(SUR, "Color")])
        self.assertEqual([campo["nombre"] for campo in self.autos_ahora()["campos"]].count("Color"), 0)


class CampoQueDejaDeAparecer(Base):
    def test_tres_documentos_seguidos_vacios_lo_marcan_y_si_vuelve_se_desmarca(self) -> None:
        for n in range(2):
            self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado(vacios=("Agente",)), f"d-{n}")
        self.assertEqual(self.autos_ahora()["campos_ausentes"], [])
        self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado(vacios=("Agente",)), "d-2")
        # Otra aseguradora lleva su propia cuenta.
        self.tipos.registrar_extraccion(EMAIL, self.autos["id"], SUR, _resultado(vacios=("Agente",)), "s-0")
        self.assertEqual(self.autos_ahora()["campos_ausentes"], [{"aseguradora": NORTE, "nombre": "Agente", "racha": 3}])
        self.tipos.registrar_extraccion(EMAIL, self.autos["id"], NORTE, _resultado(llenos=("Agente",)), "d-3")
        self.assertEqual(self.autos_ahora()["campos_ausentes"], [])


class DesdeLaExtraccionYLaApi(Base):
    def test_la_extraccion_automatica_registra_y_la_api_agrega(self) -> None:
        class GeminiConDatoNuevo(GeminiFianza):
            def extract_document(self, data: bytes, mime: str, filename: str, campos_solicitados: list[str] = (), tipo: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
                extraido = DocumentoGenerico(aseguradora="AFIANZADORA EJEMPLO", datos=[DatoGenerico(nombre="Folio interno", valor="FI-9")],
                                             campos_solicitados=[CampoSolicitadoExtraido(nombre=n, encontrado=n in self.DATOS, valor_documento=self.DATOS.get(n, "")) for n in campos_solicitados])
                return modulo_gemini._build_result_generico(filename, extraido, "m", list(campos_solicitados), "")

        class GmailVarios(GmailFalso):
            def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
                return f"%PDF-1.7 {message_id}".encode(), "application/pdf", f"{message_id}.pdf"

        almacen = AlmacenExtracciones(self.raiz / "extracciones")
        gmail = GmailVarios()
        for n in range(3):
            gmail.agregar(f"m{n}", INICIO + timedelta(minutes=5 + n), asunto="Fianza de cumplimiento")
        extractor = ExtractorAutomatico(self.raiz / "automatico", gmail, GeminiConDatoNuevo(), almacen, reloj=lambda: INICIO, plantillas=self.plantillas, tipos=self.tipos)
        self.addCleanup(extractor.detener, 1)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            extractor.configurar(EMAIL, True)
        self.assertEqual(extractor.ejecutar_ciclo()["extraidos"], 3)
        fianzas = self.tipos.por_codigo(EMAIL, "F")
        self.assertEqual([(s["aseguradora"], s["nombre"], s["veces"], s["documentos"]) for s in fianzas["sugerencias_estructura"]], [("AFIANZADORA EJEMPLO", "Folio interno", 3, 3)])
        # "Agente" no viene en esos documentos: queda marcado.
        self.assertIn({"aseguradora": "AFIANZADORA EJEMPLO", "nombre": "Agente", "racha": 3}, fianzas["campos_ausentes"])

        cuenta = patch.object(main, "_cuenta_actual", return_value=EMAIL)
        almacen_tipos = patch.object(main, "tipos", self.tipos)
        cuenta.start(), almacen_tipos.start()
        self.addCleanup(cuenta.stop)
        self.addCleanup(almacen_tipos.stop)
        api = TestClient(main.app)
        respuesta = api.post(f"/api/tipos/{fianzas['id']}/sugerencias/agregar", json={"aseguradora": "AFIANZADORA EJEMPLO", "clave": "folio interno"})
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(respuesta.json()["tipo"]["campos"][-1]["nombre"], "Folio interno")
        self.assertEqual(api.post(f"/api/tipos/{fianzas['id']}/sugerencias/ignorar", json={"aseguradora": "AFIANZADORA EJEMPLO", "clave": "no existe"}).status_code, 404)
        self.assertEqual(api.post(f"/api/tipos/{fianzas['id']}/sugerencias/borrar", json={"aseguradora": "X", "clave": "y"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
