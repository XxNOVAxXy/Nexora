"""Plantillas precargadas de tipos (A, G, F, RF): creación, completar tipos existentes, restaurar y envío automático.

Sin Gmail, Gemini ni SaveData reales y sin datos reales: nombres y valores ficticios.
"""

from __future__ import annotations

import json
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
from backend.app.gemini import CampoSolicitadoExtraido, DocumentoGenerico
from backend.app.plantilla_campos import AlmacenPlantillas, comparable
from backend.app.plantillas_tipos import PLANTILLAS, plantilla
from backend.app.savedata import ServicioEnvio
from backend.app.tipos_documento import TIPO_EC_ID, AlmacenTipos, TipoRequest, para_clasificar
from backend.tests.test_automatico import EMAIL, INICIO, GmailFalso
from backend.tests.test_envio_automatico import URL, SaveDataFalso


def _nombres(tipo: dict[str, Any], alcance: str | None = None) -> list[str]:
    return [campo["nombre"] for campo in tipo["campos"] if alcance is None or campo["alcance"] == alcance]


# Así estaban A y G antes de las plantillas (con el campo mal nombrado "Gastos medicos mayores" en G).
A_ANTERIOR = {
    "id": "tipo-a-viejo", "nombre": "Autos Individuales", "codigo": "A", "color": "#123456", "seccion": {"nombre": "Coberturas"}, "estructuras": [],
    "campos": [{"id": f"a{i}", "nombre": nombre, "origen": "ia", "alcance": "documento"} for i, nombre in enumerate(
        ["Número de póliza", "Asegurado", "RFC", "Vigencia desde", "Vigencia hasta", "Marca", "Modelo", "Año", "Placas", "Número de serie", "Uso", "Prima neta", "IVA", "Prima total", "Forma de pago"])]
    + [{"id": f"af{i}", "nombre": nombre, "origen": "manual", "alcance": "movimiento"} for i, nombre in enumerate(["Cobertura", "Suma asegurada", "Deducible"])],
}
G_ANTERIOR = {
    "id": "tipo-g-viejo", "nombre": "Gastos médicos mayores", "codigo": "G", "color": "#654321", "seccion": {"nombre": "Asegurados"}, "estructuras": [],
    "campos": [{"id": f"g{i}", "nombre": nombre, "origen": "ia", "alcance": "documento"} for i, nombre in enumerate(
        ["Número de póliza", "Contratante", "RFC", "Vigencia desde", "Vigencia hasta", "Suma asegurada", "Deducible", "Coaseguro", "Tope de coaseguro", "Prima total", "Forma de pago", "Gastos medicos mayores"])]
    + [{"id": f"gf{i}", "nombre": nombre, "origen": "manual", "alcance": "movimiento"} for i, nombre in enumerate(["Asegurado", "Parentesco", "Fecha de nacimiento", "Prima"])],
}


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.raiz = Path(self.tmp.name)
        self.plantillas = AlmacenPlantillas(self.raiz / "plantillas")
        self.tipos = AlmacenTipos(self.raiz / "tipos", self.plantillas)

    def escribir_anteriores(self, *tipos: dict[str, Any]) -> None:
        ruta = self.tipos._ruta(EMAIL)
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.write_text(json.dumps({"schema": 1, "tipos": [json.loads(json.dumps(tipo)) for tipo in tipos]}, ensure_ascii=False), encoding="utf-8")

    def por_codigo(self, codigo: str) -> dict[str, Any]:
        tipo = self.tipos.por_codigo(EMAIL, codigo)
        assert tipo is not None, codigo
        return tipo


class ConfiguracionVacia(Base):
    def test_se_crean_los_cuatro_tipos_con_su_plantilla_y_ec_queda_igual(self) -> None:
        tipos = self.tipos.leer(EMAIL)
        self.assertEqual([tipo["codigo"] for tipo in tipos], ["EC", "A", "G", "F", "RF"])
        ec = tipos[0]
        self.assertEqual((ec["id"], ec["plantilla"], ec["campos"]), (TIPO_EC_ID, None, []))
        for base in PLANTILLAS:
            tipo = self.por_codigo(base["codigo"])
            self.assertEqual(tipo["nombre"], base["nombre"])
            self.assertEqual(_nombres(tipo), [campo["nombre"] for campo in base["campos"]])
            self.assertEqual((tipo["seccion"] or {}).get("nombre"), base["seccion"])
            self.assertTrue(tipo["configurado"])
            self.assertEqual(tipo["plantilla"]["codigo"], base["codigo"])
            self.assertEqual(tipo["plantilla_faltantes"], [])
        self.assertEqual(_nombres(self.por_codigo("A"), "movimiento"), ["Cobertura", "Suma asegurada", "Deducible"])
        self.assertEqual(_nombres(self.por_codigo("G"), "movimiento"), ["Nombre", "Parentesco", "Sexo", "Fecha de nacimiento", "Antigüedad"])
        # "Fecha" es un campo del recibo de fianza (fuera de Estado de cuenta no hay columnas fijas).
        self.assertIn("Fecha", _nombres(self.por_codigo("RF")))
        # Quedó guardado: otra instancia lee lo mismo y no los duplica.
        otra = AlmacenTipos(self.raiz / "tipos", self.plantillas)
        self.assertEqual([tipo["codigo"] for tipo in otra.leer(EMAIL)], ["EC", "A", "G", "F", "RF"])

    def test_la_ia_recibe_la_descripcion_de_cada_tipo(self) -> None:
        lista = {item["codigo"]: item for item in para_clasificar(self.tipos.leer(EMAIL))}
        self.assertNotIn("descripcion", lista["EC"])
        self.assertIn("placas", lista["A"]["descripcion"])
        self.assertIn("coaseguro", lista["G"]["descripcion"])
        self.assertIn("monto afianzado", lista["F"]["descripcion"])
        self.assertIn("UUID", lista["RF"]["descripcion"])
        prompt = modulo_gemini._prompt_clasificar("x.pdf", list(lista.values()))
        self.assertIn("descripcion", prompt)
        self.assertIn("todas las paginas", prompt)

    def test_la_extraccion_pide_leer_todas_las_paginas(self) -> None:
        prompt = modulo_gemini._prompt_generico("x.pdf", "Fianzas", "", ["Número de fianza"])
        self.assertIn("Lee todas las paginas necesarias", prompt)
        self.assertIn("aviso de cobro", prompt)


class CompletarExistentes(Base):
    def test_a_y_g_existentes_solo_ganan_los_campos_que_faltan(self) -> None:
        self.escribir_anteriores(A_ANTERIOR, G_ANTERIOR)
        a, g = self.por_codigo("A"), self.por_codigo("G")
        # A: nada se borra ni se renombra (ids, nombres y color se conservan) y se agregan los faltantes.
        self.assertEqual((a["id"], a["nombre"], a["color"]), ("tipo-a-viejo", "Autos Individuales", "#123456"))
        anteriores = {campo["id"]: campo["nombre"] for campo in A_ANTERIOR["campos"]}
        self.assertEqual({campo["id"]: campo["nombre"] for campo in a["campos"] if campo["id"] in anteriores}, anteriores)
        nuevos = [campo["nombre"] for campo in a["campos"] if campo["id"] not in anteriores]
        self.assertEqual(nuevos, ["Endoso", "Inciso", "Contratante", "Dirección", "Fecha de emisión", "Versión", "Motor", "Plan", "Agente"])
        self.assertIn("Modelo", _nombres(a))  # no es la plantilla, pero no se borra
        self.assertEqual(_nombres(a, "movimiento"), ["Cobertura", "Suma asegurada", "Deducible"])  # "Una vez" van antes de la sección
        # G: "Asegurado" cuenta como "Nombre" (no se agrega) y se quita "Gastos medicos mayores".
        nombres_g = _nombres(g)
        self.assertNotIn("Nombre", nombres_g)
        self.assertNotIn("Gastos medicos mayores", nombres_g)
        self.assertEqual(_nombres(g, "movimiento"), ["Asegurado", "Parentesco", "Fecha de nacimiento", "Prima", "Sexo", "Antigüedad"])
        for nombre in ("Dirección", "Producto", "Prima neta", "Tope de coaseguro"):
            self.assertIn(nombre, _nombres(g, "documento"))
        self.assertEqual((a["plantilla_faltantes"], g["plantilla_faltantes"]), ([], []))
        # F y RF no existían: se crean.
        self.assertEqual([tipo["codigo"] for tipo in self.tipos.leer(EMAIL)], ["EC", "A", "G", "F", "RF"])

    def test_un_campo_borrado_no_regresa_solo_y_restaurar_lo_agrega(self) -> None:
        a = self.por_codigo("A")
        sin = [campo for campo in a["campos"] if campo["nombre"] not in ("Agente", "Motor")]
        self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({**a, "campos": sin}), a["id"])
        a = self.por_codigo("A")
        self.assertNotIn("Agente", _nombres(a))
        self.assertEqual(a["plantilla_faltantes"], ["Motor", "Agente"])
        restaurado, agregados = self.tipos.restaurar_plantilla(EMAIL, a["id"])
        self.assertEqual(agregados, ["Motor", "Agente"])
        self.assertEqual(restaurado["plantilla_faltantes"], [])
        self.assertEqual(sorted(_nombres(self.por_codigo("A"))), sorted(campo["nombre"] for campo in plantilla("A")["campos"]))
        self.assertEqual(_nombres(self.por_codigo("A"), "movimiento"), ["Cobertura", "Suma asegurada", "Deducible"])
        self.assertEqual(self.tipos.restaurar_plantilla(EMAIL, a["id"])[1], [])

    def test_restaurar_por_la_api(self) -> None:
        email = patch.object(main, "_cuenta_actual", return_value=EMAIL)
        almacen = patch.object(main, "tipos", self.tipos)
        email.start(), almacen.start()
        self.addCleanup(email.stop)
        self.addCleanup(almacen.stop)
        api = TestClient(main.app)
        f = self.por_codigo("F")
        self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({**f, "campos": f["campos"][1:]}), f["id"])
        respuesta = api.post(f"/api/tipos/{f['id']}/restaurar-plantilla")
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(respuesta.json()["agregados"], ["Número de fianza"])
        self.assertIn("Número de fianza", _nombres(self.por_codigo("F")))
        ec = api.post(f"/api/tipos/{TIPO_EC_ID}/restaurar-plantilla")
        self.assertEqual(ec.status_code, 409)

    def test_ec_sigue_rechazando_los_nombres_de_columnas_fijas(self) -> None:
        ec = self.tipos.ec(EMAIL)
        with self.assertRaises(ValueError):
            self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({**ec, "campos": [{"id": "x", "nombre": "Fecha", "alcance": "documento"}]}), TIPO_EC_ID)


class GeminiFianza:
    """Clasifica como Fianzas con confianza alta y extrae los datos (respuesta simulada, valores ficticios)."""

    DATOS = {"Número de fianza": "FZ-0001", "Afianzadora": "AFIANZADORA EJEMPLO", "Fiado": "EMPRESA PRUEBA", "Beneficiario": "BENEFICIARIO PRUEBA", "Monto afianzado": "100,000.00"}

    def __init__(self) -> None:
        self.clasificaciones: list[list[dict[str, Any]]] = []

    def status(self) -> dict[str, Any]:
        return {"enabled": True}

    def clasificar_documento(self, data: bytes, mime: str, filename: str, tipos: list[dict[str, Any]]) -> dict[str, Any]:
        self.clasificaciones.append(tipos)
        return {"codigo": "F", "confianza": 0.92, "aseguradora": "AFIANZADORA EJEMPLO", "motivo": "fiado y beneficiario"}

    def extract_document(self, data: bytes, mime: str, filename: str, campos_solicitados: list[str] = (), tipo: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        extraido = DocumentoGenerico(aseguradora="AFIANZADORA EJEMPLO",
                                     campos_solicitados=[CampoSolicitadoExtraido(nombre=n, encontrado=n in self.DATOS, valor_documento=self.DATOS.get(n, "")) for n in campos_solicitados])
        return modulo_gemini._build_result_generico(filename, extraido, "m", list(campos_solicitados), (tipo or {}).get("seccion") or "")


class FianzaSeEnviaSola(Base):
    def test_fianza_clasificada_con_confianza_alta_se_extrae_y_se_envia(self) -> None:
        almacen = AlmacenExtracciones(self.raiz / "extracciones")
        gmail = GmailFalso()
        gmail.agregar("m1", INICIO + timedelta(minutes=5), asunto="Fianza de cumplimiento")
        gmail.mensajes["m1"]["senderEmail"] = "emision@afianzadora.example"
        savedata = SaveDataFalso()
        gemini = GeminiFianza()
        envios = ServicioEnvio(almacen, lambda: URL, cliente=savedata, configurados=self.plantillas.efectiva,
                               tipo_de=lambda email, documento: self.tipos.obtener(email, (documento.get("tipo_documento") or {"tipo_id": TIPO_EC_ID}).get("tipo_id")))
        extractor = ExtractorAutomatico(self.raiz / "automatico", gmail, gemini, almacen, reloj=lambda: INICIO, plantillas=self.plantillas, envios=envios, tipos=self.tipos)
        self.addCleanup(extractor.detener, 1)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            extractor.configurar(EMAIL, True)
        extractor.configurar_envio(EMAIL, True, True)
        resumen = extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"], resumen["requieren_revision"]), (1, 1, 0))
        self.assertTrue(any(item.get("descripcion") for item in gemini.clasificaciones[0]))
        interno = savedata.internos()[0]
        self.assertEqual(interno["Tipo"], "F")
        self.assertEqual({k: v for k, v in interno["Datos"].items() if v}, GeminiFianza.DATOS)
        documento = almacen.obtener(EMAIL, "m1", "1")
        self.assertEqual((documento["tipo_documento"]["codigo"], documento["tipo_documento"]["requiere_revision"]), ("F", False))
        self.assertEqual(comparable(documento["estado"]), "enviado")


if __name__ == "__main__":
    unittest.main()
