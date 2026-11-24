"""Repositorios en base de datos: misma interfaz que los de JSON (``RepoDocumentos``, ``RepoEventos``, ``RepoEnvios``).

Se eligen con ``NEXORA_ALMACEN=db`` (ver ``almacenamiento.py``). Usan las 5 tablas del esquema tal como están; lo
que el esquema no tiene como columna se guarda así:

- documentos: los datos de la recepción sin columna propia (``attachment_id``, ``mime``, ``diagnostico``,
  ``bandeja``) van en ``datos["recepcion"]``. ``estado`` sale de la bandeja (``captura_manual`` mientras está
  pendiente, ``extraido`` al resolverse, ``descartado``) y ``motivo`` es el código del diagnóstico o de la bandeja.
- eventos: ``resultado`` (ok | aviso | error) se deduce del código. ``origen`` y ``detalle`` no tienen columna:
  no se guardan (el listado los devuelve en None).
- envios: un renglón por intento; ``intento`` es su número dentro del documento (1, 2, 3…), así que volver a
  sincronizar actualiza el mismo renglón y no duplica. El detalle completo del intento sigue en el JSON de la
  extracción (fuente de lo que lee el resto del código).

Cada cuenta de correo (``email``) es un renglón de ``cuentas_correo``. Si no existe se crea a nombre del usuario
``sistema`` (inactivo, sin contraseña utilizable; el login lo maneja otra parte) con la credencial cifrada con
Fernet.
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from ..db import CuentaCorreo, Documento, Envio, Evento, Usuario, a_iso, a_utc, ahora_utc
from ..seguridad import Cifrador, hash_contrasena
from .eventos import ETAPAS, MAX_LISTADO, MAX_MENSAJE

logger = logging.getLogger("nexora.repos.db")

USUARIO_SISTEMA = "sistema"

# Claves del registro JSON que tienen columna propia en ``documentos``; el resto va en datos["recepcion"].
_CON_COLUMNA = {"message_id", "part_id", "nombre", "ruta", "sha256", "tamano", "recibido_en", "asunto", "remitente", "guardado_en", "actualizado"}
_ESTADO_POR_BANDEJA = {"pendiente": "captura_manual", "resuelto": "extraido", "descartado": "descartado"}

CODIGOS_OK = {"ok", "exito"}
CODIGOS_AVISO = {"pdf_escaneado", "descartado", "omitido", "incierto", "requiere_revision", "sin_savedata", "no_existe", "original_no_guardado"}

# resultado del intento (JSON) ↔ estado del renglón de envios (enviado | pendiente | error | incierto | no_enviado).
ESTADO_ENVIO = {"exito": "enviado", "en_curso": "pendiente", "error": "error", "incierto": "incierto", "no_existe": "no_enviado"}
RESULTADO_ENVIO = {estado: resultado for resultado, estado in ESTADO_ENVIO.items()}
_ORIGENES_ENVIO = {"automatico", "configurar", "manual"}


def resultado_de(codigo: str) -> str:
    """ok | aviso | error a partir del código del evento."""
    if codigo in CODIGOS_OK:
        return "ok"
    return "aviso" if codigo in CODIGOS_AVISO else "error"


def _texto(valor: Any, maximo: int) -> str | None:
    if valor is None:
        return None
    texto = str(valor)
    return texto[:maximo] if texto else None


# --- Cuentas de correo -----------------------------------------------------------------------------

class CuentasDb:
    """email → ``cuentas_correo.id``. Crea la cuenta (y el usuario ``sistema``) la primera vez que se necesita."""

    def __init__(self, sesiones: sessionmaker[Session], cifrador: Cifrador, credencial_de: Callable[[str], str | None] = lambda _email: None,
                 proveedor: str = "gmail") -> None:
        self.sesiones = sesiones
        self.cifrador = cifrador
        self.credencial_de = credencial_de
        self.proveedor = proveedor
        self._ids: dict[str, int] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _correo(email: str) -> str:
        return email.strip().lower()

    def _buscar(self, sesion: Session, correo: str) -> int | None:
        return sesion.scalars(select(CuentaCorreo.id).where(func.lower(CuentaCorreo.correo) == correo)
                              .order_by(CuentaCorreo.activo.desc(), CuentaCorreo.id)).first()

    def id_de(self, email: str, *, crear: bool = True) -> int | None:
        correo = self._correo(email)
        if correo in self._ids:
            return self._ids[correo]
        with self.sesiones.begin() as sesion:
            encontrado = self._buscar(sesion, correo)
        if encontrado is None and crear:
            encontrado = self._crear(correo, email)
        if encontrado is not None:
            self._ids[correo] = encontrado
        return encontrado

    def _crear(self, correo: str, email: str) -> int:
        with self._lock:
            for intento in range(2):
                try:
                    with self.sesiones.begin() as sesion:
                        existente = self._buscar(sesion, correo)
                        if existente is not None:
                            return existente
                        ahora = ahora_utc()
                        cuenta = CuentaCorreo(usuario_id=self._usuario_sistema(sesion), proveedor=self.proveedor, correo=correo,
                                              credencial_cifrada=self.cifrador.cifrar(self.credencial_de(email) or ""),
                                              automatico_activo=False, activo=True, creado=ahora, actualizado=ahora)
                        sesion.add(cuenta)
                        sesion.flush()
                        logger.info("Cuenta de correo registrada en la base id=%s", cuenta.id)
                        return cuenta.id
                except IntegrityError:
                    # Otro proceso la creó al mismo tiempo: se vuelve a buscar.
                    if intento:
                        raise
        raise RuntimeError("No se pudo registrar la cuenta de correo")  # pragma: no cover

    @staticmethod
    def _usuario_sistema(sesion: Session) -> int:
        existente = sesion.scalars(select(Usuario.id).where(Usuario.usuario == USUARIO_SISTEMA)).first()
        if existente is not None:
            return existente
        ahora = ahora_utc()
        # Inactivo y con una contraseña aleatoria que nadie conoce: no sirve para entrar.
        usuario = Usuario(usuario=USUARIO_SISTEMA, nombre="Nexora (proceso automatico)", correo=None, hash_contrasena=hash_contrasena(secrets.token_urlsafe(32)),
                          rol="operador", activo=False, creado=ahora, actualizado=ahora)
        sesion.add(usuario)
        sesion.flush()
        return usuario.id


def _id_documento(sesion: Session, cuenta_id: int, message_id: str, part_id: str) -> int | None:
    return sesion.scalars(select(Documento.id).where(Documento.cuenta_id == cuenta_id, Documento.message_id == message_id, Documento.part_id == part_id)).first()


# --- Documentos ------------------------------------------------------------------------------------

def registro_desde_fila(fila: Documento) -> dict[str, Any]:
    """Renglón de ``documentos`` → registro con el mismo formato que ``DocumentosJson``."""
    datos = fila.datos if isinstance(fila.datos, dict) else {}
    registro = dict(datos.get("recepcion") or {})
    registro.update(
        message_id=fila.message_id,
        part_id=fila.part_id,
        nombre=fila.nombre_archivo,
        ruta=fila.ruta_original or None,
        sha256=fila.sha256 or None,
        tamano=fila.tamano_bytes,
        recibido_en=a_iso(fila.fecha_correo),
        asunto=fila.asunto,
        remitente=fila.remitente,
        guardado_en=a_iso(fila.creado),
        actualizado=a_iso(fila.actualizado),
    )
    return registro


def columnas_desde_registro(registro: dict[str, Any], estado_previo: str | None) -> dict[str, Any]:
    """Registro (formato JSON) → valores de las columnas de ``documentos``."""
    bandeja = registro.get("bandeja") if isinstance(registro.get("bandeja"), dict) else None
    diagnostico = registro.get("diagnostico") if isinstance(registro.get("diagnostico"), dict) else {}
    estado = _ESTADO_POR_BANDEJA.get((bandeja or {}).get("estado") or "")
    if estado is None:
        estado = estado_previo if estado_previo and estado_previo not in _ESTADO_POR_BANDEJA.values() else "leido"
    codigo_diagnostico = diagnostico.get("codigo")
    motivo = (bandeja or {}).get("codigo") or (codigo_diagnostico if codigo_diagnostico and codigo_diagnostico != "ok" else None)
    recepcion = {clave: valor for clave, valor in registro.items() if clave not in _CON_COLUMNA}
    ahora = ahora_utc()
    return {
        "nombre_archivo": (str(registro.get("nombre") or ""))[:255],
        "ruta_original": (str(registro.get("ruta") or ""))[:500],
        "sha256": (str(registro.get("sha256") or ""))[:64],
        "tamano_bytes": registro.get("tamano") if isinstance(registro.get("tamano"), int) else None,
        "fecha_correo": a_utc(registro.get("recibido_en")),
        "asunto": _texto(registro.get("asunto"), 500),
        "remitente": _texto(registro.get("remitente"), 255),
        "estado": estado,
        "motivo": _texto(motivo, 50),
        "datos": {"recepcion": recepcion},
        "creado": a_utc(registro.get("guardado_en")) or ahora,
        "actualizado": a_utc(registro.get("actualizado")) or ahora,
    }


class DocumentosDb:
    def __init__(self, sesiones: sessionmaker[Session], cuentas: CuentasDb) -> None:
        self.sesiones = sesiones
        self.cuentas = cuentas

    def _consulta(self, cuenta_id: int, message_id: str, part_id: str) -> Any:
        return select(Documento).where(Documento.cuenta_id == cuenta_id, Documento.message_id == message_id, Documento.part_id == part_id)

    def obtener(self, email: str, message_id: str, part_id: str) -> dict[str, Any] | None:
        cuenta_id = self.cuentas.id_de(email, crear=False)
        if cuenta_id is None:
            return None
        with self.sesiones.begin() as sesion:
            fila = sesion.scalars(self._consulta(cuenta_id, message_id, part_id)).first()
            return registro_desde_fila(fila) if fila else None

    def actualizar(self, email: str, message_id: str, part_id: str, cambio: Callable[[dict[str, Any] | None], dict[str, Any]]) -> dict[str, Any]:
        """Lee el renglón (bloqueado hasta terminar), aplica ``cambio`` y lo escribe en la misma transacción."""
        cuenta_id = self.cuentas.id_de(email)
        assert cuenta_id is not None
        for intento in range(2):
            try:
                with self.sesiones.begin() as sesion:
                    fila = sesion.scalars(self._consulta(cuenta_id, message_id, part_id).with_for_update()).first()
                    previo = registro_desde_fila(fila) if fila else None
                    nuevo = {**cambio(dict(previo) if previo else None), "message_id": message_id, "part_id": part_id}
                    valores = columnas_desde_registro(nuevo, fila.estado if fila else None)
                    if fila is None:
                        fila = Documento(cuenta_id=cuenta_id, message_id=message_id, part_id=part_id, **valores)
                        sesion.add(fila)
                    else:
                        valores.pop("creado")
                        for columna, valor in valores.items():
                            setattr(fila, columna, valor)
                    sesion.flush()
                    return registro_desde_fila(fila)
            except IntegrityError:
                # Lo insertó otro hilo al mismo tiempo (uq_documentos_adjunto): se repite sobre el renglón que ya existe.
                if intento:
                    raise
        raise RuntimeError("No se pudo guardar el documento")  # pragma: no cover

    def buscar_sha256(self, email: str, sha256: str) -> dict[str, Any] | None:
        cuenta_id = self.cuentas.id_de(email, crear=False)
        if cuenta_id is None:
            return None
        with self.sesiones.begin() as sesion:
            fila = sesion.scalars(select(Documento).where(Documento.cuenta_id == cuenta_id, Documento.sha256 == sha256, Documento.ruta_original != "")
                                  .order_by(Documento.id)).first()
            return registro_desde_fila(fila) if fila else None

    def listar(self, email: str, *, bandeja: str | None = None) -> list[dict[str, Any]]:
        cuenta_id = self.cuentas.id_de(email, crear=False)
        if cuenta_id is None:
            return []
        with self.sesiones.begin() as sesion:
            registros = [registro_desde_fila(fila) for fila in sesion.scalars(select(Documento).where(Documento.cuenta_id == cuenta_id).order_by(Documento.id))]
        if bandeja is not None:
            registros = [registro for registro in registros if (registro.get("bandeja") or {}).get("estado") == bandeja]
        return registros

    # --- Solo para el importador: datos de la extracción en columnas propias -------------------------

    def anotar_extraccion(self, email: str, message_id: str, part_id: str, extraccion: dict[str, Any]) -> None:
        """Tipo, aseguradora, estructura y estado (extraido/enviado) de una extracción guardada en JSON."""
        cuenta_id = self.cuentas.id_de(email)
        tipo_documento = extraccion.get("tipo_documento") or {}
        with self.sesiones.begin() as sesion:
            fila = sesion.scalars(self._consulta(cuenta_id, message_id, part_id).with_for_update()).first()
            if fila is None:
                return
            fila.tipo = _texto(tipo_documento.get("codigo") or ("EC" if not tipo_documento else None), 10)
            fila.aseguradora = _texto(tipo_documento.get("aseguradora"), 150)
            fila.estructura = _texto(tipo_documento.get("estructura"), 150)
            fila.version = tipo_documento.get("estructura_version") if isinstance(tipo_documento.get("estructura_version"), int) else None
            if fila.estado not in {"captura_manual", "descartado"}:
                fila.estado = {"enviado": "enviado", "revisado": "extraido", "borrador": "extraido"}.get(str(extraccion.get("estado")), fila.estado)


# --- Eventos ---------------------------------------------------------------------------------------

class EventosDb:
    def __init__(self, sesiones: sessionmaker[Session], cuentas: CuentasDb, reloj: Callable[[], datetime] = ahora_utc) -> None:
        self.sesiones = sesiones
        self.cuentas = cuentas
        self.reloj = reloj

    def registrar(self, email: str, *, etapa: str, codigo: str, mensaje: str, message_id: str | None = None, part_id: str | None = None,
                  origen: str | None = None, detalle: dict[str, Any] | None = None) -> dict[str, Any]:
        evento = self.insertar(email, etapa=etapa, codigo=codigo, mensaje=mensaje, message_id=message_id, part_id=part_id, fecha=self.reloj())
        assert evento is not None
        return {**evento, "origen": origen, "detalle": detalle or None}

    def insertar(self, email: str, *, etapa: str, codigo: str, mensaje: str, message_id: str | None, part_id: str | None, fecha: Any,
                 omitir_repetido: bool = False) -> dict[str, Any] | None:
        """Inserta un evento con su fecha. Con ``omitir_repetido`` (importador) no inserta uno idéntico ya existente."""
        if etapa not in ETAPAS:
            raise ValueError(f"Etapa desconocida: {etapa}")
        cuenta_id = self.cuentas.id_de(email)
        momento = a_utc(fecha) or ahora_utc()
        codigo_texto = str(codigo)[:50]
        mensaje_texto = str(mensaje or "")[:min(MAX_MENSAJE, 1000)]
        with self.sesiones.begin() as sesion:
            documento_id = _id_documento(sesion, cuenta_id, message_id, part_id) if message_id and part_id else None
            if omitir_repetido:
                repetido = sesion.scalars(select(Evento.id).where(Evento.cuenta_id == cuenta_id, Evento.documento_id.is_(None) if documento_id is None else Evento.documento_id == documento_id,
                                                                  Evento.etapa == etapa, Evento.codigo == codigo_texto, Evento.fecha == momento, Evento.mensaje == mensaje_texto)).first()
                if repetido is not None:
                    return None
            fila = Evento(documento_id=documento_id, cuenta_id=cuenta_id, usuario_id=None, etapa=etapa, resultado=resultado_de(codigo_texto),
                          codigo=codigo_texto, mensaje=mensaje_texto, fecha=momento)
            sesion.add(fila)
            sesion.flush()
            return {"id": str(fila.id), "fecha": a_iso(fila.fecha), "etapa": etapa, "codigo": codigo_texto, "mensaje": mensaje_texto,
                    "message_id": message_id, "part_id": part_id, "resultado": fila.resultado}

    def listar(self, email: str, *, message_id: str | None = None, part_id: str | None = None, etapa: str | None = None,
               desde: str | None = None, hasta: str | None = None, limite: int = 200) -> list[dict[str, Any]]:
        cuenta_id = self.cuentas.id_de(email, crear=False)
        if cuenta_id is None:
            return []
        consulta = (select(Evento, Documento.message_id, Documento.part_id).outerjoin(Documento, Evento.documento_id == Documento.id)
                    .where(Evento.cuenta_id == cuenta_id))
        if message_id is not None:
            consulta = consulta.where(Documento.message_id == message_id)
        if part_id is not None:
            consulta = consulta.where(Documento.part_id == part_id)
        if etapa is not None:
            consulta = consulta.where(Evento.etapa == etapa)
        if (inicio := a_utc(desde)) is not None:
            consulta = consulta.where(Evento.fecha >= inicio)
        if (fin := a_utc(hasta)) is not None:
            consulta = consulta.where(Evento.fecha <= fin)
        consulta = consulta.order_by(Evento.fecha.desc(), Evento.id.desc()).limit(max(1, min(limite, MAX_LISTADO)))
        with self.sesiones.begin() as sesion:
            return [{"id": str(fila.id), "fecha": a_iso(fila.fecha), "etapa": fila.etapa, "codigo": fila.codigo, "mensaje": fila.mensaje or "",
                     "message_id": mid, "part_id": pid, "origen": None, "detalle": None, "resultado": fila.resultado}
                    for fila, mid, pid in sesion.execute(consulta)]


# --- Envíos ----------------------------------------------------------------------------------------

def _datos_enviados(cuerpo: Any) -> Any:
    """El cuerpo que se mandó a SaveData (texto JSON) como JSON; si no se puede leer, el texto tal cual."""
    if cuerpo is None:
        return None
    try:
        return json.loads(cuerpo)
    except (TypeError, ValueError):
        return {"cuerpo": str(cuerpo)}


def _accion(datos_enviados: Any) -> str:
    try:
        interno = json.loads(datos_enviados["data"])
    except (TypeError, ValueError, KeyError):
        return "enviar"
    return "eliminar" if isinstance(interno, dict) and interno.get("Eliminar") is True else "enviar"


class EnviosDb:
    def __init__(self, sesiones: sessionmaker[Session], cuentas: CuentasDb) -> None:
        self.sesiones = sesiones
        self.cuentas = cuentas

    @staticmethod
    def columnas(intento: dict[str, Any]) -> dict[str, Any]:
        origen = intento.get("origen") if intento.get("origen") in _ORIGENES_ENVIO else ("automatico" if intento.get("automatico") else "manual")
        respuesta = intento.get("respuesta") if intento.get("respuesta") not in (None, "") else intento.get("error")
        return {
            "origen": origen,
            "estado": ESTADO_ENVIO.get(str(intento.get("resultado")), "error"),
            "codigo_http": intento.get("http_status") if isinstance(intento.get("http_status"), int) else None,
            "respuesta": None if respuesta is None else str(respuesta),
            "datos_enviados": _datos_enviados(intento.get("cuerpo")),
            "fecha": a_utc(intento.get("iniciado_en")) or ahora_utc(),
        }

    def sincronizar(self, email: str, message_id: str, part_id: str, envios: list[dict[str, Any]]) -> None:
        self.sincronizar_contando(email, message_id, part_id, envios)

    def sincronizar_contando(self, email: str, message_id: str, part_id: str, envios: list[dict[str, Any]]) -> tuple[int, int]:
        """(nuevos, actualizados). Un documento que no está en la tabla ``documentos`` no se puede ligar: se omite."""
        cuenta_id = self.cuentas.id_de(email)
        with self.sesiones.begin() as sesion:
            documento_id = _id_documento(sesion, cuenta_id, message_id, part_id)
            if documento_id is None:
                logger.warning("Envios sin documento en la base (se ligan al importar) message_id=%s part_id=%s", message_id, part_id)
                return 0, 0
            existentes = {fila.intento: fila for fila in sesion.scalars(select(Envio).where(Envio.documento_id == documento_id))}
            nuevos = actualizados = 0
            for numero, intento in enumerate(envios, start=1):
                if not isinstance(intento, dict):
                    continue
                valores = self.columnas(intento)
                fila = existentes.get(numero)
                if fila is None:
                    sesion.add(Envio(documento_id=documento_id, usuario_id=None, intento=numero, **valores))
                    nuevos += 1
                elif any(getattr(fila, columna) != valor for columna, valor in valores.items()):
                    for columna, valor in valores.items():
                        setattr(fila, columna, valor)
                    actualizados += 1
            return nuevos, actualizados

    def listar(self, email: str, message_id: str, part_id: str) -> list[dict[str, Any]]:
        cuenta_id = self.cuentas.id_de(email, crear=False)
        if cuenta_id is None:
            return []
        with self.sesiones.begin() as sesion:
            documento_id = _id_documento(sesion, cuenta_id, message_id, part_id)
            if documento_id is None:
                return []
            filas = sesion.scalars(select(Envio).where(Envio.documento_id == documento_id).order_by(Envio.intento, Envio.id)).all()
            return [{"id": str(fila.id), "intento": fila.intento, "accion": _accion(fila.datos_enviados), "resultado": RESULTADO_ENVIO.get(fila.estado, fila.estado),
                     "estado": fila.estado, "origen": fila.origen, "http_status": fila.codigo_http, "respuesta": fila.respuesta,
                     "cuerpo": None if fila.datos_enviados is None else json.dumps(fila.datos_enviados, ensure_ascii=False), "iniciado_en": a_iso(fila.fecha)}
                    for fila in filas]
