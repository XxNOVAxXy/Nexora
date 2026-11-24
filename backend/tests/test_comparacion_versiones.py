"""Fase 4: comparación reglas vs IA, versiones de la estructura (v1 → v2 sin borrar la anterior) y reprocesar con otra versión.

Gemini es un doble de prueba; PDFs ficticios; modo json y modo db (SQLite en memoria).
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import sqlalchemy as sa
from cryptography.fernet import Fernet

from backend.app.automatico import ExtractorAutomatico
from backend.app.db import Base, Documento, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones
from backend.app.originales import AlmacenOriginales
from backend.app.plantilla_campos import AlmacenPlantillas
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.repos.db import CuentasDb, DocumentosDb, EventosDb
from backend.app.seguridad import Cifrador
from backend.app.tipos_documento import TIPO_EC_ID, AlmacenTipos, ConflictoTipos, TipoRequest, campos_version
from backend.tests.test_automatico import EMAIL, INICIO, GeminiFalso
from backend.tests.test_recepcion import GmailConArchivos
from backend.tests.test_reglas_sin_ia import LINEAS_AUTO, campos_auto, pdf_auto


class GeminiQueCompara(GeminiFalso):
    """La IA encuentra los campos configurados (uno distinto) y dos que la estructura no tiene."""

    def extract_document(self, data: bytes, mime_type: str, filename: str, forzar: bool = False, campos_solicitados: Any = (), tipo: Any = None) -> dict[str, Any]:
        self.llamadas.append(tuple(campos_solicitados))
        if self.fallar is not None:
            raise self.fallar
        valores = {"Número de póliza": "AUT-123456", "Placas": "XYZ-123-B", "Contratante": "CLIENTE FICTICIO SA DE CV"}
        return {"model": "gemini-ficticio", "resumen": {}, "transacciones": [],
                "resultados_campos": [{"nombre": nombre, "encontrado": nombre in valores, "valores": [], **({"valor_documento": valores[nombre]} if nombre in valores else {})}
                                      for nombre in campos_solicitados],
                "sugerencias_campos": [{"clave": "color", "nombre": "Color", "valores": [], "valor_documento": "ROJO"},
                                       {"clave": "numero-de-pasajeros", "nombre": "Número de pasajeros", "valores": [], "valor_documento": "5"}]}


class Base_:
    def armar(self, recepcion: ServicioRecepcion) -> None:
        self.modo = patch.dict(os.environ, {"NEXORA_MODO_PREDETERMINADO": "manual"})
        self.modo.start()
        self.addCleanup(self.modo.stop)
        self.ahora = INICIO
        self.recepcion = recepcion
        self.gmail = GmailConArchivos()
        self.gemini = GeminiQueCompara()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        plantillas = AlmacenPlantillas(self.raiz / "plantillas")
        self.tipos = AlmacenTipos(self.raiz / "tipos", plantillas)
        self.autos = next(tipo for tipo in self.tipos.leer(EMAIL) if tipo["codigo"] == "A")
        self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({**self.autos, "campos": campos_auto(), "seccion": {"nombre": "Coberturas"}}), self.autos["id"])
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=recepcion,
                                             plantillas=plantillas, tipos=self.tipos)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)

    def recibir(self, message_id: str, lineas: list[str] = LINEAS_AUTO) -> None:
        self.gmail.correo_con(message_id, [(f"a-{message_id}", pdf_auto(lineas), "application/pdf", "poliza.pdf")], asunto="Envio de poliza de automovil")
        self.extractor.ejecutar_ciclo()

    def tipo(self) -> dict[str, Any]:
        return self.tipos.obtener(EMAIL, self.autos["id"])

    def test_versiones_sin_borrar_la_anterior(self) -> None:
        originales = [campo["nombre"] for campo in self.tipo()["campos"]]
        resultado = self.tipos.nueva_version(EMAIL, self.autos["id"], None, [{"nombre": "Color", "alcance": "documento"}, {"nombre": "Placas"}])
        self.assertEqual((resultado["version"], resultado["agregados"]), (2, ["Color"]))
        estructura = next(item for item in self.tipo()["estructuras"] if item["nombre"] == "Predeterminada")
        self.assertEqual(([v["numero"] for v in estructura["versiones"]], estructura["version_activa"]), ([1, 2], 2))
        self.assertEqual([campo["nombre"] for campo in campos_version(self.tipo())[0]], [*originales, "Color"])
        self.assertEqual([campo["nombre"] for campo in campos_version(self.tipo(), version=1)[0]], originales)
        self.tipos.activar_version(EMAIL, self.autos["id"], estructura["id"], 1)
        self.assertEqual(campos_version(self.tipo())[1], 1)
        with self.assertRaises(ConflictoTipos):
            self.tipos.nueva_version(EMAIL, self.autos["id"], estructura["id"], [{"nombre": "Placas"}])
        with self.assertRaises(ConflictoTipos):
            self.tipos.nueva_version(EMAIL, TIPO_EC_ID, None, [{"nombre": "Algo"}])

    def test_comparar_reglas_contra_ia(self) -> None:
        self.recibir("m1")
        self.assertEqual(self.gemini.llamadas, [])  # el ciclo (modo manual) no usó la IA
        comparacion = self.extractor.comparar(EMAIL, "m1", "1")
        self.assertEqual(len(self.gemini.llamadas), 1)
        self.assertEqual(comparacion["manual"]["Placas"], "XYZ-123-A")
        self.assertEqual(comparacion["ia"]["Placas"], "XYZ-123-B")
        self.assertEqual(comparacion["manual"]["Número de serie"], "")
        self.assertEqual([s["nombre"] for s in comparacion["sugerencias"]], ["Color", "Número de pasajeros"])
        self.assertEqual((comparacion["campos_configurados"], comparacion["ia_encontrados"]), (11, 5))
        self.assertEqual((comparacion["version_usada"], comparacion["tipo"]["codigo"]), (1, "A"))

    def test_aceptar_campos_crea_v2_y_los_documentos_nuevos_la_usan(self) -> None:
        self.recibir("m1")
        comparacion = self.extractor.comparar(EMAIL, "m1", "1")
        self.tipos.nueva_version(EMAIL, self.autos["id"], None, [{"nombre": s["nombre"], "alcance": s["alcance"]} for s in comparacion["sugerencias"]])
        self.recibir("m2", [*LINEAS_AUTO, "Color: ROJO"])
        guardado = self.almacen.obtener(EMAIL, "m2", "1")
        self.assertEqual(guardado["tipo_documento"]["version_campos"], 2)
        datos = {campo["nombre"]: campo.get("valor") for campo in guardado["campos_extra"] if campo.get("alcance") == "documento"}
        self.assertEqual(datos["Color"], "ROJO")
        # El documento anterior se extrajo con v1 y lo dice.
        self.assertEqual(self.almacen.obtener(EMAIL, "m1", "1")["tipo_documento"]["version_campos"], 1)

    def test_reprocesar_con_otra_version(self) -> None:
        self.recibir("m1", [*LINEAS_AUTO, "Color: AZUL"])
        self.tipos.nueva_version(EMAIL, self.autos["id"], None, [{"nombre": "Color", "alcance": "documento"}])
        resultado = self.extractor.reprocesar_version(EMAIL, "m1", "1", 2)
        datos = {campo["nombre"]: campo.get("valor") for campo in resultado["documento"]["campos_extra"] if campo.get("alcance") == "documento"}
        self.assertEqual((datos["Color"], resultado["documento"]["tipo_documento"]["version_campos"], resultado["documento"]["version"]), ("AZUL", 2, 2))
        de_vuelta = self.extractor.reprocesar_version(EMAIL, "m1", "1", 1)["documento"]
        self.assertNotIn("Color", [campo["nombre"] for campo in de_vuelta["campos_extra"]])
        with self.assertRaises(KeyError):
            self.extractor.reprocesar_version(EMAIL, "m1", "1", 9)
        self.assertEqual(self.gemini.llamadas, [])  # modo manual: ni al reprocesar


class ComparacionJson(Base_, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.armar(ServicioRecepcion(DocumentosJson(self.raiz / "d"), EventosJson(self.raiz / "e"), AlmacenOriginales(self.raiz / "o")))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()


class ComparacionDb(Base_, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.motor = crear_motor("sqlite://")
        Base.metadata.create_all(self.motor)
        self.sesiones = fabrica_sesiones(self.motor)
        cuentas = CuentasDb(self.sesiones, Cifrador(Fernet.generate_key().decode()))
        self.armar(ServicioRecepcion(DocumentosDb(self.sesiones, cuentas), EventosDb(self.sesiones, cuentas), AlmacenOriginales(self.raiz / "o")))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.motor.dispose()
        self.tmp.cleanup()

    def test_documentos_version_en_la_base(self) -> None:
        self.recibir("m1", [*LINEAS_AUTO, "Color: AZUL"])
        with self.sesiones() as sesion:
            self.assertEqual(sesion.scalars(sa.select(Documento.version)).one(), 1)
        self.tipos.nueva_version(EMAIL, self.autos["id"], None, [{"nombre": "Color", "alcance": "documento"}])
        self.extractor.reprocesar_version(EMAIL, "m1", "1", 2)
        with self.sesiones() as sesion:
            self.assertEqual(sesion.scalars(sa.select(Documento.version)).one(), 2)


if __name__ == "__main__":
    unittest.main()
