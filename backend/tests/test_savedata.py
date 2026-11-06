"""Pruebas del envío a SaveData contra un servidor simulado local (nunca contra el servidor real)."""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import time
import unittest
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import urlparse

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.extracciones import AlmacenExtracciones
from backend.app.savedata import SaveDataConfig, ServicioEnvio, TotalesEnvio, construir_saldos, enviar_a_savedata, serializar_cuerpo

EJEMPLO_INTERNO = '{"CargaInicial": false, "Saldos": [{"Sucursal": 3102, "Articulo": "10000453", "Saldo": 10.0, "Clave": "H"}, {"Sucursal": 3102, "Articulo": "10000453", "Saldo": 2.0, "Clave": "S"}]}'
RESPUESTA_EXITO = {"code": 200, "message": "Exito", "data": []}


def cliente_solo_local(url: str, cuerpo: str, timeout: float):
    """Candado: estas pruebas solo pueden hablar con el servidor simulado en 127.0.0.1."""
    if urlparse(url).hostname != "127.0.0.1":
        raise AssertionError(f"Prueba intento contactar un host no local: {url}")
    return enviar_a_savedata(url, cuerpo, timeout)


class ServidorSimulado:
    def __init__(self) -> None:
        self.status = 200
        self.cuerpo: bytes = json.dumps(RESPUESTA_EXITO).encode()
        self.demora = 0.0
        self.recibidos: list[dict[str, Any]] = []
        servidor = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                datos = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                servidor.recibidos.append({"ruta": self.path, "cuerpo": datos, "content_type": self.headers.get("Content-Type")})
                if servidor.demora:
                    time.sleep(servidor.demora)
                try:
                    self.send_response(servidor.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(servidor.cuerpo)))
                    self.end_headers()
                    self.wfile.write(servidor.cuerpo)
                except OSError:
                    pass  # el cliente ya cortó por timeout

            def log_message(self, *args: Any) -> None:
                pass

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}/V3/Pruebas/SaveData"
        self.hilo = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.hilo.start()

    def cerrar(self) -> None:
        self.http.shutdown()
        self.http.server_close()


def puerto_cerrado() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        puerto = sock.getsockname()[1]
    return f"http://127.0.0.1:{puerto}/V3/Pruebas/SaveData"


TRANSACCIONES = [
    {"id": "t1", "fecha": "02/10", "concepto": "DEPOSITO", "referencia": "", "cargo": "", "abono": "10.00", "saldo": "", "origen": "ia", "dudosos": []},
    {"id": "t2", "fecha": "05/10", "concepto": "COMISION", "referencia": "", "cargo": "2.00", "abono": "", "saldo": "", "origen": "manual", "dudosos": []},
]
RESUMEN = {"saldo_inicial": "100.00", "total_cargos": "2.00", "total_abonos": "10.00", "saldo_final": "108.00"}


class SerializacionTests(unittest.TestCase):
    def test_serializacion_exacta_como_el_ejemplo(self) -> None:
        interno = construir_saldos(TotalesEnvio(abonos=Decimal("10.00"), cargos=Decimal("2.00")), 3102, "10000453", False)
        self.assertEqual(json.dumps(interno), EJEMPLO_INTERNO)
        self.assertEqual(serializar_cuerpo(interno), json.dumps({"data": EJEMPLO_INTERNO}))
        self.assertEqual(json.loads(json.loads(serializar_cuerpo(interno))["data"]), json.loads(EJEMPLO_INTERNO))

    def test_total_cero_y_varios_articulos_solo_cambian_construir_saldos(self) -> None:
        interno = construir_saldos(TotalesEnvio(abonos=Decimal("0.00"), cargos=Decimal("1234.56")), 7, ["A1", "A2"], True)
        self.assertTrue(interno["CargaInicial"])
        self.assertEqual([(s["Articulo"], s["Clave"], s["Saldo"]) for s in interno["Saldos"]], [("A1", "H", 0.0), ("A1", "S", 1234.56), ("A2", "H", 0.0), ("A2", "S", 1234.56)])
        self.assertIn('"Saldo": 0.0', json.dumps(interno))


class EnvioTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        self.servidor = ServidorSimulado()
        self.addCleanup(self.servidor.cerrar)
        self.url = self.servidor.url
        almacen = AlmacenExtracciones(Path(self.directorio.name, "extracciones"))
        self.servicio = ServicioEnvio(almacen, lambda: self.url, timeout=5, cliente=cliente_solo_local)
        for nombre, valor in {"almacen": almacen, "envios": self.servicio, "savedata_config": SaveDataConfig(Path(self.directorio.name, "savedata.json"))}.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        perfil = patch.object(main.gmail, "profile", return_value={"email": "a@example.com"})
        perfil.start()
        self.addCleanup(perfil.stop)
        self.api = TestClient(main.app)

    # -- utilidades --
    def guardar(self, estado: str = "revisado", version_base: int | None = None, **cambios: Any) -> dict[str, Any]:
        cuerpo = {"version_base": version_base, "estado": estado, "confirmar_problemas": True, "resumen": RESUMEN, "transacciones": TRANSACCIONES, "filename": "estado.pdf", **cambios}
        respuesta = self.api.put("/api/extracciones/m1/1", json=cuerpo)
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        return respuesta.json()

    def enviar(self, version: int, **cambios: Any):
        return self.api.post("/api/extracciones/m1/1/enviar", json={"version_base": version, "sucursal": 3102, "articulo": "10000453", "carga_inicial": False, **cambios})

    def documento(self) -> dict[str, Any]:
        return self.api.get("/api/extracciones/m1/1").json()

    # -- casos --
    def test_exito_cambia_a_enviado_y_audita_cuerpo_y_respuesta(self) -> None:
        version = self.guardar()["version"]
        respuesta = self.enviar(version)
        self.assertEqual(respuesta.status_code, 200, respuesta.text)
        self.assertEqual(len(self.servidor.recibidos), 1)
        recibido = self.servidor.recibidos[0]
        self.assertEqual(recibido["cuerpo"].decode(), json.dumps({"data": EJEMPLO_INTERNO}))
        self.assertEqual(recibido["content_type"], "application/json")
        self.assertEqual(recibido["ruta"], "/V3/Pruebas/SaveData")
        documento = self.documento()
        self.assertEqual(documento["estado"], "enviado")
        self.assertIsNotNone(documento["enviado_en"])
        intento = documento["envios"][0]
        self.assertEqual((intento["resultado"], intento["http_status"], intento["error"]), ("exito", 200, None))
        self.assertEqual(intento["cuerpo"], json.dumps({"data": EJEMPLO_INTERNO}))
        self.assertEqual(json.loads(intento["respuesta"]), RESPUESTA_EXITO)
        self.assertEqual(intento["version_extraccion"], version)
        self.assertEqual(documento["version"], version)  # enviar no altera el contenido ni su versión

    def test_http_200_con_code_distinto_de_200_es_error(self) -> None:
        self.servidor.cuerpo = json.dumps({"code": 500, "message": "Articulo inexistente", "data": []}).encode()
        respuesta = self.enviar(self.guardar()["version"])
        self.assertEqual(respuesta.status_code, 502)
        self.assertEqual(respuesta.json()["detail"]["code"], "savedata_error")
        self.assertIn("Articulo inexistente", respuesta.json()["detail"]["message"])
        documento = self.documento()
        self.assertEqual(documento["estado"], "revisado")
        self.assertIsNone(documento["enviado_en"])
        self.assertEqual(documento["envios"][0]["resultado"], "error")
        self.assertIn("Articulo inexistente", documento["envios"][0]["respuesta"])

    def test_http_500_y_respuesta_no_json_son_error(self) -> None:
        version = self.guardar()["version"]
        self.servidor.status = 500
        self.assertEqual(self.enviar(version).status_code, 502)
        self.servidor.status, self.servidor.cuerpo = 200, b"<html>ok</html>"
        segundo = self.enviar(version)  # un error claro no exige confirmar el reenvío
        self.assertEqual(segundo.status_code, 502)
        self.assertIn("no es JSON", segundo.json()["detail"]["message"])
        self.assertEqual([i["resultado"] for i in self.documento()["envios"]], ["error", "error"])
        self.assertEqual(self.documento()["estado"], "revisado")

    def test_error_de_red_no_deja_estado_inconsistente(self) -> None:
        version = self.guardar()["version"]
        self.url = puerto_cerrado()
        respuesta = self.enviar(version)
        self.assertEqual(respuesta.status_code, 502)
        self.assertEqual(respuesta.json()["detail"]["code"], "savedata_error")
        documento = self.documento()
        self.assertEqual(documento["estado"], "revisado")
        self.assertEqual(documento["envios"][0]["resultado"], "error")
        self.assertNotIn("en_curso", [i["resultado"] for i in documento["envios"]])
        # La reserva se liberó: se puede editar y volver a enviar.
        self.url = self.servidor.url
        self.assertEqual(self.enviar(version).status_code, 200)

    def test_timeout_queda_incierto_y_exige_confirmar_reenvio(self) -> None:
        self.servicio.timeout = 0.5
        self.servidor.demora = 2
        version = self.guardar()["version"]
        respuesta = self.enviar(version)
        self.assertEqual(respuesta.status_code, 502)
        self.assertEqual(respuesta.json()["detail"]["code"], "savedata_incierto")
        self.assertEqual(self.documento()["estado"], "revisado")
        self.assertEqual(self.documento()["envios"][0]["resultado"], "incierto")
        self.servidor.demora = 0
        sin_confirmar = self.enviar(version)
        self.assertEqual(sin_confirmar.status_code, 409)
        self.assertEqual(sin_confirmar.json()["detail"]["code"], "requiere_confirmar_reenvio")
        self.assertEqual(self.enviar(version, confirmar_reenvio=True).status_code, 200)

    def test_rechaza_si_no_esta_revisado_sin_contactar_savedata(self) -> None:
        version = self.guardar(estado="borrador")["version"]
        respuesta = self.enviar(version)
        self.assertEqual(respuesta.status_code, 409)
        self.assertEqual(respuesta.json()["detail"]["code"], "no_revisado")
        self.assertEqual(self.servidor.recibidos, [])
        self.assertEqual(self.documento()["envios"], [])

    def test_reenvio_exige_confirmacion_explicita(self) -> None:
        version = self.guardar()["version"]
        self.assertEqual(self.enviar(version).status_code, 200)
        repetido = self.enviar(version)
        self.assertEqual(repetido.status_code, 409)
        self.assertEqual(repetido.json()["detail"]["code"], "requiere_confirmar_reenvio")
        self.assertEqual(repetido.json()["detail"]["envio_previo"]["resultado"], "exito")
        self.assertEqual(len(self.servidor.recibidos), 1)
        reenvio = self.enviar(version, confirmar_reenvio=True)
        self.assertEqual(reenvio.status_code, 200)
        self.assertEqual([i["reenvio"] for i in self.documento()["envios"]], [False, True])

    def test_editar_despues_de_enviar_vuelve_a_borrador_y_conserva_historial(self) -> None:
        version = self.guardar()["version"]
        self.enviar(version)
        enviado_en = self.documento()["enviado_en"]
        editado = self.guardar(estado="borrador", version_base=version, transacciones=TRANSACCIONES[:1])
        self.assertEqual((editado["estado"], editado["enviado_en"], len(editado["envios"])), ("borrador", enviado_en, 1))
        self.assertEqual(self.enviar(editado["version"]).json()["detail"]["code"], "no_revisado")
        revisado = self.guardar(version_base=editado["version"], transacciones=TRANSACCIONES[:1])
        self.assertEqual(self.enviar(revisado["version"]).json()["detail"]["code"], "requiere_confirmar_reenvio")

    def test_version_vieja_y_envio_en_curso_bloquean(self) -> None:
        version = self.guardar()["version"]
        self.assertEqual(self.enviar(version + 5).json()["detail"]["code"], "conflicto_version")
        reserva = main.almacen.reservar_envio("a@example.com", "m1", "1")
        try:
            self.assertEqual(self.enviar(version).json()["detail"]["code"], "envio_en_curso")
            editar = self.api.put("/api/extracciones/m1/1", json={"version_base": version, "estado": "borrador", "transacciones": []})
            self.assertEqual(editar.status_code, 409)
        finally:
            main.almacen.liberar_envio(reserva)

    def test_caida_a_mitad_del_envio_deja_en_curso_y_exige_confirmacion(self) -> None:
        version = self.guardar()["version"]
        self.servicio.cliente = lambda *_: (_ for _ in ()).throw(RuntimeError("proceso interrumpido"))
        with self.assertRaises(RuntimeError):
            self.servicio.enviar("a@example.com", "m1", "1", main.EnvioRequest(version_base=version, sucursal=3102, articulo="10000453"))
        self.assertEqual(self.documento()["envios"][0]["resultado"], "en_curso")
        self.servicio.cliente = cliente_solo_local
        self.assertEqual(self.enviar(version).json()["detail"]["code"], "requiere_confirmar_reenvio")

    def test_importes_invalidos_impiden_enviar(self) -> None:
        version = self.guardar(transacciones=[{**TRANSACCIONES[1], "cargo": "1,234", "dudosos": ["cargo"]}])["version"]
        respuesta = self.enviar(version)
        self.assertEqual(respuesta.status_code, 422)
        self.assertEqual(respuesta.json()["detail"]["code"], "importes_invalidos")
        self.assertEqual(self.servidor.recibidos, [])

    def test_vista_previa_muestra_cuerpo_exacto_sin_contactar_savedata(self) -> None:
        self.guardar(estado="borrador")
        previa = self.api.post("/api/extracciones/m1/1/enviar/vista-previa", json={"sucursal": 3102, "articulo": "10000453"}).json()
        self.assertEqual(previa["cuerpo"], json.dumps({"data": EJEMPLO_INTERNO}))
        self.assertEqual(previa["totales"], {"abonos": "10.00", "cargos": "2.00"})
        self.assertFalse(previa["puede_enviar"])
        self.assertTrue(any("revisado" in motivo for motivo in previa["motivos"]))
        self.assertEqual(self.servidor.recibidos, [])

    def test_sin_url_configurada_responde_503(self) -> None:
        self.url = ""
        self.assertEqual(self.enviar(self.guardar()["version"]).status_code, 503)
        self.assertEqual(self.servidor.recibidos, [])

    def test_sucursal_predeterminada_en_el_backend(self) -> None:
        self.assertIsNone(self.api.get("/api/savedata/config").json()["sucursal_predeterminada"])
        self.assertEqual(self.api.put("/api/savedata/config", json={"sucursal_predeterminada": 3102}).json()["sucursal_predeterminada"], 3102)
        self.assertEqual(self.api.get("/api/savedata/config").json()["sucursal_predeterminada"], 3102)
        self.assertEqual(self.api.put("/api/savedata/config", json={"sucursal_predeterminada": 0}).status_code, 422)


class ConfiguracionRealTests(unittest.TestCase):
    def test_el_servicio_real_lee_savedata_url_y_las_pruebas_nunca_lo_usan(self) -> None:
        # Documenta la protección: las pruebas sustituyen main.envios por un servicio apuntando a 127.0.0.1.
        with self.assertRaises(AssertionError):
            cliente_solo_local("http://192.168.50.212/V3/Pruebas/SaveData", "{}", 1)


if __name__ == "__main__":
    unittest.main()
