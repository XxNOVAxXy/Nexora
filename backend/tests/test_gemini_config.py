"""Bloque 6: cambiar solo el modelo conserva la API key guardada (antes respondía 422)."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.gemini import GeminiSettings


CLAVE = "AIzaClaveDePrueba-1234567890"


class CambioDeModeloTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directorio = tempfile.TemporaryDirectory()
        self.ruta = Path(self.directorio.name) / "gemini.json"
        self.parche = patch.object(main, "gemini", GeminiSettings(self.ruta))
        self.parche.start()
        # Sin archivo, GeminiSettings lee la key del entorno: se aísla para que la prueba no dependa del .env.
        self.entorno = patch.dict(os.environ, {"GOOGLE_GEMINI_API_KEY": "", "GEMINI_API_KEY": ""})
        self.entorno.start()
        self.cliente = TestClient(main.app)

    def tearDown(self) -> None:
        self.entorno.stop()
        self.parche.stop()
        self.directorio.cleanup()

    def guardado(self) -> dict[str, object]:
        return json.loads(self.ruta.read_text(encoding="utf-8"))

    def test_cambiar_solo_el_modelo_no_da_422_y_conserva_la_key(self) -> None:
        self.assertEqual(self.cliente.post("/api/gemini/config", json={"apiKey": CLAVE, "model": "modelo-a"}).status_code, 200)
        # Así lo enviaba la interfaz antes de la corrección: apiKey vacía.
        for cuerpo in ({"apiKey": "", "model": "modelo-b"}, {"apiKey": "   ", "model": "modelo-c"}, {"apiKey": None, "model": "modelo-d"}, {"model": "modelo-e"}):
            with self.subTest(cuerpo=cuerpo):
                r = self.cliente.post("/api/gemini/config", json=cuerpo)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["model"], cuerpo["model"])
                self.assertTrue(r.json()["enabled"])
                self.assertEqual(self.guardado()["apiKey"], CLAVE)

    def test_la_respuesta_nunca_expone_la_key(self) -> None:
        self.cliente.post("/api/gemini/config", json={"apiKey": CLAVE, "model": "modelo-a"})
        for r in (self.cliente.post("/api/gemini/config", json={"model": "modelo-b"}), self.cliente.get("/api/gemini/status")):
            self.assertNotIn(CLAVE, r.text)
            self.assertNotIn(CLAVE[:-4], r.text)
            self.assertEqual(r.json()["maskedKey"], f"....{CLAVE[-4:]}")

    def test_key_nueva_reemplaza_la_guardada(self) -> None:
        self.cliente.post("/api/gemini/config", json={"apiKey": CLAVE, "model": "modelo-a"})
        nueva = "AIzaOtraClaveDePrueba-0000"
        self.assertEqual(self.cliente.post("/api/gemini/config", json={"apiKey": f"  {nueva}  ", "model": "modelo-a"}).status_code, 200)
        self.assertEqual(self.guardado()["apiKey"], nueva)

    def test_key_demasiado_corta_da_422_claro_y_no_borra_la_guardada(self) -> None:
        self.cliente.post("/api/gemini/config", json={"apiKey": CLAVE, "model": "modelo-a"})
        r = self.cliente.post("/api/gemini/config", json={"apiKey": "corta", "model": "modelo-b"})
        self.assertEqual(r.status_code, 422)
        self.assertIn("demasiado corta", r.json()["detail"])
        self.assertEqual(self.guardado(), {"apiKey": CLAVE, "model": "modelo-a", "enabled": True})

    def test_sin_key_guardada_ni_enviada_da_422_controlado(self) -> None:
        r = self.cliente.post("/api/gemini/config", json={"model": "modelo-a"})
        self.assertEqual(r.status_code, 422)
        self.assertIsInstance(r.json()["detail"], str)
        self.assertFalse(self.ruta.exists())

    def test_modelo_vacio_da_422(self) -> None:
        self.cliente.post("/api/gemini/config", json={"apiKey": CLAVE, "model": "modelo-a"})
        self.assertEqual(self.cliente.post("/api/gemini/config", json={"model": "   "}).status_code, 422)
        self.assertEqual(self.guardado()["model"], "modelo-a")


if __name__ == "__main__":
    unittest.main()
