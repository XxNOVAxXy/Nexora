"""Interpretación de importes y validación contable de estados de cuenta.

La misma lógica está portada a TypeScript en ``src/services/contabilidad.ts``; ambas implementaciones
ejecutan los casos compartidos de ``backend/tests/fixtures/contabilidad_casos.json``.
Todos los cálculos usan Decimal, nunca float.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence

FormatoNumerico = Literal["us", "eu"]
Indicador = Literal["cargo", "abono"]
CAMPOS_MONTO_TRANSACCION = ("cargo", "abono", "saldo")
CAMPOS_MONTO_RESUMEN = ("saldo_inicial", "total_cargos", "total_abonos", "saldo_final")
TOLERANCIA = Decimal("0.01")


@dataclass(frozen=True)
class MontoParseado:
    """Resultado de interpretar un importe impreso.

    ``valor`` es None cuando el texto está vacío o no puede interpretarse sin adivinar.
    ``dudoso`` indica que el valor (si existe) no es confiable y requiere revisión humana.
    ``indicador`` refleja un sufijo CR/ABONO ("abono") o DR/CARGO ("cargo").
    """

    valor: Decimal | None
    dudoso: bool = False
    indicador: Indicador | None = None
    motivo: str = ""


# --- Interpretación de importes -------------------------------------------------------------

# NBSP, espacio fino estrecho y espacio fino se tratan como espacios; el signo menos tipográfico como "-".
_ESPACIOS_Y_SIGNOS = {0x00A0: " ", 0x202F: " ", 0x2009: " ", 0x2212: "-"}
_INDICADOR = re.compile(r"(?<![A-Z])(CR|DR|CARGO|ABONO)\.?$")
_MONEDA = re.compile(r"(?<![A-Z])(?:MXN|MXP|USD|EUR|DLS|M\.\s?N\.?|MN)(?![A-Z])|[$" + chr(0x20AC) + "]")
_CUERPO_NUMERICO = re.compile(r"\d(?:[\d., ]*\d)?")
_CANONICO = re.compile(r"-?\d+(?:\.\d+)?")
# "2.500" parece canónico pero en un documento europeo significa 2500: se interpreta con el formato del documento.
_CANONICO_AMBIGUO = re.compile(r"-?[1-9]\d{0,2}\.\d{3}")


@dataclass(frozen=True)
class _MontoLimpio:
    cuerpo: str
    negativo: bool
    indicador: Indicador | None
    error: str = ""


def _limpiar_monto(texto: str) -> _MontoLimpio:
    """Separa el cuerpo numérico de signos, moneda y sufijos CR/DR/CARGO/ABONO."""
    t = texto.translate(_ESPACIOS_Y_SIGNOS).upper().strip()
    indicador: Indicador | None = None
    match = _INDICADOR.search(t)
    if match:
        indicador = "abono" if match.group(1) in {"CR", "ABONO"} else "cargo"
        t = t[: match.start()].strip()
    t = _MONEDA.sub(" ", t).strip()
    signos = 0
    if t.startswith("(") and t.endswith(")"):
        signos += 1
        t = t[1:-1].strip()
    if t.startswith("-"):
        signos += 1
        t = t[1:].strip()
    elif t.startswith("+"):
        t = t[1:].strip()
    if t.endswith("-"):
        signos += 1
        t = t[:-1].strip()
    t = re.sub(r"\s+", " ", t)
    if signos > 1:
        return _MontoLimpio(t, True, indicador, "el importe tiene mas de un signo negativo")
    if not _CUERPO_NUMERICO.fullmatch(t):
        return _MontoLimpio(t, signos == 1, indicador, "texto no reconocido como importe")
    return _MontoLimpio(t, signos == 1, indicador)


def _interpretar_cuerpo(cuerpo: str, formato: FormatoNumerico | None) -> tuple[Decimal | None, str]:
    """Convierte el cuerpo numérico a Decimal. Devuelve (None, motivo) si no puede hacerlo sin adivinar."""
    if " " in cuerpo:
        # Con espacios como separador de miles, el único separador restante es el decimal.
        match = re.fullmatch(r"(\d{1,3}(?: \d{3})+)(?:[.,](\d+))?", cuerpo)
        if not match:
            return None, "agrupacion de miles con espacios invalida"
        entero = match.group(1).replace(" ", "")
        return Decimal(f"{entero}.{match.group(2)}" if match.group(2) else entero), ""

    puntos, comas = cuerpo.count("."), cuerpo.count(",")
    if not puntos and not comas:
        return Decimal(cuerpo), ""

    if puntos and comas:
        decimal = "." if cuerpo.rfind(".") > cuerpo.rfind(",") else ","
        miles = "," if decimal == "." else "."
        match = re.fullmatch(rf"(\d{{1,3}}(?:{re.escape(miles)}\d{{3}})*){re.escape(decimal)}(\d+)", cuerpo)
        if not match:
            return None, "separadores de miles y decimales inconsistentes"
        return Decimal(f"{match.group(1).replace(miles, '')}.{match.group(2)}"), ""

    separador = "." if puntos else ","
    if cuerpo.count(separador) > 1:
        # Un separador repetido solo puede ser de miles: 1,234,567 / 1.234.567.
        if not re.fullmatch(rf"\d{{1,3}}(?:{re.escape(separador)}\d{{3}})+", cuerpo):
            return None, "separadores de miles invalidos"
        return Decimal(cuerpo.replace(separador, "")), ""

    entero, fraccion = cuerpo.split(separador)
    if len(fraccion) != 3 or entero.startswith("0") or len(entero) > 3:
        # 1,5 / 1.50 / 0,500 / 1234.567: el separador solo puede ser decimal.
        return Decimal(f"{entero}.{fraccion}"), ""
    # 1,234 o 1.234: depende del formato del documento.
    if formato is None:
        return None, "separador ambiguo sin pista de formato en el documento"
    separador_decimal = "." if formato == "us" else ","
    if separador == separador_decimal:
        return Decimal(f"{entero}.{fraccion}"), ""
    return Decimal(entero + fraccion), ""


def _pista_formato(texto: str) -> FormatoNumerico | None:
    """Formato numérico que un importe revela sin ambigüedad (None si no revela ninguno)."""
    limpio = _limpiar_monto(texto)
    if limpio.error:
        return None
    cuerpo = limpio.cuerpo
    valor, _ = _interpretar_cuerpo(cuerpo, None)
    if valor is None:
        return None
    if " " in cuerpo:
        if "," in cuerpo:
            return "eu"
        return "us" if "." in cuerpo else None
    puntos, comas = cuerpo.count("."), cuerpo.count(",")
    if puntos and comas:
        return "us" if cuerpo.rfind(".") > cuerpo.rfind(",") else "eu"
    if not puntos and not comas:
        return None
    separador = "." if puntos else ","
    if cuerpo.count(separador) > 1:
        return "us" if separador == "," else "eu"
    return "us" if separador == "." else "eu"


def detectar_formato(textos: Sequence[str]) -> tuple[FormatoNumerico | None, bool]:
    """Formato numérico del documento y si hay pistas contradictorias (en cuyo caso no se elige ninguno)."""
    pistas = {pista for texto in textos if isinstance(texto, str) and texto.strip() for pista in [_pista_formato(texto)] if pista}
    if len(pistas) == 1:
        return pistas.pop(), False
    return None, len(pistas) > 1


def parse_money(value: Any, formato: FormatoNumerico | None = None) -> MontoParseado:
    """Interpreta un importe impreso en formato US/MX (1,234.56), europeo (1.234,56) o con espacios (1 234,56).

    Admite signo al inicio o al final, paréntesis, símbolos/códigos de moneda y sufijos CR/DR/CARGO/ABONO.
    Un caso ambiguo como "1,234" se resuelve con ``formato`` (detectado en el documento); sin él queda dudoso.
    """
    if not isinstance(value, str) or not value.strip():
        return MontoParseado(None)
    limpio = _limpiar_monto(value)
    if limpio.error:
        return MontoParseado(None, True, limpio.indicador, limpio.error)
    valor, motivo = _interpretar_cuerpo(limpio.cuerpo, formato)
    if valor is None:
        return MontoParseado(None, True, limpio.indicador, motivo)
    if limpio.negativo:
        valor = -valor
        if limpio.indicador == "abono":
            return MontoParseado(valor, True, limpio.indicador, "signo negativo con indicador de abono")
    return MontoParseado(valor, False, limpio.indicador)


def formatear_decimal(valor: Decimal) -> str:
    """Formato canónico "1234.56" (al menos dos decimales, sin separadores de miles ni cero negativo)."""
    if valor == 0:
        valor = abs(valor)
    exponente = valor.as_tuple().exponent
    if isinstance(exponente, int) and exponente < -2:
        return format(valor, "f")
    return f"{valor:.2f}"


def normalizar_monto(campo: str, texto: str, formato: FormatoNumerico | None) -> tuple[str, Decimal | None, bool]:
    """Devuelve (texto normalizado "1234.56", valor, dudoso) según el tipo de campo.

    Cargos y abonos se expresan como magnitud positiva; los saldos conservan su signo (DR = negativo).
    Si el importe no puede interpretarse, se conserva el texto original y se marca dudoso.
    """
    parseado = parse_money(texto, formato)
    if parseado.valor is None:
        return (texto.strip() if isinstance(texto, str) else ""), None, parseado.dudoso
    valor = parseado.valor
    dudoso = parseado.dudoso
    if campo in {"cargo", "total_cargos"}:
        dudoso = dudoso or parseado.indicador == "abono"
        valor = abs(valor)
    elif campo in {"abono", "total_abonos"}:
        dudoso = dudoso or parseado.indicador == "cargo" or valor < 0
        valor = abs(valor)
    elif parseado.indicador == "cargo":
        # Saldo con DR/CARGO: saldo deudor. Si además trae signo negativo, la intención es incierta.
        dudoso = dudoso or valor < 0
        valor = -abs(valor)
    return formatear_decimal(valor), valor, dudoso


# --- Filas de saldo ------------------------------------------------------------------------

_FILA_DE_SALDO = re.compile(r"^saldo\s+(?:inicial|anterior|previo|final|al\s+corte)\b")


def es_fila_de_saldo(concepto: Any) -> bool:
    """True para filas como "SALDO INICIAL", "Saldo anterior al 30/09" o "SALDO AL CORTE", que no son movimientos."""
    if not isinstance(concepto, str):
        return False
    sin_acentos = "".join(c for c in unicodedata.normalize("NFD", concepto) if unicodedata.category(c) != "Mn")
    return bool(_FILA_DE_SALDO.match(re.sub(r"\s+", " ", sin_acentos.strip().lower())))


# --- Validación contable -------------------------------------------------------------------

_ETIQUETAS = {
    "saldo_inicial": "saldo inicial",
    "total_cargos": "total de cargos",
    "total_abonos": "total de abonos",
    "saldo_final": "saldo final",
}


def _monto_para_validacion(campo: str, texto: Any, formato: FormatoNumerico | None) -> tuple[Decimal | None, bool]:
    """(valor, invalido). Acepta el formato canónico "1234.56" o el texto del documento."""
    if not isinstance(texto, str) or not texto.strip():
        return None, False
    t = texto.strip()
    if _CANONICO.fullmatch(t) and not _CANONICO_AMBIGUO.fullmatch(t):
        valor = Decimal(t)
        if campo in {"cargo", "total_cargos"}:
            return abs(valor), False
        if campo in {"abono", "total_abonos"} and valor < 0:
            return None, True
        return valor, False
    _, valor, dudoso = normalizar_monto(campo, t, formato)
    if valor is None or dudoso:
        return None, True
    return valor, False


def _redondear(valor: Decimal) -> Decimal:
    redondeado = valor.quantize(TOLERANCIA)
    return redondeado if redondeado != 0 else Decimal("0.00")


def _texto(valor: Decimal | None) -> str | None:
    return None if valor is None else formatear_decimal(valor)


def _comprobacion(id_: str, etiqueta: str, esperado: Decimal | None, calculado: Decimal | None, motivo: str) -> dict[str, Any]:
    if motivo or esperado is None or calculado is None:
        return {"id": id_, "estado": "no_verificable", "esperado": _texto(esperado), "calculado": _texto(calculado), "diferencia": None, "mensaje": motivo}
    diferencia = _redondear(calculado - esperado)
    ok = abs(diferencia) <= TOLERANCIA
    return {
        "id": id_,
        "estado": "ok" if ok else "diferencia",
        "esperado": _texto(esperado),
        "calculado": _texto(calculado),
        "diferencia": f"{diferencia:.2f}",
        "mensaje": f"{etiqueta} cuadra." if ok else f"{etiqueta}: diferencia de {diferencia:.2f}.",
    }


def validar_contabilidad(
    resumen: Mapping[str, Any],
    transacciones: Sequence[Mapping[str, Any]],
    formato: FormatoNumerico | None = None,
) -> dict[str, Any]:
    """Valida los movimientos contra el resumen y la continuidad de saldos por fila (tolerancia 0.01).

    - Excluye de las sumas las filas de saldo (saldo inicial/anterior/final).
    - Un importe dudoso o inválido nunca se suma: la comprobación afectada queda "no_verificable".
    - La continuidad compara cada saldo reportado contra el saldo anterior más/menos los movimientos
      intermedios y continúa desde el saldo reportado para no arrastrar un error a las filas siguientes.
    """
    resumen_valores: dict[str, tuple[Decimal | None, bool]] = {
        campo: _monto_para_validacion(campo, resumen.get(campo, ""), formato) for campo in CAMPOS_MONTO_RESUMEN
    }

    def motivo_resumen(campo: str) -> str:
        valor, invalido = resumen_valores[campo]
        if invalido:
            return f"El {_ETIQUETAS[campo]} del resumen es dudoso o invalido."
        if valor is None:
            return f"El resumen no incluye el {_ETIQUETAS[campo]}."
        return ""

    importes_invalidos: list[dict[str, str]] = []
    filas_excluidas: list[str] = []
    suma_cargos = Decimal("0")
    suma_abonos = Decimal("0")
    movimientos_validos = True
    for transaccion in transacciones:
        id_ = str(transaccion.get("id", ""))
        _, saldo_invalido = _monto_para_validacion("saldo", transaccion.get("saldo", ""), formato)
        if saldo_invalido:
            importes_invalidos.append({"id": id_, "campo": "saldo"})
        if es_fila_de_saldo(transaccion.get("concepto", "")):
            filas_excluidas.append(id_)
            continue
        cargo, cargo_invalido = _monto_para_validacion("cargo", transaccion.get("cargo", ""), formato)
        abono, abono_invalido = _monto_para_validacion("abono", transaccion.get("abono", ""), formato)
        if cargo_invalido:
            importes_invalidos.append({"id": id_, "campo": "cargo"})
        if abono_invalido:
            importes_invalidos.append({"id": id_, "campo": "abono"})
        if cargo and abono:
            importes_invalidos.append({"id": id_, "campo": "cargo_y_abono"})
        if cargo_invalido or abono_invalido or (cargo and abono):
            movimientos_validos = False
            continue
        suma_cargos += cargo or Decimal("0")
        suma_abonos += abono or Decimal("0")

    motivo_movimientos = "" if movimientos_validos else "Hay importes dudosos o invalidos en los movimientos."
    saldo_inicial = resumen_valores["saldo_inicial"][0]
    saldo_final = resumen_valores["saldo_final"][0]
    comprobaciones = [
        _comprobacion("total_cargos", "El total de cargos", resumen_valores["total_cargos"][0], suma_cargos,
                      motivo_movimientos or motivo_resumen("total_cargos")),
        _comprobacion("total_abonos", "El total de abonos", resumen_valores["total_abonos"][0], suma_abonos,
                      motivo_movimientos or motivo_resumen("total_abonos")),
        _comprobacion(
            "saldo_final",
            "Saldo inicial + abonos - cargos = saldo final",
            saldo_final,
            None if saldo_inicial is None else saldo_inicial + suma_abonos - suma_cargos,
            motivo_movimientos or motivo_resumen("saldo_inicial") or motivo_resumen("saldo_final"),
        ),
    ]

    filas_discontinuas, verificadas = _continuidad(transacciones, saldo_inicial, formato)
    if filas_discontinuas:
        continuidad = {"id": "continuidad", "estado": "diferencia", "esperado": None, "calculado": None, "diferencia": None,
                       "mensaje": f"La continuidad de saldos se rompe en {len(filas_discontinuas)} fila(s)."}
    elif verificadas == 0:
        continuidad = {"id": "continuidad", "estado": "no_verificable", "esperado": None, "calculado": None, "diferencia": None,
                       "mensaje": "No hay saldos por fila suficientes para verificar la continuidad."}
    else:
        continuidad = {"id": "continuidad", "estado": "ok", "esperado": None, "calculado": None, "diferencia": None,
                       "mensaje": f"La continuidad de saldos cuadra en {verificadas} fila(s)."}
    comprobaciones.append(continuidad)

    if any(item["estado"] == "diferencia" for item in comprobaciones):
        cuadra: bool | None = False
    elif movimientos_validos and comprobaciones[2]["estado"] == "ok":
        cuadra = True
    else:
        cuadra = None

    return {
        "cuadra": cuadra,
        "tolerancia": f"{TOLERANCIA}",
        "suma_cargos": _texto(suma_cargos) if movimientos_validos else None,
        "suma_abonos": _texto(suma_abonos) if movimientos_validos else None,
        "comprobaciones": comprobaciones,
        "filas_discontinuas": filas_discontinuas,
        "filas_excluidas": filas_excluidas,
        "importes_invalidos": importes_invalidos,
    }


def _continuidad(
    transacciones: Sequence[Mapping[str, Any]],
    saldo_inicial: Decimal | None,
    formato: FormatoNumerico | None,
) -> tuple[list[dict[str, Any]], int]:
    anterior = saldo_inicial
    pendiente = Decimal("0")
    verificadas = 0
    discontinuas: list[dict[str, Any]] = []
    for indice, transaccion in enumerate(transacciones):
        saldo, saldo_invalido = _monto_para_validacion("saldo", transaccion.get("saldo", ""), formato)
        if not es_fila_de_saldo(transaccion.get("concepto", "")):
            cargo, cargo_invalido = _monto_para_validacion("cargo", transaccion.get("cargo", ""), formato)
            abono, abono_invalido = _monto_para_validacion("abono", transaccion.get("abono", ""), formato)
            if cargo_invalido or abono_invalido or (cargo and abono):
                # Movimiento desconocido: no se puede verificar hasta el siguiente saldo confiable.
                anterior = None if saldo_invalido else saldo
                pendiente = Decimal("0")
                continue
            pendiente += (abono or Decimal("0")) - (cargo or Decimal("0"))
        if saldo_invalido:
            anterior = None
            pendiente = Decimal("0")
            continue
        if saldo is None:
            continue
        if anterior is not None:
            verificadas += 1
            esperado = anterior + pendiente
            diferencia = _redondear(saldo - esperado)
            if abs(diferencia) > TOLERANCIA:
                discontinuas.append({
                    "id": str(transaccion.get("id", "")),
                    "indice": indice,
                    "saldo_esperado": formatear_decimal(esperado),
                    "saldo_reportado": formatear_decimal(saldo),
                    "diferencia": f"{diferencia:.2f}",
                })
        anterior = saldo
        pendiente = Decimal("0")
    return discontinuas, verificadas
