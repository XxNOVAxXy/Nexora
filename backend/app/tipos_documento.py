"""Tipos de documento y estructuras (formato de cada aseguradora o banco), por cuenta.

Ruta: ``<raiz>/<cuenta_id>.json`` (escritura atómica). Modelo:

- **Tipo de documento**: nombre, código para la base de datos (``EC``, ``A``, ``AC``…), color, campos de salida y una
  sección repetible opcional (Movimientos, Incisos, Asegurados…). Los campos usan el formato de la configuración de
  campos: ``alcance="documento"`` es "Una vez"; ``alcance="movimiento"`` es un valor en cada fila de la sección.
- **Estructura**: el formato de una aseguradora dentro de un tipo. Tiene nombre, reglas para reconocerla (remitentes
  y aseguradoras detectadas en el documento) y una versión que sube cuando cambian sus reglas. Todas las estructuras
  de un tipo entregan los mismos campos y el mismo código.

Migración: el tipo "Estado de cuenta" (``tipo-ec``) se crea solo. **Sus campos no se copian**: se leen y se escriben
en la configuración de campos de siempre (``AlmacenPlantillas``), así ``/api/configuracion/campos`` y todo lo que
hoy funciona con estados de cuenta sigue igual, incluida la precarga deducida mientras no se guarde.

Detección (``detectar_tipo``), de lo más específico a lo menos:
1. Reglas de remitente (la dirección exacta gana al dominio; el dominio más largo gana al más corto).
2. Asunto de estado de cuenta → Estado de cuenta, salvo que el asunto también mencione una póliza.
3. Gemini clasifica (tipo, confianza y aseguradora). Si la aseguradora coincide con una regla, manda la regla.
Queda "Requiere revisión" (se extrae, pero no se envía solo) si no hay tipo, si la confianza es menor a
``UMBRAL_CONFIANZA`` o si el tipo no tiene campos configurados.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import estructura_sugerida, filtro_estados, plantillas_tipos
from .extracciones import MAX_CAMPOS_EXTRA, TIPO_EC_ID as TIPO_EC_ID_EXTRACCIONES, cuenta_id, escribir_atomico
from .plantilla_campos import AlmacenPlantillas, CampoPlantilla, PlantillaRequest, comparable, validar_campos
from .remitentes import ReglaInvalida, coincide, normalizar_remitente

logger = logging.getLogger("nexora.tipos")

TIPO_EC_ID = TIPO_EC_ID_EXTRACCIONES
ESTRUCTURA_EC_ID = "est-ec-predeterminada"
UMBRAL_CONFIANZA = 0.7
MAX_TIPOS = 30
MAX_ESTRUCTURAS = 50
MAX_REGLAS = 50
MAX_ASEGURADORA = 120
COLOR_EC = "#2563eb"
COLORES = ("#7c3aed", "#059669", "#d97706", "#db2777", "#0891b2", "#dc2626", "#4f46e5", "#65a30d")

MOTIVOS = {
    "sin_tipo": "No se reconoció el tipo de documento: configúralo con este documento.",
    "confianza_baja": "La IA no está segura del tipo (confianza {confianza:.0%}): confirma el tipo.",
    "sin_campos": "El tipo «{nombre}» todavía no tiene campos configurados.",
}


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _texto(valor: str, maximo: int) -> str:
    return re.sub(r"\s+", " ", valor or "").strip()[:maximo]


class ReglasEstructura(BaseModel):
    model_config = ConfigDict(extra="ignore")

    remitentes: list[str] = Field(default_factory=list, max_length=MAX_REGLAS)
    aseguradoras: list[str] = Field(default_factory=list, max_length=MAX_REGLAS)

    @field_validator("remitentes")
    @classmethod
    def _remitentes_validos(cls, valores: list[str]) -> list[str]:
        normalizados: list[str] = []
        for valor in valores:
            try:
                regla = normalizar_remitente(valor)
            except ReglaInvalida as error:
                raise ValueError(f"{valor}: {error}") from error
            if regla not in normalizados:
                normalizados.append(regla)
        return normalizados

    @field_validator("aseguradoras")
    @classmethod
    def _aseguradoras_validas(cls, valores: list[str]) -> list[str]:
        limpias: list[str] = []
        for valor in valores:
            texto = _texto(valor, MAX_ASEGURADORA)
            if texto and comparable(texto) not in {comparable(item) for item in limpias}:
                limpias.append(texto)
        return limpias


class EstructuraRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    nombre: str = Field(min_length=1, max_length=120)
    reglas: ReglasEstructura = Field(default_factory=ReglasEstructura)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, valor: str) -> str:
        texto = _texto(valor, 120)
        if not texto:
            raise ValueError("La estructura necesita un nombre (la aseguradora o el banco).")
        return texto


class SeccionTipo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    nombre: str = Field(min_length=1, max_length=60)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, valor: str) -> str:
        texto = _texto(valor, 60)
        if not texto:
            raise ValueError("La sección repetible necesita un nombre.")
        return texto


MODOS = ("manual", "ia")


def modo_predeterminado() -> str:
    """Modo de un tipo que nunca se configuró: ``manual`` (``NEXORA_MODO_PREDETERMINADO`` lo cambia)."""
    valor = os.getenv("NEXORA_MODO_PREDETERMINADO", "manual").strip().lower()
    return valor if valor in MODOS else "manual"


class TipoRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    nombre: str = Field(min_length=1, max_length=80)
    # manual: extracción por reglas, sin IA (no se llama a Gemini). ia: Gemini extrae. Sin valor: se queda el que tenía.
    modo: Literal["manual", "ia"] | None = None
    codigo: str = Field(min_length=1, max_length=5)
    color: str = Field(default="#7c3aed", pattern=r"^#[0-9a-fA-F]{6}$")
    seccion: SeccionTipo | None = None
    campos: list[CampoPlantilla] = Field(default_factory=list, max_length=MAX_CAMPOS_EXTRA)

    @field_validator("nombre")
    @classmethod
    def _nombre(cls, valor: str) -> str:
        texto = _texto(valor, 80)
        if not texto:
            raise ValueError("El tipo necesita un nombre.")
        return texto

    @field_validator("codigo")
    @classmethod
    def _codigo(cls, valor: str) -> str:
        codigo = valor.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{1,5}", codigo):
            raise ValueError("El código admite de 1 a 5 letras o números (por ejemplo A, AC, G, D, EC).")
        return codigo

    @model_validator(mode="after")
    def _campos_validos(self) -> "TipoRequest":
        # Fuera de Estado de cuenta no hay columnas fijas: "Fecha" puede ser un campo (p. ej. del recibo de fianza).
        # Los campos de EC se validan con las columnas fijas al guardarse en la configuración de campos.
        validar_campos(self.campos, fijos=False)
        if self.seccion is None and any(campo.alcance != "documento" for campo in self.campos):
            raise ValueError("Sin sección repetible, todos los campos deben ser «Una vez».")
        return self


class ConflictoTipos(ValueError):
    """Código, nombre o regla repetidos entre tipos o estructuras."""


def _estructura_ec(ahora: str | None = None) -> dict[str, Any]:
    momento = ahora or _ahora()
    return {"id": ESTRUCTURA_EC_ID, "nombre": "Predeterminada", "version": 1, "reglas": {"remitentes": [], "aseguradoras": []}, "creado": momento, "actualizado": momento}


def _tipo_ec(ahora: str | None = None) -> dict[str, Any]:
    return {"id": TIPO_EC_ID, "nombre": "Estado de cuenta", "codigo": "EC", "color": COLOR_EC, "seccion": {"nombre": "Movimientos"}, "campos": [], "estructuras": [_estructura_ec(ahora)]}


class AlmacenTipos:
    def __init__(self, raiz: Path, plantillas: AlmacenPlantillas, precargadas: tuple[dict[str, Any], ...] = plantillas_tipos.PLANTILLAS) -> None:
        self.raiz = raiz
        self.plantillas = plantillas
        # Plantillas que se precargan (las pruebas de la mecánica genérica de tipos usan una configuración vacía).
        self.precargadas = precargadas
        self._lock = threading.RLock()

    def _ruta(self, email: str) -> Path:
        return self.raiz / f"{cuenta_id(email)}.json"

    def _leer_archivo(self, email: str) -> dict[str, Any]:
        ruta = self._ruta(email)
        datos: dict[str, Any] | None = None
        if ruta.exists():
            try:
                datos = json.loads(ruta.read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                logger.warning("Tipos de documento danados (%s): se usa solo Estado de cuenta", error)
        if not isinstance(datos, dict) or not isinstance(datos.get("tipos"), list):
            datos = {"schema": 1, "tipos": [], "actualizado": None}
        # Migración: Estado de cuenta siempre existe y va primero.
        if not any(tipo.get("id") == TIPO_EC_ID for tipo in datos["tipos"]):
            datos["tipos"].insert(0, _tipo_ec())
        if self._aplicar_plantillas(datos["tipos"], self.precargadas):
            self._escribir(email, datos)
        return datos

    @staticmethod
    def _aplicar_plantillas(tipos: list[dict[str, Any]], precargadas: tuple[dict[str, Any], ...]) -> bool:
        """Plantillas precargadas (una vez por versión): crea los tipos que falten y completa los existentes con los
        campos que les falten, sin borrar ni renombrar. Devuelve True si cambió algo."""
        cambio = False
        for base in precargadas:
            marcado = next((tipo for tipo in tipos if (tipo.get("plantilla") or {}).get("codigo") == base["codigo"]), None)
            if marcado is not None and int(marcado["plantilla"].get("version") or 0) >= plantillas_tipos.VERSION_PLANTILLAS:
                continue
            tipo = marcado or next((item for item in tipos if item.get("codigo") == base["codigo"] and item.get("id") != TIPO_EC_ID), None)
            if tipo is None:
                if len(tipos) >= MAX_TIPOS or any(comparable(item.get("nombre", "")) == comparable(base["nombre"]) for item in tipos):
                    logger.warning("Plantilla %s no se creo: no hay lugar o ya hay un tipo con ese nombre", base["codigo"])
                    continue
                tipo = plantillas_tipos.nuevo_tipo(base, f"tipo-{uuid.uuid4().hex[:10]}")
                tipo["creado"] = _ahora()
                tipos.append(tipo)
                logger.info("Plantilla %s: tipo creado con %d campos", base["codigo"], len(tipo["campos"]))
            else:
                quitados = plantillas_tipos.quitar_mal_nombrados(tipo, base["codigo"])
                agregados = plantillas_tipos.completar(tipo, base, MAX_CAMPOS_EXTRA)
                logger.info("Plantilla %s: tipo existente completado agregados=%s quitados=%s", base["codigo"], agregados, quitados)
            tipo["plantilla"] = {"codigo": base["codigo"], "version": plantillas_tipos.VERSION_PLANTILLAS}
            cambio = True
        return cambio

    def _escribir(self, email: str, datos: dict[str, Any]) -> None:
        datos = {**datos, "schema": 1, "cuenta": email.strip().lower(), "actualizado": _ahora()}
        for tipo in datos["tipos"]:
            if tipo["id"] == TIPO_EC_ID:
                tipo["campos"] = []  # Los campos de EC viven en la configuración de campos.
        escribir_atomico(self._ruta(email), datos)

    def _publico(self, email: str, tipo: dict[str, Any]) -> dict[str, Any]:
        ec = tipo["id"] == TIPO_EC_ID
        campos = self.plantillas.efectiva(email) if ec else list(tipo.get("campos") or [])
        base = plantillas_tipos.plantilla((tipo.get("plantilla") or {}).get("codigo"))
        publico = {clave: valor for clave, valor in tipo.items() if clave != "estructura_sugerida"}
        return {
            **publico,
            # Avisos de cambios de estructura (por aseguradora): datos nuevos y campos que dejaron de aparecer.
            **({"sugerencias_estructura": [], "campos_ausentes": []} if ec else estructura_sugerida.publico({**tipo, "campos": campos})),
            "campos": campos,
            "modo": tipo.get("modo") if tipo.get("modo") in MODOS else modo_predeterminado(),
            "contable": ec,
            # Estado de cuenta funciona aunque no tenga campos adicionales (como siempre).
            "configurado": ec or bool(campos),
            # Tipos precargados: su plantilla, la descripción para clasificar y los campos que le faltan.
            "plantilla": None if base is None else {"codigo": base["codigo"], "version": (tipo.get("plantilla") or {}).get("version")},
            "descripcion": None if base is None else base["descripcion"],
            "plantilla_faltantes": [] if base is None else [campo["nombre"] for campo in plantillas_tipos.faltantes(tipo, base)],
        }

    def leer(self, email: str) -> list[dict[str, Any]]:
        with self._lock:
            return [self._publico(email, tipo) for tipo in self._leer_archivo(email)["tipos"]]

    def obtener(self, email: str, tipo_id: str | None) -> dict[str, Any] | None:
        return next((tipo for tipo in self.leer(email) if tipo["id"] == tipo_id), None)

    def por_codigo(self, email: str, codigo: str | None) -> dict[str, Any] | None:
        return next((tipo for tipo in self.leer(email) if codigo and tipo["codigo"] == codigo.strip().upper()), None)

    def ec(self, email: str) -> dict[str, Any]:
        tipo = self.obtener(email, TIPO_EC_ID)
        assert tipo is not None
        return tipo

    def remitentes(self, email: str) -> list[str]:
        """Todas las reglas de remitente (para el filtro de correos)."""
        reglas: list[str] = []
        for tipo in self.leer(email):
            for estructura in tipo.get("estructuras") or []:
                reglas.extend(regla for regla in (estructura.get("reglas") or {}).get("remitentes") or [] if regla not in reglas)
        return reglas

    @staticmethod
    def _validar_unicos(tipos: list[dict[str, Any]]) -> None:
        codigos = [tipo["codigo"] for tipo in tipos]
        repetidos = sorted({codigo for codigo in codigos if codigos.count(codigo) > 1})
        if repetidos:
            raise ConflictoTipos(f"El código {', '.join(repetidos)} ya lo usa otro tipo.")
        nombres = [comparable(tipo["nombre"]) for tipo in tipos]
        if len(nombres) != len(set(nombres)):
            raise ConflictoTipos("Ya hay un tipo con ese nombre.")
        vistas: dict[str, str] = {}
        for tipo in tipos:
            for estructura in tipo.get("estructuras") or []:
                reglas = estructura.get("reglas") or {}
                for regla in [*(reglas.get("remitentes") or []), *(f"aseguradora:{comparable(a)}" for a in reglas.get("aseguradoras") or [])]:
                    duenio = f"{tipo['nombre']} · {estructura['nombre']}"
                    if regla in vistas and vistas[regla] != duenio:
                        texto = regla.removeprefix("aseguradora:")
                        raise ConflictoTipos(f"La regla «{texto}» ya está en {vistas[regla]}.")
                    vistas[regla] = duenio

    def guardar_tipo(self, email: str, solicitud: TipoRequest, tipo_id: str | None = None) -> dict[str, Any]:
        """Crea (sin ``tipo_id``) o edita un tipo. Los campos de Estado de cuenta se guardan en la configuración de campos."""
        with self._lock:
            datos = self._leer_archivo(email)
            tipos = datos["tipos"]
            if tipo_id is None:
                if len(tipos) >= MAX_TIPOS:
                    raise ConflictoTipos(f"Se admiten como máximo {MAX_TIPOS} tipos.")
                actual = {"id": f"tipo-{uuid.uuid4().hex[:10]}", "estructuras": []}
                tipos.append(actual)
            else:
                actual = next((tipo for tipo in tipos if tipo["id"] == tipo_id), None)
                if actual is None:
                    raise KeyError(tipo_id)
            ec = actual["id"] == TIPO_EC_ID
            actual.update(
                nombre=solicitud.nombre,
                codigo=solicitud.codigo,
                color=solicitud.color,
                # Estado de cuenta conserva su sección de movimientos (columnas fijas y validación contable).
                seccion={"nombre": "Movimientos"} if ec else (solicitud.seccion.model_dump() if solicitud.seccion else None),
                modo=solicitud.modo or actual.get("modo") or modo_predeterminado(),
                campos=[] if ec else [campo.model_dump(exclude_none=True) for campo in solicitud.campos],
            )
            self._validar_unicos(tipos)
            if ec:
                self.plantillas.guardar(email, PlantillaRequest(campos=solicitud.campos))
            self._escribir(email, datos)
            return self._publico(email, actual)

    def guardar_estructura(self, email: str, tipo_id: str, solicitud: EstructuraRequest, estructura_id: str | None = None) -> dict[str, Any]:
        """Crea o edita una estructura. Cambiar sus reglas sube su versión."""
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            if tipo is None:
                raise KeyError(tipo_id)
            estructuras = tipo.setdefault("estructuras", [])
            ahora = _ahora()
            reglas = solicitud.reglas.model_dump()
            if estructura_id is None:
                if len(estructuras) >= MAX_ESTRUCTURAS:
                    raise ConflictoTipos(f"Se admiten como máximo {MAX_ESTRUCTURAS} estructuras por tipo.")
                if any(comparable(item["nombre"]) == comparable(solicitud.nombre) for item in estructuras):
                    raise ConflictoTipos(f"El tipo ya tiene la estructura «{solicitud.nombre}».")
                estructura = {"id": f"est-{uuid.uuid4().hex[:10]}", "nombre": solicitud.nombre, "version": 1, "reglas": reglas, "creado": ahora, "actualizado": ahora}
                estructuras.append(estructura)
            else:
                estructura = next((item for item in estructuras if item["id"] == estructura_id), None)
                if estructura is None:
                    raise KeyError(estructura_id)
                if estructura.get("reglas") != reglas:
                    estructura["version"] = int(estructura.get("version") or 1) + 1
                estructura.update(nombre=solicitud.nombre, reglas=reglas, actualizado=ahora)
            self._validar_unicos(datos["tipos"])
            self._escribir(email, datos)
            return estructura

    def agregar_reglas(self, email: str, tipo_id: str, *, nombre_estructura: str, remitente: str | None = None, aseguradora: str | None = None) -> dict[str, Any] | None:
        """Agrega reglas a la estructura con ese nombre (la crea si no existe). Devuelve la estructura, o None si no hay reglas."""
        if not remitente and not aseguradora:
            return None
        with self._lock:
            tipo = self.obtener(email, tipo_id)
            if tipo is None:
                raise KeyError(tipo_id)
            nombre = _texto(nombre_estructura, 120) or "Predeterminada"
            existente = next((item for item in tipo.get("estructuras") or [] if comparable(item["nombre"]) == comparable(nombre)), None)
            reglas = dict((existente or {}).get("reglas") or {"remitentes": [], "aseguradoras": []})
            if remitente:
                reglas["remitentes"] = [*reglas.get("remitentes", []), remitente]
            if aseguradora:
                reglas["aseguradoras"] = [*reglas.get("aseguradoras", []), aseguradora]
            solicitud = EstructuraRequest(nombre=existente["nombre"] if existente else nombre, reglas=ReglasEstructura.model_validate(reglas))
            return self.guardar_estructura(email, tipo_id, solicitud, existente["id"] if existente else None)

    # --- Avisos de cambios de estructura ---------------------------------------------------------

    def registrar_extraccion(self, email: str, tipo_id: str | None, aseguradora: str, resultado: dict[str, Any], huella: str) -> bool:
        """Suma una extracción de la IA a los avisos de estructura del tipo (nunca de Estado de cuenta). Nunca cambia
        los campos del tipo. Devuelve False si no aplica o si ese documento ya se había contado."""
        if not tipo_id or tipo_id == TIPO_EC_ID:
            return False
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            if tipo is None or not estructura_sugerida.registrar(tipo, aseguradora, resultado, huella):
                return False
            self._escribir(email, datos)
            return True

    def resolver_sugerencia(self, email: str, tipo_id: str, aseguradora: str, clave: str, accion: str) -> dict[str, Any]:
        """"Agregar" pone el dato sugerido en el tipo (en la sección si es por fila y el tipo tiene sección);
        "ignorar" no lo vuelve a sugerir para esa aseguradora."""
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            if tipo is None or tipo_id == TIPO_EC_ID:
                raise KeyError(tipo_id)
            encontrado = estructura_sugerida.buscar(tipo, aseguradora, clave)
            if encontrado is None:
                raise KeyError(clave)
            if accion == "ignorar":
                estructura_sugerida.ignorar(tipo, aseguradora, clave)
            else:
                _, nuevo = encontrado
                campos = list(tipo.get("campos") or [])
                if any(comparable(campo.get("nombre", "")) == comparable(nuevo["nombre"]) for campo in campos):
                    raise ConflictoTipos(f"El tipo ya tiene el campo «{nuevo['nombre']}».")
                if len(campos) >= MAX_CAMPOS_EXTRA:
                    raise ConflictoTipos(f"Se admiten como máximo {MAX_CAMPOS_EXTRA} campos por tipo.")
                ids = {campo.get("id") for campo in campos}
                nuevo_id = plantillas_tipos.id_campo(nuevo["nombre"]).replace("pd-", "pl-", 1)
                while nuevo_id in ids:
                    nuevo_id = f"{nuevo_id}-{len(campos) + 1}"
                alcance = "movimiento" if nuevo.get("alcance") == "movimiento" and tipo.get("seccion") else "documento"
                campos.append({"id": nuevo_id, "nombre": nuevo["nombre"], "origen": "ia", "alcance": alcance})
                TipoRequest.model_validate({**tipo, "campos": campos})
                tipo["campos"] = campos
            self._escribir(email, datos)
            return self._publico(email, tipo)

    def restaurar_plantilla(self, email: str, tipo_id: str) -> tuple[dict[str, Any], list[str]]:
        """Restaurar campos predeterminados: agrega los campos de la plantilla que falten (sin borrar ni renombrar)."""
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            if tipo is None:
                raise KeyError(tipo_id)
            base = plantillas_tipos.plantilla((tipo.get("plantilla") or {}).get("codigo"))
            if base is None:
                raise ConflictoTipos("Este tipo no tiene plantilla predeterminada.")
            agregados = plantillas_tipos.completar(tipo, base, MAX_CAMPOS_EXTRA)
            if agregados:
                self._escribir(email, datos)
            return self._publico(email, tipo), agregados

    # --- Versiones de campos de una estructura (v1 → v2…) ------------------------------------------

    def nueva_version(self, email: str, tipo_id: str, estructura_id: str | None, campos_nuevos: list[dict[str, Any]], *, origen: str = "ia",
                      nota: str | None = None) -> dict[str, Any]:
        """Crea una VERSIÓN NUEVA de los campos de la estructura (la activa + ``campos_nuevos``) sin borrar las anteriores,
        y la deja como activa. La primera vez guarda los campos de entonces como v1. Sin estructura, usa (o crea)
        «Predeterminada». Estado de cuenta no tiene versiones: sus campos son la configuración de campos."""
        if tipo_id == TIPO_EC_ID:
            raise ConflictoTipos("Estado de cuenta no tiene versiones: sus campos se editan en Configuración de campos.")
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            if tipo is None:
                raise KeyError(tipo_id)
            estructura = self._estructura_para_versiones(tipo, estructura_id)
            ahora = _ahora()
            versiones = estructura.setdefault("versiones", [])
            if not versiones:
                versiones.append({"numero": 1, "campos": [dict(campo) for campo in tipo.get("campos") or []], "creado": ahora, "origen": "inicial", "nota": None})
            activa = next((item for item in versiones if item["numero"] == estructura.get("version_activa")), versiones[-1])
            campos = [dict(campo) for campo in activa["campos"]]
            existentes = {comparable(campo.get("nombre", "")) for campo in campos}
            ids = {campo.get("id") for campo in campos}
            agregados = []
            for nuevo in campos_nuevos:
                nombre = _texto(str(nuevo.get("nombre") or ""), 60)
                if not nombre or comparable(nombre) in existentes:
                    continue
                nuevo_id = plantillas_tipos.id_campo(nombre).replace("pd-", "pl-", 1)
                while nuevo_id in ids:
                    nuevo_id = f"{nuevo_id}-{len(campos) + 1}"
                alcance = "movimiento" if nuevo.get("alcance") == "movimiento" and tipo.get("seccion") else "documento"
                campos.append({"id": nuevo_id, "nombre": nombre, "origen": "ia" if origen == "ia" else "manual", "alcance": alcance})
                existentes.add(comparable(nombre))
                ids.add(nuevo_id)
                agregados.append(nombre)
            if not agregados:
                raise ConflictoTipos("No hay campos nuevos que agregar: ya están todos en la versión activa.")
            if len(campos) > MAX_CAMPOS_EXTRA:
                raise ConflictoTipos(f"Se admiten como máximo {MAX_CAMPOS_EXTRA} campos por tipo.")
            TipoRequest.model_validate({**tipo, "campos": campos})
            numero = max(item["numero"] for item in versiones) + 1
            versiones.append({"numero": numero, "campos": campos, "creado": ahora, "origen": origen, "nota": (nota or f"Agregados: {', '.join(agregados)}")[:300]})
            estructura["version_activa"] = numero
            estructura["actualizado"] = ahora
            self._escribir(email, datos)
            return {"tipo": self._publico(email, tipo), "estructura": estructura, "version": numero, "agregados": agregados}

    def activar_version(self, email: str, tipo_id: str, estructura_id: str, numero: int) -> dict[str, Any]:
        """Elige qué versión de los campos usa la estructura desde ahora (las otras se conservan)."""
        with self._lock:
            datos = self._leer_archivo(email)
            tipo = next((item for item in datos["tipos"] if item["id"] == tipo_id), None)
            estructura = next((item for item in (tipo or {}).get("estructuras") or [] if item["id"] == estructura_id), None)
            if tipo is None or estructura is None:
                raise KeyError(estructura_id)
            if not any(item["numero"] == numero for item in estructura.get("versiones") or []):
                raise KeyError(f"v{numero}")
            estructura["version_activa"] = numero
            estructura["actualizado"] = _ahora()
            self._escribir(email, datos)
            return self._publico(email, tipo)

    @staticmethod
    def _estructura_para_versiones(tipo: dict[str, Any], estructura_id: str | None) -> dict[str, Any]:
        estructuras = tipo.setdefault("estructuras", [])
        estructura = next((item for item in estructuras if item["id"] == estructura_id), None) if estructura_id else None
        if estructura is None:
            estructura = next((item for item in estructuras if comparable(item.get("nombre", "")) == "predeterminada"), None)
        if estructura is None:
            ahora = _ahora()
            estructura = {"id": f"est-{uuid.uuid4().hex[:10]}", "nombre": "Predeterminada", "version": 1, "reglas": {"remitentes": [], "aseguradoras": []},
                          "creado": ahora, "actualizado": ahora}
            estructuras.append(estructura)
        return estructura

    def color_libre(self, email: str) -> str:
        usados = {tipo.get("color") for tipo in self.leer(email)}
        return next((color for color in COLORES if color not in usados), COLORES[0])


# --- Detección ------------------------------------------------------------------------------------

def _resumen_tipo(tipo: dict[str, Any] | None) -> dict[str, Any]:
    if tipo is None:
        return {"tipo_id": None, "codigo": None, "nombre": None, "color": None, "contable": False}
    return {"tipo_id": tipo["id"], "codigo": tipo["codigo"], "nombre": tipo["nombre"], "color": tipo.get("color"), "contable": bool(tipo.get("contable"))}


def _regla_remitente(tipos: list[dict[str, Any]], remitente: str) -> tuple[dict[str, Any], dict[str, Any], str] | None:
    """La regla de remitente más específica: dirección exacta antes que dominio, dominio largo antes que corto."""
    mejor: tuple[tuple[int, int], dict[str, Any], dict[str, Any], str] | None = None
    for tipo in tipos:
        for estructura in tipo.get("estructuras") or []:
            for regla in (estructura.get("reglas") or {}).get("remitentes") or []:
                if coincide(remitente, [regla]) is None:
                    continue
                puntaje = (1 if regla.startswith("@") else 2, len(regla))
                if mejor is None or puntaje > mejor[0]:
                    mejor = (puntaje, tipo, estructura, regla)
    return None if mejor is None else (mejor[1], mejor[2], mejor[3])


def _contiene(texto: str, buscado: str) -> bool:
    a, b = comparable(texto), comparable(buscado)
    return bool(a and b) and (a == b or re.search(rf"(?:^|\W){re.escape(b)}(?:\W|$)", a) is not None)


def _regla_aseguradora(tipos: list[dict[str, Any]], aseguradora: str) -> tuple[dict[str, Any], dict[str, Any], str] | None:
    """La regla de aseguradora más específica (la más larga) que aparece en la aseguradora detectada."""
    mejor: tuple[int, dict[str, Any], dict[str, Any], str] | None = None
    for tipo in tipos:
        for estructura in tipo.get("estructuras") or []:
            for regla in (estructura.get("reglas") or {}).get("aseguradoras") or []:
                if _contiene(aseguradora, regla) and (mejor is None or len(regla) > mejor[0]):
                    mejor = (len(regla), tipo, estructura, regla)
    return None if mejor is None else (mejor[1], mejor[2], mejor[3])


def _estructura_por_nombre(tipo: dict[str, Any] | None, aseguradora: str) -> dict[str, Any] | None:
    if tipo is None or not aseguradora:
        return None
    return next((item for item in tipo.get("estructuras") or [] if _contiene(aseguradora, item["nombre"]) or _contiene(item["nombre"], aseguradora)), None)


def finalizar_deteccion(tipo: dict[str, Any] | None, *, metodo: str, estructura: dict[str, Any] | None = None, confianza: float | None = None,
                        aseguradora: str = "", regla: str | None = None) -> dict[str, Any]:
    """Resultado de la detección, con ``requiere_revision`` y su motivo."""
    motivo = None
    if tipo is None:
        motivo = MOTIVOS["sin_tipo"]
    elif metodo == "ia" and (confianza is None or confianza < UMBRAL_CONFIANZA):
        motivo = MOTIVOS["confianza_baja"].format(confianza=confianza or 0)
    elif not tipo.get("configurado"):
        motivo = MOTIVOS["sin_campos"].format(nombre=tipo["nombre"])
    return {
        **_resumen_tipo(tipo),
        "estructura_id": (estructura or {}).get("id"),
        "estructura": (estructura or {}).get("nombre"),
        "estructura_version": (estructura or {}).get("version"),
        "metodo": metodo,
        "confianza": None if confianza is None else round(float(confianza), 3),
        "aseguradora": _texto(aseguradora, MAX_ASEGURADORA) or None,
        "regla": regla,
        "requiere_revision": motivo is not None,
        "motivo": motivo,
        "detectado_en": _ahora(),
    }


def direccion(remitente: str) -> str | None:
    """Solo la dirección del encabezado From, en minúsculas (el nombre visible se ignora)."""
    valor = parseaddr(remitente or "")[1].strip().lower()
    return valor if valor.count("@") == 1 else None


def detectar_por_reglas(tipos: list[dict[str, Any]], *, remitente: str, asunto: str) -> dict[str, Any] | None:
    """Pasos 1 y 2 (sin IA): regla de remitente o asunto de estado de cuenta. None si hay que preguntar a la IA."""
    encontrada = _regla_remitente(tipos, remitente)
    if encontrada:
        tipo, estructura, regla = encontrada
        return finalizar_deteccion(tipo, metodo="remitente", estructura=estructura, regla=regla)
    if filtro_estados.asunto_es_estado_de_cuenta(asunto) and not filtro_estados.asunto_menciona_poliza(asunto):
        ec = next((tipo for tipo in tipos if tipo["id"] == TIPO_EC_ID), None)
        if ec is not None:
            estructura = next((item for item in ec.get("estructuras") or [] if item["id"] == ESTRUCTURA_EC_ID), None)
            return finalizar_deteccion(ec, metodo="asunto", estructura=estructura, regla=filtro_estados.asunto_coincide(asunto))
    return None


PALABRAS_TIPO: dict[str, tuple[str, ...]] = {
    "EC": ("estado de cuenta", "saldo anterior", "saldo final", "movimientos del periodo"),
    "A": ("automovil", "automoviles", "vehiculo", "placas", "numero de serie", "auto individual"),
    "G": ("gastos medicos", "gastos medicos mayores", "coaseguro", "asegurados"),
    "F": ("fianza", "afianzadora", "fiado", "beneficiario de la fianza", "monto afianzado"),
    "RF": ("recibo de fianza", "recibo de pago", "importe pagado"),
}


def detectar_por_texto(tipos: list[dict[str, Any]], texto: str) -> dict[str, Any] | None:
    """Sin IA, con el texto del documento: una aseguradora de las reglas que aparezca en el texto, o el tipo cuyo nombre,
    palabras clave y etiquetas de campos aparecen más veces. None si nada destaca (entonces, si algún tipo es de
    modo IA, se le pregunta a Gemini)."""
    if not texto.strip():
        return None
    normal = comparable(texto)
    for tipo in tipos:
        for estructura in tipo.get("estructuras") or []:
            for regla in (estructura.get("reglas") or {}).get("aseguradoras") or []:
                if _contiene(normal, regla):
                    return finalizar_deteccion(tipo, metodo="aseguradora", estructura=estructura, aseguradora=regla, regla=regla)
    from .reglas_extraccion import etiquetas

    puntajes: list[tuple[float, dict[str, Any]]] = []
    for tipo in tipos:
        palabras = [comparable(tipo["nombre"]), *PALABRAS_TIPO.get(tipo["codigo"], ())]
        puntaje = sum(3 for palabra in palabras if palabra and _contiene(normal, palabra))
        puntaje += sum(1 for campo in tipo.get("campos") or [] if any(_contiene(normal, etiqueta) for etiqueta in etiquetas(campo)[:3]))
        puntajes.append((puntaje, tipo))
    puntajes.sort(key=lambda par: par[0], reverse=True)
    if not puntajes or puntajes[0][0] < 4 or (len(puntajes) > 1 and puntajes[0][0] - puntajes[1][0] < 2):
        return None
    tipo = puntajes[0][1]
    return finalizar_deteccion(tipo, metodo="texto", estructura=next(iter(tipo.get("estructuras") or []), None))


def resolver_clasificacion(tipos: list[dict[str, Any]], clasificacion: dict[str, Any]) -> dict[str, Any]:
    """Paso 3: la clasificación de la IA. Una regla de aseguradora manda sobre el tipo que propone la IA."""
    aseguradora = str(clasificacion.get("aseguradora") or "")
    encontrada = _regla_aseguradora(tipos, aseguradora) if aseguradora else None
    if encontrada:
        tipo, estructura, regla = encontrada
        return finalizar_deteccion(tipo, metodo="aseguradora", estructura=estructura, aseguradora=aseguradora, regla=regla)
    codigo = str(clasificacion.get("codigo") or "").strip().upper()
    tipo = next((item for item in tipos if codigo and item["codigo"] == codigo), None)
    confianza = clasificacion.get("confianza")
    confianza = max(0.0, min(1.0, float(confianza))) if isinstance(confianza, (int, float)) else None
    return finalizar_deteccion(tipo, metodo="ia", estructura=_estructura_por_nombre(tipo, aseguradora), confianza=confianza, aseguradora=aseguradora)


def detectar_tipo(tipos: list[dict[str, Any]], *, remitente: str, asunto: str, clasificar: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Detección completa: reglas primero; la IA solo si ninguna regla coincide."""
    deteccion = detectar_por_reglas(tipos, remitente=remitente, asunto=asunto) or resolver_clasificacion(tipos, clasificar())
    return {**deteccion, "remitente": direccion(remitente)}


def deteccion_manual(tipo: dict[str, Any], aseguradora: str = "") -> dict[str, Any]:
    """El usuario eligió el tipo: no requiere revisión por confianza (sí si el tipo no tiene campos)."""
    return finalizar_deteccion(tipo, metodo="manual", estructura=_estructura_por_nombre(tipo, aseguradora), aseguradora=aseguradora)


def para_clasificar(tipos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Lo que la IA necesita saber de cada tipo para clasificar."""
    return [{
        "codigo": tipo["codigo"],
        "nombre": tipo["nombre"],
        "seccion": (tipo.get("seccion") or {}).get("nombre"),
        **({"descripcion": tipo["descripcion"]} if tipo.get("descripcion") else {}),
        "campos": [campo["nombre"] for campo in tipo.get("campos") or []][:15],
    } for tipo in tipos]


def huella_documento(data: bytes) -> str:
    """Identifica un documento por su contenido (los avisos de estructura no cuentan dos veces el mismo PDF)."""
    return hashlib.sha256(data or b"").hexdigest()[:16]


def estructura_de(tipo: dict[str, Any] | None, estructura_id: str | None) -> dict[str, Any] | None:
    """La estructura con ese id; sin id, «Predeterminada» si existe (la que reciben los documentos sin aseguradora)."""
    estructuras = (tipo or {}).get("estructuras") or []
    if estructura_id:
        encontrada = next((item for item in estructuras if item.get("id") == estructura_id), None)
        if encontrada is not None:
            return encontrada
    return next((item for item in estructuras if comparable(item.get("nombre", "")) == "predeterminada"), None)


def campos_version(tipo: dict[str, Any] | None, estructura_id: str | None = None, version: int | None = None) -> tuple[list[dict[str, Any]], int]:
    """(campos, número de versión) con que se extrae: la versión pedida (o la activa) de la estructura; si la estructura no
    tiene versiones, los campos del tipo como v1."""
    estructura = estructura_de(tipo, estructura_id)
    versiones = (estructura or {}).get("versiones") or []
    if not versiones:
        return list((tipo or {}).get("campos") or []), 1
    numero = version or (estructura or {}).get("version_activa") or versiones[-1]["numero"]
    elegida = next((item for item in versiones if item["numero"] == numero), None)
    if elegida is None:
        raise KeyError(f"v{numero}")
    return [dict(campo) for campo in elegida["campos"]], int(elegida["numero"])


def tipo_para_extraer(tipo: dict[str, Any] | None) -> dict[str, Any] | None:
    """Tipo que recibe Gemini: None para Estado de cuenta (extracción de siempre); genérico si no hay tipo."""
    if tipo is not None and tipo.get("contable"):
        return None
    if tipo is None:
        return {"codigo": "", "nombre": "Documento", "seccion": "Filas"}
    return {"codigo": tipo["codigo"], "nombre": tipo["nombre"], "seccion": (tipo.get("seccion") or {}).get("nombre")}
