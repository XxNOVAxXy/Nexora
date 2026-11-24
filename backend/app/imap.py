"""Cuentas IMAP corporativas: adaptación de ``singularity/backend/app/imap_service.py``.

Del proyecto anterior se toman la validación del servidor (nombre de host, puerto, SSL/STARTTLS, sin URLs y sin
redes privadas salvo las autorizadas), la conexión con ``imaplib`` y los ids estables con UIDVALIDITY + UID.

``ClienteImap`` tiene la MISMA interfaz que ``GmailClient`` (``profile``, ``buscar_ids``, ``get_message``,
``attachment``): así el ciclo automático, "Revisar ahora", la bandeja y los reintentos funcionan igual con IMAP.

La contraseña nunca se registra en logs ni se devuelve: se guarda cifrada con Fernet (``cuentas_imap``) y solo
viaja en memoria hasta ``login``. Los mensajes de error se arman sin ella.
"""

from __future__ import annotations

import email.utils
import imaplib
import ipaddress
import logging
import os
import re
import socket
import ssl
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesParser
from typing import Any, Callable

from .gmail import GmailNotConnectedError

logger = logging.getLogger("nexora.imap")

SEGURIDADES = ("ssl", "starttls", "ninguna")
TIMEOUT_SEGUNDOS = 30
MAX_MENSAJE_BYTES = 30 * 1024 * 1024
MAX_EN_MEMORIA = 20
ID_IMAP = re.compile(r"^imap(\d{1,12})\.(\d{1,20})\.(\d{1,20})$")
MESES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


class ImapError(RuntimeError):
    """Error de configuración o de la conversación con el servidor (mensaje para la persona, sin contraseña)."""


class ImapSinConexion(GmailNotConnectedError):
    """No se pudo conectar o entrar al servidor IMAP: para el ciclo es como "Gmail no conectado" (no gasta intentos)."""


def es_id_imap(message_id: str) -> bool:
    return bool(ID_IMAP.fullmatch(message_id or ""))


def cuenta_de_id(message_id: str) -> str | None:
    coincidencia = ID_IMAP.fullmatch(message_id or "")
    return coincidencia.group(1) if coincidencia else None


def hosts_permitidos() -> set[str]:
    """Servidores en red privada autorizados (``NEXORA_IMAP_HOSTS_PERMITIDOS``), p. ej. un IMAP interno de la empresa."""
    return {valor.strip().lower().rstrip(".") for valor in os.getenv("NEXORA_IMAP_HOSTS_PERMITIDOS", "").split(",") if valor.strip()}


def validar_config(servidor: str, puerto: int, seguridad: str, *, resolver: Callable[[str, int], list[str]] | None = None) -> str:
    """Valida servidor, puerto y seguridad (como ``validate_config`` del proyecto anterior). Devuelve el host limpio."""
    host = str(servidor or "").strip().lower().rstrip(".")
    if not host or len(host) > 253 or any(caracter.isspace() for caracter in host):
        raise ImapError("El servidor IMAP no es valido.")
    if "://" in host or "/" in host or "@" in host:
        raise ImapError("El servidor IMAP debe ser un nombre de host (imap.empresa.com), no una URL ni un correo.")
    if seguridad not in SEGURIDADES:
        raise ImapError("La seguridad IMAP debe ser ssl, starttls o ninguna.")
    if not isinstance(puerto, int) or not 1 <= puerto <= 65535:
        raise ImapError("El puerto IMAP no es valido (1 a 65535).")
    resolver = resolver or _resolver
    try:
        direcciones = {ipaddress.ip_address(valor) for valor in resolver(host, puerto)}
    except (OSError, ValueError) as error:
        raise ImapError("No se pudo resolver el servidor IMAP.") from error
    if not direcciones:
        raise ImapError("El servidor IMAP no tiene direcciones disponibles.")
    permitido = host in hosts_permitidos()
    for direccion in direcciones:
        restringida = direccion.is_private or direccion.is_loopback or direccion.is_link_local or direccion.is_reserved or direccion.is_multicast
        if restringida and not permitido and not (seguridad == "ninguna" and direccion.is_loopback):
            raise ImapError("El servidor IMAP apunta a una red privada no autorizada (agregalo a NEXORA_IMAP_HOSTS_PERMITIDOS).")
    if seguridad == "ninguna" and not all(direccion.is_loopback for direccion in direcciones):
        raise ImapError("IMAP sin cifrado solo se permite en este equipo (127.0.0.1). Usa SSL o STARTTLS.")
    return host


def _resolver(host: str, puerto: int) -> list[str]:
    return [item[4][0] for item in socket.getaddrinfo(host, puerto, type=socket.SOCK_STREAM)]


def conectar_imaplib(host: str, puerto: int, seguridad: str) -> Any:
    """Conexión real con ``imaplib`` (en las pruebas se usa un servidor simulado)."""
    contexto = ssl.create_default_context()
    if seguridad == "ssl":
        return imaplib.IMAP4_SSL(host, puerto, ssl_context=contexto, timeout=TIMEOUT_SEGUNDOS)
    conexion = imaplib.IMAP4(host, puerto, timeout=TIMEOUT_SEGUNDOS)
    if seguridad == "starttls":
        conexion.starttls(ssl_context=contexto)
    return conexion


def _texto_encabezado(valor: Any) -> str:
    if not valor:
        return ""
    try:
        return str(make_header(decode_header(str(valor)))).strip()
    except Exception:
        return str(valor).strip()


def _bytes_de(datos: Any) -> bytes:
    for item in datos or []:
        if isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], (bytes, bytearray)):
            return bytes(item[1])
    return b""


def _partes(mensaje: Message) -> list[tuple[str, Message]]:
    """Partes hoja del mensaje, numeradas (``part-1``…), igual que ``_parts`` del proyecto anterior."""
    return [(f"part-{indice}", parte) for indice, parte in enumerate(mensaje.walk(), start=1) if not parte.is_multipart()]


@dataclass
class DatosCuentaImap:
    id: str
    correo: str
    servidor: str
    puerto: int
    seguridad: str
    usuario: str
    contrasena: str = field(repr=False)  # nunca en repr ni en logs
    carpeta: str = "INBOX"


class ClienteImap:
    """Cliente IMAP con la interfaz de ``GmailClient`` para el ciclo automático y la API."""

    def __init__(self, cuenta: DatosCuentaImap, conectar: Callable[[str, int, str], Any] = conectar_imaplib,
                 resolver: Callable[[str, int], list[str]] | None = None) -> None:
        self.cuenta = cuenta
        self._conectar = conectar
        self._resolver = resolver
        self._lock = threading.Lock()
        self._cache: dict[str, bytes] = {}

    # --- conexión ----------------------------------------------------------------------------------

    def _abrir(self) -> tuple[Any, str]:
        host = validar_config(self.cuenta.servidor, self.cuenta.puerto, self.cuenta.seguridad, resolver=self._resolver)
        try:
            conexion = self._conectar(host, self.cuenta.puerto, self.cuenta.seguridad)
        except (OSError, ssl.SSLError, imaplib.IMAP4.error, TimeoutError) as error:
            raise ImapSinConexion(f"No se pudo conectar a {host}:{self.cuenta.puerto} ({error.__class__.__name__}).") from None
        try:
            conexion.login(self.cuenta.usuario, self.cuenta.contrasena)
        except imaplib.IMAP4.error:
            self._cerrar(conexion)
            # Sin repetir la respuesta del servidor (podría citar lo enviado).
            raise ImapSinConexion("El servidor IMAP rechazo el usuario o la contrasena.") from None
        estado, _datos = conexion.select(self.cuenta.carpeta, readonly=True)
        if estado != "OK":
            self._cerrar(conexion)
            raise ImapError(f"No se pudo abrir la carpeta {self.cuenta.carpeta}.")
        validez = "0"
        respuesta = conexion.response("UIDVALIDITY")
        if respuesta and len(respuesta) > 1 and respuesta[1]:
            valor = respuesta[1][0] if isinstance(respuesta[1], list) else respuesta[1]
            validez = (valor.decode("ascii", "ignore") if isinstance(valor, bytes) else str(valor)) or "0"
        return conexion, re.sub(r"\D", "", validez) or "0"

    @staticmethod
    def _cerrar(conexion: Any) -> None:
        try:
            conexion.logout()
        except Exception:
            pass

    def probar(self) -> dict[str, Any]:
        """"Probar conexión": entra, abre la carpeta y cuenta los mensajes."""
        with self._lock:
            conexion, validez = self._abrir()
            try:
                estado, datos = conexion.uid("search", None, "ALL")
                total = len((datos or [b""])[0].split()) if estado == "OK" else 0
            finally:
                self._cerrar(conexion)
        return {"ok": True, "mensajes": total, "carpeta": self.cuenta.carpeta, "uidvalidity": validez}

    # --- interfaz de GmailClient -------------------------------------------------------------------

    def profile(self) -> dict[str, Any]:
        return {"email": self.cuenta.correo}

    def buscar_ids(self, query: str, max_results: int = 100) -> list[str]:
        """Los más recientes primero. De la consulta de Gmail solo se usa ``after:<segundos>`` (SINCE); los filtros de
        asunto y remitente se aplican después, igual que con Gmail."""
        desde = re.search(r"after:(\d+)", query or "")
        criterio = "ALL"
        if desde:
            dia = datetime.fromtimestamp(int(desde.group(1)), tz=timezone.utc)
            criterio = f"SINCE {dia.day:02d}-{MESES[dia.month - 1]}-{dia.year}"
        with self._lock:
            conexion, validez = self._abrir()
            try:
                estado, datos = conexion.uid("search", None, criterio)
            finally:
                self._cerrar(conexion)
        if estado != "OK":
            raise ImapError("El servidor IMAP no respondio la busqueda.")
        uids = [uid.decode("ascii", "ignore") for uid in (datos or [b""])[0].split()]
        return [f"imap{self.cuenta.id}.{validez}.{uid}" for uid in reversed(uids)][:max_results]

    def _crudo(self, message_id: str) -> bytes:
        coincidencia = ID_IMAP.fullmatch(message_id)
        if not coincidencia or coincidencia.group(1) != str(self.cuenta.id):
            raise ImapError("Identificador de mensaje IMAP no valido.")
        if message_id in self._cache:
            return self._cache[message_id]
        with self._lock:
            conexion, validez = self._abrir()
            try:
                if validez != coincidencia.group(2):
                    raise ImapError("La carpeta cambio en el servidor (UIDVALIDITY distinto): el mensaje ya no se puede ubicar.")
                estado, datos = conexion.uid("fetch", coincidencia.group(3), "(RFC822)")
            finally:
                self._cerrar(conexion)
        crudo = _bytes_de(datos) if estado == "OK" else b""
        if not crudo:
            raise ImapError("No se encontro el mensaje en el servidor IMAP.")
        if len(crudo) > MAX_MENSAJE_BYTES:
            raise ImapError("El mensaje IMAP supera el limite permitido.")
        if len(self._cache) >= MAX_EN_MEMORIA:
            self._cache.pop(next(iter(self._cache)))
        self._cache[message_id] = crudo
        return crudo

    def get_message(self, message_id: str) -> dict[str, Any]:
        mensaje = BytesParser(policy=policy.default).parsebytes(self._crudo(message_id))
        remitente = _texto_encabezado(mensaje.get("From"))
        fecha = None
        try:
            fecha = email.utils.parsedate_to_datetime(str(mensaje.get("Date") or ""))
        except (TypeError, ValueError):
            fecha = None
        if fecha is not None and fecha.tzinfo is None:
            fecha = fecha.replace(tzinfo=timezone.utc)
        adjuntos = []
        for indice, (parte_id, parte) in enumerate(_partes(mensaje), start=1):
            nombre = _texto_encabezado(parte.get_filename())
            if not nombre and parte.get_content_disposition() != "attachment":
                continue
            contenido = parte.get_payload(decode=True)
            adjuntos.append({"id": parte_id, "filename": nombre or f"adjunto-{indice}", "mimeType": parte.get_content_type(),
                             "size": len(contenido) if isinstance(contenido, bytes) else 0, "partId": str(indice)})
        return {"id": message_id, "subject": _texto_encabezado(mensaje.get("Subject")), "sender": remitente, "senderEmail": remitente,
                "receivedAt": None if fecha is None else fecha.astimezone(timezone.utc).isoformat(timespec="seconds"), "attachments": adjuntos,
                "snippet": "", "unread": False}

    def attachment(self, message_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        mensaje = BytesParser(policy=policy.default).parsebytes(self._crudo(message_id))
        parte = next((item for parte_id, item in _partes(mensaje) if parte_id == attachment_id), None)
        if parte is None:
            raise ImapError("El adjunto no existe en el mensaje IMAP.")
        contenido = parte.get_payload(decode=True)
        if not isinstance(contenido, bytes) or not contenido:
            raise ImapError("El adjunto IMAP esta vacio.")
        return contenido, parte.get_content_type(), _texto_encabezado(parte.get_filename()) or "adjunto"

    def clear_cache(self) -> None:
        self._cache.clear()
