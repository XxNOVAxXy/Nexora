"""Configuración de campos: los campos que se capturan de cada estado de cuenta, definidos una vez por cuenta.

Ruta: ``<raiz>/<cuenta_id>.json`` (escritura atómica). Cada campo tiene un ``id`` estable, nombre, origen (``ia`` si
salió de una sugerencia de la IA, ``manual`` si lo escribió el usuario) y tipo (``documento``: una vez por estado de
cuenta; ``movimiento``: un valor en cada movimiento).

- Mientras el usuario no guarde la configuración, la lista efectiva es la deducida de sus extracciones guardadas
  (lo que se hacía antes), con ids deterministas para que los documentos se vinculen igual antes y después de guardar.
- ``aplicar_plantilla`` vincula los campos de un documento a la configuración por ``plantilla_id``: un campo
  vinculado toma el nombre nuevo si se renombró en la configuración; los que faltan se agregan vacíos. Nunca borra ni
  cambia valores, y los campos solo del documento (sin vínculo) no cambian.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .extracciones import MAX_CAMPOS_EXTRA, MAX_NOMBRE_CAMPO, ExtraccionDanada, cuenta_id, escribir_atomico

logger = logging.getLogger("nexora.plantilla")

NOMBRES_FIJOS = ("fecha", "concepto", "referencia", "cargo", "abono", "saldo")


def comparable(nombre: str) -> str:
    """Igual que ``nombreComparable`` del frontend: sin acentos, minúsculas y espacios simples."""
    sin_acentos = "".join(c for c in unicodedata.normalize("NFKD", nombre or "") if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", sin_acentos).strip().lower()


def id_determinista(nombre: str) -> str:
    clave = re.sub(r"[^a-z0-9]+", "-", comparable(nombre)).strip("-")[:56] or "campo"
    return f"pl-{clave}"


class CampoPlantilla(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    nombre: str = Field(max_length=200)
    origen: Literal["ia", "manual"] = "manual"
    alcance: Literal["documento", "movimiento"] = "movimiento"
    clave: str | None = Field(default=None, max_length=64)

    @field_validator("nombre")
    @classmethod
    def _nombre_valido(cls, valor: str) -> str:
        nombre = re.sub(r"\s+", " ", valor).strip()
        if not nombre:
            raise ValueError("El nombre del campo no puede estar vacio.")
        if len(nombre) > MAX_NOMBRE_CAMPO:
            raise ValueError(f"El nombre del campo admite hasta {MAX_NOMBRE_CAMPO} caracteres.")
        if comparable(nombre) in NOMBRES_FIJOS:
            raise ValueError(f"«{nombre}» ya es un campo fijo de la tabla.")
        return nombre


class PlantillaRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    campos: list[CampoPlantilla] = Field(default_factory=list, max_length=MAX_CAMPOS_EXTRA)

    @model_validator(mode="after")
    def _sin_repetidos(self) -> "PlantillaRequest":
        ids = [campo.id for campo in self.campos]
        if len(ids) != len(set(ids)):
            raise ValueError("Los ids de los campos deben ser unicos.")
        nombres = [comparable(campo.nombre) for campo in self.campos]
        repetidos = sorted({nombre for nombre in nombres if nombres.count(nombre) > 1})
        if repetidos:
            raise ValueError(f"Hay campos repetidos: {', '.join(repetidos)}.")
        return self


def deducir_campos(almacen: Any, email: str) -> list[dict[str, Any]]:
    """Lo que se hacía antes de la configuración: los campos que el usuario agregó o aceptó en sus extracciones
    guardadas (más recientes primero), sin repetidos y como máximo 30. Las sugerencias no elegidas nunca cuentan."""
    listado = sorted(almacen.listar(email), key=lambda item: item.get("actualizado") or "", reverse=True)
    campos: list[dict[str, Any]] = []
    vistos: set[str] = set()
    for entrada in listado:
        try:
            documento = almacen.obtener(email, entrada["messageId"], entrada["partId"])
        except (ExtraccionDanada, ValueError, TypeError, KeyError):
            continue
        for campo in (documento or {}).get("campos_extra") or []:
            nombre = re.sub(r"\s+", " ", str(campo.get("nombre") or "")).strip()[:MAX_NOMBRE_CAMPO]
            if not nombre or comparable(nombre) in vistos or comparable(nombre) in NOMBRES_FIJOS:
                continue
            vistos.add(comparable(nombre))
            campos.append({
                "id": id_determinista(nombre),
                "nombre": nombre,
                "origen": "ia" if campo.get("origen") == "ia" else "manual",
                "alcance": "documento" if campo.get("alcance") == "documento" else "movimiento",
                **({"clave": campo["clave"]} if campo.get("clave") else {}),
            })
            if len(campos) >= MAX_CAMPOS_EXTRA:
                return campos
    return campos


class AlmacenPlantillas:
    def __init__(self, raiz: Path, deducir: Callable[[str], list[dict[str, Any]]] = lambda _email: []) -> None:
        self.raiz = raiz
        self.deducir = deducir
        self._lock = threading.Lock()

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.json"

    def _guardada(self, email: str) -> dict[str, Any] | None:
        ruta = self._ruta(email)
        if not ruta.exists():
            return None
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
            campos = PlantillaRequest.model_validate({"campos": datos.get("campos") or []}).campos
        except (OSError, ValueError) as error:
            logger.warning("Configuracion de campos danada (%s): se usa la deducida", error)
            return None
        return {"campos": [campo.model_dump(exclude_none=True) for campo in campos], "actualizado": datos.get("actualizado")}

    def leer(self, email: str) -> dict[str, Any]:
        guardada = self._guardada(email)
        if guardada is not None:
            return {"configurada": True, **guardada}
        # Primera vez: precargada con lo que hoy se deduce de las extracciones guardadas.
        return {"configurada": False, "campos": self.deducir(email), "actualizado": None}

    def efectiva(self, email: str) -> list[dict[str, Any]]:
        return self.leer(email)["campos"]

    def guardar(self, email: str, solicitud: PlantillaRequest) -> dict[str, Any]:
        datos = {
            "cuenta": email.strip().lower(),
            "campos": [campo.model_dump(exclude_none=True) for campo in solicitud.campos],
            "actualizado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            escribir_atomico(self._ruta(email), datos)
        return self.leer(email)


def aplicar_plantilla(documento: dict[str, Any], plantilla: list[dict[str, Any]]) -> dict[str, Any]:
    """Vincula y completa los campos del documento con la configuración. Si no cambia nada devuelve el mismo dict.

    - Un campo con ``plantilla_id`` de la configuración toma su nombre actual (si el nombre nuevo no choca con otro
      campo del documento). Su tipo y sus valores se conservan.
    - Un campo sin vínculo con el mismo nombre que uno de la configuración queda vinculado.
    - Los campos de la configuración que faltan se agregan vacíos.
    """
    if not plantilla:
        return documento
    campos = [dict(campo) for campo in documento.get("campos_extra") or []]
    cambio = False
    por_plantilla = {campo.get("plantilla_id"): campo for campo in campos if campo.get("plantilla_id")}
    for configurado in plantilla:
        vinculado = por_plantilla.get(configurado["id"])
        if vinculado is None:
            vinculado = next((c for c in campos if not c.get("plantilla_id") and comparable(c.get("nombre", "")) == comparable(configurado["nombre"])), None)
            if vinculado is not None:
                vinculado["plantilla_id"] = configurado["id"]
                cambio = True
        if vinculado is not None:
            otro = any(c is not vinculado and comparable(c.get("nombre", "")) == comparable(configurado["nombre"]) for c in campos)
            if vinculado.get("nombre") != configurado["nombre"] and not otro:
                vinculado["nombre"] = configurado["nombre"]
                cambio = True
            continue
        if len(campos) >= MAX_CAMPOS_EXTRA or any(comparable(c.get("nombre", "")) == comparable(configurado["nombre"]) for c in campos):
            continue
        ids = {c.get("id") for c in campos}
        nuevo_id = configurado["id"] if configurado["id"] not in ids else f"{configurado['id']}-{len(campos) + 1}"
        nuevo: dict[str, Any] = {"id": nuevo_id, "nombre": configurado["nombre"], "origen": configurado.get("origen", "manual"), "plantilla_id": configurado["id"]}
        if configurado.get("clave"):
            nuevo["clave"] = configurado["clave"]
        if configurado.get("alcance") == "documento":
            nuevo.update(alcance="documento", valor="")
        campos.append(nuevo)
        cambio = True
    return {**documento, "campos_extra": campos} if cambio else documento


def sugerencias_para_configurar(resultado: dict[str, Any]) -> list[dict[str, Any]]:
    """Sugerencias de la IA (las mismas de "+ Campo") con un valor de ejemplo y su tipo. Nunca inventa campos."""
    sugerencias = []
    for sugerencia in resultado.get("sugerencias_campos") or []:
        valores = sugerencia.get("valores") or []
        ejemplo = sugerencia.get("valor_documento") or (valores[0].get("valor") if valores else "")
        if not sugerencia.get("nombre") or not ejemplo:
            continue
        sugerencias.append({
            "clave": sugerencia.get("clave"),
            "nombre": sugerencia["nombre"],
            "ejemplo": ejemplo,
            "alcance": "movimiento" if valores else "documento",
            "filas": len(valores),
        })
    return sugerencias
