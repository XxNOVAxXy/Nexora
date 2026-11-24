"""Fase 1: repositorio de envíos (formato de siempre) y eventos de lectura y diagnóstico separados."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.app import main
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest, cuenta_id
from backend.app.originales import AlmacenOriginales
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EnviosJson, EventosJson
from backend.app.savedata import EnvioRequest, RespuestaSaveData, ServicioEnvio
from backend.tests.pdf_ficticio import pdf_con_texto, pdf_protegido

EMAIL = "a@example.com"


class EspiaEnvios:
    def __init__(self, falla: bool = False) -> None:
        self.llamadas: list[tuple[str, str, str, list[dict[str, Any]]]] = []
        self.falla = falla

    def sincronizar(self, email: str, message_id: str, part_id: str, envios: list[dict[str, Any]]) -> None:
        self.llamadas.append((email, message_id, part_id, envios))
        if self.falla:
            raise RuntimeError("base caida")


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.almacen = AlmacenExtracciones(Path(self.tmp.name))
        self.respuestas = [RespuestaSaveData("exito", 200, '{"code":200}', "")]
        self.servicio = ServicioEnvio(self.almacen, lambda: "https://savedata.invalid/api", cliente=lambda _u, _c, _t: self.respuestas.pop(0))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def revisado(self) -> dict[str, Any]:
        return self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest(estado="revisado", filename="e.pdf", resumen={"banco": "Banco Ficticio"}, confirmar_problemas=True))

    def enviar(self, version: int) -> None:
        self.servicio.enviar(EMAIL, "m1", "1", EnvioRequest(version_base=version, sucursal=1, articulo="A"))


class EnviosJsonFormato(Base):
    def test_lee_los_envios_de_siempre_sin_cambiar_el_formato(self) -> None:
        documento = self.revisado()
        self.enviar(documento["version"])
        repo = EnviosJson(self.almacen)
        envios = repo.listar(EMAIL, "m1", "1")
        self.assertEqual(len(envios), 1)
        # Mismo intento que está en el JSON de la extracción, campo por campo.
        en_disco = json.loads((Path(self.tmp.name) / cuenta_id(EMAIL) / "m1__1.json").read_text(encoding="utf-8"))["envios"]
        self.assertEqual(envios, en_disco)
        self.assertEqual((envios[0]["accion"], envios[0]["resultado"], envios[0]["http_status"]), ("enviar", "exito", 200))
        # Sincronizar no escribe nada (los intentos ya están en el JSON).
        repo.sincronizar(EMAIL, "m1", "1", [{"id": "otro"}])
        self.assertEqual(repo.listar(EMAIL, "m1", "1"), en_disco)

    def test_documento_sin_extraccion_no_tiene_envios(self) -> None:
        self.assertEqual(EnviosJson(self.almacen).listar(EMAIL, "nada", "1"), [])


class SincronizacionDesdeElAlmacen(Base):
    def test_avisa_al_repositorio_solo_cuando_cambian_los_envios(self) -> None:
        espia = EspiaEnvios()
        self.almacen.envios = espia
        documento = self.revisado()
        self.assertEqual(espia.llamadas, [])  # guardar la extracción no toca los envíos
        self.enviar(documento["version"])
        # Inicio (en_curso) y fin (exito): la lista completa cada vez.
        self.assertEqual([[intento["resultado"] for intento in llamada[3]] for llamada in espia.llamadas], [["en_curso"], ["exito"]])
        self.assertEqual(espia.llamadas[-1][:3], (EMAIL, "m1", "1"))
        self.almacen.actualizar(EMAIL, "m1", "1", lambda actual: {**(actual or {}), "nota": "sin cambio en envios"})
        self.assertEqual(len(espia.llamadas), 2)

    def test_si_el_repositorio_falla_el_envio_queda_en_el_json(self) -> None:
        self.almacen.envios = EspiaEnvios(falla=True)
        documento = self.revisado()
        self.enviar(documento["version"])
        self.assertEqual(self.almacen.leer_completo(EMAIL, "m1", "1")["envios"][0]["resultado"], "exito")

    def test_main_usa_el_repositorio_json(self) -> None:
        self.assertIsInstance(main.almacen.envios, EnviosJson)


class EventosSeparados(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        raiz = Path(self.tmp.name)
        self.recepcion = ServicioRecepcion(DocumentosJson(raiz / "d"), EventosJson(raiz / "e"), AlmacenOriginales(raiz / "o"))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def etapas(self) -> list[tuple[str, str]]:
        return [(e["etapa"], e["codigo"]) for e in reversed(self.recepcion.eventos.listar(EMAIL))]

    def test_lectura_y_diagnostico_son_dos_eventos(self) -> None:
        self.recepcion.recibir(EMAIL, message_id="m1", part_id="1", data=pdf_con_texto(), mime_type="application/pdf", filename="a.pdf")
        self.recepcion.recibir(EMAIL, message_id="m2", part_id="1", data=pdf_protegido(), mime_type="application/pdf", filename="b.pdf")
        self.assertEqual(self.etapas(), [("lectura", "ok"), ("diagnostico", "ok"), ("lectura", "ok"), ("diagnostico", "pdf_protegido")])
        diagnostico = self.recepcion.eventos.listar(EMAIL, message_id="m1", etapa="diagnostico")[0]
        self.assertEqual(diagnostico["detalle"]["formato"], "pdf")
        lectura = self.recepcion.eventos.listar(EMAIL, message_id="m1", etapa="lectura")[0]
        self.assertTrue(lectura["detalle"]["original_guardado"])
        self.assertEqual(len(lectura["detalle"]["sha256"]), 64)

    def test_si_no_se_guarda_el_original_la_lectura_lo_dice(self) -> None:
        with patch.object(self.recepcion.originales, "guardar", side_effect=OSError("disco lleno")):
            self.recepcion.recibir(EMAIL, message_id="m1", part_id="1", data=pdf_con_texto(), mime_type="application/pdf", filename="a.pdf")
        self.assertEqual(self.etapas(), [("lectura", "original_no_guardado"), ("diagnostico", "ok")])

    def test_filtro_por_etapa_diagnostico_en_la_api(self) -> None:
        from fastapi.testclient import TestClient

        main.recepcion.recibir(EMAIL, message_id="m1", part_id="1", data=pdf_protegido(), mime_type="application/pdf", filename="b.pdf")
        with patch.object(main, "_cuenta_actual", return_value=EMAIL):
            respuesta = TestClient(main.app).get("/api/eventos", params={"etapa": "diagnostico"})
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual([e["codigo"] for e in respuesta.json()["eventos"]], ["pdf_protegido"])


if __name__ == "__main__":
    unittest.main()
