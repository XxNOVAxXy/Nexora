"""PDFs FICTICIOS generados en la prueba (nunca documentos reales).

- ``pdf_con_texto(lineas)``: PDF 1.4 escrito a mano con Helvetica (capa de texto real, legible por pypdf y pdfplumber).
- ``pdf_sin_texto()``: una página en blanco (como un escaneado: sin capa de texto).
- ``pdf_protegido()``: PDF con contraseña de apertura (pypdf, AES-256).
- ``pdf_danado()``: empieza con %PDF- pero el resto es basura.
- ``png_minimo()``: imagen PNG de 1x1 válida.
"""

from __future__ import annotations

import io
import struct
import zlib

LINEAS_POR_DEFECTO = (
    "DOCUMENTO FICTICIO PARA PRUEBAS - SIN VALIDEZ",
    "POLIZA: FIC-0001",
    "ASEGURADO: CLIENTE DE PRUEBA NEXORA",
    "VIGENCIA DESDE: 01/01/2026 HASTA: 01/01/2027",
    "PRIMA TOTAL: 12,345.67",
)


def _escapar(texto: str) -> str:
    return texto.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_con_texto(lineas: tuple[str, ...] | list[str] = LINEAS_POR_DEFECTO, *, tamano: int = 11) -> bytes:
    """PDF de una página con las líneas dadas (de arriba hacia abajo)."""
    contenido = "\n".join(f"BT /F1 {tamano} Tf 50 {780 - indice * (tamano + 8)} Td ({_escapar(linea)}) Tj ET" for indice, linea in enumerate(lineas)).encode("latin-1")
    objetos = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(contenido)).encode() + b" >>\nstream\n" + contenido + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    salida = io.BytesIO()
    salida.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    posiciones = []
    for numero, cuerpo in enumerate(objetos, start=1):
        posiciones.append(salida.tell())
        salida.write(f"{numero} 0 obj\n".encode() + cuerpo + b"\nendobj\n")
    inicio_xref = salida.tell()
    salida.write(f"xref\n0 {len(objetos) + 1}\n0000000000 65535 f \n".encode())
    for posicion in posiciones:
        salida.write(f"{posicion:010d} 00000 n \n".encode())
    salida.write(f"trailer\n<< /Size {len(objetos) + 1} /Root 1 0 R >>\nstartxref\n{inicio_xref}\n%%EOF\n".encode())
    return salida.getvalue()


def pdf_sin_texto(paginas: int = 1) -> bytes:
    from pypdf import PdfWriter

    escritor = PdfWriter()
    for _ in range(paginas):
        escritor.add_blank_page(width=612, height=792)
    salida = io.BytesIO()
    escritor.write(salida)
    return salida.getvalue()


def pdf_protegido(contrasena: str = "secreta-ficticia") -> bytes:
    from pypdf import PdfReader, PdfWriter

    escritor = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_con_texto())))
    escritor.encrypt(user_password=contrasena, owner_password=contrasena + "-dueno", algorithm="AES-256")
    salida = io.BytesIO()
    escritor.write(salida)
    return salida.getvalue()


def pdf_solo_permisos() -> bytes:
    """Cifrado solo con contraseña de permisos: se abre sin contraseña."""
    from pypdf import PdfReader, PdfWriter

    escritor = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_con_texto())))
    escritor.encrypt(user_password="", owner_password="dueno-ficticio", algorithm="AES-256")
    salida = io.BytesIO()
    escritor.write(salida)
    return salida.getvalue()


def pdf_danado() -> bytes:
    return b"%PDF-1.7\n" + bytes(range(256)) * 4


def png_minimo() -> bytes:
    def bloque(tipo: bytes, datos: bytes) -> bytes:
        return struct.pack(">I", len(datos)) + tipo + datos + struct.pack(">I", zlib.crc32(tipo + datos) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + bloque(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + bloque(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + bloque(b"IEND", b"")


def pdf_con_tabla(lineas: tuple[str, ...] | list[str], encabezado: list[str], filas: list[list[str]], *, ancho_columna: int = 160) -> bytes:
    """PDF FICTICIO con líneas de texto arriba y una tabla con bordes (como Coberturas o Asegurados) abajo.

    La tabla se dibuja con líneas para que pdfplumber la reconozca como tabla."""
    partes = [f"BT /F1 11 Tf 50 {780 - indice * 19} Td ({_escapar(linea)}) Tj ET" for indice, linea in enumerate(lineas)]
    arriba = 760 - len(lineas) * 19
    alto = 20
    todas = [encabezado, *filas]
    x0, x1 = 50, 50 + ancho_columna * len(encabezado)
    for numero in range(len(todas) + 1):
        y = arriba - numero * alto
        partes.append(f"0.5 w {x0} {y} m {x1} {y} l S")
    for columna in range(len(encabezado) + 1):
        x = x0 + columna * ancho_columna
        partes.append(f"0.5 w {x} {arriba} m {x} {arriba - len(todas) * alto} l S")
    for numero, fila in enumerate(todas):
        for columna, texto in enumerate(fila):
            partes.append(f"BT /F1 9 Tf {x0 + columna * ancho_columna + 4} {arriba - numero * alto - 14} Td ({_escapar(texto)}) Tj ET")
    contenido = "\n".join(partes).encode("latin-1")
    objetos = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(contenido)).encode() + b" >>\nstream\n" + contenido + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    salida = io.BytesIO()
    salida.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    posiciones = []
    for numero, cuerpo in enumerate(objetos, start=1):
        posiciones.append(salida.tell())
        salida.write(f"{numero} 0 obj\n".encode() + cuerpo + b"\nendobj\n")
    inicio_xref = salida.tell()
    salida.write(f"xref\n0 {len(objetos) + 1}\n0000000000 65535 f \n".encode())
    for posicion in posiciones:
        salida.write(f"{posicion:010d} 00000 n \n".encode())
    salida.write(f"trailer\n<< /Size {len(objetos) + 1} /Root 1 0 R >>\nstartxref\n{inicio_xref}\n%%EOF\n".encode())
    return salida.getvalue()
