"""Tipos de documento y estructuras: migración, detección, filtro, extracción con sección repetible y SaveData.

Sin Gmail, Gemini ni SaveData reales.
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
from backend.app.automatico import ExtractorAutomatico, borrador_desde_extraccion
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest
from backend.app.filtro_estados import asunto_coincide, asunto_es_estado_de_cuenta, asunto_menciona_poliza, construir_query, es_candidato, firma_filtro, FIRMA_FILTRO
from backend.app.gemini import CampoSolicitadoExtraido, DocumentoGenerico, FilaGenerica, ValorAdicional, DatoGenerico, _build_result_generico
from backend.app.plantilla_campos import AlmacenPlantillas, PlantillaRequest
from backend.app.savedata import ServicioEnvio, datos_documento, preparar_envio, totales_de
from backend.app.tipos_documento import (
    TIPO_EC_ID,
    UMBRAL_CONFIANZA,
    AlmacenTipos,
    ConflictoTipos,
    EstructuraRequest,
    ReglasEstructura,
    TipoRequest,
    detectar_por_reglas,
    detectar_tipo,
    resolver_clasificacion,
)
from backend.tests.test_automatico import EMAIL, INICIO, GeminiFalso, GmailFalso, _resultado
from backend.tests.test_envio_automatico import URL, SaveDataFalso

RFC = {"id": "pl-rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento"}
POLIZA = {"id": "c-poliza", "nombre": "Número de póliza", "origen": "ia", "alcance": "documento"}
PLACAS = {"id": "c-placas", "nombre": "Placas", "origen": "ia", "alcance": "movimiento"}
SERIE = {"id": "c-serie", "nombre": "Serie", "origen": "manual", "alcance": "movimiento"}


def _flotilla(**cambios: Any) -> TipoRequest:
    datos = {"nombre": "Autos flotilla", "codigo": "AC", "color": "#059669", "seccion": {"nombre": "Incisos"}, "campos": [POLIZA, PLACAS, SERIE]}
    return TipoRequest.model_validate({**datos, **cambios})


def _resultado_flotilla(campos: Any = ()) -> dict[str, Any]:
    """Lo que devuelve la extracción genérica de una póliza de flotilla con dos incisos."""
    extraido = DocumentoGenerico(
        aseguradora="GNP Seguros",
        datos=[DatoGenerico(nombre="Vigencia", valor="01/11/2026 - 01/11/2027")],
        filas=[
            FilaGenerica(valores=[ValorAdicional(campo="Placas", valor="ABC-123"), ValorAdicional(campo="Serie", valor="S1")]),
            FilaGenerica(valores=[ValorAdicional(campo="Placas", valor="XYZ-987"), ValorAdicional(campo="Serie", valor="S2")]),
        ],
        campos_solicitados=[
            CampoSolicitadoExtraido(nombre="Número de póliza", encontrado=True, valor_documento="POL-77"),
            CampoSolicitadoExtraido(nombre="Placas", encontrado=True),
            CampoSolicitadoExtraido(nombre="Serie", encontrado=True),
        ],
    )
    return _build_result_generico("poliza.pdf", extraido, "m", list(campos), "Incisos")


class GeminiConTipos(GeminiFalso):
    def __init__(self) -> None:
        super().__init__()
        self.clasificacion: dict[str, Any] = {"codigo": "", "confianza": 0.0, "aseguradora": ""}
        self.clasificaciones = 0
        self.tipos_pedidos: list[Any] = []

    def clasificar_documento(self, data: bytes, mime_type: str, filename: str, tipos: list[dict[str, Any]]) -> dict[str, Any]:
        self.clasificaciones += 1
        return dict(self.clasificacion)

    def extract_document(self, data: bytes, mime_type: str, filename: str, forzar: bool = False, campos_solicitados: Any = (), tipo: Any = None) -> dict[str, Any]:
        self.tipos_pedidos.append(tipo)
        self.llamadas.append(tuple(campos_solicitados))
        if tipo is not None:
            return _resultado_flotilla(campos_solicitados)
        return _resultado(campos_solicitados)


class BaseTipos(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        raiz = Path(self.tmp.name)
        self.almacen = AlmacenExtracciones(raiz / "extracciones")
        self.plantillas = AlmacenPlantillas(raiz / "plantillas", lambda _email: [])
        self.tipos = AlmacenTipos(raiz / "tipos", self.plantillas)


class Migracion(BaseTipos):
    def test_la_configuracion_actual_es_el_tipo_estado_de_cuenta(self) -> None:
        self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": [RFC]}))
        lista = self.tipos.leer(EMAIL)
        self.assertEqual(len(lista), 1)
        ec = lista[0]
        self.assertEqual((ec["id"], ec["nombre"], ec["codigo"]), (TIPO_EC_ID, "Estado de cuenta", "EC"))
        self.assertEqual(ec["seccion"], {"nombre": "Movimientos"})
        self.assertEqual([estructura["nombre"] for estructura in ec["estructuras"]], ["Predeterminada"])
        self.assertTrue(ec["contable"])
        # Los campos son los de la configuración de siempre (no una copia).
        self.assertEqual(ec["campos"], self.plantillas.efectiva(EMAIL))
        self.assertEqual(ec["campos"][0]["nombre"], "RFC")

    def test_campos_deducidos_mientras_no_se_guarde(self) -> None:
        deducidos = AlmacenPlantillas(Path(self.tmp.name) / "p2", lambda _email: [RFC])
        tipos = AlmacenTipos(Path(self.tmp.name) / "t2", deducidos)
        self.assertEqual(tipos.ec(EMAIL)["campos"], [RFC])
        self.assertFalse(deducidos.leer(EMAIL)["configurada"])

    def test_editar_ec_escribe_en_la_configuracion_de_campos(self) -> None:
        ec = self.tipos.ec(EMAIL)
        self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({"nombre": ec["nombre"], "codigo": "EC", "color": ec["color"], "seccion": None, "campos": [RFC]}), TIPO_EC_ID)
        self.assertEqual(self.plantillas.leer(EMAIL), {"configurada": True, "campos": [RFC], "actualizado": self.plantillas.leer(EMAIL)["actualizado"]})
        # Estado de cuenta conserva su sección de movimientos, y el archivo de tipos no guarda una copia de sus campos.
        self.assertEqual(self.tipos.ec(EMAIL)["seccion"], {"nombre": "Movimientos"})
        archivo = json.loads(next(Path(self.tmp.name, "tipos").glob("*.json")).read_text(encoding="utf-8"))
        self.assertEqual(archivo["tipos"][0]["campos"], [])

    def test_codigo_y_reglas_unicos(self) -> None:
        self.tipos.guardar_tipo(EMAIL, _flotilla())
        with self.assertRaises(ConflictoTipos):
            self.tipos.guardar_tipo(EMAIL, _flotilla(nombre="Otro", codigo="ac"))
        tipo = self.tipos.por_codigo(EMAIL, "AC")
        assert tipo is not None
        self.tipos.agregar_reglas(EMAIL, tipo["id"], nombre_estructura="GNP", remitente="polizas@gnp.com.mx")
        with self.assertRaises(ConflictoTipos):
            self.tipos.agregar_reglas(EMAIL, TIPO_EC_ID, nombre_estructura="Otra", remitente="polizas@gnp.com.mx")

    def test_cambiar_reglas_sube_la_version(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        estructura = self.tipos.guardar_estructura(EMAIL, tipo["id"], EstructuraRequest(nombre="GNP", reglas=ReglasEstructura(remitentes=["@gnp.com.mx"])))
        self.assertEqual(estructura["version"], 1)
        estructura = self.tipos.guardar_estructura(EMAIL, tipo["id"], EstructuraRequest(nombre="GNP", reglas=ReglasEstructura(remitentes=["@gnp.com.mx"], aseguradoras=["GNP"])), estructura["id"])
        self.assertEqual(estructura["version"], 2)
        self.assertEqual(self.tipos.remitentes(EMAIL), ["@gnp.com.mx"])


class Deteccion(BaseTipos):
    def setUp(self) -> None:
        super().setUp()
        self.flotilla = self.tipos.guardar_tipo(EMAIL, _flotilla())
        self.tipos.agregar_reglas(EMAIL, self.flotilla["id"], nombre_estructura="GNP", remitente="@gnp.com.mx", aseguradora="GNP Seguros")
        self.tipos.agregar_reglas(EMAIL, TIPO_EC_ID, nombre_estructura="Predeterminada", remitente="flotillas@gnp.com.mx")
        self.gm = self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({"nombre": "Gastos médicos mayores", "codigo": "G", "seccion": {"nombre": "Asegurados"}, "campos": []}))
        self.lista = self.tipos.leer(EMAIL)

    def test_por_remitente_la_direccion_exacta_gana_al_dominio(self) -> None:
        exacta = detectar_por_reglas(self.lista, remitente="GNP <flotillas@gnp.com.mx>", asunto="Su póliza")
        assert exacta is not None
        self.assertEqual((exacta["codigo"], exacta["metodo"], exacta["regla"]), ("EC", "remitente", "flotillas@gnp.com.mx"))
        dominio = detectar_por_reglas(self.lista, remitente="avisos@mail.gnp.com.mx", asunto="Estado de cuenta")
        assert dominio is not None
        # La regla de remitente va antes que el asunto de estado de cuenta.
        self.assertEqual((dominio["codigo"], dominio["metodo"], dominio["estructura"]), ("AC", "remitente", "GNP"))
        self.assertFalse(dominio["requiere_revision"])

    def test_asunto_de_estado_de_cuenta_sin_ia(self) -> None:
        deteccion = detectar_tipo(self.lista, remitente="x@banco.com", asunto="Tu estado de cuenta de octubre", clasificar=lambda: self.fail("no debe usar la IA"))
        self.assertEqual((deteccion["codigo"], deteccion["metodo"], deteccion["remitente"]), ("EC", "asunto", "x@banco.com"))

    def test_asunto_de_estado_de_cuenta_que_menciona_poliza_lo_clasifica_la_ia(self) -> None:
        self.assertIsNone(detectar_por_reglas(self.lista, remitente="x@seguros.com", asunto="Estado de cuenta de su póliza 123"))
        llamadas = []

        def clasificar() -> dict[str, Any]:
            llamadas.append(1)
            return {"codigo": "AC", "confianza": 0.9, "aseguradora": "Qualitas"}
        deteccion = detectar_tipo(self.lista, remitente="x@seguros.com", asunto="Estado de cuenta de su poliza 123", clasificar=clasificar)
        self.assertEqual(llamadas, [1])
        self.assertEqual((deteccion["codigo"], deteccion["metodo"], deteccion["confianza"]), ("AC", "ia", 0.9))

    def test_por_aseguradora_detectada_en_el_documento(self) -> None:
        deteccion = resolver_clasificacion(self.lista, {"codigo": "G", "confianza": 0.95, "aseguradora": "Grupo Nacional Provincial GNP Seguros S.A."})
        self.assertEqual((deteccion["codigo"], deteccion["metodo"], deteccion["regla"], deteccion["estructura"]), ("AC", "aseguradora", "GNP Seguros", "GNP"))

    def test_por_ia_con_confianza_alta_baja_o_sin_tipo(self) -> None:
        alta = resolver_clasificacion(self.lista, {"codigo": "AC", "confianza": 0.85, "aseguradora": "Qualitas"})
        self.assertEqual((alta["codigo"], alta["metodo"], alta["requiere_revision"]), ("AC", "ia", False))
        baja = resolver_clasificacion(self.lista, {"codigo": "AC", "confianza": UMBRAL_CONFIANZA - 0.01, "aseguradora": "Qualitas"})
        self.assertTrue(baja["requiere_revision"])
        self.assertIn("confianza", baja["motivo"])
        sin_tipo = resolver_clasificacion(self.lista, {"codigo": "", "confianza": 0.9, "aseguradora": ""})
        self.assertIsNone(sin_tipo["tipo_id"])
        self.assertTrue(sin_tipo["requiere_revision"])

    def test_tipo_sin_campos_requiere_revision(self) -> None:
        deteccion = resolver_clasificacion(self.lista, {"codigo": "G", "confianza": 0.99, "aseguradora": "AXA"})
        self.assertEqual(deteccion["codigo"], "G")
        self.assertTrue(deteccion["requiere_revision"])
        self.assertIn("no tiene campos", deteccion["motivo"])


class Filtro(unittest.TestCase):
    def test_asuntos_de_polizas(self) -> None:
        for asunto in ["Su póliza de autos", "POLIZA 123", "Renovación de su seguro", "Endoso a la póliza"]:
            with self.subTest(asunto=asunto):
                self.assertIsNotNone(asunto_coincide(asunto))
        self.assertTrue(asunto_es_estado_de_cuenta("Estado de cuenta"))
        self.assertFalse(asunto_es_estado_de_cuenta("Su póliza"))
        self.assertTrue(asunto_menciona_poliza("Estado de cuenta de su póliza"))
        self.assertIn("póliza", construir_query("inbox"))

    def test_remitentes_de_las_reglas(self) -> None:
        query = construir_query("inbox", ["polizas@gnp.com.mx", "@axa.com.mx"])
        self.assertTrue(query.startswith("in:inbox {subject:("))
        self.assertTrue(query.endswith('from:"polizas@gnp.com.mx" from:"axa.com.mx"}'))
        self.assertTrue(es_candidato("Documentos adjuntos", "AXA <envios@axa.com.mx>", ["@axa.com.mx"]))
        self.assertFalse(es_candidato("Documentos adjuntos", "envios@axa.com.mx.malo.net", ["@axa.com.mx"]))
        self.assertFalse(es_candidato("Documentos adjuntos", "envios@axa.com.mx", []))
        self.assertEqual(firma_filtro([]), FIRMA_FILTRO)
        self.assertNotEqual(firma_filtro(["@axa.com.mx"]), FIRMA_FILTRO)


class ExtraccionConIncisos(unittest.TestCase):
    def test_seccion_repetible_en_el_borrador(self) -> None:
        resultado = _resultado_flotilla(["Número de póliza", "Placas", "Serie"])
        self.assertEqual(resultado["validacion"]["aplica"], False)
        self.assertEqual(resultado["aseguradora"], "GNP Seguros")
        self.assertEqual([s["nombre"] for s in resultado["sugerencias_campos"]], ["Vigencia"])
        solicitud = borrador_desde_extraccion(resultado, [POLIZA, PLACAS, SERIE], filename="poliza.pdf", attachment_id="a", lote="L")
        poliza = next(c for c in solicitud.campos_extra if c.id == "c-poliza")
        self.assertEqual((poliza.alcance, poliza.valor), ("documento", "POL-77"))
        self.assertEqual([fila.extras for fila in solicitud.transacciones], [{"c-placas": "ABC-123", "c-serie": "S1"}, {"c-placas": "XYZ-987", "c-serie": "S2"}])
        # Sin columnas fijas: las filas solo traen sus campos.
        self.assertTrue(all(not fila.fecha and not fila.cargo for fila in solicitud.transacciones))

    def test_prompt_generico_y_el_de_estado_de_cuenta_no_cambia(self) -> None:
        ajustes = modulo_gemini.GeminiSettings(Path(tempfile.mkdtemp()) / "g.json")
        ajustes._write({"apiKey": "x" * 20, "model": "m", "enabled": True})
        prompts: list[tuple[str, Any]] = []

        def sdk(api_key: str, model: str, data: bytes, mime: str, filename: str, prompt: str | None = None, schema: Any = modulo_gemini.StatementExtraction) -> str:
            prompts.append((prompt or "", schema))
            if schema is DocumentoGenerico:
                return DocumentoGenerico(aseguradora="AXA").model_dump_json()
            return modulo_gemini.StatementExtraction().model_dump_json()
        with patch.object(modulo_gemini, "_call_gemini_sdk", side_effect=sdk):
            ajustes.extract_document(b"%PDF-1.7 x", "application/pdf", "e.pdf")
            ajustes.extract_document(b"%PDF-1.7 x", "application/pdf", "p.pdf", campos_solicitados=["Placas"], tipo={"nombre": "Autos flotilla", "seccion": "Incisos"})
        self.assertEqual(prompts[0][0], modulo_gemini._extraction_prompt("e.pdf", []))
        self.assertIs(prompts[0][1], modulo_gemini.StatementExtraction)
        self.assertIn("Autos flotilla", prompts[1][0])
        self.assertIn("Incisos", prompts[1][0])
        self.assertIs(prompts[1][1], DocumentoGenerico)


def _documento_guardado(almacen: AlmacenExtracciones, tipo_documento: dict[str, Any] | None, resultado: dict[str, Any], campos: list[dict[str, Any]], message_id: str = "m1") -> dict[str, Any]:
    solicitud = borrador_desde_extraccion(resultado, campos, filename="doc.pdf", attachment_id="a", lote="L", tipo_documento=tipo_documento)
    return almacen.guardar(EMAIL, message_id, "1", solicitud)


class SaveDataConTipo(BaseTipos):
    def test_tipo_aseguradora_y_seccion_con_su_nombre(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        deteccion = {"tipo_id": tipo["id"], "codigo": "AC", "nombre": tipo["nombre"], "metodo": "remitente", "aseguradora": "GNP Seguros", "estructura": "GNP"}
        documento = _documento_guardado(self.almacen, deteccion, _resultado_flotilla(["Número de póliza", "Placas", "Serie"]), tipo["campos"])
        self.assertIsNone(documento["validacion"]["cuadra"])
        self.assertEqual(documento["problemas"]["total"], 0)  # sin validación contable no hay "validación incompleta"
        interno = datos_documento(documento, totales_de(documento), tipo["campos"], tipo=tipo)
        self.assertEqual(list(interno), ["Id", "Actualizacion", "Tipo", "Aseguradora", "Archivo", "Datos", "Incisos"])
        self.assertEqual((interno["Id"], interno["Tipo"], interno["Aseguradora"]), ("m1__1", "AC", "GNP Seguros"))
        self.assertEqual(interno["Datos"], {"Número de póliza": "POL-77"})
        self.assertEqual(interno["Incisos"], [{"Placas": "ABC-123", "Serie": "S1"}, {"Placas": "XYZ-987", "Serie": "S2"}])

    def test_aseguradora_de_la_estructura_si_no_se_detecto(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        documento = _documento_guardado(self.almacen, {"tipo_id": tipo["id"], "codigo": "AC", "metodo": "remitente", "estructura": "Qualitas"}, _resultado_flotilla(), tipo["campos"])
        self.assertEqual(datos_documento(documento, totales_de(documento), tipo["campos"], tipo=tipo)["Aseguradora"], "Qualitas")

    def test_estado_de_cuenta_igual_con_tipo_y_banco(self) -> None:
        sin_tipo = _documento_guardado(self.almacen, None, _resultado(), [])
        antes = datos_documento(sin_tipo, totales_de(sin_tipo))
        self.assertEqual(list(antes), ["Id", "Actualizacion", "Tipo", "Archivo", "Resumen", "Datos", "Transacciones", "Validacion"])
        self.assertEqual(antes["Tipo"], "EC")
        self.assertNotIn("Aseguradora", antes)
        con_banco = {**_resultado(), "resumen": {**_resultado()["resumen"], "banco": "BBVA"}}
        detectado = _documento_guardado(self.almacen, {"tipo_id": TIPO_EC_ID, "codigo": "EC", "metodo": "asunto", "contable": True}, con_banco, [], "m2")
        despues = datos_documento(detectado, totales_de(detectado), tipo=self.tipos.ec(EMAIL))
        self.assertEqual(despues["Aseguradora"], "BBVA")
        # Fuera de Tipo y Aseguradora, el JSON del estado de cuenta es el mismo de siempre.
        sin_cabecera = {k: v for k, v in despues.items() if k not in {"Id", "Tipo", "Aseguradora"}}
        self.assertEqual(sin_cabecera, {**{k: v for k, v in antes.items() if k not in {"Id", "Tipo"}}, "Resumen": {**antes["Resumen"], "banco": "BBVA"}})
        self.assertEqual(detectado["validacion"]["cuadra"], sin_tipo["validacion"]["cuadra"])
        self.assertEqual(detectado["problemas"], sin_tipo["problemas"])


class BaseProceso(BaseTipos):
    def setUp(self) -> None:
        super().setUp()
        self.ahora = INICIO
        self.gmail = GmailFalso()
        self.gemini = GeminiConTipos()
        self.savedata = SaveDataFalso()
        tipos = self.tipos
        self.envios = ServicioEnvio(self.almacen, lambda: URL, cliente=self.savedata, configurados=self.plantillas.efectiva, tipo_de=lambda email, documento: tipos.obtener(email, (documento.get("tipo_documento") or {"tipo_id": TIPO_EC_ID}).get("tipo_id")))
        self.extractor = ExtractorAutomatico(Path(self.tmp.name) / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora,
                                             plantillas=self.plantillas, envios=self.envios, tipos=self.tipos)
        self.addCleanup(self.extractor.detener, 1)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)
        self.extractor.configurar_envio(EMAIL, True, True)

    def correo(self, message_id: str, asunto: str, remitente: str = "x@banco.com") -> None:
        self.gmail.agregar(message_id, INICIO + timedelta(minutes=5), asunto=asunto)
        self.gmail.mensajes[message_id]["senderEmail"] = remitente

    def documento(self, message_id: str) -> dict[str, Any]:
        documento = self.almacen.leer_completo(EMAIL, message_id, "1")
        assert documento is not None
        return documento


class ProcesoAutomatico(BaseProceso):
    def test_estados_de_cuenta_siguen_igual(self) -> None:
        self.plantillas.guardar(EMAIL, PlantillaRequest.model_validate({"campos": [RFC]}))
        self.correo("m1", "Tu estado de cuenta")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"]), (1, 1))
        self.assertEqual(self.gemini.clasificaciones, 0)
        self.assertEqual(self.gemini.tipos_pedidos, [None])
        self.assertEqual(self.gemini.llamadas, [("RFC",)])
        documento = self.documento("m1")
        self.assertEqual((documento["tipo_documento"]["codigo"], documento["tipo_documento"]["metodo"]), ("EC", "asunto"))
        interno = self.savedata.internos()[0]
        self.assertEqual(interno["Tipo"], "EC")
        self.assertIn("Transacciones", interno)

    def test_poliza_por_remitente_se_extrae_con_incisos_y_se_envia(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        self.tipos.agregar_reglas(EMAIL, tipo["id"], nombre_estructura="GNP", remitente="@gnp.com.mx")
        self.correo("m1", "Documentos de su seguro", remitente="GNP <polizas@gnp.com.mx>")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"]), (1, 1))
        self.assertTrue(any('from:"gnp.com.mx"' in query for query in self.gmail.queries))
        self.assertEqual(self.gemini.tipos_pedidos, [{"codigo": "AC", "nombre": "Autos flotilla", "seccion": "Incisos"}])
        self.assertEqual(self.gemini.llamadas, [("Número de póliza", "Placas", "Serie")])
        interno = self.savedata.internos()[0]
        self.assertEqual((interno["Tipo"], interno["Aseguradora"]), ("AC", "GNP Seguros"))
        self.assertEqual(len(interno["Incisos"]), 2)

    def test_tipo_sin_configurar_se_extrae_pero_no_se_envia_solo(self) -> None:
        self.gemini.clasificacion = {"codigo": "", "confianza": 0.4, "aseguradora": "AXA"}
        self.correo("m1", "Su póliza de gastos médicos")
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(self.gemini.clasificaciones, 1)
        self.assertEqual((resumen["extraidos"], resumen["enviados"], resumen["requieren_revision"]), (1, 0, 1))
        self.assertEqual(self.savedata.recibidos, [])
        documento = self.documento("m1")
        self.assertEqual(documento["estado"], "borrador")
        self.assertTrue(documento["tipo_documento"]["requiere_revision"])
        self.assertIsNone(documento["tipo_documento"]["tipo_id"])
        self.assertEqual(self.extractor.estado(EMAIL)["adjuntos"]["m1__1"]["envio"]["estado"], "requiere_revision")
        # Más ciclos no lo envían.
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.savedata.recibidos, [])

    def test_confianza_baja_no_se_envia_sola(self) -> None:
        self.tipos.guardar_tipo(EMAIL, _flotilla())
        self.gemini.clasificacion = {"codigo": "AC", "confianza": 0.5, "aseguradora": "Qualitas"}
        self.correo("m1", "Renovación de su póliza")
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.savedata.recibidos, [])
        self.assertEqual(self.documento("m1")["tipo_documento"]["codigo"], "AC")
        self.assertTrue(self.documento("m1")["tipo_documento"]["requiere_revision"])


class ApiTipos(BaseProceso):
    def setUp(self) -> None:
        super().setUp()
        reemplazos = {"gmail": self.gmail, "gemini": self.gemini, "almacen": self.almacen, "plantillas": self.plantillas, "tipos": self.tipos, "envios": self.envios, "automatico": self.extractor}
        for nombre, valor in reemplazos.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        self.api = TestClient(main.app)

    def _sin_configurar(self) -> None:
        self.gemini.clasificacion = {"codigo": "", "confianza": 0.3, "aseguradora": "GNP Seguros"}
        self.correo("m1", "Su póliza", remitente="Pólizas GNP <polizas@gnp.com.mx>")
        self.extractor.ejecutar_ciclo()

    def test_documentos_que_llegaron(self) -> None:
        self._sin_configurar()
        respuesta = self.api.get("/api/tipos/documentos").json()
        documento = respuesta["documentos"][0]
        self.assertEqual(documento["messageId"], "m1")
        self.assertTrue(documento["tipo_documento"]["requiere_revision"])
        self.assertEqual(documento["tipo_documento"]["remitente"], "polizas@gnp.com.mx")
        self.assertEqual(documento["tipo_documento"]["aseguradora"], "GNP Seguros")
        self.assertEqual(respuesta["umbral_confianza"], UMBRAL_CONFIANZA)

    def test_configurar_con_este_documento_crea_tipo_regla_y_campos_y_envia(self) -> None:
        self._sin_configurar()
        respuesta = self.api.post("/api/tipos/configurar-documento", json={
            "messageId": "m1", "partId": "1", "attachmentId": "att-1",
            "nuevo": {"nombre": "Autos flotilla", "codigo": "ac", "seccion": "Incisos"},
            "reglas": {"remitente": "polizas@gnp.com.mx", "aseguradora": "GNP Seguros"},
            "campos": [POLIZA, PLACAS, SERIE],
            "extraer_y_enviar": True,
        })
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        cuerpo = respuesta.json()
        self.assertEqual(cuerpo["tipo"]["codigo"], "AC")
        self.assertEqual(cuerpo["estructura"]["nombre"], "GNP Seguros")
        self.assertEqual(cuerpo["estructura"]["reglas"], {"remitentes": ["polizas@gnp.com.mx"], "aseguradoras": ["GNP Seguros"]})
        self.assertEqual([campo["nombre"] for campo in cuerpo["tipo"]["campos"]], ["Número de póliza", "Placas", "Serie"])
        self.assertEqual(cuerpo["envio"], "enviado")
        interno = self.savedata.internos()[-1]
        self.assertEqual(interno["Tipo"], "AC")
        self.assertEqual(interno["Incisos"][0], {"Placas": "ABC-123", "Serie": "S1"})
        documento = self.documento("m1")
        self.assertEqual(documento["estado"], "enviado")
        self.assertFalse(documento["tipo_documento"]["requiere_revision"])
        self.assertEqual(documento["tipo_documento"]["metodo"], "manual")
        # La próxima vez se reconoce por la regla de remitente.
        detectado = detectar_por_reglas(self.tipos.leer(EMAIL), remitente="polizas@gnp.com.mx", asunto="Otra cosa")
        assert detectado is not None
        self.assertEqual(detectado["codigo"], "AC")
        tipos = self.api.get("/api/tipos").json()["tipos"]
        flotilla = next(tipo for tipo in tipos if tipo["codigo"] == "AC")
        self.assertEqual(flotilla["estructuras"][0]["documentos"], 1)

    def test_configurar_sin_extraer_solo_asigna_el_tipo(self) -> None:
        self._sin_configurar()
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla(campos=[]))
        respuesta = self.api.post("/api/tipos/configurar-documento", json={"messageId": "m1", "partId": "1", "tipo_id": tipo["id"], "campos": [POLIZA], "reglas": {}})
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(self.documento("m1")["tipo_documento"]["codigo"], "AC")
        self.assertFalse(self.documento("m1")["tipo_documento"]["requiere_revision"])
        self.assertEqual(self.savedata.recibidos, [])

    def test_crear_tipo_con_codigo_repetido_es_conflicto(self) -> None:
        self.assertEqual(self.api.post("/api/tipos", json={"nombre": "Autos", "codigo": "A"}).status_code, 200)
        respuesta = self.api.post("/api/tipos", json={"nombre": "Autos 2", "codigo": "A"})
        self.assertEqual(respuesta.status_code, 409)

    def test_extraer_desde_la_pantalla_detecta_el_tipo(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        self.tipos.agregar_reglas(EMAIL, tipo["id"], nombre_estructura="GNP", remitente="@gnp.com.mx")
        self.correo("m9", "Documentos", remitente="polizas@gnp.com.mx")
        respuesta = self.api.post("/api/gemini/extract", json={"messageId": "m9", "attachmentId": "att-1", "detectar": True, "campos_solicitados": ["RFC"]}).json()
        self.assertEqual((respuesta["tipo_documento"]["codigo"], respuesta["tipo_documento"]["metodo"]), ("AC", "remitente"))
        self.assertEqual([campo["nombre"] for campo in respuesta["campos_tipo"]], ["Número de póliza", "Placas", "Serie"])
        self.assertEqual(self.gemini.llamadas[-1], ("Número de póliza", "Placas", "Serie"))
        # Un estado de cuenta sigue usando los campos que pide la pantalla.
        self.correo("m8", "Estado de cuenta")
        respuesta = self.api.post("/api/gemini/extract", json={"messageId": "m8", "attachmentId": "att-1", "detectar": True, "campos_solicitados": ["RFC"]}).json()
        self.assertEqual(respuesta["tipo_documento"]["codigo"], "EC")
        self.assertIsNone(respuesta["campos_tipo"])
        self.assertEqual(self.gemini.llamadas[-1], ("RFC",))

    def test_filtro_de_correos_toma_los_remitentes_de_las_reglas(self) -> None:
        tipo = self.tipos.guardar_tipo(EMAIL, _flotilla())
        self.tipos.agregar_reglas(EMAIL, tipo["id"], nombre_estructura="GNP", remitente="@gnp.com.mx")
        consultas: list[str] = []
        mensajes = [
            {"id": "p1", "subject": "Documentos de su seguro", "senderEmail": "polizas@gnp.com.mx", "attachments": [{"filename": "p.pdf", "mimeType": "application/pdf"}]},
            {"id": "x1", "subject": "Documentos de su seguro", "senderEmail": "otro@seguros.com", "attachments": [{"filename": "p.pdf", "mimeType": "application/pdf"}]},
        ]

        def listar(folder: str, max_results: int, page_token: str | None = None, query: str | None = None) -> dict[str, Any]:
            consultas.append(query or "")
            return {"messages": mensajes, "nextPageToken": None}
        with patch.object(self.gmail, "list_messages", side_effect=listar, create=True), patch.object(main, "configuracion") as configuracion:
            configuracion.leer.return_value = {"remitentes": [], "firma": "sin-remitentes"}
            respuesta = self.api.get("/api/gmail/messages").json()
        self.assertEqual([m["id"] for m in respuesta["messages"]], ["p1"])
        self.assertIn('from:"gnp.com.mx"', consultas[0])
        self.assertNotEqual(respuesta["firmaFiltro"], FIRMA_FILTRO)


if __name__ == "__main__":
    unittest.main()
