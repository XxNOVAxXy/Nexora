"""Envío automático a SaveData después de la extracción automática: sin Gmail, Gemini ni SaveData reales."""

from __future__ import annotations

import json
import threading
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.app.automatico import ExtractorAutomatico
from backend.app.extracciones import GuardarExtraccionRequest
from backend.app.savedata import RespuestaSaveData, ServicioEnvio, historial_envios, preparar_envio
from backend.tests.test_automatico import EMAIL, INICIO, Base, _resultado

URL = "http://savedata.local/guardar"
EXITO = RespuestaSaveData("exito", 200, '{"code": 200, "message": "Exito"}', "SaveData confirmo el envio: Exito.")
ERROR = RespuestaSaveData("error", 500, '{"code": 500}', "SaveData respondio HTTP 500.")
INCIERTO = RespuestaSaveData("incierto", None, "", "SaveData no respondio en 30 s; no se sabe si recibio el envio.")


class _Caida(BaseException):
    """Simula que el proceso del backend muere a mitad de una operación."""


class SaveDataFalso:
    def __init__(self) -> None:
        self.respuestas: list[RespuestaSaveData] = []
        self.recibidos: list[str] = []
        self.caer = False
        self.espera: threading.Event | None = None
        self.en_llamada = threading.Event()

    def __call__(self, url: str, cuerpo: str, timeout: float) -> RespuestaSaveData:
        self.recibidos.append(cuerpo)
        self.en_llamada.set()
        if self.espera is not None:
            self.espera.wait(5)
        if self.caer:
            raise _Caida()
        return self.respuestas.pop(0) if self.respuestas else EXITO

    def internos(self) -> list[dict[str, Any]]:
        return [json.loads(json.loads(cuerpo)["data"]) for cuerpo in self.recibidos]


class BaseEnvio(Base):
    def setUp(self) -> None:
        self.url = URL
        self.savedata = SaveDataFalso()
        super().setUp()

    def _nuevo(self) -> ExtractorAutomatico:
        servicio = ServicioEnvio(self.almacen, lambda: self.url, cliente=self.savedata)
        return ExtractorAutomatico(Path(self.tmp.name) / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora, envios=servicio)

    def encender_envio(self, solo_si_cuadra: bool = True, extractor: ExtractorAutomatico | None = None) -> None:
        (extractor or self.extractor).configurar_envio(EMAIL, True, solo_si_cuadra)

    def correo(self, message_id: str = "m1") -> None:
        self.gmail.agregar(message_id, INICIO + timedelta(minutes=5))

    def envio(self, message_id: str = "m1") -> dict[str, Any]:
        return self.adjunto(message_id).get("envio") or {}

    def documento(self, message_id: str = "m1") -> dict[str, Any]:
        documento = self.almacen.leer_completo(EMAIL, message_id, "1")
        assert documento is not None
        return documento

    def resultado_gemini(self, **cambios: Any) -> None:
        original = self.gemini.extract_document

        def extraer(*args: Any, **kwargs: Any) -> dict[str, Any]:
            resultado = original(*args, **kwargs)
            return {**resultado, **cambios}
        self.gemini.extract_document = extraer  # type: ignore[method-assign]


class EnvioAutomatico(BaseEnvio):
    def test_extraido_y_cuadra_se_envia_solo_una_vez(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["enviados"]), (1, 1))
        self.assertEqual(self.envio()["estado"], "enviado")
        documento = self.documento()
        self.assertEqual(documento["estado"], "enviado")
        self.assertTrue(documento["revisado_automaticamente"])
        self.assertTrue(documento["envios"][-1]["automatico"])
        self.assertEqual(documento["envio_automatico"]["estado"], "enviado")
        # Mismo formato que el envío manual: Id fijo, alta nueva y bloque "Datos".
        interno = self.savedata.internos()[0]
        self.assertEqual((interno["Id"], interno["Actualizacion"]), ("m1__1", False))
        self.assertIn("Datos", interno)

        # Más ciclos (y un reinicio) no lo vuelven a enviar.
        self.extractor.ejecutar_ciclo()
        self.extractor = self._nuevo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)

        historial = historial_envios(self.almacen, EMAIL)[0]
        self.assertTrue(historial["ultimo"]["automatico"])
        self.assertEqual(historial["envio_automatico"]["estado"], "enviado")

    def test_envio_automatico_apagado_no_envia_nada(self) -> None:
        self.activar()
        self.correo()
        self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)
        self.assertEqual(self.savedata.recibidos, [])
        self.assertEqual(self.documento()["estado"], "borrador")
        self.assertIsNone(self.adjunto()["envio"])
        self.assertFalse(self.adjunto()["enviar_auto"])

    def test_solo_se_envia_lo_extraido_despues_de_encender_el_interruptor(self) -> None:
        self.activar()
        self.correo("antes")
        self.extractor.ejecutar_ciclo()
        self.encender_envio()
        self.correo("despues")
        self.extractor.ejecutar_ciclo()
        self.assertEqual([i["Id"] for i in self.savedata.internos()], ["despues__1"])
        self.assertEqual(self.documento("antes")["estado"], "borrador")

    def test_no_cuadra_con_la_proteccion_encendida_queda_requiere_revision(self) -> None:
        self.resultado_gemini(resumen={"saldo_inicial": "100.00", "saldo_final": "999.00", "dudosos": []})
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.savedata.recibidos, [])
        envio = self.envio()
        self.assertEqual(envio["estado"], "requiere_revision")
        self.assertIn("La validacion contable no cuadra.", envio["motivos"])
        self.assertEqual(self.documento()["estado"], "borrador")
        # Aparece en la página Envíos aunque no se envió.
        historial = historial_envios(self.almacen, EMAIL)[0]
        self.assertIsNone(historial["ultimo"])
        self.assertEqual(historial["envio_automatico"]["estado"], "requiere_revision")

    def test_importes_dudosos_cuentan_como_no_cuadra(self) -> None:
        resultado = _resultado()
        transacciones = [{**resultado["transacciones"][0], "dudosos": ["cargo"]}, resultado["transacciones"][1]]
        self.resultado_gemini(transacciones=transacciones)
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "requiere_revision")
        self.assertIn("1 importe(s) dudoso(s).", self.envio()["motivos"])
        self.assertEqual(self.savedata.recibidos, [])

    def test_sin_proteccion_se_envia_y_queda_marcado_con_los_problemas(self) -> None:
        self.resultado_gemini(resumen={"saldo_inicial": "100.00", "saldo_final": "999.00", "dudosos": []})
        self.activar()
        self.encender_envio(solo_si_cuadra=False)
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual(self.envio()["estado"], "enviado")
        self.assertIn("La validacion contable no cuadra.", self.envio()["problemas"])
        documento = self.documento()
        self.assertTrue(documento["revisado_con_problemas"])
        self.assertIn("La validacion contable no cuadra.", historial_envios(self.almacen, EMAIL)[0]["envio_automatico"]["problemas"])

    def test_campos_configurados_no_encontrados_van_como_null_y_no_detienen_el_envio(self) -> None:
        self.extractor.plantillas.efectiva = lambda email: [{"id": "rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento"}]  # type: ignore[method-assign]
        self.resultado_gemini(resultados_campos=[])
        self.extractor.envios.configurados = lambda email: [{"id": "rfc", "nombre": "RFC", "origen": "manual", "alcance": "documento"}]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "enviado")
        self.assertEqual(self.savedata.internos()[0]["Datos"], {"RFC": None})

    def test_documento_editado_por_el_usuario_no_se_envia_solo(self) -> None:
        self.savedata.respuestas = [ERROR]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "pendiente")
        # El usuario corrige el documento antes del siguiente ciclo.
        documento = self.documento()
        self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate({**documento, "version_base": documento["version"], "estado": "borrador"}))
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual(self.envio()["estado"], "omitido")

    def test_borrador_guardado_por_el_usuario_antes_del_envio_no_se_envia(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        original = self.extractor._enviar_auto

        def editar_y_enviar(email: str, message_id: str, part_id: str) -> Any:
            documento = self.documento(message_id)
            self.almacen.guardar(EMAIL, message_id, part_id, GuardarExtraccionRequest.model_validate({**documento, "version_base": documento["version"], "estado": "borrador"}))
            return original(email, message_id, part_id)
        with patch.object(self.extractor, "_enviar_auto", side_effect=editar_y_enviar):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.savedata.recibidos, [])
        self.assertEqual(self.envio()["estado"], "omitido")

    def test_documento_enviado_manualmente_no_se_envia_solo(self) -> None:
        self.savedata.respuestas = [ERROR]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        # El usuario lo envía a mano (con sucursal y artículo, como siempre).
        from backend.app.savedata import EnvioRequest
        self.extractor.envios.enviar(EMAIL, "m1", "1", EnvioRequest(version_base=self.documento()["version"], sucursal=3102, articulo="10000453"))
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 2)
        self.assertEqual(self.envio()["estado"], "omitido")

    def test_error_de_savedata_reintenta_en_ciclos_hasta_tres_veces(self) -> None:
        self.savedata.respuestas = [ERROR, ERROR, ERROR, EXITO]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.envio()["estado"], self.envio()["intentos"]), ("pendiente", 1))
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.envio()["estado"], self.envio()["intentos"]), ("pendiente", 2))
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.envio()["estado"], self.envio()["intentos"]), ("error", 3))
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 3)
        self.assertEqual(self.documento()["envio_automatico"]["estado"], "error")
        self.assertEqual(self.documento()["estado"], "revisado")

    def test_error_y_luego_exito_en_el_siguiente_ciclo(self) -> None:
        self.savedata.respuestas = [ERROR]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "enviado")
        self.assertEqual([i["Actualizacion"] for i in self.savedata.internos()], [False, False])

    def test_timeout_queda_incierto_sin_reintento(self) -> None:
        self.savedata.respuestas = [INCIERTO]
        self.activar()
        self.encender_envio()
        self.correo()
        self.extractor.ejecutar_ciclo()
        self.extractor.ejecutar_ciclo()
        self.extractor = self._nuevo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual(self.envio()["estado"], "incierto")

    def test_sin_savedata_url_extrae_pero_no_envia(self) -> None:
        self.activar()
        self.encender_envio()
        self.url = ""
        self.correo()
        self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)
        self.assertEqual(self.savedata.recibidos, [])
        self.assertEqual(self.envio()["estado"], "sin_savedata")
        self.assertFalse(self.extractor.estado(EMAIL)["savedata_configurada"])

    def test_no_se_puede_encender_sin_savedata_url(self) -> None:
        self.url = ""
        with self.assertRaises(ValueError):
            self.encender_envio()
        self.assertFalse(self.extractor.estado(EMAIL)["envio_activo"])

    def test_configuracion_predeterminada(self) -> None:
        estado = self.extractor.estado(EMAIL)
        self.assertEqual((estado["envio_activo"], estado["solo_si_cuadra"]), (False, True))


class ReinicioYConcurrencia(BaseEnvio):
    def test_reinicio_durante_el_envio_no_vuelve_a_enviar(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        self.savedata.caer = True
        with self.assertRaises(_Caida):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "en_curso")
        # Reinicio del backend: SaveData pudo haberlo recibido, así que no se reenvía.
        self.savedata.caer = False
        self.extractor = self._nuevo()
        self.extractor.ejecutar_ciclo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual(self.envio()["estado"], "incierto")

    def test_reinicio_antes_de_contactar_savedata_permite_enviarlo(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        with patch.object(ServicioEnvio, "enviar", side_effect=_Caida()):
            with self.assertRaises(_Caida):
                self.extractor.ejecutar_ciclo()
        self.assertEqual(self.envio()["estado"], "en_curso")
        self.extractor = self._nuevo()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual((self.envio()["estado"], self.envio()["intentos"]), ("enviado", 2))

    def test_ciclos_simultaneos_no_envian_dos_veces(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        self.savedata.espera = threading.Event()
        hilo = threading.Thread(target=self.extractor.ejecutar_ciclo)
        hilo.start()
        try:
            self.assertTrue(self.savedata.en_llamada.wait(5))
            # Otro ciclo en este proceso y otro "proceso" (otra instancia) mientras SaveData responde.
            self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "en_curso"})
            self.assertEqual(self._nuevo().ejecutar_ciclo(), {"resultado": "en_curso"})
        finally:
            self.savedata.espera.set()
            hilo.join(5)
        self.extractor.ejecutar_ciclo()
        self._nuevo().ejecutar_ciclo()
        self.assertEqual(len(self.savedata.recibidos), 1)
        self.assertEqual(self.envio()["estado"], "enviado")


class CuerpoSinSucursalNiArticulo(BaseEnvio):
    def test_el_cuerpo_es_identico_con_o_sin_sucursal_y_articulo(self) -> None:
        self.activar()
        self.correo()
        self.extractor.ejecutar_ciclo()
        documento = self.documento()
        con = preparar_envio(documento, sucursal=3102, articulo="10000453", carga_inicial=True)
        sin = preparar_envio(documento, sucursal=None, articulo=None, carga_inicial=False)  # type: ignore[arg-type]
        self.assertEqual(con["cuerpo"], sin["cuerpo"])
        self.assertNotIn("3102", con["cuerpo"])
        self.assertNotIn("10000453", con["cuerpo"])

    def test_el_envio_automatico_manda_el_mismo_cuerpo_que_la_vista_previa_manual(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo()
        captura: dict[str, str] = {}
        original = self.extractor.envios.enviar

        def antes_de_enviar(email: str, message_id: str, part_id: str, solicitud: Any) -> Any:
            captura["vista"] = self.extractor.envios.vista_previa(email, message_id, part_id, sucursal=3102, articulo="10000453", carga_inicial=False)["cuerpo"]
            return original(email, message_id, part_id, solicitud)
        with patch.object(self.extractor.envios, "enviar", side_effect=antes_de_enviar):
            self.extractor.ejecutar_ciclo()
        self.assertEqual(self.savedata.recibidos, [captura["vista"]])
        intento = self.documento()["envios"][-1]
        self.assertEqual((intento["sucursal"], intento["articulo"]), (None, None))


if __name__ == "__main__":
    unittest.main()
