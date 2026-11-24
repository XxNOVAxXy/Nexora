"""Recepción de documentos: guardar el original, diagnosticarlo, registrar eventos y la Bandeja de captura manual.

Todo pasa por los repositorios (``repos.documentos``, ``repos.eventos``) y el almacén de originales en disco; este
módulo no escribe archivos por su cuenta.

Bandeja de captura manual: un documento entra cuando su diagnóstico no es ``ok`` (``pdf_protegido``, ``pdf_danado``,
``pdf_escaneado``, ``formato_no_soportado``) o cuando la extracción automática agotó sus intentos
(``error_extraccion``). Sale como ``resuelto`` al extraerse (Reprocesar) o al guardarse a mano, o como ``descartado``
si el usuario lo quita.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from .diagnostico import diagnosticar
from .originales import AlmacenOriginales, extension_segura
from .repos import RepoDocumentos, RepoEventos

logger = logging.getLogger("nexora.recepcion")

MOTIVOS_BANDEJA: dict[str, str] = {
    "pdf_protegido": "PDF con contrasena",
    "pdf_danado": "PDF danado",
    "pdf_escaneado": "PDF escaneado (sin texto)",
    "formato_no_soportado": "Formato no soportado",
    "error_extraccion": "No se pudo extraer",
}
ESTADOS_BANDEJA = ("pendiente", "resuelto", "descartado")


def _fecha(valor: Any) -> datetime | None:
    if not isinstance(valor, str) or not valor:
        return None
    try:
        momento = datetime.fromisoformat(valor)
    except ValueError:
        return None
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


class ServicioRecepcion:
    def __init__(self, documentos: RepoDocumentos, eventos: RepoEventos, originales: AlmacenOriginales,
                 reloj: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
        self.documentos = documentos
        self.eventos = eventos
        self.originales = originales
        self.reloj = reloj

    def _ahora(self) -> str:
        return self.reloj().astimezone(timezone.utc).isoformat(timespec="seconds")

    def evento(self, email: str, etapa: str, codigo: str, mensaje: str, *, message_id: str | None = None, part_id: str | None = None,
               origen: str | None = None, detalle: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """Registra un evento. Un fallo al registrar nunca detiene el proceso (queda en el log)."""
        try:
            return self.eventos.registrar(email, etapa=etapa, codigo=codigo, mensaje=mensaje, message_id=message_id, part_id=part_id, origen=origen, detalle=detalle)
        except Exception:
            logger.exception("No se pudo registrar el evento etapa=%s codigo=%s", etapa, codigo)
            return None

    # --- Lectura ----------------------------------------------------------------------------------

    def recibir(self, email: str, *, message_id: str, part_id: str, data: bytes, mime_type: str, filename: str, attachment_id: str | None = None,
                recibido_en: str | None = None, asunto: str | None = None, remitente: str | None = None, origen: str = "automatico") -> dict[str, Any]:
        """Guarda el original (sin duplicar), lo diagnostica, registra el evento de lectura y, si no es ``ok``, lo
        manda a la bandeja. Devuelve el registro del documento (con ``diagnostico``)."""
        diagnostico = diagnosticar(data, mime_type, filename)
        extension = diagnostico.get("extension") or extension_segura(_sufijo(filename))
        ruta: str | None = None
        sha: str | None = None
        error_guardado: str | None = None
        try:
            ruta, sha, _nuevo = self.originales.guardar(email, data, extension, _fecha(recibido_en) or self.reloj())
        except OSError as error:
            error_guardado = f"No se pudo guardar el original: {error.__class__.__name__}."
            logger.exception("No se pudo guardar el original message_id=%s part_id=%s", message_id, part_id)
        ahora = self._ahora()
        codigo = diagnostico["codigo"]

        def cambio(previo: dict[str, Any] | None) -> dict[str, Any]:
            registro = dict(previo or {})
            registro.update(
                attachment_id=attachment_id or registro.get("attachment_id"),
                nombre=filename or registro.get("nombre") or "",
                mime=diagnostico.get("mime") or (mime_type or "")[:100],
                tamano=len(data),
                sha256=sha or registro.get("sha256"),
                ruta=ruta or registro.get("ruta"),
                recibido_en=recibido_en or registro.get("recibido_en"),
                asunto=(asunto or registro.get("asunto") or "")[:200] or None,
                remitente=(remitente or registro.get("remitente") or "")[:254] or None,
                diagnostico={k: diagnostico.get(k) for k in ("codigo", "mensaje", "formato", "mime", "paginas", "caracteres")},
                guardado_en=registro.get("guardado_en") or ahora,
                actualizado=ahora,
            )
            if codigo != "ok":
                registro["bandeja"] = self._entrada_bandeja(registro.get("bandeja"), codigo, diagnostico["mensaje"], ahora)
            return registro

        documento = self.documentos.actualizar(email, message_id, part_id, cambio)
        # Dos etapas separadas: "lectura" (el archivo se recibió y su original se guardó) y "diagnostico" (si se puede extraer).
        if error_guardado:
            self.evento(email, "lectura", "original_no_guardado", error_guardado, message_id=message_id, part_id=part_id, origen=origen,
                        detalle={"sha256": sha, "tamano": len(data), "original_guardado": False})
        else:
            self.evento(email, "lectura", "ok", "Archivo recibido y original guardado.", message_id=message_id, part_id=part_id, origen=origen,
                        detalle={"sha256": sha, "tamano": len(data), "original_guardado": True})
        self.evento(email, "diagnostico", codigo, diagnostico["mensaje"], message_id=message_id, part_id=part_id, origen=origen,
                    detalle={"formato": diagnostico.get("formato"), "paginas": diagnostico.get("paginas"), "caracteres": diagnostico.get("caracteres")})
        return documento

    @staticmethod
    def _entrada_bandeja(previa: Any, codigo: str, mensaje: str, ahora: str) -> dict[str, Any]:
        """Entrada pendiente; si ya estaba pendiente conserva la fecha de entrada."""
        sigue = isinstance(previa, dict) and previa.get("estado") == "pendiente"
        return {"estado": "pendiente", "codigo": codigo, "motivo": MOTIVOS_BANDEJA.get(codigo, codigo), "mensaje": mensaje[:500],
                "entrada_en": previa.get("entrada_en") if sigue else ahora, "resuelto_en": None, "resolucion": None}

    # --- Bandeja ----------------------------------------------------------------------------------

    def a_bandeja(self, email: str, message_id: str, part_id: str, codigo: str, mensaje: str) -> dict[str, Any]:
        ahora = self._ahora()

        def cambio(previo: dict[str, Any] | None) -> dict[str, Any]:
            registro = dict(previo or {})
            registro["bandeja"] = self._entrada_bandeja(registro.get("bandeja"), codigo, mensaje, ahora)
            registro["actualizado"] = ahora
            return registro
        return self.documentos.actualizar(email, message_id, part_id, cambio)

    def resolver(self, email: str, message_id: str, part_id: str, resolucion: str, *, estado: str = "resuelto") -> dict[str, Any] | None:
        """Saca el documento de la bandeja (si estaba pendiente). Devuelve el registro o None si no estaba."""
        previo = self.documentos.obtener(email, message_id, part_id)
        if previo is None or (previo.get("bandeja") or {}).get("estado") != "pendiente":
            return None
        ahora = self._ahora()

        def cambio(registro: dict[str, Any] | None) -> dict[str, Any]:
            registro = dict(registro or {})
            registro["bandeja"] = {**(registro.get("bandeja") or {}), "estado": estado, "resuelto_en": ahora, "resolucion": resolucion}
            registro["actualizado"] = ahora
            return registro
        return self.documentos.actualizar(email, message_id, part_id, cambio)

    def bandeja(self, email: str, estado: str = "pendiente") -> list[dict[str, Any]]:
        registros = self.documentos.listar(email, bandeja=estado)
        return sorted(registros, key=lambda registro: str((registro.get("bandeja") or {}).get("entrada_en") or ""), reverse=True)

    def original(self, email: str, message_id: str, part_id: str) -> tuple[bytes, str, str] | None:
        """(contenido, mime, nombre) del original guardado en disco, o None si no está."""
        registro = self.documentos.obtener(email, message_id, part_id)
        if not registro or not registro.get("ruta"):
            return None
        try:
            data = self.originales.leer(registro["ruta"])
        except (OSError, ValueError):
            logger.warning("Original no disponible en disco message_id=%s part_id=%s", message_id, part_id)
            return None
        return data, str(registro.get("mime") or "application/octet-stream"), str(registro.get("nombre") or "")


def _sufijo(filename: str) -> str:
    nombre = filename or ""
    return nombre[nombre.rfind("."):] if "." in nombre else ""
