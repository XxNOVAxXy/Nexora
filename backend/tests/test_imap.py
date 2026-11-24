"""Fase 5: cuentas IMAP corporativas con un servidor IMAP SIMULADO (nunca uno real).

El servidor falso habla como ``imaplib`` (login, select, uid search/fetch, response); los correos son ficticios
con PDFs generados aquí. Contraseñas cifradas con Fernet; se revisa que nunca aparezcan en logs ni respuestas.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import imaplib
import sqlalchemy as sa
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.automatico import ExtractorAutomatico
from backend.app.cuentas_imap import CuentaImapRequest, CuentasImapDb, CuentasImapJson
from backend.app.db import Base, CuentaCorreo, Documento, crear_motor, fabrica_sesiones
from backend.app.extracciones import AlmacenExtracciones
from backend.app.imap import ClienteImap, DatosCuentaImap, ImapError, ImapSinConexion, es_id_imap, validar_config
from backend.app.originales import AlmacenOriginales
from backend.app.plantilla_campos import AlmacenPlantillas
from backend.app.recepcion import ServicioRecepcion
from backend.app.repos import DocumentosJson, EventosJson
from backend.app.repos.db import CuentasDb, DocumentosDb, EventosDb
from backend.app.seguridad import Cifrador, LlaveCifradoInvalida
from backend.app.tipos_documento import AlmacenTipos, TipoRequest
from backend.tests.test_automatico import GeminiFalso
from backend.tests.test_reglas_sin_ia import LINEAS_AUTO, campos_auto, pdf_auto

CORREO = "polizas@empresa-ficticia.test"
CONTRASENA = "Contrasena-Ficticia-123"
LLAVE = Fernet.generate_key().decode()
INICIO = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
PUBLICO = lambda _host, _puerto: ["93.184.216.34"]  # noqa: E731  (una dirección pública; nunca se conecta: el servidor es simulado)


def correo_ficticio(asunto: str, fecha: datetime, adjunto: bytes | None, nombre: str = "poliza.pdf") -> bytes:
    mensaje = EmailMessage()
    mensaje["From"] = "Aseguradora Ficticia <envios@aseguradora-ficticia.test>"
    mensaje["To"] = CORREO
    mensaje["Subject"] = asunto
    mensaje["Date"] = format_datetime(fecha)
    mensaje.set_content("Correo ficticio para pruebas.")
    if adjunto is not None:
        mensaje.add_attachment(adjunto, maintype="application", subtype="pdf", filename=nombre)
    return mensaje.as_bytes()


class ServidorImapFalso:
    """Lo mínimo de ``imaplib.IMAP4`` que usa ClienteImap."""

    def __init__(self) -> None:
        self.mensajes: dict[int, bytes] = {}
        self.uidvalidity = 777
        self.logins: list[tuple[str, str]] = []
        self.busquedas: list[str] = []
        self.rechazar_login = False
        self.caido = False

    def conectar(self, host: str, puerto: int, seguridad: str) -> "ServidorImapFalso":
        if self.caido:
            raise OSError("conexion rechazada")
        self.ultimo = (host, puerto, seguridad)
        return self

    def login(self, usuario: str, contrasena: str) -> tuple[str, list[bytes]]:
        self.logins.append((usuario, contrasena))
        if self.rechazar_login or contrasena != CONTRASENA:
            raise imaplib.IMAP4.error(f"[AUTHENTICATIONFAILED] usuario {usuario}")
        return "OK", [b"LOGIN completed"]

    def select(self, carpeta: str, readonly: bool = False) -> tuple[str, list[bytes]]:
        return "OK", [str(len(self.mensajes)).encode()]

    def response(self, codigo: str) -> tuple[str, list[bytes]]:
        return (codigo, [str(self.uidvalidity).encode()]) if codigo == "UIDVALIDITY" else (codigo, [None])

    def uid(self, comando: str, *args: Any) -> tuple[str, list[Any]]:
        if comando == "search":
            self.busquedas.append(" ".join(str(a) for a in args if a))
            return "OK", [" ".join(str(uid) for uid in sorted(self.mensajes)).encode()]
        if comando == "fetch":
            crudo = self.mensajes.get(int(args[0]))
            return ("OK", [(b"1 (RFC822 {%d}" % len(crudo), crudo), b")"]) if crudo else ("OK", [None])
        raise AssertionError(comando)

    def logout(self) -> None:
        return None


def datos(servidor: str = "imap.empresa-ficticia.test", seguridad: str = "ssl", contrasena: str = CONTRASENA, cuenta_id: str = "1") -> DatosCuentaImap:
    return DatosCuentaImap(id=cuenta_id, correo=CORREO, servidor=servidor, puerto=993, seguridad=seguridad, usuario="polizas", contrasena=contrasena)


class Cliente(unittest.TestCase):
    def setUp(self) -> None:
        self.servidor = ServidorImapFalso()
        self.servidor.mensajes[41] = correo_ficticio("Envio de poliza de automovil", INICIO, pdf_auto())
        self.servidor.mensajes[42] = correo_ficticio("Boletin", INICIO + timedelta(hours=1), None)
        self.cliente = ClienteImap(datos(), conectar=self.servidor.conectar, resolver=PUBLICO)

    def test_misma_interfaz_que_gmail(self) -> None:
        self.assertEqual(self.cliente.profile(), {"email": CORREO})
        ids = self.cliente.buscar_ids(f"in:inbox after:{int(INICIO.timestamp())}", 10)
        self.assertEqual(ids, ["imap1.777.42", "imap1.777.41"])
        self.assertTrue(all(es_id_imap(valor) for valor in ids))
        self.assertEqual(self.servidor.busquedas[-1], "SINCE 20-Nov-2026")
        mensaje = self.cliente.get_message("imap1.777.41")
        self.assertEqual((mensaje["subject"], mensaje["receivedAt"]), ("Envio de poliza de automovil", "2026-11-20T12:00:00+00:00"))
        self.assertIn("envios@aseguradora-ficticia.test", mensaje["senderEmail"])
        [adjunto] = mensaje["attachments"]
        self.assertEqual((adjunto["filename"], adjunto["mimeType"]), ("poliza.pdf", "application/pdf"))
        data, mime, nombre = self.cliente.attachment("imap1.777.41", adjunto["id"])
        self.assertEqual((data[:5], mime, nombre), (b"%PDF-", "application/pdf", "poliza.pdf"))
        self.assertEqual(self.servidor.ultimo, ("imap.empresa-ficticia.test", 993, "ssl"))

    def test_probar_conexion(self) -> None:
        self.assertEqual(self.cliente.probar()["mensajes"], 2)

    def test_contrasena_incorrecta_sin_repetirla(self) -> None:
        cliente = ClienteImap(datos(contrasena="otra-ficticia"), conectar=self.servidor.conectar, resolver=PUBLICO)
        with self.assertRaises(ImapSinConexion) as capturado:
            cliente.probar()
        self.assertEqual(str(capturado.exception), "El servidor IMAP rechazo el usuario o la contrasena.")
        self.assertNotIn("otra-ficticia", str(capturado.exception))
        self.assertNotIn("otra-ficticia", repr(datos(contrasena="otra-ficticia")))

    def test_sin_conexion_es_como_gmail_no_conectado(self) -> None:
        self.servidor.caido = True
        with self.assertRaises(ImapSinConexion):
            self.cliente.buscar_ids("after:0")

    def test_uidvalidity_distinto(self) -> None:
        self.servidor.uidvalidity = 778
        with self.assertRaises(ImapError):
            self.cliente.get_message("imap1.777.41")

    def test_validacion_del_servidor(self) -> None:
        with self.assertRaisesRegex(ImapError, "nombre de host"):
            validar_config("https://imap.empresa.test", 993, "ssl", resolver=PUBLICO)
        with self.assertRaisesRegex(ImapError, "red privada"):
            validar_config("imap.interno.test", 993, "ssl", resolver=lambda *_: ["10.0.0.5"])
        with patch.dict(os.environ, {"NEXORA_IMAP_HOSTS_PERMITIDOS": "imap.interno.test"}):
            self.assertEqual(validar_config("imap.interno.test", 993, "starttls", resolver=lambda *_: ["10.0.0.5"]), "imap.interno.test")
        with self.assertRaisesRegex(ImapError, "sin cifrado"):
            validar_config("imap.empresa.test", 143, "ninguna", resolver=PUBLICO)
        with self.assertRaisesRegex(ImapError, "puerto"):
            validar_config("imap.empresa.test", 0, "ssl", resolver=PUBLICO)


def solicitud(**cambios: Any) -> CuentaImapRequest:
    return CuentaImapRequest(**{"correo": CORREO, "servidor": "imap.empresa-ficticia.test", "puerto": 993, "seguridad": "ssl", "usuario": "polizas", "contrasena": CONTRASENA, **cambios})


class Almacen(unittest.TestCase):
    def test_json_cifra_la_contrasena(self) -> None:
        with tempfile.TemporaryDirectory() as directorio:
            ruta = Path(directorio) / "imap" / "cuentas.json"
            cuentas = CuentasImapJson(ruta, lambda: Cifrador(LLAVE))
            publica = cuentas.agregar(solicitud())
            self.assertNotIn("contrasena", publica)
            self.assertNotIn(CONTRASENA, ruta.read_text(encoding="utf-8"))
            self.assertEqual([c["correo"] for c in cuentas.listar()], [CORREO])
            self.assertNotIn(CONTRASENA, json.dumps(cuentas.listar()))
            self.assertEqual(cuentas.privada(publica["id"]).contrasena, CONTRASENA)
            with self.assertRaises(ValueError):
                cuentas.agregar(solicitud())
            self.assertTrue(cuentas.desactivar(publica["id"]))
            self.assertEqual(cuentas.listar(), [])

    def test_json_sin_llave_da_error_claro(self) -> None:
        with tempfile.TemporaryDirectory() as directorio:
            cuentas = CuentasImapJson(Path(directorio) / "c.json", lambda: Cifrador(""))
            with self.assertRaisesRegex(LlaveCifradoInvalida, "NEXORA_LLAVE_CIFRADO"):
                cuentas.agregar(solicitud())

    def test_db_en_cuentas_correo(self) -> None:
        motor = crear_motor("sqlite://")
        Base.metadata.create_all(motor)
        try:
            cuentas = CuentasImapDb(fabrica_sesiones(motor), Cifrador(LLAVE))
            publica = cuentas.agregar(solicitud(seguridad="starttls", puerto=143))
            with motor.connect() as conexion:
                fila = conexion.execute(sa.select(CuentaCorreo)).one()
            self.assertEqual((fila.proveedor, fila.correo, fila.servidor_imap, fila.puerto_imap), ("imap", CORREO, "imap.empresa-ficticia.test", 143))
            self.assertNotIn(CONTRASENA, fila.credencial_cifrada)
            self.assertEqual(json.loads(Cifrador(LLAVE).descifrar(fila.credencial_cifrada))["seguridad"], "starttls")
            self.assertEqual((publica["seguridad"], cuentas.privada(publica["id"]).contrasena), ("starttls", CONTRASENA))
            self.assertTrue(cuentas.desactivar(publica["id"]))
            self.assertEqual(cuentas.listar(), [])
        finally:
            motor.dispose()


class CicloImap:
    """El ciclo automático de siempre, leyendo de IMAP (modo manual, reglas sin IA). Subclases: json y db."""

    def armar(self, recepcion: ServicioRecepcion) -> None:
        self.modo = patch.dict(os.environ, {"NEXORA_MODO_PREDETERMINADO": "manual"})
        self.modo.start()
        self.addCleanup(self.modo.stop)
        self.ahora = INICIO + timedelta(days=1)
        self.recepcion = recepcion
        self.servidor = ServidorImapFalso()
        self.cliente = ClienteImap(datos(), conectar=self.servidor.conectar, resolver=PUBLICO)
        self.gemini = GeminiFalso()
        self.almacen = AlmacenExtracciones(self.raiz / "extracciones")
        plantillas = AlmacenPlantillas(self.raiz / "plantillas")
        tipos = AlmacenTipos(self.raiz / "tipos", plantillas)
        autos = next(tipo for tipo in tipos.leer(CORREO) if tipo["codigo"] == "A")
        tipos.guardar_tipo(CORREO, TipoRequest.model_validate({**autos, "campos": campos_auto(), "seccion": {"nombre": "Coberturas"}}), autos["id"])
        self.extractor = ExtractorAutomatico(self.raiz / "automatico", self.cliente, self.gemini, self.almacen, reloj=lambda: self.ahora, recepcion=recepcion,
                                             plantillas=plantillas, tipos=tipos)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(CORREO, True)

    def llega(self, uid: int, adjunto: bytes | None, asunto: str = "Envio de poliza de automovil") -> None:
        self.servidor.mensajes[uid] = correo_ficticio(asunto, self.ahora + timedelta(minutes=uid), adjunto)

    def test_extrae_lo_que_llega_por_imap(self) -> None:
        self.llega(1, pdf_auto())
        self.llega(2, pdf_auto([l for l in LINEAS_AUTO if not l.startswith("Placas")]))
        self.ahora += timedelta(hours=1)
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["correos_encontrados"], resumen["extraidos"]), (2, 2))
        self.assertEqual(self.recepcion.estado(self.recepcion.documentos.obtener(CORREO, "imap1.777.1", "2")), ("extraido", None))
        self.assertEqual(self.recepcion.estado(self.recepcion.documentos.obtener(CORREO, "imap1.777.2", "2")), ("requiere_revision", "campos_faltantes"))
        self.assertEqual(self.gemini.llamadas, [])

    def test_sin_conexion_no_gasta_intentos_y_se_reintenta(self) -> None:
        self.llega(1, pdf_auto())
        self.ahora += timedelta(hours=1)
        self.servidor.caido = True
        self.assertEqual(self.extractor.ejecutar_ciclo()["resultado"], "error")
        self.servidor.caido = False
        self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)


class CicloImapJson(CicloImap, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.armar(ServicioRecepcion(DocumentosJson(self.raiz / "d"), EventosJson(self.raiz / "e"), AlmacenOriginales(self.raiz / "o")))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()


class CicloImapDb(CicloImap, unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        self.motor = crear_motor("sqlite://")
        Base.metadata.create_all(self.motor)
        self.sesiones = fabrica_sesiones(self.motor)
        cuentas = CuentasDb(self.sesiones, Cifrador(LLAVE))
        # La cuenta IMAP ya registrada (como al agregarla en la pantalla): sus documentos se ligan a ella.
        CuentasImapDb(self.sesiones, Cifrador(LLAVE)).agregar(solicitud())
        self.armar(ServicioRecepcion(DocumentosDb(self.sesiones, cuentas), EventosDb(self.sesiones, cuentas), AlmacenOriginales(self.raiz / "o")))

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.motor.dispose()
        self.tmp.cleanup()

    def test_documento_ligado_a_la_cuenta_imap(self) -> None:
        self.llega(1, pdf_auto())
        self.ahora += timedelta(hours=1)
        self.extractor.ejecutar_ciclo()
        with self.sesiones() as sesion:
            documento = sesion.scalars(sa.select(Documento)).one()
            proveedor = sesion.scalars(sa.select(CuentaCorreo.proveedor).where(CuentaCorreo.id == documento.cuenta_id)).one()
        self.assertEqual((documento.message_id, proveedor), ("imap1.777.1", "imap"))


class Api(unittest.TestCase):
    """Endpoints con el main real; las cuentas IMAP en un archivo temporal y el servidor IMAP simulado."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.servidor = ServidorImapFalso()
        self.servidor.mensajes[5] = correo_ficticio("Envio de poliza de automovil", INICIO, pdf_auto())
        cuentas = CuentasImapJson(Path(self.tmp.name) / "imap.json", lambda: Cifrador(LLAVE))
        self.parches = [
            patch.object(main.repositorios, "cuentas_imap", cuentas),
            patch.object(main, "gestor_imap", main.GestorImap()),
            patch("backend.app.imap.conectar_imaplib", self.servidor.conectar),
            patch("backend.app.imap._resolver", PUBLICO),
            patch.object(ClienteImap.__init__, "__defaults__", (self.servidor.conectar, PUBLICO)),
            patch.object(main, "_cuenta_actual", side_effect=main.HTTPException(status_code=401, detail="sin Gmail")),
        ]
        for parche in self.parches:
            parche.start()
        self.api = TestClient(main.app)
        self.cuerpo = {"correo": CORREO, "servidor": "imap.empresa-ficticia.test", "puerto": 993, "seguridad": "ssl", "usuario": "polizas", "contrasena": CONTRASENA}

    def tearDown(self) -> None:
        main.gestor_imap.detener()
        for parche in reversed(self.parches):
            parche.stop()
        self.tmp.cleanup()

    def test_probar_agregar_listar_revisar_y_bandeja(self) -> None:
        with self.assertLogs("nexora", level=logging.DEBUG) as registros:
            self.assertEqual(self.api.post("/api/imap/probar", json=self.cuerpo).json()["mensajes"], 1)
            malo = self.api.post("/api/imap/probar", json={**self.cuerpo, "contrasena": "equivocada-ficticia"})
            self.assertEqual(malo.status_code, 422)
            self.assertNotIn("equivocada-ficticia", malo.text)
            creada = self.api.post("/api/imap/cuentas", json=self.cuerpo)
            self.assertEqual(creada.status_code, 200)
            cuenta = creada.json()["cuenta"]
            self.assertNotIn("contrasena", cuenta)
            listado = self.api.get("/api/imap/cuentas").json()["cuentas"]
            self.assertEqual([c["correo"] for c in listado], [CORREO])
            self.assertFalse(listado[0]["automatico"]["activo"])
            self.assertEqual(self.api.post(f"/api/imap/cuentas/{cuenta['id']}/revisar").status_code, 200)
            # Los mensajes IMAP se leen por las mismas rutas que los de Gmail.
            mensaje = self.api.get("/api/gmail/messages/imap1.777.5").json()
            self.assertEqual(mensaje["subject"], "Envio de poliza de automovil")
            adjunto = self.api.get(f"/api/gmail/messages/imap1.777.5/attachments/{mensaje['attachments'][0]['id']}")
            self.assertTrue(adjunto.content.startswith(b"%PDF-"))
            # La bandeja junta las cuentas aunque Gmail no esté conectado.
            self.assertEqual(self.api.get("/api/bandeja").status_code, 200)
        self.assertNotIn(CONTRASENA, "\n".join(registros.output))
        self.assertNotIn(CONTRASENA, json.dumps(self.api.get("/api/imap/cuentas").json()))

    def test_error_de_validacion_no_repite_la_contrasena(self) -> None:
        respuesta = self.api.post("/api/imap/probar", json={**self.cuerpo, "puerto": 0})
        self.assertEqual(respuesta.status_code, 422)
        self.assertNotIn(CONTRASENA, respuesta.text)

    def test_no_guarda_si_no_conecta(self) -> None:
        respuesta = self.api.post("/api/imap/cuentas", json={**self.cuerpo, "contrasena": "equivocada-ficticia"})
        self.assertEqual(respuesta.status_code, 422)
        self.assertEqual(self.api.get("/api/imap/cuentas").json()["cuentas"], [])

    def test_quitar(self) -> None:
        cuenta = self.api.post("/api/imap/cuentas", json=self.cuerpo).json()["cuenta"]
        self.assertEqual(self.api.delete(f"/api/imap/cuentas/{cuenta['id']}").status_code, 200)
        self.assertEqual(self.api.get("/api/imap/cuentas").json()["cuentas"], [])
        self.assertEqual(self.api.get("/api/gmail/messages/imap1.777.5").status_code, 404)


if __name__ == "__main__":
    unittest.main()
