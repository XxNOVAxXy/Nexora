"""Bloque 6: nombres de adjuntos problemáticos nunca producen un 500 ni inyectan cabeceras."""
from __future__ import annotations

import re
import unittest
from email.message import Message
from urllib.parse import unquote
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.adjuntos import MAX_LONGITUD_NOMBRE, content_disposition, decodificar_nombre, nombre_seguro
from backend.app.gmail import GmailAttachmentError, _attachments


PDF = b"%PDF-1.4 contenido"

# (nombre recibido, nombre seguro esperado)
NOMBRES = [
    ("estado_año.pdf", "estado_año.pdf"),
    ("Café “octubre”.pdf", "Café “octubre”.pdf"),
    ("日本の明細.pdf", "日本の明細.pdf"),
    ("emoji😀.pdf", "emoji😀.pdf"),
    ('con"comillas".pdf', 'con"comillas".pdf'),
    ("barra\\invertida.pdf", "barra_invertida.pdf"),
    ("ruta/../../etc.pdf", "ruta_.._.._etc.pdf"),
    ("a\r\nX-Inyectada: 1.pdf", "a X-Inyectada: 1.pdf"),
    ("tab\tnul\x00.pdf", "tab nul .pdf"),
    ("linea separador.pdf", "linea separador.pdf"),
    ("", "adjunto.pdf"),
    ("   ", "adjunto.pdf"),
    ("...", "adjunto.pdf"),
    ("=?UTF-8?B?ZXN0YWRvX8OxLnBkZg==?=", "estado_ñ.pdf"),
    ("=?ISO-8859-1?Q?estado_de_cuenta_=F1.pdf?=", "estado de cuenta ñ.pdf"),
    ("UTF-8''estado%20de%20cuenta%C3%B1.pdf", "estado de cuentañ.pdf"),
    ("=?UTF-8?B?roto", "=?UTF-8?B?roto"),
]


def cabecera_valida(valor: str) -> bool:
    """Lo que exige un servidor HTTP real (h11/uvicorn): ASCII imprimible, sin CR/LF."""
    return all(32 <= ord(c) < 127 for c in valor)


def nombre_de_cabecera(valor: str) -> str:
    """Nombre que usa un navegador: ``filename*`` (RFC 6266 le da prioridad sobre ``filename``)."""
    extendido = re.search(r"filename\*=UTF-8''([^;\s]+)", valor)
    if extendido:
        return unquote(extendido.group(1), encoding="utf-8", errors="strict")
    mensaje = Message()
    mensaje["Content-Disposition"] = valor
    return mensaje.get_filename() or ""


class NombreSeguroTests(unittest.TestCase):
    def test_casos_problematicos(self) -> None:
        for recibido, esperado in NOMBRES:
            with self.subTest(recibido=recibido):
                self.assertEqual(nombre_seguro(recibido, "application/pdf"), esperado)

    def test_nombre_muy_largo_conserva_la_extension(self) -> None:
        nombre = nombre_seguro("x" * 600 + ".pdf", "application/pdf")
        self.assertEqual(len(nombre), MAX_LONGITUD_NOMBRE)
        self.assertTrue(nombre.endswith(".pdf"))
        sin_extension = nombre_seguro("y" * 600, "application/pdf")
        self.assertEqual(len(sin_extension), MAX_LONGITUD_NOMBRE)

    def test_nombre_vacio_usa_extension_del_tipo(self) -> None:
        self.assertEqual(nombre_seguro("", "image/png"), "adjunto.png")
        self.assertEqual(nombre_seguro(None, "image/jpeg"), "adjunto.jpg")
        self.assertEqual(nombre_seguro("", ""), "adjunto")

    def test_decodificacion_rfc2047_invalida_no_lanza(self) -> None:
        self.assertEqual(decodificar_nombre("=?X-DESCONOCIDO?B?AAAA?="), "=?X-DESCONOCIDO?B?AAAA?=")


class ContentDispositionTests(unittest.TestCase):
    def test_siempre_ascii_sin_saltos_y_recupera_el_nombre(self) -> None:
        for recibido, esperado in NOMBRES + [("z" * 600 + ".pdf", "z" * 146 + ".pdf")]:
            with self.subTest(recibido=recibido):
                valor = content_disposition(recibido, "application/pdf")
                self.assertTrue(cabecera_valida(valor), valor)
                self.assertTrue(valor.startswith('inline; filename="'))
                # filename* (RFC 5987) lleva el nombre UTF-8 exacto; los navegadores lo prefieren al respaldo.
                self.assertEqual(nombre_de_cabecera(valor), esperado)

    def test_respaldo_ascii(self) -> None:
        self.assertIn('filename="estado_ano.pdf"', content_disposition("estado_año.pdf"))
        self.assertIn('filename="adjunto.pdf"', content_disposition("日本.pdf"))
        self.assertIn('filename="con_comillas.pdf"', content_disposition('con"comillas".pdf'))
        self.assertIn('filename="a X-Inyectada: 1.pdf"', content_disposition("a\r\nX-Inyectada: 1.pdf"))


class DescargaDeAdjuntoTests(unittest.TestCase):
    def descargar(self, nombre: str) -> object:
        with patch.object(main.gmail, "attachment", return_value=(PDF, "application/pdf", nombre)):
            return TestClient(main.app, raise_server_exceptions=False).get("/api/gmail/messages/m/attachments/a")

    def test_ningun_nombre_produce_500(self) -> None:
        for recibido, esperado in NOMBRES + [("x" * 600 + ".pdf", None)]:
            with self.subTest(recibido=recibido):
                r = self.descargar(recibido)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.content, PDF)
                cabecera = r.headers["content-disposition"]
                self.assertTrue(cabecera_valida(cabecera), cabecera)
                self.assertNotIn("X-Inyectada", {k.title() for k in r.headers})
                if esperado is not None:
                    self.assertEqual(nombre_de_cabecera(cabecera), esperado)

    def test_adjunto_invalido_es_422_controlado(self) -> None:
        with patch.object(main.gmail, "attachment", side_effect=GmailAttachmentError("Gmail devolvio un adjunto vacio.")):
            r = TestClient(main.app, raise_server_exceptions=False).get("/api/gmail/messages/m/attachments/a")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["detail"], "Gmail devolvio un adjunto vacio.")


class ListadoDeAdjuntosTests(unittest.TestCase):
    def payload(self, *partes: dict[str, object]) -> dict[str, object]:
        return {"mimeType": "multipart/mixed", "parts": list(partes)}

    def test_nombres_saneados_y_decodificados(self) -> None:
        adjuntos = _attachments(
            self.payload(
                {"partId": "1", "mimeType": "application/pdf", "filename": "=?UTF-8?B?ZXN0YWRvX8OxLnBkZg==?=", "body": {"attachmentId": "A1", "size": 10}},
                {"partId": "2", "mimeType": "application/pdf", "filename": "a\r\nb.pdf", "body": {"attachmentId": "A2", "size": 10}},
            )
        )
        self.assertEqual([a["filename"] for a in adjuntos], ["estado_ñ.pdf", "a b.pdf"])

    def test_rfc2231_solo_en_cabeceras(self) -> None:
        parte = {
            "partId": "3",
            "mimeType": "application/octet-stream",
            "filename": "",
            "headers": [{"name": "Content-Disposition", "value": "attachment; filename*=UTF-8''estado%20oct%C3%BAbre.pdf"}],
            "body": {"attachmentId": "A3", "size": 10},
        }
        adjuntos = _attachments(self.payload(parte))
        self.assertEqual(adjuntos[0]["filename"], "estado octúbre.pdf")
        self.assertEqual(adjuntos[0]["mimeType"], "application/pdf")

    def test_pdf_sin_nombre_se_lista_pero_un_cuerpo_html_no(self) -> None:
        adjuntos = _attachments(
            self.payload(
                {"partId": "1", "mimeType": "text/html", "filename": "", "body": {"attachmentId": "CUERPO", "size": 90000}},
                {"partId": "2", "mimeType": "application/pdf", "filename": "", "body": {"attachmentId": "PDF", "size": 10}},
            )
        )
        self.assertEqual([(a["id"], a["filename"], a["partId"]) for a in adjuntos], [("PDF", "adjunto.pdf", "2")])


if __name__ == "__main__":
    unittest.main()
