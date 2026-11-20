"""Avisos de cambios de estructura: lo que la IA ve en los documentos de cada aseguradora frente a la plantilla del tipo.

Por tipo (``tipo["estructura_sugerida"]``) y por aseguradora se guarda:

- ``documentos``: cuántos documentos distintos se extrajeron (``vistos`` guarda la huella de cada uno, así extraer
  dos veces el mismo PDF no cuenta doble).
- ``nuevos``: datos que la IA encontró y que no están en el tipo, con cuántas veces aparecieron y un ejemplo.
- ``vacios``: racha de documentos seguidos en que cada campo del tipo salió vacío (se reinicia cuando aparece).
- ``ignorados``: campos que el usuario decidió no agregar; no se vuelven a sugerir para esa aseguradora.

Nunca cambia la plantilla: solo informa. Agregar o ignorar lo decide el usuario.
"""

from __future__ import annotations

from typing import Any

from . import plantillas_tipos
from .plantilla_campos import comparable

# Un campo del tipo que sale vacío en N documentos seguidos de la misma aseguradora se marca.
RACHA_AUSENTE = 3
# Un dato nuevo se sugiere cuando apareció en al menos este número de documentos.
MIN_APARICIONES = 2
MAX_VISTOS = 200
MAX_NUEVOS = 40
MAX_ASEGURADORAS = 30
SIN_ASEGURADORA = "Sin aseguradora identificada"


def _clave(nombre: str) -> str:
    return comparable(nombre)


def _en_tipo(tipo: dict[str, Any]) -> set[str]:
    """Nombres (comparables) que el tipo ya cubre, incluidos los equivalentes de su plantilla ("Asegurado" = "Nombre")."""
    nombres = {_clave(campo.get("nombre", "")) for campo in tipo.get("campos") or []}
    for principal, otros in plantillas_tipos.EQUIVALENTES.get((tipo.get("plantilla") or {}).get("codigo") or "", {}).items():
        grupo = {_clave(principal), *(_clave(otro) for otro in otros)}
        if grupo & nombres:
            nombres |= grupo
    return nombres


def registrar(tipo: dict[str, Any], aseguradora: str, resultado: dict[str, Any], huella: str) -> bool:
    """Suma una extracción a las estadísticas del tipo. Devuelve False si ese documento ya se había contado."""
    nombre_aseguradora = (aseguradora or "").strip()[:120] or SIN_ASEGURADORA
    todas = tipo.setdefault("estructura_sugerida", {})
    llave = _clave(nombre_aseguradora)
    datos = todas.get(llave)
    if datos is None:
        if len(todas) >= MAX_ASEGURADORAS:
            return False
        datos = todas[llave] = {"aseguradora": nombre_aseguradora, "documentos": 0, "vistos": [], "nuevos": {}, "vacios": {}, "ignorados": []}
    if huella in datos["vistos"]:
        return False
    datos["vistos"] = [*datos["vistos"], huella][-MAX_VISTOS:]
    datos["documentos"] = int(datos.get("documentos") or 0) + 1

    en_tipo = _en_tipo(tipo)
    # Datos nuevos: lo que la IA vio y no está en el tipo (las sugerencias ya excluyen los campos pedidos).
    nuevos = datos.setdefault("nuevos", {})
    vistos_aqui: set[str] = set()
    for sugerencia in resultado.get("sugerencias_campos") or []:
        nombre = str(sugerencia.get("nombre") or "").strip()
        clave = _clave(nombre)
        valores = sugerencia.get("valores") or []
        ejemplo = str(sugerencia.get("valor_documento") or (valores[0].get("valor") if valores else "") or "")
        if not clave or not ejemplo or clave in en_tipo or clave in vistos_aqui:
            continue
        vistos_aqui.add(clave)
        actual = nuevos.get(clave) or {"nombre": nombre[:60], "veces": 0}
        actual.update(veces=int(actual.get("veces") or 0) + 1, alcance="movimiento" if valores else "documento", ejemplo=ejemplo[:120])
        nuevos[clave] = actual
    if len(nuevos) > MAX_NUEVOS:
        datos["nuevos"] = dict(sorted(nuevos.items(), key=lambda item: -int(item[1].get("veces") or 0))[:MAX_NUEVOS])

    # Campos del tipo que salieron vacíos: la racha sube; si aparecen, se reinicia.
    vacios = datos.setdefault("vacios", {})
    for resultado_campo in resultado.get("resultados_campos") or []:
        nombre = str(resultado_campo.get("nombre") or "")
        clave = _clave(nombre)
        if clave not in en_tipo:
            continue
        if resultado_campo.get("encontrado"):
            vacios.pop(clave, None)
        else:
            vacios[clave] = {"nombre": nombre, "racha": int((vacios.get(clave) or {}).get("racha") or 0) + 1}
    return True


def publico(tipo: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Lo que ve el usuario: datos nuevos por aseguradora (sin los ignorados ni los ya agregados) y campos ausentes."""
    en_tipo = _en_tipo(tipo)
    sugerencias: list[dict[str, Any]] = []
    ausentes: list[dict[str, Any]] = []
    for datos in (tipo.get("estructura_sugerida") or {}).values():
        ignorados = set(datos.get("ignorados") or [])
        documentos = int(datos.get("documentos") or 0)
        for clave, nuevo in (datos.get("nuevos") or {}).items():
            if clave in en_tipo or clave in ignorados or int(nuevo.get("veces") or 0) < MIN_APARICIONES:
                continue
            sugerencias.append({"aseguradora": datos["aseguradora"], "clave": clave, "nombre": nuevo["nombre"], "alcance": nuevo.get("alcance", "documento"),
                                "veces": int(nuevo["veces"]), "documentos": documentos, "ejemplo": nuevo.get("ejemplo", "")})
        for clave, vacio in (datos.get("vacios") or {}).items():
            if clave in en_tipo and int(vacio.get("racha") or 0) >= RACHA_AUSENTE:
                ausentes.append({"aseguradora": datos["aseguradora"], "nombre": vacio["nombre"], "racha": int(vacio["racha"])})
    sugerencias.sort(key=lambda item: (-item["veces"], item["aseguradora"], item["nombre"]))
    ausentes.sort(key=lambda item: (-item["racha"], item["aseguradora"], item["nombre"]))
    return {"sugerencias_estructura": sugerencias, "campos_ausentes": ausentes}


def buscar(tipo: dict[str, Any], aseguradora: str, clave: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    datos = (tipo.get("estructura_sugerida") or {}).get(_clave(aseguradora))
    nuevo = ((datos or {}).get("nuevos") or {}).get(_clave(clave))
    return None if datos is None or nuevo is None else (datos, nuevo)


def ignorar(tipo: dict[str, Any], aseguradora: str, clave: str) -> bool:
    encontrado = buscar(tipo, aseguradora, clave)
    if encontrado is None:
        return False
    datos, _ = encontrado
    if _clave(clave) not in datos.setdefault("ignorados", []):
        datos["ignorados"].append(_clave(clave))
    return True
