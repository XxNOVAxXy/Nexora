"""Persistencia de extracciones revisadas: un archivo JSON por documento y por cuenta de Gmail.

Ruta: ``<raiz>/<cuenta_id>/<messageId>__<partId>.json``, donde ``cuenta_id`` es un hash del email.
La clave usa ``partId`` porque Gmail rota el ``attachmentId`` entre consultas.

- Escritura atómica: archivo temporal en el mismo directorio + fsync + ``os.replace``.
- Control de versión optimista: cada guardado incrementa ``version``; una versión base vieja es un conflicto.
- La validación contable se recalcula siempre aquí; nunca se acepta la que envía el cliente.
- El lock por documento es de este proceso (uvicorn de un solo proceso). Con varios workers haría falta SQLite.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .contabilidad import validar_contabilidad

logger = logging.getLogger("nexora.extracciones")

SCHEMA_VERSION = 1
MAX_TRANSACCIONES = 5000
ID_DOCUMENTO_SEGURO = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

CampoMonto = Literal["cargo", "abono", "saldo"]
CampoMontoResumen = Literal["saldo_inicial", "total_cargos", "total_abonos", "saldo_final"]


class TransaccionGuardada(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=200)
    fecha: str = Field(default="", max_length=200)
    concepto: str = Field(default="", max_length=2000)
    referencia: str = Field(default="", max_length=500)
    cargo: str = Field(default="", max_length=200)
    abono: str = Field(default="", max_length=200)
    saldo: str = Field(default="", max_length=200)
    cargo_original: str | None = Field(default=None, max_length=200)
    abono_original: str | None = Field(default=None, max_length=200)
    saldo_original: str | None = Field(default=None, max_length=200)
    origen: Literal["ia", "manual", "ia_editada"]
    dudosos: list[CampoMonto] = Field(default_factory=list)
    huella: str | None = Field(default=None, max_length=64)
    revision: Literal["no_aparece_en_extraccion", "fila_de_saldo_con_importe"] | None = None

    @field_validator("dudosos")
    @classmethod
    def _sin_repetidos(cls, valor: list[str]) -> list[str]:
        return list(dict.fromkeys(valor))


class ResumenGuardado(BaseModel):
    model_config = ConfigDict(extra="ignore")

    banco: str = Field(default="", max_length=500)
    titular: str = Field(default="", max_length=500)
    cuenta: str = Field(default="", max_length=200)
    periodo: str = Field(default="", max_length=200)
    moneda: str = Field(default="", max_length=50)
    saldo_inicial: str = Field(default="", max_length=200)
    total_cargos: str = Field(default="", max_length=200)
    total_abonos: str = Field(default="", max_length=200)
    saldo_final: str = Field(default="", max_length=200)
    saldo_inicial_original: str | None = Field(default=None, max_length=200)
    total_cargos_original: str | None = Field(default=None, max_length=200)
    total_abonos_original: str | None = Field(default=None, max_length=200)
    saldo_final_original: str | None = Field(default=None, max_length=200)
    dudosos: list[CampoMontoResumen] = Field(default_factory=list)


class GuardarExtraccionRequest(BaseModel):
    """Cuerpo del PUT. Campos desconocidos (p. ej. una ``validacion`` del cliente) se ignoran."""

    model_config = ConfigDict(extra="ignore")

    version_base: int | None = Field(default=None, ge=1)
    # "enviado" queda reservado para el envío del bloque 4: no se acepta desde este endpoint.
    estado: Literal["borrador", "revisado"]
    confirmar_problemas: bool = False
    resumen: ResumenGuardado = Field(default_factory=ResumenGuardado)
    transacciones: list[TransaccionGuardada] = Field(default_factory=list, max_length=MAX_TRANSACCIONES)
    formato_numerico: Literal["us", "eu"] | None = None
    modelo: str | None = Field(default=None, max_length=200)
    prompt_version: str | None = Field(default=None, max_length=100)
    filename: str = Field(default="", max_length=500)
    attachmentId: str | None = Field(default=None, max_length=4000)

    @field_validator("transacciones")
    @classmethod
    def _ids_unicos(cls, valor: list[TransaccionGuardada]) -> list[TransaccionGuardada]:
        ids = [item.id for item in valor]
        if len(ids) != len(set(ids)):
            raise ValueError("Los ids de las transacciones deben ser unicos.")
        return valor


class ConflictoVersion(Exception):
    def __init__(self, actual: dict[str, Any] | None) -> None:
        super().__init__("La extraccion guardada cambio desde que se cargo.")
        self.actual = actual


class RevisionConProblemas(Exception):
    def __init__(self, problemas: dict[str, Any]) -> None:
        super().__init__("La extraccion tiene problemas pendientes; confirma explicitamente para marcarla como revisada.")
        self.problemas = problemas


class ExtraccionDanada(Exception):
    pass


class EnvioEnCurso(Exception):
    """Hay un envío a SaveData en curso para este documento: no se puede editar ni enviar otra vez a la vez."""


def cuenta_id(email: str) -> str:
    """Identificador estable de la cuenta (no expone el email en rutas de archivo)."""
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()[:16]


def contar_problemas(validacion: dict[str, Any], resumen: dict[str, Any], transacciones: list[dict[str, Any]]) -> dict[str, Any]:
    """Problemas que exigen confirmación explícita para marcar como revisado (mismo cálculo en el frontend)."""
    diferencias = sum(1 for item in validacion["comprobaciones"] if item["estado"] == "diferencia")
    dudosos_por_fila = {(t["id"], campo) for t in transacciones for campo in t.get("dudosos", [])}
    dudosos = len(resumen.get("dudosos", [])) + len(dudosos_por_fila)
    invalidos = sum(1 for item in validacion["importes_invalidos"] if (item["id"], item["campo"]) not in dudosos_por_fila)
    en_revision = sum(1 for t in transacciones if t.get("revision"))
    incompleta = validacion["cuadra"] is None
    total = diferencias + dudosos + invalidos + en_revision + (1 if incompleta else 0)
    return {
        "cuadra": validacion["cuadra"],
        "diferencias": diferencias,
        "dudosos": dudosos,
        "invalidos": invalidos,
        "en_revision": en_revision,
        "validacion_incompleta": incompleta,
        "total": total,
    }


def escribir_atomico(ruta: Path, datos: dict[str, Any]) -> None:
    """Escribe JSON sin dejar nunca un archivo a medias: si algo falla, el archivo anterior queda intacto."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporal = tempfile.mkstemp(dir=ruta.parent, prefix=f".{ruta.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
            json.dump(datos, archivo, ensure_ascii=False, indent=2)
            archivo.flush()
            os.fsync(archivo.fileno())
        os.replace(temporal, ruta)
    except BaseException:
        try:
            os.unlink(temporal)
        except FileNotFoundError:
            pass
        raise


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _validar_id(valor: str, nombre: str) -> str:
    if not ID_DOCUMENTO_SEGURO.fullmatch(valor):
        raise ValueError(f"{nombre} invalido.")
    return valor


class AlmacenExtracciones:
    def __init__(self, raiz: Path) -> None:
        self.raiz = raiz
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._envios_en_curso: set[str] = set()

    def _ruta(self, email: str, message_id: str, part_id: str) -> Path:
        _validar_id(message_id, "messageId")
        _validar_id(part_id, "partId")
        return self.raiz / cuenta_id(email) / f"{message_id}__{part_id}.json"

    def _lock(self, ruta: Path) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(str(ruta), threading.Lock())

    @staticmethod
    def _leer(ruta: Path) -> dict[str, Any] | None:
        if not ruta.exists():
            return None
        try:
            return json.loads(ruta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ExtraccionDanada(f"El archivo guardado de esta extraccion esta danado: {ruta.name}") from error

    @staticmethod
    def _publica(documento: dict[str, Any]) -> dict[str, Any]:
        return {clave: valor for clave, valor in documento.items() if clave != "cuenta"}

    def obtener(self, email: str, message_id: str, part_id: str) -> dict[str, Any] | None:
        documento = self._leer(self._ruta(email, message_id, part_id))
        return None if documento is None else self._publica(documento)

    def listar(self, email: str) -> list[dict[str, Any]]:
        directorio = self.raiz / cuenta_id(email)
        if not directorio.is_dir():
            return []
        resultado = []
        for ruta in sorted(directorio.glob("*.json")):
            try:
                documento = self._leer(ruta)
            except ExtraccionDanada:
                logger.warning("Extraccion danada omitida del listado: %s", ruta.name)
                continue
            if not documento:
                continue
            resultado.append({
                "messageId": documento.get("messageId"),
                "partId": documento.get("partId"),
                "filename": documento.get("filename", ""),
                "estado": documento.get("estado"),
                "version": documento.get("version"),
                "actualizado": documento.get("actualizado"),
                "cuadra": documento.get("validacion", {}).get("cuadra"),
                "problemas": documento.get("problemas", {}).get("total", 0),
            })
        return resultado

    def guardar(self, email: str, message_id: str, part_id: str, solicitud: GuardarExtraccionRequest) -> dict[str, Any]:
        ruta = self._ruta(email, message_id, part_id)
        with self._lock(ruta):
            if str(ruta) in self._envios_en_curso:
                raise EnvioEnCurso()
            actual = self._leer(ruta)
            if solicitud.version_base is None and actual is not None:
                raise ConflictoVersion(self._publica(actual))
            if solicitud.version_base is not None and (actual is None or actual.get("version") != solicitud.version_base):
                raise ConflictoVersion(None if actual is None else self._publica(actual))

            resumen = solicitud.resumen.model_dump(exclude_none=True)
            transacciones = [item.model_dump(exclude_none=True) for item in solicitud.transacciones]
            # Nunca se confía en la validación del cliente: se recalcula con los datos recibidos.
            validacion = validar_contabilidad(resumen, transacciones, solicitud.formato_numerico)
            problemas = contar_problemas(validacion, resumen, transacciones)
            if solicitud.estado == "revisado" and problemas["total"] > 0 and not solicitud.confirmar_problemas:
                raise RevisionConProblemas(problemas)

            ahora = _ahora()
            ya_revisado = actual is not None and actual.get("estado") == "revisado"
            documento = {
                "schema": SCHEMA_VERSION,
                "cuenta": email.strip().lower(),
                "messageId": message_id,
                "partId": part_id,
                "attachmentId": solicitud.attachmentId,
                "filename": solicitud.filename,
                "estado": solicitud.estado,
                "version": 1 if actual is None else int(actual.get("version", 0)) + 1,
                "creado": ahora if actual is None else actual.get("creado", ahora),
                "actualizado": ahora,
                "revisado_en": (actual.get("revisado_en") if ya_revisado else ahora) if solicitud.estado == "revisado" else None,
                "revisado_con_problemas": solicitud.estado == "revisado" and problemas["total"] > 0,
                # El historial de envíos se conserva aunque el documento se edite después de enviarlo.
                "enviado_en": None if actual is None else actual.get("enviado_en"),
                "envios": [] if actual is None else actual.get("envios", []),
                "modelo": solicitud.modelo,
                "prompt_version": solicitud.prompt_version,
                "formato_numerico": solicitud.formato_numerico,
                "resumen": resumen,
                "transacciones": transacciones,
                "validacion": validacion,
                "problemas": problemas,
            }
            escribir_atomico(ruta, documento)
            return self._publica(documento)

    # --- Soporte para el envío a SaveData (ver savedata.py) ---------------------------------------

    def actualizar(self, email: str, message_id: str, part_id: str, cambio: Callable[[dict[str, Any] | None], dict[str, Any]]) -> dict[str, Any]:
        """Lee, aplica ``cambio`` y escribe atómicamente bajo el lock del documento."""
        ruta = self._ruta(email, message_id, part_id)
        with self._lock(ruta):
            documento = cambio(self._leer(ruta))
            escribir_atomico(ruta, documento)
            return self._publica(documento)

    def leer_completo(self, email: str, message_id: str, part_id: str) -> dict[str, Any] | None:
        return self._leer(self._ruta(email, message_id, part_id))

    def reservar_envio(self, email: str, message_id: str, part_id: str) -> str:
        """Marca un envío en curso (en este proceso). Lanza EnvioEnCurso si ya hay uno."""
        ruta = str(self._ruta(email, message_id, part_id))
        with self._locks_guard:
            if ruta in self._envios_en_curso:
                raise EnvioEnCurso()
            self._envios_en_curso.add(ruta)
        return ruta

    def liberar_envio(self, reserva: str) -> None:
        with self._locks_guard:
            self._envios_en_curso.discard(reserva)
