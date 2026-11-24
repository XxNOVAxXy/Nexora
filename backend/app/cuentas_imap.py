"""Cuentas IMAP guardadas: en modo db, en ``cuentas_correo`` (proveedor='imap'); en modo json, en un archivo.

Servidor y puerto van en sus columnas (``servidor_imap``, ``puerto_imap``). Usuario, contraseña y seguridad
(ssl/starttls/ninguna) van JUNTOS y cifrados con Fernet en ``credencial_cifrada`` (en json, en el mismo campo): no
hace falta cambiar el esquema. La contraseña nunca sale de aquí salvo en ``privada`` (solo para conectar).
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .extracciones import escribir_atomico
from .imap import SEGURIDADES, DatosCuentaImap
from .seguridad import Cifrador

logger = logging.getLogger("nexora.cuentas_imap")

MAX_CUENTAS = 20


class CuentaImapRequest(BaseModel):
    """Lo que llena la persona. ``contrasena`` nunca se devuelve (ni en errores de validación: ver main)."""

    model_config = ConfigDict(extra="ignore")

    correo: str = Field(min_length=3, max_length=254)
    servidor: str = Field(min_length=1, max_length=253)
    puerto: int = Field(ge=1, le=65535)
    seguridad: str = Field(default="ssl")
    usuario: str = Field(min_length=1, max_length=254)
    contrasena: str = Field(min_length=1, max_length=1024, repr=False)

    @field_validator("correo")
    @classmethod
    def _correo(cls, valor: str) -> str:
        correo = valor.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", correo):
            raise ValueError("El correo no es valido.")
        return correo

    @field_validator("seguridad")
    @classmethod
    def _seguridad(cls, valor: str) -> str:
        if valor not in SEGURIDADES:
            raise ValueError("La seguridad debe ser ssl, starttls o ninguna.")
        return valor


def publica(cuenta: dict[str, Any]) -> dict[str, Any]:
    """Lo que puede ver la interfaz: sin contraseña ni credencial cifrada."""
    return {clave: cuenta.get(clave) for clave in ("id", "correo", "servidor", "puerto", "seguridad", "usuario", "activo", "creado")}


def _credencial(cifrador: Cifrador, solicitud: CuentaImapRequest) -> str:
    return cifrador.cifrar(json.dumps({"usuario": solicitud.usuario, "contrasena": solicitud.contrasena, "seguridad": solicitud.seguridad}))


def _descifrada(cifrador: Cifrador, credencial: str) -> dict[str, str]:
    datos = json.loads(cifrador.descifrar(credencial) or "{}")
    return datos if isinstance(datos, dict) else {}


class CuentasImapJson:
    def __init__(self, ruta: Path, cifrador: Callable[[], Cifrador]) -> None:
        self.ruta = ruta
        self.cifrador = cifrador
        self._lock = threading.Lock()

    def _leer(self) -> list[dict[str, Any]]:
        if not self.ruta.exists():
            return []
        try:
            datos = json.loads(self.ruta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("El archivo de cuentas IMAP esta danado: no se usan cuentas IMAP")
            return []
        return [cuenta for cuenta in datos.get("cuentas") or [] if isinstance(cuenta, dict)]

    def listar(self) -> list[dict[str, Any]]:
        cifrador = None
        salida = []
        for cuenta in self._leer():
            if not cuenta.get("activo", True):
                continue
            try:
                cifrador = cifrador or self.cifrador()
                extra = _descifrada(cifrador, cuenta["credencial_cifrada"])
            except Exception:
                extra = {}
            salida.append(publica({**cuenta, "usuario": extra.get("usuario"), "seguridad": extra.get("seguridad")}))
        return salida

    def agregar(self, solicitud: CuentaImapRequest) -> dict[str, Any]:
        cifrador = self.cifrador()
        with self._lock:
            cuentas = self._leer()
            if any(c.get("correo") == solicitud.correo and c.get("activo", True) for c in cuentas):
                raise ValueError("Ya hay una cuenta IMAP con ese correo.")
            if sum(1 for c in cuentas if c.get("activo", True)) >= MAX_CUENTAS:
                raise ValueError(f"Se admiten como maximo {MAX_CUENTAS} cuentas IMAP.")
            from .db import a_iso, ahora_utc

            nueva = {"id": str(max([int(c.get("id") or 0) for c in cuentas] + [0]) + 1), "correo": solicitud.correo, "servidor": solicitud.servidor.strip().lower(),
                     "puerto": solicitud.puerto, "credencial_cifrada": _credencial(cifrador, solicitud), "activo": True, "creado": a_iso(ahora_utc())}
            cuentas.append(nueva)
            escribir_atomico(self.ruta, {"schema": 1, "cuentas": cuentas})
        return publica({**nueva, "usuario": solicitud.usuario, "seguridad": solicitud.seguridad})

    def desactivar(self, cuenta_id: str) -> bool:
        with self._lock:
            cuentas = self._leer()
            encontrada = next((c for c in cuentas if str(c.get("id")) == str(cuenta_id) and c.get("activo", True)), None)
            if encontrada is None:
                return False
            encontrada["activo"] = False
            escribir_atomico(self.ruta, {"schema": 1, "cuentas": cuentas})
            return True

    def privada(self, cuenta_id: str) -> DatosCuentaImap | None:
        cuenta = next((c for c in self._leer() if str(c.get("id")) == str(cuenta_id) and c.get("activo", True)), None)
        if cuenta is None:
            return None
        datos = _descifrada(self.cifrador(), cuenta["credencial_cifrada"])
        return DatosCuentaImap(id=str(cuenta["id"]), correo=cuenta["correo"], servidor=cuenta["servidor"], puerto=int(cuenta["puerto"]), seguridad=datos.get("seguridad", "ssl"),
                               usuario=datos.get("usuario", ""), contrasena=datos.get("contrasena", ""))


class CuentasImapDb:
    """``cuentas_correo`` con proveedor='imap', a nombre del usuario ``sistema`` (el login lo maneja otra parte)."""

    def __init__(self, sesiones: Any, cifrador: Cifrador) -> None:
        self.sesiones = sesiones
        self.cifrador = cifrador

    def _filas(self, sesion: Any) -> list[Any]:
        from sqlalchemy import select

        from .db import CuentaCorreo

        return list(sesion.scalars(select(CuentaCorreo).where(CuentaCorreo.proveedor == "imap", CuentaCorreo.activo.is_(True)).order_by(CuentaCorreo.id)))

    def _publica(self, fila: Any) -> dict[str, Any]:
        from .db import a_iso

        try:
            extra = _descifrada(self.cifrador, fila.credencial_cifrada)
        except Exception:
            extra = {}
        return publica({"id": str(fila.id), "correo": fila.correo, "servidor": fila.servidor_imap, "puerto": fila.puerto_imap, "seguridad": extra.get("seguridad"),
                        "usuario": extra.get("usuario"), "activo": bool(fila.activo), "creado": a_iso(fila.creado)})

    def listar(self) -> list[dict[str, Any]]:
        with self.sesiones.begin() as sesion:
            return [self._publica(fila) for fila in self._filas(sesion)]

    def agregar(self, solicitud: CuentaImapRequest) -> dict[str, Any]:
        from sqlalchemy.exc import IntegrityError

        from .db import CuentaCorreo, ahora_utc
        from .repos.db import CuentasDb

        try:
            with self.sesiones.begin() as sesion:
                if len(self._filas(sesion)) >= MAX_CUENTAS:
                    raise ValueError(f"Se admiten como maximo {MAX_CUENTAS} cuentas IMAP.")
                ahora = ahora_utc()
                fila = CuentaCorreo(usuario_id=CuentasDb._usuario_sistema(sesion), proveedor="imap", correo=solicitud.correo, servidor_imap=solicitud.servidor.strip().lower(),
                                    puerto_imap=solicitud.puerto, credencial_cifrada=_credencial(self.cifrador, solicitud), automatico_activo=False, activo=True,
                                    creado=ahora, actualizado=ahora)
                sesion.add(fila)
                sesion.flush()
                return self._publica(fila)
        except IntegrityError as error:
            raise ValueError("Ya hay una cuenta con ese correo (uq_cuentas_usuario_correo).") from error

    def desactivar(self, cuenta_id: str) -> bool:
        from sqlalchemy import select

        from .db import CuentaCorreo, ahora_utc

        with self.sesiones.begin() as sesion:
            fila = sesion.scalars(select(CuentaCorreo).where(CuentaCorreo.id == int(cuenta_id), CuentaCorreo.proveedor == "imap")).first()
            if fila is None or not fila.activo:
                return False
            fila.activo = False
            fila.actualizado = ahora_utc()
            return True

    def privada(self, cuenta_id: str) -> DatosCuentaImap | None:
        from sqlalchemy import select

        from .db import CuentaCorreo

        if not str(cuenta_id).isdigit():
            return None
        with self.sesiones.begin() as sesion:
            fila = sesion.scalars(select(CuentaCorreo).where(CuentaCorreo.id == int(cuenta_id), CuentaCorreo.proveedor == "imap", CuentaCorreo.activo.is_(True))).first()
            if fila is None:
                return None
            datos = _descifrada(self.cifrador, fila.credencial_cifrada)
            return DatosCuentaImap(id=str(fila.id), correo=fila.correo, servidor=fila.servidor_imap or "", puerto=int(fila.puerto_imap or 993),
                                   seguridad=datos.get("seguridad", "ssl"), usuario=datos.get("usuario", ""), contrasena=datos.get("contrasena", ""))
