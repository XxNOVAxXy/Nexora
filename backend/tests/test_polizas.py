"""Extracción de pólizas (tipos que no son estado de cuenta) con los tres PDF de prueba y Gemini simulado.

Autos individual (sección Coberturas, 4 filas), flotilla (sección Incisos, 5 filas) y gastos médicos mayores (sección
Asegurados, 3 filas): campos "Una vez" llenos, todas las filas y el nombre de la sección en SaveData. También: un tipo
sin sección avisa de la tabla, un documento sin datos no se envía solo y "no se pudo conectar" no es "incierto".
"""

from __future__ import annotations

import socket
import tempfile
import threading
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.app import gemini as modulo_gemini
from backend.app.automatico import ExtractorAutomatico, borrador_desde_extraccion, sin_datos_extraidos
from backend.app.extracciones import AlmacenExtracciones
from backend.app.gemini import CampoSolicitadoExtraido, DatoGenerico, DocumentoGenerico, FilaGenerica, ValorAdicional
from backend.app.plantilla_campos import AlmacenPlantillas
from backend.app.savedata import MENSAJE_SIN_CONEXION, ServicioEnvio, datos_documento, enviar_a_savedata, totales_de
from backend.app.tipos_documento import TIPO_EC_ID, AlmacenTipos, TipoRequest, tipo_para_extraer
from backend.tests.test_automatico import EMAIL, INICIO, GmailFalso
from backend.tests.test_envio_automatico import URL, SaveDataFalso

FIXTURES = Path(__file__).parent / "fixtures"


def _campos(una_vez: list[str], por_fila: list[str]) -> list[dict[str, Any]]:
    return ([{"id": f"u{i}", "nombre": nombre, "origen": "ia", "alcance": "documento"} for i, nombre in enumerate(una_vez)]
            + [{"id": f"f{i}", "nombre": nombre, "origen": "manual", "alcance": "movimiento"} for i, nombre in enumerate(por_fila)])


# Lo que hay en cada PDF de prueba (valores ficticios): datos "Una vez" y filas de su sección.
POLIZAS: dict[str, dict[str, Any]] = {
    "autos_individual": {
        "pdf": "poliza_auto_individual_prueba.pdf", "nombre": "Autos individuales", "codigo": "A", "seccion": "Coberturas",
        "una_vez": {"Número de póliza": "AUT-1", "Asegurado": "Persona Prueba", "Vigencia desde": "01/01/2026", "Vigencia hasta": "01/01/2027", "Marca": "Marca X", "Placas": "AAA-000", "Prima total": "9,000.00"},
        "filas": [{"Cobertura": f"Cobertura {n}", "Suma asegurada": f"{n}00,000.00", "Deducible": f"{n}%"} for n in range(1, 5)],
    },
    "flotilla": {
        "pdf": "poliza_flotilla_prueba.pdf", "nombre": "Autos flotilla", "codigo": "AC", "seccion": "Incisos",
        "una_vez": {"Número de póliza": "FLO-1", "Contratante": "Empresa Prueba", "Vigencia desde": "01/01/2026", "Prima total": "50,000.00"},
        "filas": [{"Inciso": str(n), "Placas": f"PLA-00{n}", "Serie": f"SERIE{n}", "Prima": f"{n},000.00"} for n in range(1, 6)],
    },
    "gastos_medicos": {
        "pdf": "poliza_gastos_medicos_prueba.pdf", "nombre": "Gastos médicos mayores", "codigo": "G", "seccion": "Asegurados",
        "una_vez": {"Número de póliza": "GMM-1", "Contratante": "Persona Prueba", "RFC": "XAXX010101000", "Vigencia desde": "01/01/2026", "Vigencia hasta": "01/01/2027",
                    "Suma asegurada": "5,000,000.00", "Deducible": "20,000.00", "Coaseguro": "10%", "Tope de coaseguro": "50,000.00", "Prima total": "30,000.00",
                    "Forma de pago": "Anual", "Producto": "Gastos médicos mayores"},
        "filas": [{"Asegurado": f"Asegurado {n}", "Parentesco": p, "Fecha de nacimiento": f"0{n}/01/1990", "Prima": f"{n},500.00"} for n, p in [(1, "Titular"), (2, "Cónyuge"), (3, "Hijo")]],
    },
}


def _respuesta_gemini(poliza: dict[str, Any], pedidos: list[str], con_filas: bool = True) -> str:
    """Respuesta simulada de Gemini con el esquema genérico: lo que el documento trae, para los campos pedidos."""
    return DocumentoGenerico(
        aseguradora="ASEGURADORA EJEMPLO NORTE",
        datos=[DatoGenerico(nombre=nombre, valor=valor) for nombre, valor in poliza["una_vez"].items()],
        filas=[FilaGenerica(valores=[ValorAdicional(campo=campo, valor=valor) for campo, valor in fila.items()]) for fila in poliza["filas"]] if con_filas else [],
        campos_solicitados=[CampoSolicitadoExtraido(nombre=nombre, encontrado=True, valor_documento=poliza["una_vez"].get(nombre, "")) for nombre in pedidos],
    ).model_dump_json()


class TresPolizas(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        raiz = Path(self.tmp.name)
        self.ajustes = modulo_gemini.GeminiSettings(raiz / "gemini.json")
        self.ajustes._write({"apiKey": "x" * 20, "model": "m", "enabled": True})
        self.tipos = AlmacenTipos(raiz / "tipos", AlmacenPlantillas(raiz / "plantillas"), precargadas=())
        self.almacen = AlmacenExtracciones(raiz / "extracciones")

    def _extraer(self, clave: str) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
        poliza = POLIZAS[clave]
        tipo = self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({
            "nombre": poliza["nombre"], "codigo": poliza["codigo"], "seccion": {"nombre": poliza["seccion"]},
            "campos": _campos(list(poliza["una_vez"]), list(poliza["filas"][0])),
        }))
        prompts: list[str] = []

        def sdk(api_key: str, model: str, data: bytes, mime: str, filename: str, prompt: str | None = None, schema: Any = None) -> str:
            prompts.append(prompt or "")
            return _respuesta_gemini(poliza, [campo["nombre"] for campo in tipo["campos"]])
        data = (FIXTURES / poliza["pdf"]).read_bytes()
        with patch.object(modulo_gemini, "_call_gemini_sdk", side_effect=sdk):
            resultado = self.ajustes.extract_document(data, "application/pdf", poliza["pdf"], campos_solicitados=[c["nombre"] for c in tipo["campos"]], tipo=tipo_para_extraer(tipo))
        return tipo, resultado, prompts

    def _comprobar(self, clave: str) -> None:
        poliza = POLIZAS[clave]
        tipo, resultado, prompts = self._extraer(clave)
        self.assertIn(poliza["seccion"], prompts[0])
        self.assertEqual(resultado["seccion"], poliza["seccion"])
        solicitud = borrador_desde_extraccion(resultado, tipo["campos"], filename=poliza["pdf"], attachment_id="a", lote="L",
                                              tipo_documento={"tipo_id": tipo["id"], "codigo": tipo["codigo"], "metodo": "remitente"})
        una_vez = {c.nombre: c.valor for c in solicitud.campos_extra if c.alcance == "documento"}
        self.assertEqual(una_vez, poliza["una_vez"])  # todos llenos, cada uno una sola vez
        por_fila = {c.id: c.nombre for c in solicitud.campos_extra if c.alcance != "documento"}
        filas = [{por_fila[clave_id]: valor for clave_id, valor in (fila.extras or {}).items()} for fila in solicitud.transacciones]
        self.assertEqual(filas, poliza["filas"])
        documento = self.almacen.guardar(EMAIL, "m1", clave.replace("_", "-"), solicitud)
        self.assertEqual(documento["problemas"]["total"], 0)
        self.assertFalse(sin_datos_extraidos(documento))
        interno = datos_documento(documento, totales_de(documento), tipo["campos"], tipo=tipo)
        self.assertEqual(interno["Tipo"], poliza["codigo"])
        self.assertEqual(interno["Datos"], poliza["una_vez"])
        self.assertEqual(interno[poliza["seccion"]], poliza["filas"])
        self.assertNotIn("Filas", interno)

    def test_autos_individual_con_4_coberturas(self) -> None:
        self._comprobar("autos_individual")

    def test_flotilla_con_5_incisos(self) -> None:
        self._comprobar("flotilla")

    def test_gastos_medicos_con_3_asegurados(self) -> None:
        self._comprobar("gastos_medicos")

    def test_tipo_sin_seccion_avisa_de_la_tabla_y_llena_los_datos(self) -> None:
        poliza = POLIZAS["gastos_medicos"]
        tipo = self.tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({"nombre": "GMM", "codigo": "G", "seccion": None, "campos": _campos(list(poliza["una_vez"]), [])}))
        data = (FIXTURES / poliza["pdf"]).read_bytes()
        prompts: list[str] = []

        def sdk(api_key: str, model: str, data: bytes, mime: str, filename: str, prompt: str | None = None, schema: Any = None) -> str:
            prompts.append(prompt or "")
            return _respuesta_gemini(poliza, [campo["nombre"] for campo in tipo["campos"]])
        with patch.object(modulo_gemini, "_call_gemini_sdk", side_effect=sdk):
            resultado = self.ajustes.extract_document(data, "application/pdf", poliza["pdf"], campos_solicitados=[c["nombre"] for c in tipo["campos"]], tipo=tipo_para_extraer(tipo))
        self.assertIn("no tiene seccion repetible configurada", prompts[0])
        self.assertEqual(resultado["transacciones"], [])
        self.assertEqual(resultado["tabla_sin_seccion"], {"filas": 3, "campos": ["Asegurado", "Parentesco", "Fecha de nacimiento", "Prima"]})
        self.assertTrue(any("Agrega una sección al tipo" in aviso for aviso in resultado["warnings"]))
        solicitud = borrador_desde_extraccion(resultado, tipo["campos"], filename=poliza["pdf"], attachment_id="a", lote="L")
        self.assertTrue(all(c.valor for c in solicitud.campos_extra))


class SinDatosNoSeEnvia(unittest.TestCase):
    def test_poliza_sin_campos_ni_filas_queda_en_revision(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raiz = Path(tmp.name)
        almacen = AlmacenExtracciones(raiz / "extracciones")
        plantillas = AlmacenPlantillas(raiz / "plantillas")
        tipos = AlmacenTipos(raiz / "tipos", plantillas, precargadas=())
        tipo = tipos.guardar_tipo(EMAIL, TipoRequest.model_validate({"nombre": "Autos", "codigo": "A", "seccion": {"nombre": "Coberturas"}, "campos": _campos(["Número de póliza"], ["Cobertura"])}))
        tipos.agregar_reglas(EMAIL, tipo["id"], nombre_estructura="Norte", remitente="@norte.example")
        gmail = GmailFalso()
        gmail.agregar("m1", INICIO + timedelta(minutes=5), asunto="Documentos")
        gmail.mensajes["m1"]["senderEmail"] = "polizas@norte.example"
        savedata = SaveDataFalso()

        class GeminiVacio:
            def status(self) -> dict[str, Any]:
                return {"enabled": True}

            def extract_document(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
                return {"model": "m", "prompt_version": "p", "formato_numerico": None, "resumen": {"dudosos": []}, "transacciones": [],
                        "sugerencias_campos": [], "resultados_campos": [{"nombre": "Número de póliza", "clave": "numero-de-poliza", "encontrado": False, "valores": []}]}
        envios = ServicioEnvio(almacen, lambda: URL, cliente=savedata, configurados=plantillas.efectiva,
                               tipo_de=lambda email, documento: tipos.obtener(email, (documento.get("tipo_documento") or {"tipo_id": TIPO_EC_ID}).get("tipo_id")))
        extractor = ExtractorAutomatico(raiz / "automatico", gmail, GeminiVacio(), almacen, reloj=lambda: INICIO, plantillas=plantillas, envios=envios, tipos=tipos)
        self.addCleanup(extractor.detener, 1)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            extractor.configurar(EMAIL, True)
        extractor.configurar_envio(EMAIL, True, False)  # aun con "Enviar solo si cuadra" apagado
        resumen = extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"], resumen["requieren_revision"]), (1, 0, 1))
        self.assertEqual(savedata.recibidos, [])
        envio = extractor.estado(EMAIL)["adjuntos"]["m1__1"]["envio"]
        self.assertEqual(envio["estado"], "requiere_revision")
        self.assertIn("No se extrajo ningun dato", envio["motivos"][0])


def _puerto_libre() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ConexionConSaveData(unittest.TestCase):
    def test_sin_conexion_es_error_reintentable_y_no_incierto(self) -> None:
        respuesta = enviar_a_savedata(f"http://127.0.0.1:{_puerto_libre()}/guardar", '{"data": "{}"}', timeout=2)
        self.assertEqual(respuesta.resultado, "error")
        self.assertIsNone(respuesta.http_status)
        self.assertEqual(respuesta.mensaje, MENSAJE_SIN_CONEXION)
        self.assertEqual(MENSAJE_SIN_CONEXION, "No se pudo conectar con SaveData; no se envió nada.")

    def test_conexion_abierta_sin_respuesta_es_incierto(self) -> None:
        servidor = socket.socket()
        servidor.bind(("127.0.0.1", 0))
        servidor.listen(1)
        self.addCleanup(servidor.close)
        conexiones: list[socket.socket] = []

        def aceptar() -> None:
            conexion, _ = servidor.accept()
            conexiones.append(conexion)  # recibe el cuerpo y nunca responde
        hilo = threading.Thread(target=aceptar, daemon=True)
        hilo.start()
        respuesta = enviar_a_savedata(f"http://127.0.0.1:{servidor.getsockname()[1]}/guardar", '{"data": "{}"}', timeout=0.5)
        for conexion in conexiones:
            conexion.close()
        self.assertEqual(respuesta.resultado, "incierto")
        self.assertIn("no se sabe si recibio", respuesta.mensaje)

    def test_envio_automatico_sin_conexion_se_reintenta(self) -> None:
        from backend.tests.test_envio_automatico import BaseEnvio
        from backend.app.savedata import RespuestaSaveData

        class Caso(BaseEnvio):
            def runTest(self) -> None:
                self.savedata.respuestas = [RespuestaSaveData("error", None, "", MENSAJE_SIN_CONEXION)]
                self.activar()
                self.encender_envio()
                self.correo()
                self.extractor.ejecutar_ciclo()
                self.assertEqual(self.envio()["estado"], "pendiente")  # no se envió nada: se intenta otra vez
                self.assertEqual(self.envio()["error"], MENSAJE_SIN_CONEXION)
                self.extractor.ejecutar_ciclo()
                self.assertEqual(self.envio()["estado"], "enviado")
        resultado = unittest.TestResult()
        Caso().run(resultado)
        self.assertEqual((resultado.errors, resultado.failures), ([], []))


if __name__ == "__main__":
    unittest.main()
