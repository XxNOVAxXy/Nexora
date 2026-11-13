"""Extracción automática: sin contactar Gmail, Gemini ni SaveData reales."""

from __future__ import annotations

import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.app import automatico as modulo
from backend.app.automatico import ExtractorAutomatico, borrador_desde_extraccion, intervalo_desde_entorno
from backend.app.extracciones import AlmacenExtracciones, GuardarExtraccionRequest
from backend.app.gemini import GeminiRequestError
from backend.app.gmail import GmailRateLimitError

EMAIL = "a@example.com"
INICIO = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
PDF = {"id": "att-1", "filename": "estado.pdf", "mimeType": "application/pdf", "size": 10, "partId": "1"}


def _resultado(campos: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "model": "m",
        "prompt_version": "p",
        "formato_numerico": "us",
        "resumen": {"saldo_inicial": "100.00", "saldo_final": "50.00", "dudosos": []},
        "transacciones": [
            {"id": "ia-1", "fecha": "01/11", "concepto": "PAGO A", "referencia": "", "cargo": "30.00", "abono": "", "saldo": "", "origen": "ia", "dudosos": [], "huella": "h1"},
            {"id": "ia-2", "fecha": "02/11", "concepto": "PAGO B", "referencia": "", "cargo": "20.00", "abono": "", "saldo": "", "origen": "ia", "dudosos": [], "huella": "h2"},
        ],
        "sugerencias_campos": [{"clave": "folio", "nombre": "Folio", "valores": [{"huella": "h1", "valor": "F1"}]}],
        "resultados_campos": [{"nombre": nombre, "clave": nombre.lower(), "encontrado": True, "valores": [], "valor_documento": "Persona"} for nombre in campos],
    }


class GmailFalso:
    def __init__(self) -> None:
        self.mensajes: dict[str, dict[str, Any]] = {}
        self.conectado = True
        self.limite = False
        self.queries: list[str] = []
        self.descargas = 0

    def agregar(self, message_id: str, recibido: datetime, asunto: str = "Estado de cuenta noviembre", adjuntos: list[dict[str, Any]] | None = None) -> None:
        self.mensajes[message_id] = {"id": message_id, "subject": asunto, "receivedAt": recibido.isoformat(), "attachments": adjuntos if adjuntos is not None else [PDF]}

    def profile(self) -> dict[str, Any]:
        if not self.conectado:
            raise modulo.GmailNotConnectedError("sin token")
        return {"email": EMAIL}

    def buscar_ids(self, query: str, max_results: int = 100) -> list[str]:
        if self.limite:
            raise GmailRateLimitError("429")
        self.queries.append(query)
        return list(self.mensajes)[:max_results]

    def get_message(self, message_id: str) -> dict[str, Any]:
        return self.mensajes[message_id]

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        self.descargas += 1
        return b"%PDF-1.7", "application/pdf", "estado.pdf"


class GeminiFalso:
    def __init__(self) -> None:
        self.habilitado = True
        self.llamadas: list[tuple[str, ...]] = []
        self.fallar: Exception | None = None
        self.espera: threading.Event | None = None
        self.en_llamada = threading.Event()

    def status(self) -> dict[str, Any]:
        return {"enabled": self.habilitado}

    def extract_document(self, data: bytes, mime_type: str, filename: str, forzar: bool = False, campos_solicitados: Any = ()) -> dict[str, Any]:
        self.llamadas.append(tuple(campos_solicitados))
        self.en_llamada.set()
        if self.espera is not None:
            self.espera.wait(5)
        if self.fallar is not None:
            raise self.fallar
        return _resultado(campos_solicitados)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        raiz = Path(self.tmp.name)
        self.ahora = INICIO
        self.gmail = GmailFalso()
        self.gemini = GeminiFalso()
        self.almacen = AlmacenExtracciones(raiz / "extracciones")
        self.extractor = self._nuevo()

    def tearDown(self) -> None:
        self.extractor.detener(espera=1)
        self.tmp.cleanup()

    def _nuevo(self) -> ExtractorAutomatico:
        """Otra instancia sobre las mismas carpetas: equivale a reiniciar el backend."""
        return ExtractorAutomatico(Path(self.tmp.name) / "automatico", self.gmail, self.gemini, self.almacen, reloj=lambda: self.ahora)

    def activar(self) -> None:
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, True)

    def adjunto(self, message_id: str = "m1") -> dict[str, Any]:
        return self.extractor.estado(EMAIL)["adjuntos"].get(f"{message_id}__1", {})


class SoloCorreosNuevos(Base):
    def test_solo_extrae_correos_posteriores_a_la_activacion(self) -> None:
        self.gmail.agregar("viejo", INICIO - timedelta(minutes=5))
        self.activar()
        self.gmail.agregar("nuevo", INICIO + timedelta(minutes=5))
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        self.assertIsNone(self.almacen.obtener(EMAIL, "viejo", "1"))
        self.assertEqual(self.almacen.obtener(EMAIL, "nuevo", "1")["estado"], "borrador")
        self.assertIn(f"after:{int(INICIO.timestamp())}", self.gmail.queries[0])

    def test_descarta_asuntos_que_no_son_estados_y_adjuntos_que_no_son_documentos(self) -> None:
        self.activar()
        self.gmail.agregar("promo", INICIO + timedelta(minutes=1), asunto="Oferta especial")
        self.gmail.agregar("zip", INICIO + timedelta(minutes=1), adjuntos=[{**PDF, "filename": "a.zip", "mimeType": "application/zip"}])
        self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 0)
        self.assertEqual(self.gemini.llamadas, [])

    def test_reanudar_conserva_la_fecha_de_activacion(self) -> None:
        self.activar()
        self.ahora = INICIO + timedelta(hours=1)
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, False)
            estado = self.extractor.configurar(EMAIL, True)
        self.assertEqual(estado["activado_en"], INICIO.isoformat(timespec="seconds"))


class SinDuplicados(Base):
    def test_no_extrae_dos_veces_tras_reiniciar(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.extractor.ejecutar_ciclo()
        reiniciado = self._nuevo()
        self.assertEqual(reiniciado.ejecutar_ciclo()["extraidos"], 0)
        self.assertEqual(len(self.gemini.llamadas), 1)
        self.assertEqual(self.almacen.obtener(EMAIL, "m1", "1")["version"], 1)

    def test_reinicio_a_mitad_de_la_llamada_cuenta_como_intento_y_no_duplica(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        # Simula un proceso que murió con el adjunto en_curso (intento ya contado en disco).
        self.extractor._anotar(EMAIL, "m1__1", estado="en_curso", intentos=1)
        reiniciado = self._nuevo()
        reiniciado.ejecutar_ciclo()
        self.assertEqual(self.adjunto()["estado"], "extraido")
        self.assertEqual(self.adjunto()["intentos"], 2)
        self.assertEqual(len(self.gemini.llamadas), 1)

    def test_ciclos_simultaneos_en_el_mismo_proceso(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gemini.espera = threading.Event()
        hilo = threading.Thread(target=self.extractor.ejecutar_ciclo)
        hilo.start()
        self.assertTrue(self.gemini.en_llamada.wait(5))
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "en_curso"})
        self.assertFalse(self.extractor.revisar_ahora())
        self.gemini.espera.set()
        hilo.join(5)
        self.assertEqual(len(self.gemini.llamadas), 1)

    def test_ciclos_simultaneos_en_dos_procesos(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gemini.espera = threading.Event()
        otro_proceso = self._nuevo()  # lock propio: solo lo frena el archivo de bloqueo
        hilo = threading.Thread(target=self.extractor.ejecutar_ciclo)
        hilo.start()
        self.assertTrue(self.gemini.en_llamada.wait(5))
        self.assertEqual(otro_proceso.ejecutar_ciclo(), {"resultado": "en_curso"})
        self.gemini.espera.set()
        hilo.join(5)
        self.assertEqual(len(self.gemini.llamadas), 1)
        self.assertFalse((Path(self.tmp.name) / "automatico" / ".ciclo.lock").exists())

    def test_bloqueo_caducado_no_detiene_el_proceso(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        bloqueo = Path(self.tmp.name) / "automatico" / ".ciclo.lock"
        bloqueo.write_text("123", encoding="utf-8")
        with patch.object(modulo, "BLOQUEO_CADUCA_SEGUNDOS", -1):
            self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)


class NoSobrescribe(Base):
    def _guardado_por_usuario(self) -> None:
        self.almacen.guardar(EMAIL, "m1", "1", GuardarExtraccionRequest.model_validate({"estado": "borrador", "transacciones": [{"id": "x", "concepto": "MIO", "origen": "manual"}]}))

    def test_no_toca_una_extraccion_ya_guardada(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self._guardado_por_usuario()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.gemini.llamadas, [])
        self.assertEqual(self.adjunto()["estado"], "omitido")
        self.assertEqual(self.almacen.obtener(EMAIL, "m1", "1")["transacciones"][0]["concepto"], "MIO")

    def test_si_el_usuario_guarda_mientras_gemini_extrae_se_conserva_lo_suyo(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        original = self.gemini.extract_document

        def extraer_y_guardar_en_paralelo(*args: Any, **kwargs: Any) -> dict[str, Any]:
            self._guardado_por_usuario()
            return original(*args, **kwargs)

        self.gemini.extract_document = extraer_y_guardar_en_paralelo  # type: ignore[method-assign]
        self.extractor.ejecutar_ciclo()
        guardado = self.almacen.obtener(EMAIL, "m1", "1")
        self.assertEqual(guardado["version"], 1)
        self.assertEqual(guardado["transacciones"][0]["concepto"], "MIO")
        self.assertEqual(self.adjunto()["estado"], "omitido")


class Reintentos(Base):
    def test_fallo_de_gemini_reintenta_y_marca_error_tras_tres_intentos(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gemini.fallar = GeminiRequestError("Gemini fallo", status_code=502)
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.adjunto()["estado"], self.adjunto()["intentos"]), ("pendiente", 1))
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.adjunto()["estado"], self.adjunto()["intentos"]), ("pendiente", 2))
        self.extractor.ejecutar_ciclo()
        self.assertEqual((self.adjunto()["estado"], self.adjunto()["intentos"]), ("error", 3))
        self.assertEqual(self.adjunto()["error"], "Gemini fallo")
        self.extractor.ejecutar_ciclo()
        self.assertEqual(len(self.gemini.llamadas), 3)
        self.assertIsNone(self.almacen.obtener(EMAIL, "m1", "1"))

    def test_reintento_exitoso_en_el_siguiente_ciclo(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gemini.fallar = GeminiRequestError("Gemini fallo")
        self.extractor.ejecutar_ciclo()
        self.gemini.fallar = None
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.adjunto()["estado"], "extraido")
        self.assertIsNotNone(self.almacen.obtener(EMAIL, "m1", "1"))

    def test_limite_de_gmail_corta_el_ciclo_sin_gastar_intentos(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gmail.limite = True
        self.assertEqual(self.extractor.ejecutar_ciclo()["resultado"], "limite_gmail")
        self.assertEqual(self.adjunto(), {})
        self.assertEqual(self.extractor.estado(EMAIL)["ultimo_resultado"], "limite_gmail")

    def test_limite_al_descargar_no_cuenta_como_intento(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        with patch.object(self.gmail, "attachment", side_effect=GmailRateLimitError("429")):
            self.extractor.ejecutar_ciclo()
        self.assertEqual((self.adjunto()["estado"], self.adjunto()["intentos"]), ("pendiente", 0))


class SinCondiciones(Base):
    def test_pausado_no_hace_nada(self) -> None:
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "pausado"})
        self.activar()
        with patch.object(ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, False)
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "pausado"})
        self.assertEqual((self.gmail.queries, self.gemini.llamadas, self.gmail.descargas), ([], [], 0))

    def test_sin_gmail_o_sin_gemini_no_hace_nada(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gmail.conectado = False
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "sin_gmail"})
        self.gmail.conectado = True
        self.gemini.habilitado = False
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "sin_gemini"})
        self.assertEqual((self.gmail.queries, self.gemini.llamadas), ([], []))

    def test_nunca_envia_a_savedata(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        with patch("backend.app.savedata.ServicioEnvio.enviar", side_effect=AssertionError("no debe enviarse")) as enviar, \
                patch("urllib.request.urlopen", side_effect=AssertionError("sin red")):
            self.extractor.ejecutar_ciclo()
        enviar.assert_not_called()
        guardado = self.almacen.obtener(EMAIL, "m1", "1")
        self.assertEqual((guardado["estado"], guardado["envios"], guardado["enviado_en"]), ("borrador", [], None))
        self.assertNotIn("savedata", modulo.__dict__)


class ColumnasYBorrador(Base):
    def _usuario_con_columnas(self) -> None:
        self.almacen.guardar(EMAIL, "previo", "1", GuardarExtraccionRequest.model_validate({
            "estado": "borrador",
            "campos_extra": [{"id": "c1", "nombre": "Nombre", "origen": "manual"}, {"id": "c2", "nombre": "RFC", "origen": "ia", "clave": "rfc"}],
            "sugerencias_campos": [{"clave": "sucursal", "nombre": "Sucursal", "valores": []}],
        }))

    def test_pide_columnas_agregadas_o_aceptadas_y_nunca_sugerencias_no_elegidas(self) -> None:
        self._usuario_con_columnas()
        self.assertEqual(self.extractor.campos_a_buscar(EMAIL), ["Nombre", "RFC"])
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.gemini.llamadas, [("Nombre", "RFC")])
        guardado = self.almacen.obtener(EMAIL, "m1", "1")
        self.assertEqual([c["nombre"] for c in guardado["campos_extra"]], ["Nombre", "RFC"])
        # Sin configuración guardada se usan los campos deducidos, con su tipo ("En cada movimiento") y vinculados.
        self.assertEqual([c.get("plantilla_id") for c in guardado["campos_extra"]], ["pl-nombre", "pl-rfc"])
        # El tipo configurado manda: un valor único del documento no se repite en cada movimiento.
        self.assertTrue(all("alcance" not in c for c in guardado["campos_extra"]))
        self.assertTrue(all("extras" not in t for t in guardado["transacciones"]))
        self.assertEqual([s["clave"] for s in guardado["sugerencias_campos"]], ["folio"])

    def test_columnas_sin_duplicados_y_maximo_treinta(self) -> None:
        campos = [{"id": f"c{i}", "nombre": f"Campo {i}", "origen": "manual"} for i in range(30)]
        self.almacen.guardar(EMAIL, "a", "1", GuardarExtraccionRequest.model_validate({"estado": "borrador", "campos_extra": campos}))
        self.almacen.guardar(EMAIL, "b", "1", GuardarExtraccionRequest.model_validate({"estado": "borrador", "campos_extra": [{"id": "x", "nombre": "campo  0", "origen": "manual"}, {"id": "y", "nombre": "Extra", "origen": "manual"}]}))
        nombres = self.extractor.campos_a_buscar(EMAIL)
        self.assertEqual(len(nombres), 30)
        self.assertEqual(len({n.lower().replace(" ", "") for n in nombres}), 30)

    def test_borrador_equivale_al_del_frontend(self) -> None:
        solicitud = borrador_desde_extraccion(_resultado(["Nombre"]), [{"id": "pl-nombre", "nombre": "Nombre", "alcance": "documento"}], filename="e.pdf", attachment_id="att", lote="L")
        self.assertEqual([t.id for t in solicitud.transacciones], ["ia-L-1", "ia-L-2"])
        self.assertTrue(all(t.origen == "ia" for t in solicitud.transacciones))
        self.assertEqual(solicitud.estado, "borrador")
        self.assertIsNone(solicitud.transacciones[0].extras)
        self.assertEqual((solicitud.campos_extra[0].alcance, solicitud.campos_extra[0].valor), ("documento", "Persona"))

    def test_valores_por_huella(self) -> None:
        resultado = _resultado()
        resultado["resultados_campos"] = [{"nombre": "Folio", "clave": "folio", "encontrado": True, "valores": [{"huella": "h2", "valor": "F2"}]}]
        solicitud = borrador_desde_extraccion(resultado, [{"id": "pl-folio", "nombre": "Folio", "alcance": "movimiento"}], filename="e.pdf", attachment_id=None, lote="L")
        self.assertIsNone(solicitud.transacciones[0].extras)
        self.assertEqual(solicitud.transacciones[1].extras, {"pl-folio": "F2"})


class Programacion(Base):
    def test_intervalo_desde_entorno(self) -> None:
        self.assertEqual(intervalo_desde_entorno(None), 20)
        self.assertEqual(intervalo_desde_entorno("5"), 5)
        self.assertEqual(intervalo_desde_entorno("0"), 20)
        self.assertEqual(intervalo_desde_entorno("abc"), 20)

    def test_arranca_y_se_detiene_limpio(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.extractor.iniciar()
        self.assertTrue(self.extractor.corriendo())
        for _ in range(50):
            if self.adjunto().get("estado") == "extraido":
                break
            threading.Event().wait(0.05)
        self.assertEqual(self.adjunto().get("estado"), "extraido")
        self.assertIsNotNone(self.extractor.estado(EMAIL)["proxima_revision"])
        self.extractor.detener(espera=2)
        self.assertFalse(self.extractor.corriendo())


if __name__ == "__main__":
    unittest.main()
