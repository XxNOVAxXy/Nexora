"""Diagnóstico del proceso automático: descartes con motivo, resumen del ciclo, reinicios, avisos y logs.

Sin contactar Gmail, Gemini ni SaveData reales.
"""

from __future__ import annotations

import json
import os
import threading
import unittest
from datetime import timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.app import automatico as modulo
from backend.app.extracciones import cuenta_id
from backend.tests.test_automatico import EMAIL, INICIO, PDF, Base, _resultado
from backend.tests.test_envio_automatico import BaseEnvio


class Diagnostico(Base):
    def estado(self) -> dict[str, Any]:
        return self.extractor.estado(EMAIL)

    def archivo(self) -> dict[str, Any]:
        return json.loads((Path(self.tmp.name) / "automatico" / f"{cuenta_id(EMAIL)}.json").read_text(encoding="utf-8"))

    def descartado(self, clave: str) -> dict[str, Any]:
        return next(item for item in self.estado()["descartados"] if item["clave"] == clave)


class Descartes(Diagnostico):
    def test_correo_sin_adjunto_valido_queda_descartado_y_no_es_ultimo_correo(self) -> None:
        self.activar()
        self.gmail.agregar("sin", INICIO + timedelta(minutes=1), adjuntos=[])
        self.gmail.agregar("zip", INICIO + timedelta(minutes=2), adjuntos=[{**PDF, "filename": "secreto-cliente.zip", "mimeType": "application/zip"}])
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["extraidos"], resumen["omitidos"]), (0, 2))
        archivo = self.archivo()
        self.assertIsNone(archivo["ultimo_correo"])
        self.assertEqual(archivo["revisado_hasta"], modulo._iso(INICIO + timedelta(minutes=2)))
        self.assertEqual(archivo["adjuntos"], {})
        sin = self.descartado("sin")
        self.assertEqual(sin["motivo"], "sin_adjunto_valido")
        self.assertIn("no trae adjuntos", sin["detalle"])
        self.assertEqual(sin["asunto"], "Estado de cuenta noviembre")
        zip_ = self.descartado("zip")
        self.assertIn("application/zip (.zip)", zip_["detalle"])
        self.assertNotIn("secreto-cliente", json.dumps(self.estado()))
        ciclo = self.estado()["ultimo_ciclo"]
        self.assertEqual((ciclo["resultado"], ciclo["correos_encontrados"], ciclo["omitidos"]), ("ok", 2, 2))
        self.assertEqual({d["motivo"] for d in ciclo["descartes"]}, {"sin_adjunto_valido"})

    def test_cada_motivo_queda_registrado(self) -> None:
        self.activar()
        self.gmail.agregar("viejo", INICIO - timedelta(minutes=5))
        self.gmail.agregar("promo", INICIO + timedelta(minutes=1), asunto="Oferta especial")
        self.gmail.agregar("mixto", INICIO + timedelta(minutes=2), adjuntos=[PDF, {"id": "att-2", "filename": "logo.gif", "mimeType": "image/gif", "partId": "2"}])
        self.gmail.agregar("guardado", INICIO + timedelta(minutes=3))
        self.gmail.mensajes["sinfecha"] = {"id": "sinfecha", "subject": "Estado de cuenta", "receivedAt": None, "attachments": [PDF]}
        self.almacen.guardar(EMAIL, "guardado", "1", modulo.borrador_desde_extraccion(_resultado(), [], filename="e.pdf", attachment_id="a", lote="x"))
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        motivos = {item["clave"]: item["motivo"] for item in self.estado()["descartados"]}
        self.assertEqual(motivos, {
            "viejo": "anterior_a_activacion",
            "promo": "asunto_no_coincide",
            "mixto__2": "adjunto_no_extraible",
            "guardado__1": "ya_tenia_extraccion",
            "sinfecha": "sin_fecha",
        })
        self.assertEqual(self.archivo()["ultimo_correo"]["id"], "guardado")

    def test_un_descarte_repetido_no_se_cuenta_dos_veces(self) -> None:
        self.activar()
        self.gmail.agregar("promo", INICIO + timedelta(minutes=1), asunto="Oferta especial")
        self.extractor.ejecutar_ciclo()
        self.ahora = INICIO + timedelta(minutes=20)
        resumen = self.extractor.ejecutar_ciclo()
        self.assertEqual((resumen["omitidos"], resumen["ya_revisados"]), (0, 1))
        self.assertEqual(self.descartado("promo")["veces"], 2)
        self.assertEqual(self.estado()["ultimo_ciclo"]["descartes"], [])

    def test_tope_de_descartes(self) -> None:
        self.activar()
        for indice in range(8):
            self.gmail.agregar(f"p{indice}", INICIO + timedelta(minutes=indice + 1), asunto="Oferta")
        with patch.object(modulo, "MAX_DESCARTES", 5):
            self.extractor.ejecutar_ciclo()
            self.assertEqual(len(self.archivo()["descartados"]), 5)

    def test_estado_anterior_sin_adjuntos_se_convierte_en_limite_de_busqueda(self) -> None:
        self.activar()
        ruta = Path(self.tmp.name) / "automatico" / f"{cuenta_id(EMAIL)}.json"
        datos = json.loads(ruta.read_text(encoding="utf-8"))
        recibido = modulo._iso(INICIO + timedelta(days=2))
        ruta.write_text(json.dumps({**datos, "ultimo_correo": {"id": "m15", "recibido": recibido}}), encoding="utf-8")
        estado = self.extractor._leer(EMAIL)
        self.assertIsNone(estado["ultimo_correo"])
        self.assertEqual(estado["revisado_hasta"], recibido)
        self.extractor.ejecutar_ciclo()
        self.assertIn(f"after:{int((INICIO + timedelta(days=1)).timestamp())}", self.gmail.queries[-1])


class EstadoReal(Diagnostico):
    def test_salidas_tempranas_quedan_registradas(self) -> None:
        self.activar()
        self.extractor.ejecutar_ciclo()
        self.gmail.conectado = False
        self.ahora = INICIO + timedelta(minutes=20)
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "sin_gmail"})
        estado = self.estado()
        self.assertEqual((estado["ultimo_ciclo"]["resultado"], estado["ultimo_resultado"]), ("sin_gmail", "sin_gmail"))
        self.assertEqual(estado["ultima_revision"], modulo._iso(self.ahora))
        self.gmail.conectado = True
        self.gemini.habilitado = False
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "sin_gemini"})
        self.assertEqual(self.estado()["ultimo_ciclo"]["resultado"], "sin_gemini")
        with patch.object(modulo.ExtractorAutomatico, "revisar_ahora", return_value=True):
            self.extractor.configurar(EMAIL, False)
        self.assertEqual(self.extractor.ejecutar_ciclo(), {"resultado": "pausado"})
        self.assertEqual(self.estado()["ultimo_ciclo"]["resultado"], "pausado")

    def test_revisando_solo_mientras_hay_un_ciclo(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gemini.espera = threading.Event()
        hilo = threading.Thread(target=self.extractor.ejecutar_ciclo)
        hilo.start()
        self.assertTrue(self.gemini.en_llamada.wait(5))
        durante = self.estado()
        self.assertTrue(durante["en_curso"])
        self.assertIsNotNone(durante["ciclo_en_curso_desde"])
        self.assertIsNotNone(self.archivo()["ciclo_en_curso"])
        self.gemini.espera.set()
        hilo.join(5)
        despues = self.estado()
        self.assertFalse(despues["en_curso"])
        self.assertIsNone(despues["ciclo_en_curso_desde"])
        self.assertIsNone(self.archivo()["ciclo_en_curso"])
        self.assertEqual((despues["ultimo_ciclo"]["resultado"], despues["ultimo_ciclo"]["extraidos"]), ("ok", 1))

    def test_revisar_ahora_deja_rastro_y_marca_el_ciclo_como_manual(self) -> None:
        self.activar()
        with patch.object(self.extractor, "_ejecutar_seguro"):
            self.assertTrue(self.extractor.revisar_ahora(EMAIL))
        estado = self.estado()
        self.assertEqual(estado["revision_solicitada_en"], modulo._iso(INICIO))
        self.assertTrue(estado["revision_pendiente"])
        self.ahora = INICIO + timedelta(seconds=5)
        self.extractor.ejecutar_ciclo()
        estado = self.estado()
        self.assertFalse(estado["revision_pendiente"])
        self.assertEqual(estado["ultimo_ciclo"]["origen"], "manual")
        self.ahora = INICIO + timedelta(minutes=20)
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.estado()["ultimo_ciclo"]["origen"], "programado")

    def test_revisar_ahora_rechaza_si_otro_proceso_vivo_tiene_el_bloqueo(self) -> None:
        self.activar()
        bloqueo = Path(self.tmp.name) / "automatico" / ".ciclo.lock"
        bloqueo.write_text("424242 2026-11-01T12:00:00+00:00", encoding="utf-8")
        with patch.object(modulo, "_proceso_vivo", return_value=True):
            self.assertFalse(self.extractor.revisar_ahora(EMAIL))
            self.assertTrue(self.estado()["en_curso"])
        with patch.object(modulo, "_proceso_vivo", return_value=False):
            self.assertFalse(self.estado()["en_curso"])
            # Bloqueo de un proceso que murió (p. ej. por --reload): no frena el siguiente ciclo.
            self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
            self.assertEqual(self.extractor.ejecutar_ciclo()["extraidos"], 1)
        self.assertFalse(bloqueo.exists())

    def test_proceso_vivo(self) -> None:
        self.assertTrue(modulo._proceso_vivo(os.getpid()))
        self.assertFalse(modulo._proceso_vivo(0))


class InterrumpidoPorReinicio(Diagnostico):
    def marca_huerfana(self, pid: int) -> None:
        def cambio(estado: dict[str, Any]) -> None:
            estado["ciclo_en_curso"] = {"inicio": modulo._iso(INICIO), "origen": "manual", "pid": pid, "instancia": "anterior"}
        self.extractor._mutar(EMAIL, cambio)

    def test_al_arrancar_registra_el_ciclo_cortado(self) -> None:
        self.activar()
        self.marca_huerfana(424242)
        self.ahora = INICIO + timedelta(minutes=3)
        reiniciado = self._nuevo()
        with patch.object(modulo, "_proceso_vivo", return_value=False):
            reiniciado._recuperar_al_arrancar()
        estado = reiniciado.estado(EMAIL)
        self.assertEqual(estado["ultimo_ciclo"]["resultado"], "interrumpido_reinicio")
        self.assertEqual(estado["ultimo_ciclo"]["inicio"], modulo._iso(INICIO))
        self.assertEqual(estado["ultimo_resultado"], "interrumpido_reinicio")
        self.assertEqual([aviso["tipo"] for aviso in estado["avisos"]], ["error_ciclo"])
        self.assertEqual(estado["avisos_sin_leer"], 1)
        self.assertIsNone(self.archivo()["ciclo_en_curso"])
        # Una segunda revisión no lo registra dos veces.
        reiniciado._recuperar_al_arrancar()
        self.assertEqual(len(reiniciado.estado(EMAIL)["avisos"]), 1)

    def test_iniciar_registra_la_interrupcion(self) -> None:
        self.activar()
        self.marca_huerfana(os.getpid())  # misma pid, otra instancia: el reinicio de las pruebas
        reiniciado = self._nuevo()
        with patch.object(reiniciado, "_bucle"):
            reiniciado.iniciar()
        self.assertEqual(reiniciado.estado(EMAIL)["ultimo_resultado"], "interrumpido_reinicio")
        reiniciado.detener(espera=1)

    def test_no_toca_el_ciclo_de_otro_proceso_vivo(self) -> None:
        self.activar()
        self.marca_huerfana(424242)
        with patch.object(modulo, "_proceso_vivo", return_value=True):
            self._nuevo()._recuperar_al_arrancar()
        self.assertIsNotNone(self.archivo()["ciclo_en_curso"])

    def test_el_siguiente_ciclo_registra_la_interrupcion_y_sigue(self) -> None:
        self.activar()
        self.marca_huerfana(424242)
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        resumen = self._nuevo().ejecutar_ciclo()
        self.assertEqual(resumen["extraidos"], 1)
        estado = self.estado()
        self.assertEqual(estado["ultimo_ciclo"]["resultado"], "ok")
        self.assertIn("error_ciclo", [aviso["tipo"] for aviso in estado["avisos"]])

    def test_apagado_a_mitad_del_ciclo_queda_como_interrumpido_por_reinicio(self) -> None:
        self.activar()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1))
        self.gmail.agregar("m2", INICIO + timedelta(minutes=2))
        self.gemini.espera = threading.Event()
        hilo = threading.Thread(target=self.extractor.ejecutar_ciclo)
        hilo.start()
        self.assertTrue(self.gemini.en_llamada.wait(5))
        self.extractor._parar.set()
        self.gemini.espera.set()
        hilo.join(5)
        estado = self.estado()
        self.assertEqual(estado["ultimo_ciclo"]["resultado"], "interrumpido_reinicio")
        self.assertIn("error_ciclo", [aviso["tipo"] for aviso in estado["avisos"]])
        self.assertIsNone(self.archivo()["ciclo_en_curso"])


class Avisos(BaseEnvio):
    def test_aviso_al_enviar_y_al_requerir_revision(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo("m1")
        self.extractor.ejecutar_ciclo()
        estado = self.extractor.estado(EMAIL)
        self.assertEqual([(a["tipo"], a["claves"]) for a in estado["avisos"]], [("enviado", ["m1__1"])])
        self.assertEqual(estado["ultimo_ciclo"]["enviados"], 1)

        self.resultado_gemini(resumen={"saldo_inicial": "100.00", "saldo_final": "999.00", "dudosos": []})
        self.correo("m2")
        self.ahora = INICIO + timedelta(minutes=20)
        self.extractor.ejecutar_ciclo()
        estado = self.extractor.estado(EMAIL)
        self.assertEqual(estado["avisos"][0]["tipo"], "requiere_revision")
        self.assertEqual(estado["ultimo_ciclo"]["requieren_revision"], 1)
        self.assertEqual(estado["avisos_sin_leer"], 2)

        primero = estado["avisos"][0]["id"]
        self.assertEqual(self.extractor.marcar_avisos_leidos(EMAIL, [primero])["avisos_sin_leer"], 1)
        self.assertEqual(self.extractor.marcar_avisos_leidos(EMAIL)["avisos_sin_leer"], 0)

    def test_ciclo_sin_novedades_no_genera_avisos(self) -> None:
        self.activar()
        self.extractor.ejecutar_ciclo()
        self.assertEqual(self.extractor.estado(EMAIL)["avisos"], [])

    def test_envio_omitido_queda_con_motivo(self) -> None:
        self.activar()
        self.encender_envio()
        self.correo("m1")
        self.url = ""
        self.extractor.ejecutar_ciclo()
        descarte = next(d for d in self.extractor.estado(EMAIL)["descartados"] if d["clave"] == "m1__1")
        self.assertEqual(descarte["motivo"], "sin_savedata")

    def test_logs_de_cada_paso_sin_datos_personales(self) -> None:
        self.activar()
        self.encender_envio()
        self.gmail.agregar("m1", INICIO + timedelta(minutes=1), asunto="Estado de cuenta Juan Perez")
        self.gmail.agregar("promo", INICIO + timedelta(minutes=2), asunto="Oferta para Juan Perez")
        with self.assertLogs("nexora.automatico", level="INFO") as registro:
            self.extractor.ejecutar_ciclo()
        texto = "\n".join(registro.output)
        for esperado in ("inicio origen=programado", f"cuenta={cuenta_id(EMAIL)}", "correos encontrados=2", "descartado message_id=promo",
                         "motivo=asunto_no_coincide", "extrayendo message_id=m1", "adjunto extraido message_id=m1", "enviando a SaveData",
                         "respuesta SaveData message_id=m1 part_id=1 resultado=exito http=200", "fin resultado=ok"):
            self.assertIn(esperado, texto)
        for privado in (EMAIL, "Juan", "estado.pdf", "100.00"):
            self.assertNotIn(privado, texto)


if __name__ == "__main__":
    unittest.main()
