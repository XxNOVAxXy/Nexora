"""Remitentes de estados de cuenta: normalización, consulta de Gmail y comparación exacta.

Cómo se compara el remitente (``coincide``):

- Solo cuenta la **dirección** del encabezado ``From`` (``email.utils.parseaddr``); el nombre visible se ignora.
  ``"Banco <a@b.com>"`` se compara como ``a@b.com`` y un nombre visible falsificado como
  ``"banco@ejemplo.com" <x@malo.com>`` **no** coincide con ``banco@ejemplo.com``.
- Todo se compara en **minúsculas** (la parte local es técnicamente sensible a mayúsculas, pero ningún
  proveedor de correo la trata así).
- Regla de correo (``banco@ejemplo.com``): igualdad exacta de la dirección.
- Regla de dominio (``@ejemplo.com``): el dominio igual **o un subdominio**, con frontera de punto:
  ``mail.ejemplo.com`` sí; ``ejemplo.com.malo.net`` y ``otroejemplo.com`` no.

La búsqueda ``from:`` de Gmail es más amplia (también busca en el nombre visible), por eso el backend vuelve a
comprobar cada resultado con estas reglas y descarta los falsos positivos.

Mejora futura documentada (no implementada): el encabezado ``From`` puede falsificarse; no se verifican
SPF/DKIM. Se podría exigir ``dkim=pass`` con ``header.d`` del dominio en ``Authentication-Results``.
"""

from __future__ import annotations

import hashlib
import re
from email.utils import parseaddr
from typing import Sequence

MAX_REMITENTES = 50
MAX_LONGITUD = 254

_ETIQUETA = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DOMINIO = rf"(?:{_ETIQUETA}\.)+[a-z]{{2,63}}"
_LOCAL = r"[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*"
_CORREO = re.compile(rf"{_LOCAL}@{_DOMINIO}")
_REGLA_DOMINIO = re.compile(rf"@{_DOMINIO}")
# Lista blanca de caracteres que pueden llegar a la consulta de Gmail (sin comillas, espacios, paréntesis ni llaves).
_SEGURO_EN_QUERY = re.compile(r"[a-z0-9._%+@-]+")

CONSULTAS_CARPETA = {
    "inbox": "in:inbox",
    "sent": "in:sent",
    "archive": "-in:inbox -in:sent -in:trash",
    "trash": "in:trash",
}


class ReglaInvalida(ValueError):
    pass


class ListaRemitentesInvalida(ValueError):
    def __init__(self, errores: list[dict[str, str]]) -> None:
        super().__init__("La lista de remitentes tiene errores.")
        self.errores = errores


def normalizar_remitente(valor: str) -> str:
    """Minúsculas y sin espacios (extremos recortados, internos rechazados); valida correo completo o dominio (``@ejemplo.com``)."""
    if not isinstance(valor, str):
        raise ReglaInvalida("El remitente debe ser texto.")
    # Se recortan los espacios de los extremos; uno interno se rechaza (unirlo podría formar otra dirección).
    normalizado = valor.strip().lower()
    if not normalizado:
        raise ReglaInvalida("El remitente esta vacio.")
    if re.search(r"\s", normalizado):
        raise ReglaInvalida("El remitente no puede contener espacios.")
    if len(normalizado) > MAX_LONGITUD:
        raise ReglaInvalida("El remitente es demasiado largo.")
    if _CORREO.fullmatch(normalizado) or _REGLA_DOMINIO.fullmatch(normalizado):
        return normalizado
    raise ReglaInvalida("Usa un correo completo (banco@ejemplo.com) o un dominio que empiece con @ (@ejemplo.com).")


def validar_lista(valores: Sequence[str]) -> list[str]:
    """Normaliza la lista y rechaza formatos inválidos y duplicados (también los que solo difieren en mayúsculas)."""
    if len(valores) > MAX_REMITENTES:
        raise ListaRemitentesInvalida([{"valor": "", "motivo": f"Se admiten como maximo {MAX_REMITENTES} remitentes."}])
    errores: list[dict[str, str]] = []
    normalizados: list[str] = []
    for valor in valores:
        try:
            regla = normalizar_remitente(valor)
        except ReglaInvalida as error:
            errores.append({"valor": str(valor), "motivo": str(error)})
            continue
        if regla in normalizados:
            errores.append({"valor": str(valor), "motivo": f"Duplicado: {regla} ya esta en la lista."})
            continue
        normalizados.append(regla)
    if errores:
        raise ListaRemitentesInvalida(errores)
    return normalizados


def firma_remitentes(reglas: Sequence[str]) -> str:
    """Identifica la configuración de remitentes (forma parte de la clave de caché del listado)."""
    if not reglas:
        return "sin-remitentes"
    return hashlib.sha256("\n".join(sorted(reglas)).encode("utf-8")).hexdigest()[:12]


def _termino_from(regla: str) -> str:
    valor = regla[1:] if regla.startswith("@") else regla
    if not _SEGURO_EN_QUERY.fullmatch(valor):
        # No debería ocurrir: las reglas ya están validadas. Se comprueba otra vez antes de tocar la query.
        raise ReglaInvalida(f"Remitente no seguro para la consulta de Gmail: {regla!r}")
    return f'from:"{valor}"'


def construir_query(folder: str, reglas: Sequence[str]) -> str:
    """Consulta de Gmail: carpeta + ``has:attachment`` + uno o varios ``from:`` unidos con OR."""
    if not reglas:
        raise ReglaInvalida("No hay remitentes configurados.")
    terminos = [_termino_from(regla) for regla in reglas]
    remitentes = terminos[0] if len(terminos) == 1 else f"({' OR '.join(terminos)})"
    return f"{CONSULTAS_CARPETA.get(folder, 'in:inbox')} has:attachment {remitentes}"


def coincide(remitente: str, reglas: Sequence[str]) -> str | None:
    """Regla que coincide exactamente con la dirección del remitente (o None). Ver la documentación del módulo."""
    _, direccion = parseaddr(remitente or "")
    direccion = direccion.strip().lower()
    if direccion.count("@") != 1:
        return None
    dominio = direccion.split("@", 1)[1]
    for regla in reglas:
        if regla.startswith("@"):
            base = regla[1:]
            if dominio == base or dominio.endswith(f".{base}"):
                return regla
        elif direccion == regla:
            return regla
    return None
