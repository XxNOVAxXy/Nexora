from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.extracciones import cuenta_id
from backend.app.preferencias import AlmacenClasificaciones, ConfiguracionCuenta
from backend.app.remitentes import ListaRemitentesInvalida, ReglaInvalida, coincide, construir_query, firma_remitentes, normalizar_remitente, validar_lista


class QueryTests(unittest.TestCase):
    def test_un_remitente(self) -> None:
        self.assertEqual(construir_query("inbox", ["banco@ejemplo.com"]), 'in:inbox has:attachment from:"banco@ejemplo.com"')

    def test_un_dominio(self) -> None:
        self.assertEqual(construir_query("inbox", ["@ejemplo.com"]), 'in:inbox has:attachment from:"ejemplo.com"')

    def test_varios_remitentes_y_dominios_con_or(self) -> None:
        self.assertEqual(
            construir_query("archive", ["estados@banco.com", "@otro-banco.com.mx"]),
            '-in:inbox -in:sent -in:trash has:attachment (from:"estados@banco.com" OR from:"otro-banco.com.mx")',
        )

    def test_valores_con_sintaxis_de_gmail_no_llegan_a_la_query(self) -> None:
        for intento in ['a@b.com" OR from:"x', "a@b.com OR x", "(a@b.com)", "{a@b.com}", "a@b.com -in:trash", "a\"@b.com"]:
            with self.subTest(intento=intento), self.assertRaises((ReglaInvalida, ListaRemitentesInvalida)):
                construir_query("inbox", validar_lista([intento]))
        with self.assertRaises(ReglaInvalida):
            construir_query("inbox", ['a@b.com" OR from:"x'])  # aun sin validar, la lista blanca lo bloquea

    def test_sin_remitentes_no_hay_query(self) -> None:
        with self.assertRaises(ReglaInvalida):
            construir_query("inbox", [])


class NormalizacionTests(unittest.TestCase):
    def test_normaliza_minusculas_y_espacios(self) -> None:
        self.assertEqual(normalizar_remitente("  Estados@Banco.COM "), "estados@banco.com")
        self.assertEqual(normalizar_remitente("\t@Banco.com.MX "), "@banco.com.mx")
        with self.assertRaises(ReglaInvalida):
            normalizar_remitente("@ Banco.com.MX")  # un espacio interno no se une en silencio

    def test_rechaza_formatos_invalidos(self) -> None:
        for valor in ["", "banco", "banco.com", "@banco", "a@@b.com", "a@b..com", ".a@b.com", "a.@b.com", "a@-b.com", "a@b.c", "@", "a@b.com,c@d.com"]:
            with self.subTest(valor=valor), self.assertRaises(ReglaInvalida):
                normalizar_remitente(valor)

    def test_rechaza_duplicados_tras_normalizar(self) -> None:
        with self.assertRaises(ListaRemitentesInvalida) as contexto:
            validar_lista(["banco@ejemplo.com", "Banco@Ejemplo.com ", "@x.com"])
        self.assertEqual(len(contexto.exception.errores), 1)
        self.assertIn("Duplicado", contexto.exception.errores[0]["motivo"])

    def test_firma_cambia_con_la_lista_y_no_con_el_orden(self) -> None:
        self.assertEqual(firma_remitentes(["a@b.com", "@c.com"]), firma_remitentes(["@c.com", "a@b.com"]))
        self.assertNotEqual(firma_remitentes(["a@b.com"]), firma_remitentes(["a@b.com", "@c.com"]))
        self.assertEqual(firma_remitentes([]), "sin-remitentes")


class ComparacionTests(unittest.TestCase):
    reglas = ["estados@banco.com", "@otrobanco.mx"]

    def test_nombre_visible_y_mayusculas(self) -> None:
        self.assertEqual(coincide('"Banco Ejemplo" <Estados@Banco.COM>', self.reglas), "estados@banco.com")
        self.assertEqual(coincide("estados@banco.com", self.reglas), "estados@banco.com")

    def test_nombre_visible_falsificado_no_coincide(self) -> None:
        self.assertIsNone(coincide('"estados@banco.com" <x@malo.com>', self.reglas))
        self.assertIsNone(coincide("otro@banco.com", self.reglas))

    def test_dominio_con_subdominios_y_frontera_de_punto(self) -> None:
        self.assertEqual(coincide("a@otrobanco.mx", self.reglas), "@otrobanco.mx")
        self.assertEqual(coincide("a@notificaciones.otrobanco.mx", self.reglas), "@otrobanco.mx")
        self.assertIsNone(coincide("a@otrobanco.mx.malo.net", self.reglas))
        self.assertIsNone(coincide("a@nootrobanco.mx", self.reglas))
        self.assertIsNone(coincide("", self.reglas))


class FakeGmailPaginado:
    """Dos páginas de ids que se solapan para comprobar que no hay duplicados."""

    def __init__(self) -> None:
        self.consultas: list[dict[str, Any]] = []
        self.paginas = {None: (["m1", "m2", "m2"], "tok-2"), "tok-2": (["m3", "spoof"], None)}

    def profile(self) -> dict[str, Any]:
        return {"email": EMAIL_ACTUAL[0]}

    def list_messages(self, folder: str, max_results: int, page_token: str | None = None, query: str | None = None) -> dict[str, Any]:
        self.consultas.append({"folder": folder, "page_token": page_token, "query": query})
        ids, siguiente = self.paginas[page_token]
        remitente = {"m1": "estados@banco.com", "m2": "a@mail.otrobanco.mx", "m3": "estados@banco.com", "spoof": "x@malo.com"}
        return {"messages": [{"id": i, "senderEmail": remitente[i], "attachments": []} for i in dict.fromkeys(ids)], "nextPageToken": siguiente}


EMAIL_ACTUAL = ["a@example.com"]


class RutasTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.addCleanup(self.directorio.cleanup)
        EMAIL_ACTUAL[0] = "a@example.com"
        self.gmail = FakeGmailPaginado()
        reemplazos = {
            "gmail": self.gmail,
            "configuracion": ConfiguracionCuenta(Path(self.directorio.name, "configuracion")),
            "clasificaciones": AlmacenClasificaciones(Path(self.directorio.name, "clasificaciones")),
        }
        for nombre, valor in reemplazos.items():
            parche = patch.object(main, nombre, valor)
            parche.start()
            self.addCleanup(parche.stop)
        self.api = TestClient(main.app)

    def poner_remitentes(self, remitentes: list[str]):
        return self.api.put("/api/configuracion/remitentes", json={"remitentes": remitentes})

    def test_sin_remitentes_no_consulta_gmail_y_lo_indica(self) -> None:
        respuesta = self.api.get("/api/gmail/messages").json()
        self.assertTrue(respuesta["sinRemitentes"])
        self.assertEqual((respuesta["messages"], respuesta["nextPageToken"]), ([], None))
        self.assertEqual(self.gmail.consultas, [])
        todos = self.api.get("/api/gmail/messages?filtro=todos").json()
        self.assertFalse(todos["sinRemitentes"])
        self.assertEqual(self.gmail.consultas[0]["query"], "in:inbox")

    def test_filtro_en_gmail_paginacion_sin_duplicados_y_falsos_positivos_descartados(self) -> None:
        self.assertEqual(self.poner_remitentes(["Estados@Banco.com", "@otrobanco.mx"]).status_code, 200)
        primera = self.api.get("/api/gmail/messages").json()
        self.assertEqual(self.gmail.consultas[0]["query"], 'in:inbox has:attachment (from:"estados@banco.com" OR from:"otrobanco.mx")')
        self.assertEqual([m["id"] for m in primera["messages"]], ["m1", "m2"])
        self.assertEqual(primera["nextPageToken"], "tok-2")
        self.assertEqual(primera["messages"][1]["reglaRemitente"], "@otrobanco.mx")
        segunda = self.api.get("/api/gmail/messages?pageToken=tok-2").json()
        self.assertEqual(self.gmail.consultas[1]["page_token"], "tok-2")
        self.assertEqual([m["id"] for m in segunda["messages"]], ["m3"])
        self.assertEqual(segunda["descartados"], 1)  # "spoof" lo devolvió Gmail pero la dirección no coincide
        self.assertIsNone(segunda["nextPageToken"])
        ids = [m["id"] for m in primera["messages"] + segunda["messages"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_cambiar_remitentes_cambia_la_firma_del_filtro(self) -> None:
        self.poner_remitentes(["estados@banco.com"])
        firma_a = self.api.get("/api/gmail/messages").json()["firmaFiltro"]
        self.poner_remitentes(["estados@banco.com", "@otrobanco.mx"])
        firma_b = self.api.get("/api/gmail/messages").json()["firmaFiltro"]
        self.assertNotEqual(firma_a, firma_b)
        self.assertEqual(self.api.get("/api/configuracion/remitentes").json()["firma"], firma_b)

    def test_remitentes_invalidos_o_duplicados_422(self) -> None:
        respuesta = self.poner_remitentes(["banco", "a@b.com", "A@B.com"])
        self.assertEqual(respuesta.status_code, 422)
        self.assertEqual(len(respuesta.json()["detail"]["errores"]), 2)
        self.assertEqual(self.api.get("/api/configuracion/remitentes").json()["remitentes"], [])
        self.assertEqual(self.api.get("/api/gmail/messages?pageToken=a%22b").status_code, 422)

    def test_clasificaciones_poner_quitar_y_migracion_unica(self) -> None:
        self.assertEqual(self.api.put("/api/clasificaciones/m1", json={"classification": "ESTADO_DE_CUENTA", "fingerprint": "v2:abc"}).status_code, 200)
        migracion = {"clasificaciones": {
            "m1": {"classification": "NO_ES_ESTADO_DE_CUENTA", "fingerprint": "legado"},  # no sobrescribe la del backend
            "m2": {"classification": "REQUIERE_REVISION", "fingerprint": "legado"},
        }}
        primera = self.api.post("/api/clasificaciones/migrar", json=migracion).json()
        self.assertEqual((primera["migradas"], primera["ya_migrado"]), (1, False))
        segunda = self.api.post("/api/clasificaciones/migrar", json={"clasificaciones": {"m3": {"classification": "ESTADO_DE_CUENTA", "fingerprint": "legado"}}}).json()
        self.assertTrue(segunda["ya_migrado"])
        guardadas = self.api.get("/api/clasificaciones").json()
        self.assertEqual(sorted(guardadas["clasificaciones"]), ["m1", "m2"])
        self.assertEqual(guardadas["clasificaciones"]["m1"]["classification"], "ESTADO_DE_CUENTA")
        self.assertIsNotNone(guardadas["migrado_en"])
        self.assertEqual(self.api.delete("/api/clasificaciones/m1").status_code, 200)
        self.assertNotIn("m1", self.api.get("/api/clasificaciones").json()["clasificaciones"])
        self.assertEqual(self.api.put("/api/clasificaciones/m1", json={"classification": "OTRA", "fingerprint": "x"}).status_code, 422)

    def test_aislamiento_por_cuenta(self) -> None:
        self.poner_remitentes(["estados@banco.com"])
        self.api.put("/api/clasificaciones/m1", json={"classification": "ESTADO_DE_CUENTA", "fingerprint": "v2:abc"})
        EMAIL_ACTUAL[0] = "b@example.com"
        self.assertEqual(self.api.get("/api/configuracion/remitentes").json()["remitentes"], [])
        self.assertTrue(self.api.get("/api/gmail/messages").json()["sinRemitentes"])
        self.assertEqual(self.api.get("/api/clasificaciones").json()["clasificaciones"], {})
        self.assertFalse(self.api.post("/api/clasificaciones/migrar", json={"clasificaciones": {}}).json()["ya_migrado"])
        EMAIL_ACTUAL[0] = "A@example.com"
        self.assertEqual(self.api.get("/api/configuracion/remitentes").json()["remitentes"], ["estados@banco.com"])
        self.assertIn("m1", self.api.get("/api/clasificaciones").json()["clasificaciones"])
        self.assertTrue(Path(self.directorio.name, "configuracion", f"{cuenta_id('a@example.com')}.json").exists())


if __name__ == "__main__":
    unittest.main()
