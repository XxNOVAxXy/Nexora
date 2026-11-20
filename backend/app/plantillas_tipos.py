"""Plantillas precargadas de tipos de documento (definidas en código, nunca en ``backend/data``).

Se armaron a partir de carátulas de 15 aseguradoras de autos, 5 de gastos médicos y 8 afianzadoras. Cada plantilla
tiene código, nombre, color, sección repetible opcional, campos ("Una vez" y por fila) y una descripción corta que se
le da a Gemini al clasificar.

Reglas (las aplica ``AlmacenTipos``):

- Si no hay un tipo con ese código, se crea con su plantilla.
- Si ya existe, solo se agregan los campos que falten: nunca se borra ni se renombra un campo existente. Un campo
  existente con un nombre equivalente (``EQUIVALENTES``) cuenta como presente.
- Se aplica una sola vez por versión de plantilla (``tipo["plantilla"] = {"codigo", "version"}``): un campo que el
  usuario borró no regresa solo; regresa con "Restaurar campos predeterminados".
- Estado de cuenta (EC) no tiene plantilla: se queda como está.
"""

from __future__ import annotations

import re
from typing import Any

from .plantilla_campos import comparable

VERSION_PLANTILLAS = 1


def _campos(una_vez: list[str], por_fila: list[str] | None = None) -> list[dict[str, str]]:
    return [{"nombre": nombre, "alcance": "documento"} for nombre in una_vez] + [{"nombre": nombre, "alcance": "movimiento"} for nombre in por_fila or []]


PLANTILLAS: tuple[dict[str, Any], ...] = (
    {
        "codigo": "A",
        "nombre": "Autos individuales",
        "color": "#7c3aed",
        "seccion": "Coberturas",
        "descripcion": "Póliza de seguro de un vehículo: marca, versión, año, placas, número de serie, motor y sus coberturas.",
        "campos": _campos(
            ["Número de póliza", "Endoso", "Inciso", "Contratante", "RFC", "Dirección", "Vigencia desde", "Vigencia hasta", "Fecha de emisión",
             "Marca", "Versión", "Año", "Número de serie", "Motor", "Placas", "Uso", "Plan", "Forma de pago", "Prima neta", "IVA", "Prima total", "Agente"],
            ["Cobertura", "Suma asegurada", "Deducible"],
        ),
    },
    {
        "codigo": "G",
        "nombre": "Gastos médicos mayores",
        "color": "#d97706",
        "seccion": "Asegurados",
        "descripcion": "Póliza de gastos médicos mayores: lista de asegurados con parentesco, suma asegurada, deducible y coaseguro.",
        "campos": _campos(
            ["Número de póliza", "Contratante", "RFC", "Dirección", "Vigencia desde", "Vigencia hasta", "Producto", "Suma asegurada", "Deducible",
             "Coaseguro", "Forma de pago", "Prima neta", "Prima total"],
            ["Nombre", "Parentesco", "Sexo", "Fecha de nacimiento", "Antigüedad"],
        ),
    },
    {
        "codigo": "F",
        "nombre": "Fianzas",
        "color": "#059669",
        "seccion": None,
        "descripcion": "Póliza de fianza emitida por una afianzadora: fiado, beneficiario, monto afianzado y obligación garantizada.",
        "campos": _campos(
            ["Número de fianza", "Afianzadora", "Fiado", "Beneficiario", "Monto afianzado", "Monto del movimiento", "Moneda", "Movimiento", "Ramo",
             "Subramo", "Tipo de fianza", "Fecha de expedición", "Vigencia desde", "Vigencia hasta", "Obligación garantizada", "Agente"],
        ),
    },
    {
        "codigo": "RF",
        "nombre": "Recibo de fianza",
        "color": "#0891b2",
        "seccion": None,
        "descripcion": "Recibo o factura CFDI (con UUID, serie y folio) que cobra la prima de una fianza y menciona su número de fianza.",
        "campos": _campos(
            ["Serie y folio", "UUID", "Fecha", "Número de fianza", "Afianzadora", "Prima neta", "Derechos", "Gastos", "IVA", "Total",
             "Forma de pago", "Método de pago"],
        ),
    },
)

# Mismo dato con otro nombre: si el tipo ya tiene alguno de estos campos, el de la plantilla no se agrega.
EQUIVALENTES: dict[str, dict[str, tuple[str, ...]]] = {
    "G": {"Nombre": ("Asegurado", "Nombre del asegurado")},
}

# Campos mal nombrados que se quitan una sola vez al aplicar la plantilla (sus valores ya extraídos no se tocan).
QUITAR_AL_MIGRAR: dict[str, tuple[str, ...]] = {
    "G": ("Gastos medicos mayores",),
}


def plantilla(codigo: str | None) -> dict[str, Any] | None:
    return next((item for item in PLANTILLAS if codigo and item["codigo"] == codigo.strip().upper()), None)


def id_campo(nombre: str) -> str:
    clave = re.sub(r"[^a-z0-9]+", "-", comparable(nombre)).strip("-")[:56] or "campo"
    return f"pd-{clave}"


def _presente(campo_plantilla: dict[str, str], nombres: set[str], codigo: str) -> str | None:
    """Nombre del campo existente que cubre al de la plantilla (el mismo o uno equivalente), o None si falta."""
    candidatos = (campo_plantilla["nombre"], *EQUIVALENTES.get(codigo, {}).get(campo_plantilla["nombre"], ()))
    return next((candidato for candidato in candidatos if comparable(candidato) in nombres), None)


def faltantes(tipo: dict[str, Any], base: dict[str, Any]) -> list[dict[str, str]]:
    """Campos de la plantilla que el tipo no tiene (ni con un nombre equivalente)."""
    nombres = {comparable(campo.get("nombre", "")) for campo in tipo.get("campos") or []}
    return [campo for campo in base["campos"] if _presente(campo, nombres, base["codigo"]) is None]


def equivalencias_usadas(tipo: dict[str, Any], base: dict[str, Any]) -> list[tuple[str, str]]:
    """(campo de la plantilla, campo existente que cuenta como él) cuando los nombres no son iguales."""
    nombres = {comparable(campo.get("nombre", "")) for campo in tipo.get("campos") or []}
    usadas = []
    for campo in base["campos"]:
        encontrado = _presente(campo, nombres, base["codigo"])
        if encontrado and comparable(encontrado) != comparable(campo["nombre"]):
            existente = next(c["nombre"] for c in tipo.get("campos") or [] if comparable(c.get("nombre", "")) == comparable(encontrado))
            usadas.append((campo["nombre"], existente))
    return usadas


def completar(tipo: dict[str, Any], base: dict[str, Any], maximo: int) -> list[str]:
    """Agrega al tipo (en su lugar) los campos que le faltan de la plantilla. Los "Una vez" van antes de los de la
    sección. Si el tipo no tiene sección y la plantilla sí, toma la de la plantilla. Devuelve los nombres agregados."""
    campos = [dict(campo) for campo in tipo.get("campos") or []]
    if not tipo.get("seccion") and base.get("seccion"):
        tipo["seccion"] = {"nombre": base["seccion"]}
    con_seccion = bool(tipo.get("seccion"))
    ids = {campo.get("id") for campo in campos}
    agregados: list[str] = []
    for campo in faltantes({**tipo, "campos": campos}, base):
        if len(campos) >= maximo:
            break
        alcance = campo["alcance"] if con_seccion else "documento"
        nuevo_id = id_campo(campo["nombre"])
        while nuevo_id in ids:
            nuevo_id = f"{nuevo_id}-{len(campos) + 1}"
        ids.add(nuevo_id)
        nuevo = {"id": nuevo_id, "nombre": campo["nombre"], "origen": "manual", "alcance": alcance}
        if alcance == "documento":
            posicion = next((i for i, actual in enumerate(campos) if actual.get("alcance") != "documento"), len(campos))
            campos.insert(posicion, nuevo)
        else:
            campos.append(nuevo)
        agregados.append(campo["nombre"])
    tipo["campos"] = campos
    return agregados


def nuevo_tipo(base: dict[str, Any], tipo_id: str) -> dict[str, Any]:
    tipo: dict[str, Any] = {"id": tipo_id, "nombre": base["nombre"], "codigo": base["codigo"], "color": base["color"],
                            "seccion": {"nombre": base["seccion"]} if base.get("seccion") else None, "campos": [], "estructuras": []}
    completar(tipo, base, maximo=10_000)
    return tipo


def quitar_mal_nombrados(tipo: dict[str, Any], codigo: str) -> list[str]:
    quitar = {comparable(nombre) for nombre in QUITAR_AL_MIGRAR.get(codigo, ())}
    antes = tipo.get("campos") or []
    quitados = [campo["nombre"] for campo in antes if comparable(campo.get("nombre", "")) in quitar]
    if quitados:
        tipo["campos"] = [campo for campo in antes if comparable(campo.get("nombre", "")) not in quitar]
    return quitados
