"""Estado de envío de un documento, con una etiqueta clara y su motivo (lo muestra "Documentos que llegaron").

Sale del historial de intentos del documento (cada intento guarda su ``origen``: ``manual``, ``automatico`` o
``configurar``; los intentos anteriores a esta marca se leen como automáticos si el proceso los marcó, si no como a
mano) y del registro del proceso automático (pendiente, requiere revisión, omitido…).

Estados y filtros:

- ``enviado`` (Enviados): "Enviado automáticamente", "Enviado al configurar" o "Enviado a mano", con fecha y la
  respuesta de SaveData.
- ``pendiente`` (Pendientes): "Pendiente de envío (se reintentará en la próxima revisión)" o "Pendiente de envío
  (pedido al configurar)" cuando no se pudo conectar con SaveData.
- ``no_enviado`` (No enviados): "No se envió: <motivo>".
- ``error`` / ``incierto`` (Con error): "Error al enviar" o "Incierto, verificar".
"""

from __future__ import annotations

import json
from typing import Any

from .savedata import estado_en_savedata

ETIQUETA_ENVIADO = {"automatico": "Enviado automáticamente", "configurar": "Enviado al configurar", "manual": "Enviado a mano"}
PENDIENTE = "Pendiente de envío (se reintentará en la próxima revisión)"
PENDIENTE_CONFIGURAR = "Pendiente de envío (pedido al configurar)"
FILTRO = {"enviado": "enviados", "pendiente": "pendientes", "en_curso": "pendientes", "no_enviado": "no_enviados", "error": "con_error", "incierto": "con_error"}


def origen_de(intento: dict[str, Any]) -> str:
    origen = intento.get("origen")
    if origen in ETIQUETA_ENVIADO:
        return origen
    return "automatico" if intento.get("automatico") else "manual"


def _respuesta(intento: dict[str, Any]) -> tuple[int | None, str | None]:
    """(code, texto) de la respuesta de SaveData guardada en el intento."""
    try:
        datos = json.loads(intento.get("respuesta") or "")
    except (TypeError, ValueError):
        return None, None
    if not isinstance(datos, dict):
        return None, None
    code = datos.get("code")
    code = code if isinstance(code, int) and not isinstance(code, bool) else None
    mensaje = datos.get("message")
    texto = f"code {code}" + (f": {mensaje}" if mensaje else "") if code is not None else (str(mensaje) if mensaje else None)
    return code, texto


def _motivo_omitido(error: str) -> str:
    texto = (error or "").lower()
    if "edit" in texto:
        return "editado a mano"
    if "manualmente" in texto:
        return "ya se envió a mano"
    return error or "se omitió"


def _resultado(estado: str, etiqueta: str, motivo: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"estado": estado, "filtro": FILTRO[estado], "etiqueta": etiqueta, "motivo": motivo or None, "fecha": extra.get("fecha"),
            "code": extra.get("code"), "respuesta": extra.get("respuesta"), "origen": extra.get("origen")}


def estado_envio(documento: dict[str, Any], entrada_auto: dict[str, Any] | None = None) -> dict[str, Any]:
    """Estado de envío del documento. ``entrada_auto`` es su registro en el proceso automático (o None)."""
    envios = [intento for intento in documento.get("envios") or [] if intento.get("accion", "enviar") == "enviar"]
    ultimo = envios[-1] if envios else None
    auto = dict((entrada_auto or {}).get("envio") or documento.get("envio_automatico") or {})
    origen_auto = auto.get("origen") or (entrada_auto or {}).get("origen_envio")
    estado_auto = auto.get("estado")

    if estado_en_savedata(documento) == "eliminado":
        return _resultado("no_enviado", "No se envió: se eliminó de SaveData", "El documento se eliminó de SaveData desde Nexora.")
    if documento.get("estado") == "enviado" or (ultimo is not None and ultimo.get("resultado") == "exito"):
        exito = next((intento for intento in reversed(envios) if intento.get("resultado") == "exito"), ultimo or {})
        origen = origen_de(exito)
        code, respuesta = _respuesta(exito)
        return _resultado("enviado", ETIQUETA_ENVIADO[origen], respuesta, fecha=exito.get("terminado_en") or documento.get("enviado_en"), code=code, respuesta=respuesta, origen=origen)
    if ultimo is not None and ultimo.get("resultado") == "en_curso" or estado_auto == "en_curso":
        return _resultado("en_curso", "Enviando a SaveData…", None, fecha=(ultimo or {}).get("iniciado_en"))
    if estado_auto == "pendiente":
        error = auto.get("error") or "El envío anterior no se completó."
        etiqueta = PENDIENTE_CONFIGURAR if origen_auto == "configurar" else PENDIENTE
        motivo = f"{error} Se reintentará en la próxima revisión." if origen_auto == "configurar" else error
        return _resultado("pendiente", etiqueta, motivo, fecha=auto.get("actualizado"), origen=origen_auto)
    if (ultimo is not None and ultimo.get("resultado") == "incierto") or estado_auto == "incierto":
        return _resultado("incierto", "Incierto, verificar", (ultimo or {}).get("error") or auto.get("error"), fecha=(ultimo or {}).get("terminado_en"), origen=origen_de(ultimo) if ultimo else origen_auto)
    if estado_auto == "error" or (ultimo is not None and ultimo.get("resultado") in ("error", "no_existe")):
        code, respuesta = _respuesta(ultimo or {})
        return _resultado("error", "Error al enviar", (ultimo or {}).get("error") or auto.get("error"), fecha=(ultimo or {}).get("terminado_en") or auto.get("actualizado"),
                          code=code, respuesta=respuesta, origen=origen_de(ultimo) if ultimo else origen_auto)
    if estado_auto == "requiere_revision":
        motivos = [str(motivo) for motivo in auto.get("motivos") or auto.get("problemas") or [] if motivo] or ["requiere revisión"]
        return _resultado("no_enviado", f"No se envió: {motivos[0]}", " ".join(motivos), fecha=auto.get("actualizado"), origen=origen_auto)
    if estado_auto == "sin_savedata":
        return _resultado("no_enviado", "No se envió: SaveData no está configurado", auto.get("error"), fecha=auto.get("actualizado"))
    if estado_auto == "omitido":
        motivo = _motivo_omitido(str(auto.get("error") or ""))
        return _resultado("no_enviado", f"No se envió: {motivo}", auto.get("error"), fecha=auto.get("actualizado"))
    tipo = documento.get("tipo_documento") or {}
    if tipo.get("requiere_revision"):
        motivo = tipo.get("motivo") or "requiere revisión"
        return _resultado("no_enviado", f"No se envió: {motivo}", motivo)
    if entrada_auto is not None and entrada_auto.get("estado") == "extraido" and not entrada_auto.get("enviar_auto"):
        return _resultado("no_enviado", "No se envió: envío automático apagado", "Se extrajo con el envío automático apagado.")
    return _resultado("no_enviado", "No se envió: falta enviarlo", "Revísalo y envíalo desde Extracción.")
