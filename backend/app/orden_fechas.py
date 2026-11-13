"""Orden de los movimientos por fecha al extraer (mismo algoritmo que ``ordenarPorFecha`` del frontend).

- Orden estable: con la misma fecha se conserva el orden del documento.
- Un movimiento cuya fecha no se puede leer se queda en su lugar; solo se reordenan los demás entre sí.
- Fechas sin año ("02/11", "15 DIC"): el año se toma del periodo del resumen y un mes anterior al de inicio del
  periodo pasa al año siguiente (cruce de diciembre a enero). Sin periodo, si los meses cruzan de fin a inicio de
  año (hay meses de octubre a diciembre y de enero a marzo), los meses de enero a junio van después.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

MESES = {
    "ene": 1, "jan": 1, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "may": 5, "jun": 6, "jul": 7,
    "ago": 8, "aug": 8, "sep": 9, "set": 9, "oct": 10, "nov": 11, "dic": 12, "dec": 12,
}

_ISO = re.compile(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})")
_NUMERICA = re.compile(r"(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?")
_TEXTO = re.compile(r"(\d{1,2})[\s/.-]*([a-z]{3,})\.?(?:[\s/.,-]*(\d{2,4}))?")


def _normalizar(texto: str) -> str:
    sin_acentos = "".join(c for c in unicodedata.normalize("NFKD", texto or "") if not unicodedata.combining(c))
    return sin_acentos.lower().strip()


def _anio(texto: str | None) -> int | None:
    if not texto:
        return None
    valor = int(texto)
    return valor + 2000 if valor < 100 else valor


def leer_fecha(texto: str) -> tuple[int | None, int, int] | None:
    """(año o None, mes, día), o None si no es una fecha reconocible."""
    limpio = _normalizar(texto)
    if (iso := _ISO.search(limpio)) is not None:
        anio, mes, dia = int(iso.group(1)), int(iso.group(2)), int(iso.group(3))
    elif (numerica := _NUMERICA.search(limpio)) is not None:
        dia, mes, anio = int(numerica.group(1)), int(numerica.group(2)), _anio(numerica.group(3))
    elif (textual := _TEXTO.search(limpio)) is not None and textual.group(2)[:3] in MESES:
        dia, mes, anio = int(textual.group(1)), MESES[textual.group(2)[:3]], _anio(textual.group(3))
    else:
        return None
    if not (1 <= mes <= 12 and 1 <= dia <= 31):
        return None
    return anio, mes, dia


def _inicio_periodo(periodo: str) -> tuple[int, int] | None:
    fecha = leer_fecha(periodo or "")
    if fecha is not None and fecha[0] is not None:
        return fecha[0], fecha[1]
    anio = re.search(r"\b(20\d{2})\b", periodo or "")
    if anio is None:
        return None
    textual = re.search(r"([a-z]{3,})", _normalizar(periodo))
    mes = MESES.get(textual.group(1)[:3], 1) if textual else 1
    return int(anio.group(1)), mes


def ordenar_por_fecha(transacciones: list[dict[str, Any]], periodo: str = "") -> list[dict[str, Any]]:
    fechas = [leer_fecha(str(t.get("fecha", ""))) for t in transacciones]
    inicio = _inicio_periodo(periodo)
    meses_sin_anio = {f[1] for f in fechas if f is not None and f[0] is None}
    cruza = any(m >= 10 for m in meses_sin_anio) and any(m <= 3 for m in meses_sin_anio)

    def clave(indice: int) -> tuple[int, int, int, int]:
        anio, mes, dia = fechas[indice]  # type: ignore[misc]
        if anio is None:
            if inicio is not None:
                anio = inicio[0] if mes >= inicio[1] else inicio[0] + 1
            else:
                anio = 1 if cruza and mes <= 6 else 0
        return anio, mes, dia, indice

    posiciones = [indice for indice, fecha in enumerate(fechas) if fecha is not None]
    ordenadas = sorted(posiciones, key=clave)
    resultado = list(transacciones)
    for destino, origen in zip(posiciones, ordenadas):
        resultado[destino] = transacciones[origen]
    return resultado
