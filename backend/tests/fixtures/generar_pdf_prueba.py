"""Genera ``estado_cuenta_ficticio.pdf``: un estado de cuenta INVENTADO para las pruebas.

Todos los datos son ficticios (banco, titular, cuenta y movimientos). El PDF se escribe a mano (PDF 1.4,
fuente Helvetica estándar) para no añadir dependencias. Los totales se calculan aquí, así que el documento
siempre cuadra: saldo inicial + abonos - cargos = saldo final.

Uso: python backend/tests/fixtures/generar_pdf_prueba.py
"""
from __future__ import annotations

from decimal import Decimal
from pathlib import Path


DESTINO = Path(__file__).with_name("estado_cuenta_ficticio.pdf")

BANCO = "BANCO FICTICIO DE PRUEBA S.A."
TITULAR = "CLIENTE DE PRUEBA NEXORA"
CUENTA = "0000-0000-0000-1234"
PERIODO = "01/10/2026 AL 31/10/2026"
MONEDA = "MXN"
SALDO_INICIAL = Decimal("25000.00")

# (fecha, concepto, referencia, cargo, abono)
MOVIMIENTOS: list[tuple[str, str, str, str, str]] = [
    ("02/10/2026", "TRANSFERENCIA RECIBIDA", "REF-0001", "", "12000.00"),
    ("03/10/2026", "PAGO A PROVEEDOR", "REF-0002", "4250.00", ""),
    ("05/10/2026", "COMISION POR MANEJO DE CUENTA", "REF-0003", "150.00", ""),
    ("07/10/2026", "DEPOSITO REFERENCIADO", "REF-0004", "", "6750.00"),
    ("09/10/2026", "PAGO DE SERVICIOS", "REF-0005", "1875.50", ""),
    ("11/10/2026", "TRANSFERENCIA SALIENTE", "REF-0006", "3300.00", ""),
    ("13/10/2026", "DEPOSITO EN EFECTIVO", "REF-0007", "", "2500.00"),
    ("15/10/2026", "PAGO CON TARJETA", "REF-0008", "980.25", ""),
    ("17/10/2026", "TRANSFERENCIA RECIBIDA", "REF-0009", "", "8400.00"),
    ("19/10/2026", "PAGO DE NOMINA", "REF-0010", "7200.00", ""),
    ("21/10/2026", "INTERESES GANADOS", "REF-0011", "", "35.40"),
    ("23/10/2026", "RETIRO EN CAJERO", "REF-0012", "2000.00", ""),
    ("25/10/2026", "DEPOSITO REFERENCIADO", "REF-0013", "", "1250.00"),
    ("28/10/2026", "PAGO A PROVEEDOR", "REF-0014", "5600.00", ""),
    ("30/10/2026", "IVA COMISION", "REF-0015", "24.00", ""),
]


def _monto(valor: Decimal) -> str:
    return f"{valor:,.2f}"


def _escapar(texto: str) -> str:
    return texto.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def lineas_del_documento() -> tuple[list[tuple[float, float, int, str]], dict[str, Decimal]]:
    """Devuelve las líneas a dibujar (x, y, tamaño, texto) y los totales calculados."""
    saldo = SALDO_INICIAL
    cargos = abonos = Decimal("0")
    lineas: list[tuple[float, float, int, str]] = [
        (50, 790, 14, BANCO),
        (50, 772, 9, "DOCUMENTO FICTICIO PARA PRUEBAS AUTOMATIZADAS - SIN VALIDEZ"),
        (50, 745, 10, "ESTADO DE CUENTA"),
        (50, 730, 9, f"TITULAR: {TITULAR}"),
        (50, 717, 9, f"CUENTA: {CUENTA}"),
        (50, 704, 9, f"PERIODO: {PERIODO}"),
        (50, 691, 9, f"MONEDA: {MONEDA}"),
        (50, 660, 9, "FECHA"),
        (115, 660, 9, "CONCEPTO"),
        (300, 660, 9, "REFERENCIA"),
        (380, 660, 9, "CARGO"),
        (445, 660, 9, "ABONO"),
        (510, 660, 9, "SALDO"),
        (50, 645, 8, "01/10/2026"),
        (115, 645, 8, "SALDO INICIAL"),
        (510, 645, 8, _monto(SALDO_INICIAL)),
    ]
    y = 630
    for fecha, concepto, referencia, cargo, abono in MOVIMIENTOS:
        if cargo:
            saldo -= Decimal(cargo)
            cargos += Decimal(cargo)
        if abono:
            saldo += Decimal(abono)
            abonos += Decimal(abono)
        lineas += [
            (50, y, 8, fecha),
            (115, y, 8, concepto),
            (300, y, 8, referencia),
            (380, y, 8, _monto(Decimal(cargo)) if cargo else ""),
            (445, y, 8, _monto(Decimal(abono)) if abono else ""),
            (510, y, 8, _monto(saldo)),
        ]
        y -= 15
    y -= 15
    totales = {"saldo_inicial": SALDO_INICIAL, "total_cargos": cargos, "total_abonos": abonos, "saldo_final": saldo}
    for etiqueta, clave in (("SALDO INICIAL", "saldo_inicial"), ("TOTAL CARGOS", "total_cargos"), ("TOTAL ABONOS", "total_abonos"), ("SALDO FINAL", "saldo_final")):
        lineas += [(300, y, 9, etiqueta), (510, y, 9, _monto(totales[clave]))]
        y -= 14
    return [linea for linea in lineas if linea[3]], totales


def construir_pdf() -> bytes:
    lineas, _ = lineas_del_documento()
    contenido = "\n".join(f"BT /F1 {t} Tf {x:g} {y:g} Td ({_escapar(texto)}) Tj ET" for x, y, t, texto in lineas).encode("latin-1")
    objetos = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(contenido) + contenido + b"\nendstream",
        b"<< /Title (Estado de cuenta ficticio) /Producer (Nexora - pruebas) >>",
    ]
    salida = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    posiciones = []
    for numero, cuerpo in enumerate(objetos, start=1):
        posiciones.append(len(salida))
        salida += b"%d 0 obj\n" % numero + cuerpo + b"\nendobj\n"
    inicio_xref = len(salida)
    salida += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objetos) + 1)
    for posicion in posiciones:
        salida += b"%010d 00000 n \n" % posicion
    salida += b"trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objetos) + 1, inicio_xref)
    return bytes(salida)


if __name__ == "__main__":
    DESTINO.write_bytes(construir_pdf())
    _, totales = lineas_del_documento()
    print(f"{DESTINO} ({DESTINO.stat().st_size} bytes)", {k: _monto(v) for k, v in totales.items()})
