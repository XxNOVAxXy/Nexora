"""Preferencias por cuenta de Gmail guardadas en el backend (nunca en el navegador).

- Remitentes de estados de cuenta: ``<raiz>/configuracion/<hash cuenta>.json``.
- Clasificaciones manuales de correos: ``<raiz>/clasificaciones/<hash cuenta>.json``.

Escritura atómica (ver ``extracciones.escribir_atomico``) y un lock por archivo dentro del proceso.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .extracciones import ID_DOCUMENTO_SEGURO, cuenta_id, escribir_atomico
from .remitentes import firma_remitentes, validar_lista

logger = logging.getLogger("nexora.preferencias")
Clasificacion = Literal["ESTADO_DE_CUENTA", "NO_ES_ESTADO_DE_CUENTA", "REQUIERE_REVISION"]
MAX_CLASIFICACIONES_MIGRACION = 5000


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class _ArchivoPorCuenta:
    def __init__(self, directorio: Path) -> None:
        self.directorio = directorio
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def ruta(self, email: str) -> Path:
        return self.directorio / f"{cuenta_id(email)}.json"

    def lock(self, email: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(cuenta_id(email), threading.Lock())

    def leer(self, email: str) -> dict[str, Any]:
        ruta = self.ruta(email)
        if not ruta.exists():
            return {}
        try:
            datos = json.loads(ruta.read_text(encoding="utf-8"))
            return datos if isinstance(datos, dict) else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.warning("Archivo de preferencias danado, se ignora: %s", ruta.name)
            return {}


class RemitentesRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    remitentes: list[str] = Field(default_factory=list, max_length=200)


class ConfiguracionCuenta:
    def __init__(self, directorio: Path) -> None:
        self.archivos = _ArchivoPorCuenta(directorio)

    def leer(self, email: str) -> dict[str, Any]:
        datos = self.archivos.leer(email)
        remitentes = [r for r in datos.get("remitentes", []) if isinstance(r, str)]
        return {"remitentes": remitentes, "actualizado": datos.get("actualizado"), "firma": firma_remitentes(remitentes)}

    def guardar_remitentes(self, email: str, valores: list[str]) -> dict[str, Any]:
        remitentes = validar_lista(valores)  # lanza ListaRemitentesInvalida
        with self.archivos.lock(email):
            datos = self.archivos.leer(email)
            escribir_atomico(self.archivos.ruta(email), {**datos, "schema": 1, "remitentes": remitentes, "actualizado": _ahora()})
        return self.leer(email)


class ClasificacionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    classification: Clasificacion
    fingerprint: str = Field(min_length=1, max_length=128)


class MigracionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    clasificaciones: dict[str, ClasificacionRequest] = Field(default_factory=dict, max_length=MAX_CLASIFICACIONES_MIGRACION)


def validar_message_id(message_id: str) -> str:
    if not ID_DOCUMENTO_SEGURO.fullmatch(message_id):
        raise ValueError("messageId invalido.")
    return message_id


class AlmacenClasificaciones:
    """Clasificaciones manuales por cuenta, con migración única desde el navegador."""

    def __init__(self, directorio: Path) -> None:
        self.archivos = _ArchivoPorCuenta(directorio)

    def leer(self, email: str) -> dict[str, Any]:
        datos = self.archivos.leer(email)
        return {"clasificaciones": datos.get("clasificaciones", {}), "migrado_en": datos.get("migrado_en")}

    def _modificar(self, email: str, cambio: Any) -> dict[str, Any]:
        with self.archivos.lock(email):
            datos = self.archivos.leer(email)
            datos = {"schema": 1, "clasificaciones": {}, "migrado_en": None, **datos}
            resultado = cambio(datos)
            escribir_atomico(self.archivos.ruta(email), datos)
        return resultado

    def poner(self, email: str, message_id: str, solicitud: ClasificacionRequest) -> dict[str, Any]:
        validar_message_id(message_id)
        entrada = {"classification": solicitud.classification, "fingerprint": solicitud.fingerprint, "actualizado": _ahora()}

        def cambio(datos: dict[str, Any]) -> dict[str, Any]:
            datos["clasificaciones"] = {**datos["clasificaciones"], message_id: entrada}
            return entrada

        return self._modificar(email, cambio)

    def quitar(self, email: str, message_id: str) -> None:
        validar_message_id(message_id)

        def cambio(datos: dict[str, Any]) -> None:
            datos["clasificaciones"] = {clave: valor for clave, valor in datos["clasificaciones"].items() if clave != message_id}

        self._modificar(email, cambio)

    def migrar(self, email: str, solicitud: MigracionRequest) -> dict[str, Any]:
        """Migración única: no sobrescribe clasificaciones existentes; un segundo intento no cambia nada."""
        for message_id in solicitud.clasificaciones:
            validar_message_id(message_id)

        def cambio(datos: dict[str, Any]) -> dict[str, Any]:
            if datos.get("migrado_en"):
                return {"migradas": 0, "ya_migrado": True, "migrado_en": datos["migrado_en"]}
            actuales = dict(datos["clasificaciones"])
            migradas = 0
            ahora = _ahora()
            for message_id, entrada in solicitud.clasificaciones.items():
                if message_id in actuales:
                    continue
                actuales[message_id] = {"classification": entrada.classification, "fingerprint": entrada.fingerprint, "actualizado": ahora, "migrado": True}
                migradas += 1
            datos["clasificaciones"] = actuales
            datos["migrado_en"] = ahora
            return {"migradas": migradas, "ya_migrado": False, "migrado_en": ahora}

        return self._modificar(email, cambio)
