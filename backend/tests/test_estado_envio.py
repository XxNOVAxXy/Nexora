"""Que se vea si se envió o no: estado de envío por documento, reintento de "extraer y enviar", resumen y aviso por tipo.

Sin Gmail, Gemini ni SaveData reales y sin datos reales: todo simulado y con valores ficticios.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import gemini as modulo_gemini
from backend.app import main
from backend.app.automatico import MAX_INTENTOS, ExtractorAutomatico
from backend.app.extracciones import AlmacenExtracciones
from backend.app.gemini import CampoSolicitadoExtraido, DocumentoGenerico
from backend.app.plantilla_campos import AlmacenPlantillas
from backend.app.savedata import MENSAJE_SIN_CONEXION, RespuestaSaveData, ServicioEnvio
from backend.app.tipos_documento import TIPO_EC_ID, AlmacenTipos
from backend.tests.test_automatico import EMAIL, INICIO, GmailFalso
from backend.tests.test_envio_automatico import URL, SaveDataFalso

SIN_CONEXION = RespuestaSaveData("error", None, "", MENSAJE_SIN_CONEXION)


class GmailVarios(GmailFalso):
    """Cada correo trae un PDF distinto (nombre = id del mensaje)."""

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        return f"%PDF-1.7 {message_id}".encode(), "application/pdf", f"{message_id}.pdf"


class GeminiPorArchivo:
    """Clasifica según el nombre del archivo: "fz…" Fianzas (confianza alta), "gm…" Gastos médicos (confianza baja)."""

    def status(self) -> dict[str, Any]:
        return {"enabled": True}

    def clasificar_documento(self, data: bytes, mime: str, filename: str, tipos: list[dict[str, Any]]) -> dict[str, Any]:
        if filename.startswith("gm"):
            return {"codigo": "G", "confianza": 0.4, "aseguradora": "ASEGURADORA EJEMPLO", "motivo": ""}
        return {"codigo": "F", "confianza": 0.92, "aseguradora": "AFIANZADORA EJEMPLO", "motivo": ""}

    def extract_document(self, data: bytes, mime: str, filename: str, campos_solicitados: list[str] = (), tipo: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        valores = {nombre: f"valor {n}" for n, nombre in enumerate(campos_solicitados[:3])}
        extraido = DocumentoGenerico(aseguradora="AFIANZADORA EJEMPLO",
                                     campos_solicitados=[CampoSolicitadoExtraido(nombre=n, encontrado=n in valores, valor_documento=valores.get(n, "")) for n in campos_solicitados])
        return modulo_gemini._build_result_generico(filename, extraido, "m", list(campos_solicitados), (tipo or {}).get("seccion") or "")


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        raiz = Path(self.tmp.name)
        self.ahora = INICIO
        self.plantillas = AlmacenPlantillas(raiz / "plantillas")
        self.tipos = AlmacenTipos(raiz / "tipos", self.plantillas)
        self.almacen = AlmacenExtracciones(raiz / "extracciones")
        self.gmail = GmailVarios()
        self.savedata = SaveDataFalso()
        self.envios = ServicioEnvio(self.almacen, lambda: URL, cliente=self.savedata, configurados=self.plantillas.efectiva,
                                    tipo_de=lambda email, documento: self.tipos.obtener(email, (documento.get("tipo_documento") or {"tipo_id": TIPO_EC_ID}).get("tipo_id")))
        self.extractor = ExtractorAutomatico(raiz / "automatico", self.gmail, GeminiPorArchivo(), self.almacen, reloj=lambda: self.ahora,
                                             plantillas=self.plantillas, envios=self.envios, tipos=self.tipos)
        self.addCleanup(self.extractor.detener, 1)
        for nombre, valor in {"almacen": self.almacen, "tipos": self.tipos, "automatico": self.extractor}.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        cuenta = patch.object(main, "_cuenta_actual", return_value=EMAIL)
        cuenta.start()
        self.addCleanup(cuenta.stop)
        self.api = TestClient(main.app)

    def activar(self, envio: bool) -> None:
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)
        if envio:
            self.extractor.configurar_envio(EMAIL, True, True)

    def correo(self, message_id: str, minutos: int = 5) -> None:
        self.gmail.agregar(message_id, INICIO + timedelta(minutes=minutos), asunto="Fianza de cumplimiento")

    def estados(self) -> dict[str, dict[str, Any]]:
        documentos = self.api.get("/api/tipos/documentos").json()["documentos"]
        return {documento["messageId"]: documento["estado_envio"] for documento in documentos}

    def configurar(self, message_id: str) -> dict[str, Any]:
        """"Configurar con este documento" con "extraer y enviar", eligiendo Fianzas."""
        fianzas = self.tipos.por_codigo(EMAIL, "F")
        respuesta = self.api.post("/api/tipos/configurar-documento", json={
            "messageId": message_id, "partId": "1", "attachmentId": "att-1", "tipo_id": fianzas["id"], "reglas": {},
            "campos": fianzas["campos"], "extraer_y_enviar": True})
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        return respuesta.json()


class EstadosEnLaLista(Base):
    def test_enviado_al_configurar_con_code_de_savedata(self) -> None:
        self.correo("fz-1")
        resultado = self.configurar("fz-1")
        self.assertEqual((resultado["envio"], resultado["code"], resultado["reintentara"]), ("enviado", 200, False))
        estado = self.estados()["fz-1"]
        self.assertEqual((estado["estado"], estado["filtro"], estado["etiqueta"], estado["origen"]), ("enviado", "enviados", "Enviado al configurar", "configurar"))
        self.assertEqual(estado["code"], 200)
        self.assertIsNotNone(estado["fecha"])
        self.assertTrue(estado["respuesta"].startswith("code 200"))

    def test_enviado_automaticamente(self) -> None:
        self.activar(envio=True)
        self.correo("fz-1")
        self.assertEqual(self.extractor.ejecutar_ciclo()["enviados"], 1)
        estado = self.estados()["fz-1"]
        self.assertEqual((estado["etiqueta"], estado["origen"], estado["code"]), ("Enviado automáticamente", "automatico", 200))

    def test_no_enviado_con_motivo(self) -> None:
        # Envío automático apagado.
        self.activar(envio=False)
        self.correo("fz-1")
        # Confianza baja: requiere revisión.
        self.correo("gm-1", minutos=6)
        self.extractor.ejecutar_ciclo()
        estados = self.estados()
        self.assertEqual((estados["fz-1"]["etiqueta"], estados["fz-1"]["filtro"]), ("No se envió: envío automático apagado", "no_enviados"))
        self.assertTrue(estados["gm-1"]["etiqueta"].startswith("No se envió: La IA no está segura del tipo (confianza 40%)"))
        # Editado a mano antes del envío automático.
        self.extractor.configurar_envio(EMAIL, True, True)
        self.correo("fz-2", minutos=7)
        original = self.extractor._enviar_auto

        def editar_antes(email: str, message_id: str, part_id: str) -> Any:
            if message_id == "fz-2":
                self.almacen.actualizar(email, message_id, part_id, lambda doc: {**doc, "version": int(doc["version"]) + 1})
            return original(email, message_id, part_id)
        with patch.object(self.extractor, "_enviar_auto", side_effect=editar_antes):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estados()["fz-2"]["etiqueta"], "No se envió: editado a mano")
        self.assertEqual(self.savedata.recibidos, [])


class ReintentoAlConfigurar(Base):
    def test_sin_conexion_queda_pendiente_y_el_proceso_lo_reintenta_aunque_el_envio_automatico_este_apagado(self) -> None:
        self.correo("fz-1")
        self.savedata.respuestas = [SIN_CONEXION]
        resultado = self.configurar("fz-1")
        self.assertEqual((resultado["envio"], resultado["reintentara"]), ("pendiente", True))
        self.assertEqual(resultado["mensaje"], MENSAJE_SIN_CONEXION)
        estado = self.estados()["fz-1"]
        self.assertEqual((estado["etiqueta"], estado["filtro"]), ("Pendiente de envío (pedido al configurar)", "pendientes"))
        self.assertIn("Se reintentará en la próxima revisión", estado["motivo"])
        # La extracción automática está en pausa y el envío automático apagado: igual se reintenta.
        self.assertFalse(self.extractor.estado(EMAIL)["envio_activo"])
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 2)
        estado = self.estados()["fz-1"]
        self.assertEqual((estado["etiqueta"], estado["origen"]), ("Enviado al configurar", "configurar"))
        self.assertTrue(any("Se envió 1 (Fianzas)" in aviso["texto"] for aviso in self.extractor.estado(EMAIL)["avisos"]))

    def test_se_reintenta_como_maximo_tres_veces(self) -> None:
        self.activar(envio=False)
        self.correo("fz-1")
        self.savedata.respuestas = [SIN_CONEXION] * (1 + MAX_INTENTOS)
        self.configurar("fz-1")
        for n in range(MAX_INTENTOS):
            self.ahora = INICIO + timedelta(minutes=20 * (n + 1))
            self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1 + MAX_INTENTOS)
        self.assertEqual(self.estados()["fz-1"]["etiqueta"], "Error al enviar")
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1 + MAX_INTENTOS)  # ya no se reintenta

    def test_incierto_no_se_reintenta_solo(self) -> None:
        self.correo("fz-1")
        self.savedata.respuestas = [RespuestaSaveData("incierto", None, "", "SaveData no respondio; no se sabe si recibio el envio.")]
        resultado = self.configurar("fz-1")
        self.assertEqual((resultado["envio"], resultado["reintentara"]), ("incierto", False))
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual((self.estados()["fz-1"]["etiqueta"], self.estados()["fz-1"]["filtro"]), ("Incierto, verificar", "con_error"))


class ResumenYAvisoPorTipo(Base):
    def test_texto_con_varios_tipos(self) -> None:
        ctx = {"claves": {"enviado": ["a", "b", "c"], "requiere_revision": ["d"], "error": [], "incierto": []},
               "tipo_de": {"a": "Fianzas", "b": "Autos individuales", "c": "Fianzas", "d": "Gastos médicos mayores"}}
        self.assertEqual(ExtractorAutomatico.texto_envios(ctx), "Se enviaron 3 (2 Fianzas, 1 Autos individuales) · 1 requiere revisión (Gastos médicos mayores)")

    def test_resumen_de_30_dias_por_tipo_y_aviso_del_ciclo_por_tipo(self) -> None:
        self.activar(envio=True)
        self.correo("fz-1")
        self.correo("fz-2", minutos=6)
        self.correo("gm-1", minutos=7)
        self.savedata.respuestas = [RespuestaSaveData("exito", 200, '{"code": 200}', "ok"), SIN_CONEXION]
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["enviados"], resumen["requieren_revision"]), (1, 1))
        estado = self.extractor.estado(EMAIL)
        texto = "Se envió 1 (Fianzas) · 1 requiere revisión (Gastos médicos mayores)"
        self.assertEqual(estado["ultimo_ciclo"]["texto_envios"], texto)
        self.assertEqual(estado["avisos"][0]["texto"], f"{texto}.")
        self.assertEqual(sorted(estado["avisos"][0]["claves"]), ["fz-1__1", "gm-1__1"])

        tipos = {tipo["codigo"]: tipo for tipo in self.api.get("/api/tipos").json()["tipos"]}
        self.assertEqual(tipos["F"]["resumen_envios"], {"dias": 30, "recibidos": 2, "enviados_automatico": 1, "enviados_configurar": 0, "enviados_manual": 0,
                                                        "pendientes": 1, "no_enviados": 0, "con_error": 0})
        self.assertEqual(tipos["G"]["resumen_envios"]["no_enviados"], 1)
        self.assertEqual(tipos["A"]["resumen_envios"]["recibidos"], 0)
        # Fuera de los 30 días ya no cuentan.
        documentos = main._documentos_con_envio(EMAIL)
        creado = datetime.fromisoformat(documentos[0]["creado"].replace("Z", "+00:00"))
        self.assertEqual(main._resumen_por_tipo(documentos, ahora=creado + timedelta(days=40)), {})
        self.assertEqual(main._resumen_por_tipo(documentos, ahora=creado + timedelta(days=29))[tipos["F"]["id"]]["recibidos"], 2)


if __name__ == "__main__":
    unittest.main()
