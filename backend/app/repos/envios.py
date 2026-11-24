"""Envíos a SaveData: cada intento (enviar o eliminar) de un documento.

Formato de un intento (el de siempre, no cambia)::

    id, accion (enviar | eliminar), iniciado_en, terminado_en, resultado (en_curso | exito | error | incierto | no_existe),
    url, cuerpo, http_status, respuesta, error, sucursal, articulo, carga_inicial, totales, version_extraccion,
    reenvio, actualizacion, agregado_de_nuevo, origen (manual | automatico | configurar), automatico

Los intentos viven en la lista ``envios`` del JSON de la extracción (``AlmacenExtracciones``), que sigue siendo la
fuente que lee el resto del código. El almacén avisa al repositorio cada vez que esa lista cambia
(``sincronizar``) con la lista completa, así que sincronizar dos veces lo mismo no duplica nada.

- ``EnviosJson``: no copia nada; los intentos ya quedaron en el JSON de la extracción con su formato.
- ``EnviosDb`` (``repos/db``): además escribe cada intento en la tabla ``envios``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from ..extracciones import AlmacenExtracciones


class RepoEnvios(Protocol):
    def listar(self, email: str, message_id: str, part_id: str) -> list[dict[str, Any]]: ...

    def sincronizar(self, email: str, message_id: str, part_id: str, envios: list[dict[str, Any]]) -> None: ...


class EnviosJson:
    """Envíos guardados dentro del JSON de cada extracción (``documento["envios"]``), sin cambiar su formato."""

    def __init__(self, almacen: "AlmacenExtracciones") -> None:
        self.almacen = almacen

    def listar(self, email: str, message_id: str, part_id: str) -> list[dict[str, Any]]:
        documento = self.almacen.leer_completo(email, message_id, part_id) or {}
        envios = documento.get("envios")
        return [dict(intento) for intento in envios if isinstance(intento, dict)] if isinstance(envios, list) else []

    def sincronizar(self, email: str, message_id: str, part_id: str, envios: list[dict[str, Any]]) -> None:
        """Nada que copiar: el almacén ya escribió la lista en el JSON de la extracción."""
        return None
