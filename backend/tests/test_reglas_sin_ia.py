"""Fase 3: extracción por reglas sin IA (modo manual), secciones repetibles, OCR opcional y envío automático.

PDFs ficticios generados aquí; Gemini y SaveData son dobles; Tesseract se simula (no está instalado en las pruebas).
"""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import sqlalchemy as sa
from cryptography.fernet import Fernet
from pydantic import ValidationError

from backend.app import reglas_extraccion
from backend.app.automatico import ExtractorAutomatico
from backend.app.db import Base, Documento, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones
from backend.app.originales import AlmacenOriginales
from backend.app.plantilla_campos import AlmacenPlantillas, CampoPlantilla
from backend.app.recepcion import ServicioRecepcion
from backend.app.reglas_extraccion import etiquetas, es_obligatorio, extraer_por_reglas, leer_documento
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.repos.db import CuentasDb, DocumentosDb, EventosDb
from backend.app.savedata import RespuestaSaveData, ServicioEnvio
from backend.app.seguridad import Cifrador
from backend.app.tipos_documento import AlmacenTipos, TipoRequest, detectar_por_texto
from backend.tests.pdf_ficticio import pdf_con_tabla, pdf_con_texto, pdf_sin_texto
from backend.tests.test_automatico import EMAIL, INICIO, GeminiFalso
from backend.tests.test_recepcion import GmailConArchivos

LINEAS_AUTO = ["POLIZA FICTICIA DE AUTOMOVILES - SIN VALIDEZ", "No. de poliza: AUT-123456  Vigencia desde: 01/02/2026", "Vigencia hasta: 01/02/2027",
               "Contratante: CLIENTE FICTICIO SA DE CV", "Marca: MARCA FICTICIA", "Placas: XYZ-123-A", "Prima total: $ 9,876.50"]
ENCABEZADO = ["Cobertura", "Suma asegurada", "Deducible"]
COBERTURAS = [["Danos materiales", "Valor comercial", "5%"], ["Robo total", "Valor comercial", "10%"], ["Responsabilidad civil", "3,000,000", "0"]]


def pdf_auto(lineas: list[str] = LINEAS_AUTO) -> bytes:
    return pdf_con_tabla(lineas, ENCABEZADO, COBERTURAS)


def campos_auto() -> list[dict[str, Any]]:
    una_vez = ["Número de póliza", "Vigencia desde", "Vigencia hasta", "Contratante", "Marca", "Placas", "Número de serie", "Prima total"]
    return ([{"id": f"c{i}", "nombre": nombre, "alcance": "documento"} for i, nombre in enumerate(una_vez)]
            + [{"id": f"f{i}", "nombre": nombre, "alcance": "movimiento"} for i, nombre in enumerate(ENCABEZADO)])


def valores(resultado: dict[str, Any]) -> dict[str, Any]:
    return {item["nombre"]: item.get("valor_documento") or [v["valor"] for v in item["valores"]] or None for item in resultado["resultados_campos"]}


class Reglas(unittest.TestCase):
    def test_campos_una_vez_y_seccion_repetible(self) -> None:
        resultado = extraer_por_reglas(pdf_auto(), "application/pdf", "poliza.pdf", campos_auto(), seccion="Coberturas", contable=False, codigo_tipo="A")
        encontrados = valores(resultado)
        self.assertEqual(encontrados["Número de póliza"], "AUT-123456")
        # El valor termina donde empieza la siguiente etiqueta de la misma línea.
        self.assertEqual(encontrados["Vigencia desde"], "01/02/2026")
        self.assertEqual(encontrados["Vigencia hasta"], "01/02/2027")
        self.assertEqual(encontrados["Contratante"], "CLIENTE FICTICIO SA DE CV")
        self.assertEqual(encontrados["Placas"], "XYZ-123-A")
        self.assertEqual(encontrados["Prima total"], "$ 9,876.50")
        self.assertIsNone(encontrados["Número de serie"])
        # Coberturas: una fila por renglón de la tabla.
        self.assertEqual(encontrados["Cobertura"], ["Danos materiales", "Robo total", "Responsabilidad civil"])
        self.assertEqual(encontrados["Deducible"], ["5%", "10%", "0"])
        self.assertEqual(len(resultado["transacciones"]), 3)
        self.assertEqual((resultado["metodo"], resultado["model"], resultado["encontrados"], resultado["total_campos"]), ("reglas", "reglas", 10, 11))
        self.assertEqual(resultado["faltantes"], [])

    def test_obligatorio_que_falta(self) -> None:
        sin_placas = [linea for linea in LINEAS_AUTO if not linea.startswith("Placas")]
        resultado = extraer_por_reglas(pdf_auto(sin_placas), "application/pdf", "p.pdf", campos_auto(), seccion="Coberturas", contable=False, codigo_tipo="A")
        self.assertEqual(resultado["faltantes"], ["Placas"])
        # Placas solo es obligatorio en autos (SPECIFIC_KEYS_BY_POLICY); en fianzas no.
        self.assertTrue(es_obligatorio({"nombre": "Placas"}, "A"))
        self.assertFalse(es_obligatorio({"nombre": "Placas"}, "F"))
        self.assertFalse(es_obligatorio({"nombre": "Placas", "obligatorio": False}, "A"))
        self.assertTrue(es_obligatorio({"nombre": "Algo propio", "obligatorio": True}))

    def test_sinonimos_y_regex_configurados(self) -> None:
        pdf = pdf_con_texto(["Folio interno: X-99", "Referencia bancaria 0099887766"])
        campos = [{"id": "a", "nombre": "Número de póliza", "alcance": "documento", "sinonimos": ["folio interno"]},
                  {"id": "b", "nombre": "Referencia", "alcance": "documento", "regex": r"bancaria\s+(\d{10})"}]
        self.assertEqual(valores(extraer_por_reglas(pdf, "application/pdf", "x.pdf", campos, seccion=None, contable=False)), {"Número de póliza": "X-99", "Referencia": "0099887766"})
        # Sinónimos propios reemplazan a los de la plantilla; sin ellos, se usan los del proyecto anterior.
        self.assertEqual(etiquetas(campos[0]), ["numero de poliza", "folio interno"])
        self.assertIn("no. de poliza", etiquetas({"nombre": "Número de póliza"}))

    def test_validacion_de_la_configuracion(self) -> None:
        campo = CampoPlantilla(id="a", nombre="Póliza", alcance="documento", sinonimos=[" Folio ", "folio", ""], regex=r"POL(\d+)", obligatorio=True)
        self.assertEqual((campo.sinonimos, campo.regex, campo.obligatorio), (["Folio"], r"POL(\d+)", True))
        with self.assertRaises(ValidationError):
            CampoPlantilla(id="a", nombre="Póliza", regex="(sin cerrar")
        with self.assertRaises(ValidationError):
            CampoPlantilla(id="a", nombre="Póliza", regex=r"(\d)-(\d)")

    def test_estado_de_cuenta_resumen_y_movimientos(self) -> None:
        pdf = pdf_con_tabla(["ESTADO DE CUENTA FICTICIO", "Banco: BANCO FICTICIO", "Titular: PERSONA FICTICIA", "Saldo anterior: 1,000.00", "Saldo final: 1,150.00"],
                            ["Fecha", "Concepto", "Cargo", "Abono", "Saldo"], [["01/03/2026", "Deposito ficticio", "", "200.00", "1,200.00"], ["02/03/2026", "Comision", "50.00", "", "1,150.00"]],
                            ancho_columna=100)
        resultado = extraer_por_reglas(pdf, "application/pdf", "ec.pdf", [], seccion="Movimientos", contable=True)
        self.assertEqual((resultado["resumen"]["banco"], resultado["resumen"]["saldo_inicial"], resultado["resumen"]["saldo_final"]), ("BANCO FICTICIO", "1,000.00", "1,150.00"))
        self.assertEqual([(m["fecha"], m["concepto"], m["cargo"], m["abono"]) for m in resultado["transacciones"]],
                         [("01/03/2026", "Deposito ficticio", "", "200.00"), ("02/03/2026", "Comision", "50.00", "")])

    def test_deteccion_por_texto_sin_ia(self) -> None:
        tipos = AlmacenTipos(Path(tempfile.mkdtemp()) / "t", AlmacenPlantillas(Path(tempfile.mkdtemp()) / "p")).leer(EMAIL)
        texto = "\n".join(reglas_extraccion.leer_documento(pdf_auto(), "application/pdf", usar_ocr=False)["paginas"])
        deteccion = detectar_por_texto(tipos, texto)
        self.assertEqual((deteccion["codigo"], deteccion["metodo"]), ("A", "texto"))
        self.assertIsNone(detectar_por_texto(tipos, "texto que no se parece a nada"))


class Ocr(unittest.TestCase):
    def test_sin_tesseract_no_hay_ocr(self) -> None:
        with patch.object(reglas_extraccion, "ruta_tesseract", return_value=None):
            self.assertFalse(reglas_extraccion.ocr_disponible())
            lectura = leer_documento(pdf_sin_texto(), "application/pdf")
        self.assertEqual((lectura["paginas_sin_texto"], lectura["ocr"]), (1, False))

    def test_con_tesseract_lee_la_pagina_escaneada(self) -> None:
        with patch.object(reglas_extraccion, "_ocr_imagen", return_value="Placas: OCR-777") as ocr:
            lectura = leer_documento(pdf_sin_texto(), "application/pdf", usar_ocr=True)
        self.assertEqual((lectura["paginas"], lectura["ocr"], ocr.call_count), (["Placas: OCR-777"], True, 1))


class GeminiQueNoDebeLlamarse(GeminiFalso):
    def __init__(self) -> None:
        super().__init__()
        self.clasificaciones = 0

    def clasificar_documento(self, *_args: Any) -> dict[str, Any]:
        self.clasificaciones += 1
        return {"codigo": "A", "confianza": 0.9, "aseguradora": ""}


class CicloManual:
    """Ciclo automático con los tipos en modo manual (el predeterminado). Las subclases dan la recepción (json/db)."""

    def armar(self, recepcion: ServicioRecepcion) -> None:
        # Modo predeterminado de verdad (manual) durante toda la prueba; el conftest lo pone en "ia" para las de antes.
        self.modo = patch.dict(os.environ, {"NEXORA_MODO_PREDETERMINADO": "manual"})
        self.modo.start()
        self.addCleanup(self.modo.stop)
        self.ahora = INICIO
        self.recepcion = recepcion
        self.gmail = GmailConArchivos()
        self.gemini = GeminiQueNoDebeLlamarse()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        self.enviados: list[str] = []
        self.envios = ServicioEnvio(self.almacen, lambda: "https://savedata.invalid/api", cliente=lambda _u, cuerpo, _t: self.enviar(cuerpo))
        plantillas = AlmacenPlantillas(self.raiz / "plantillas")
        self.tipos = AlmacenTipos(self.raiz / "tipos", plantillas)
        autos = next(tipo for tipo in self.tipos.leer(EMAIL) if tipo["codigo"] == "A")
        self.assertEqual(autos["modo"], "manual")
        # El tipo de autos con los campos de esta prueba (los obligatorios salen de la plantilla).
        self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({**autos, "campos": campos_auto(), "seccion": {"nombre": "Coberturas"}}), autos["id"])
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=recepcion,
                                             plantillas=plantillas, tipos=self.tipos, envios=self.envios)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)

    def enviar(self, cuerpo: str) -> RespuestaSaveData:
        self.enviados.append(cuerpo)
        return RespuestaSaveData("exito", 200, '{"code":200}', "")

    def correo(self, message_id: str, data: bytes, nombre: str = "poliza.pdf") -> None:
        self.gmail.correo_con(message_id, [(f"a-{message_id}", data, "application/pdf", nombre)], asunto="Envio de poliza de automovil")

    def estado(self, message_id: str) -> tuple[str, str | None]:
        return self.recepcion.estado(self.recepcion.documentos.obtener(EMAIL, message_id, "1"))

    def test_modo_manual_no_llama_a_gemini_y_registra_el_modo(self) -> None:
        self.correo("m1", pdf_auto(), "poliza.pdf")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        self.assertEqual((self.gemini.llamadas, self.gemini.clasificaciones), ([], 0))
        documento = self.almacen.obtener(EMAIL, "m1", "1")
        datos = {campo["nombre"]: campo.get("valor") for campo in documento["campos_extra"] if campo.get("alcance") == "documento"}
        self.assertEqual((datos["Placas"], datos["Número de póliza"]), ("XYZ-123-A", "AUT-123456"))
        self.assertEqual(len(documento["transacciones"]), 3)
        self.assertEqual((documento["tipo_documento"]["modo"], documento["tipo_documento"]["encontrados"], documento["tipo_documento"]["total_campos"]), ("manual", 10, 11))
        self.assertEqual(self.estado("m1"), ("extraido", None))
        evento = self.recepcion.eventos.listar(EMAIL, message_id="m1", etapa="extraccion")[0]
        self.assertEqual(evento["mensaje"], "Extraido por reglas (modo manual): 10 de 11 campos.")
        if evento.get("detalle") is not None:
            self.assertEqual((evento["detalle"]["modo"], evento["detalle"]["encontrados"], evento["detalle"]["total"]), ("manual", 10, 11))

    def test_faltan_obligatorios_requiere_revision_y_no_se_envia(self) -> None:
        self.extractor.configurar_envio(EMAIL, True, False)
        self.correo("m1", pdf_auto([l for l in LINEAS_AUTO if not l.startswith("Placas")]), "poliza.pdf")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"], resumen["requieren_revision"]), (1, 0, 1))
        self.assertEqual(self.estado("m1"), ("requiere_revision", "campos_faltantes"))
        self.assertIn("Placas", self.recepcion.documentos.obtener(EMAIL, "m1", "1")["proceso"]["mensaje"])
        self.assertEqual(self.enviados, [])

    def test_envio_automatico_con_lo_que_extraen_las_reglas(self) -> None:
        self.extractor.configurar_envio(EMAIL, True, False)
        self.correo("m1", pdf_auto(), "poliza.pdf")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["enviados"], 1)
        self.assertEqual(len(self.enviados), 1)
        self.assertIn("XYZ-123-A", self.enviados[0])
        self.assertEqual(self.estado("m1"), ("enviado", None))
        self.assertEqual(self.gemini.llamadas, [])

    def test_gemini_apagado_no_detiene_el_modo_manual(self) -> None:
        self.gemini.habilitado = False
        self.correo("m1", pdf_auto(), "poliza.pdf")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["resultado"], resumen["extraidos"]), ("ok", 1))

    def test_escaneado_sin_ocr_va_a_la_bandeja(self) -> None:
        self.correo("m1", pdf_sin_texto(), "escaneado.pdf")
        with patch("backend.app.automatico.ocr_disponible", return_value=False):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estado("m1"), ("captura_manual", "pdf_escaneado"))
        with patch("backend.app.automatico.ocr_disponible", return_value=False):
            resultado = self.extractor.reprocesar_bandeja(EMAIL, "m1", "1")
        self.assertEqual(resultado["estado"], "sigue_en_bandeja")
        self.assertIn("Tesseract", resultado["mensaje"])
        self.assertEqual(self.gemini.llamadas, [])

    def test_escaneado_con_ocr_se_extrae_por_reglas(self) -> None:
        self.correo("m1", pdf_sin_texto(), "escaneado.pdf")
        texto = "\n".join(["POLIZA FICTICIA DE AUTOMOVILES", *LINEAS_AUTO[1:]])
        with patch("backend.app.automatico.ocr_disponible", return_value=True), patch.object(reglas_extraccion, "ocr_disponible", return_value=True), \
                patch.object(reglas_extraccion, "_ocr_imagen", return_value=texto):
            resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        datos = {campo["nombre"]: campo.get("valor") for campo in self.almacen.obtener(EMAIL, "m1", "1")["campos_extra"] if campo.get("alcance") == "documento"}
        self.assertEqual(datos["Placas"], "XYZ-123-A")
        self.assertIn("con OCR", self.recepcion.eventos.listar(EMAIL, message_id="m1", etapa="extraccion")[0]["mensaje"])
        self.assertEqual(self.gemini.llamadas, [])

    def test_automatizacion_muestra_los_campos_de_cada_tipo(self) -> None:
        por_tipo = {item["codigo"]: item for item in self.extractor.estado(EMAIL)["campos_por_tipo"]}
        self.assertEqual(por_tipo["A"]["modo"], "manual")
        self.assertIn("Placas", por_tipo["A"]["campos"])
        self.assertIn("G", por_tipo)


class CicloManualJson(CicloManual, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.armar(ServicioRecepcion(DocumentosJson(self.raiz / "d"), EventosJson(self.raiz / "e", reloj=lambda: self.ahora), AlmacenOriginales(self.raiz / "o"),
                                     reloj=lambda: self.ahora))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()


class CicloManualDb(CicloManual, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.motor = crear_motor("sqlite://")
        Base.metadata.create_all(self.motor)
        self.sesiones = fabrica_sesiones(self.motor)
        cuentas = CuentasDb(self.sesiones, Cifrador(Fernet.generate_key().decode()))
        self.armar(ServicioRecepcion(DocumentosDb(self.sesiones, cuentas), EventosDb(self.sesiones, cuentas, reloj=lambda: self.ahora), AlmacenOriginales(self.raiz / "o"),
                                     reloj=lambda: self.ahora))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.motor.dispose()
        self.tmp.cleanup()

    def test_fila_en_la_base(self) -> None:
        self.correo("m1", pdf_auto([l for l in LINEAS_AUTO if not l.startswith("Placas")]))
        self.extractor.ejecutar_ciclo()
        with self.sesiones() as sesion:
            fila = sesion.scalars(sa.select(Documento)).one()
        self.assertEqual((fila.estado, fila.motivo), ("requiere_revision", "campos_faltantes"))
        # Tipo y modo en sus columnas (antes quedaban en NULL).
        self.assertEqual((fila.tipo, fila.modo, fila.estructura), ("A", "manual", None))


class ModoPredeterminado(unittest.TestCase):
    def test_sin_configurar_es_manual(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NEXORA_MODO_PREDETERMINADO", None)
            tipos = AlmacenTipos(Path(tempfile.mkdtemp()) / "t", AlmacenPlantillas(Path(tempfile.mkdtemp()) / "p")).leer(EMAIL)
        self.assertTrue(all(tipo["modo"] == "manual" for tipo in tipos))
        os.environ["NEXORA_MODO_PREDETERMINADO"] = "ia"

    def test_el_modo_se_guarda_por_tipo(self) -> None:
        almacen = AlmacenTipos(Path(tempfile.mkdtemp()) / "t", AlmacenPlantillas(Path(tempfile.mkdtemp()) / "p"))
        fianzas = next(tipo for tipo in almacen.leer(EMAIL) if tipo["codigo"] == "F")
        almacen.guardar_tipo(EMAIL, TipoRequest.model_validate({**fianzas, "modo": "ia"}), fianzas["id"])
        self.assertEqual(next(t for t in almacen.leer(EMAIL) if t["codigo"] == "F")["modo"], "ia")
        # Guardar sin "modo" conserva el que tenía.
        sin_modo = {clave: valor for clave, valor in fianzas.items() if clave != "modo"}
        almacen.guardar_tipo(EMAIL, TipoRequest.model_validate(sin_modo), fianzas["id"])
        self.assertEqual(next(t for t in almacen.leer(EMAIL) if t["codigo"] == "F")["modo"], "ia")


if __name__ == "__main__":
    unittest.main()
