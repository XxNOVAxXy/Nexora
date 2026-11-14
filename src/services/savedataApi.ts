/**
 * Envío a SaveData a través del backend. El navegador nunca contacta SaveData directamente:
 * el backend construye el cuerpo, lo envía y audita cada intento.
 */
import { ErrorApi, type EstadoExtraccion, type ExtraccionGuardada, type IntentoEnvio, type ResultadoIntento } from './extraccionesApi'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type ConfigSaveData = { sucursal_predeterminada: number | null; url_configurada: boolean; url: string | null }

export type DatosEnvio = { sucursal: number; articulo: string; carga_inicial: boolean }

export type VistaPreviaEnvio = {
  /** Cuerpo exacto que se enviaría a SaveData. */
  cuerpo: string
  interno: {
    /** Id fijo del documento: es el mismo en cada reenvío para que SaveData actualice ese registro. */
    Id: string | null
    /** true si el documento ya se había enviado antes. */
    Actualizacion: boolean
    Archivo: string | null
    Resumen: Record<string, string>
    /** Campos "Una vez" (datos del documento): {"Nombre del campo": valor}; null si no se encontró. */
    Datos: Record<string, string | null>
    /** Campos fijos más los campos "En cada movimiento" con su nombre (null si están vacíos). */
    Transacciones: ({ fecha: string; concepto: string; referencia: string; cargo: string; abono: string; saldo: string } & Record<string, string | null>)[]
    Validacion: { cuadra: boolean | null; suma_cargos: string; suma_abonos: string }
  }
  totales: { abonos: string; cargos: string }
  version: number
  estado: string
  url_configurada: boolean
  puede_enviar: boolean
  motivos: string[]
  requiere_confirmar_reenvio: boolean
  envio_previo: IntentoEnvio | null
  /** El último envío regresó que SaveData ya no tiene el registro (lo borraron). */
  borrado_en_savedata: boolean
  /** Lo eliminamos de SaveData desde Nexora: el siguiente envío es un alta nueva. */
  eliminado_de_savedata: boolean
  /** SaveData tiene este documento y se puede eliminar. */
  puede_eliminar: boolean
}

/** Un intento en el historial de envíos, con los campos que se mandaron vacíos. */
export type IntentoHistorial = {
  id: string
  iniciado_en: string
  terminado_en: string | null
  resultado: ResultadoIntento
  sucursal: number | null
  articulo: string | null
  error: string | null
  accion: 'enviar' | 'eliminar'
  reenvio: boolean
  agregado_de_nuevo: boolean
  version_extraccion: number | null
  /** Campos que llegaron a SaveData como null ("RFC", "Folio (3 mov.)"). */
  faltantes: string[]
}

/** Un documento enviado a SaveData (historial). */
export type DocumentoEnviado = {
  id: string | null
  messageId: string
  partId: string
  filename: string
  estado: EstadoExtraccion
  version: number
  enviado_en: string | null
  /** Se editó después del último intento: SaveData todavía no tiene esos cambios. */
  modificado_tras_envio: boolean
  /** presente | borrado (lo borraron en SaveData) | eliminado (lo eliminamos desde Nexora) | nunca */
  en_savedata: 'nunca' | 'presente' | 'borrado' | 'eliminado'
  ultimo: IntentoHistorial
  intentos: IntentoHistorial[]
}

type RespuestaEnvio = { resultado: 'exito'; mensaje: string; intento: IntentoEnvio; extraccion: ExtraccionGuardada }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new ErrorApi('No se pudo contactar el backend FastAPI.', null, 'red', null)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    const detalle = body?.detail
    const mensaje = typeof detalle === 'string' ? detalle
      : Array.isArray(detalle) ? `Datos inválidos: ${detalle.map((item: { msg?: string }) => item.msg ?? 'valor inválido').join('; ')}`
      : (detalle as { message?: string } | undefined)?.message ?? `La API respondió con ${response.status}.`
    const code = detalle && typeof detalle === 'object' && !Array.isArray(detalle) ? (detalle as { code?: string }).code ?? null : null
    throw new ErrorApi(mensaje, response.status, code, detalle)
  }
  return response.json() as Promise<T>
}

const ruta = (messageId: string, partId: string) => `/extracciones/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}/enviar`

export const savedataApi = {
  config: () => request<ConfigSaveData>('/savedata/config'),
  historial: () => request<{ documentos: DocumentoEnviado[] }>('/envios'),
  guardarConfig: (sucursal: number | null) => request<ConfigSaveData>('/savedata/config', { method: 'PUT', body: JSON.stringify({ sucursal_predeterminada: sucursal }) }),
  vistaPrevia: (messageId: string, partId: string, datos: DatosEnvio, signal?: AbortSignal) =>
    request<VistaPreviaEnvio>(`${ruta(messageId, partId)}/vista-previa`, { method: 'POST', body: JSON.stringify(datos), signal }),
  /** Pide a SaveData borrar el registro de este documento (mismo Id). */
  eliminar: (messageId: string, partId: string) =>
    request<{ resultado: 'eliminado'; mensaje: string; intento: IntentoEnvio; extraccion: ExtraccionGuardada }>(`/extracciones/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}/eliminar`, { method: 'POST', body: JSON.stringify({ confirmar: true }) }),
  enviar: (messageId: string, partId: string, datos: DatosEnvio & { version_base: number; confirmar_reenvio: boolean; agregar_de_nuevo?: boolean }) =>
    request<RespuestaEnvio>(ruta(messageId, partId), { method: 'POST', body: JSON.stringify(datos) }),
}

export type ResultadoEnvio =
  | { ok: true; mensaje: string; intento: IntentoEnvio; extraccion: ExtraccionGuardada }
  | { ok: false; tipo: 'requiere_confirmar_reenvio' | 'no_existe' | 'incierto' | 'error' | 'conflicto'; mensaje: string; intento?: IntentoEnvio; extraccion?: ExtraccionGuardada }

/** Solo es éxito si el backend confirmó HTTP 200 + code 200 de SaveData. Los fallos traen la extracción ya auditada. */
export async function ejecutarEnvio(enviar: () => Promise<RespuestaEnvio>): Promise<ResultadoEnvio> {
  try {
    const respuesta = await enviar()
    if (respuesta?.resultado !== 'exito' || !respuesta.extraccion || !respuesta.intento) return { ok: false, tipo: 'error', mensaje: 'El backend respondió sin confirmar el envío.' }
    return { ok: true, mensaje: respuesta.mensaje, intento: respuesta.intento, extraccion: respuesta.extraccion }
  } catch (error) {
    if (error instanceof ErrorApi) {
      const detalle = (error.detalle ?? {}) as { intento?: IntentoEnvio; extraccion?: ExtraccionGuardada }
      const tipo = error.code === 'requiere_confirmar_reenvio' ? 'requiere_confirmar_reenvio' : error.code === 'savedata_no_existe' ? 'no_existe' : error.code === 'savedata_incierto' ? 'incierto' : error.code === 'conflicto_version' ? 'conflicto' : 'error'
      return { ok: false, tipo, mensaje: error.message, intento: detalle.intento, extraccion: detalle.extraccion }
    }
    return { ok: false, tipo: 'error', mensaje: error instanceof Error ? error.message : 'No se pudo enviar a SaveData.' }
  }
}

export type ResultadoEliminacion =
  | { ok: true; mensaje: string; extraccion: ExtraccionGuardada }
  | { ok: false; mensaje: string; incierto: boolean; extraccion?: ExtraccionGuardada }

/** Eliminar de SaveData: éxito si SaveData lo borró o ya no lo tenía. Los fallos traen la extracción auditada. */
export async function ejecutarEliminacion(messageId: string, partId: string): Promise<ResultadoEliminacion> {
  try {
    const respuesta = await savedataApi.eliminar(messageId, partId)
    if (respuesta?.resultado !== 'eliminado' || !respuesta.extraccion) return { ok: false, mensaje: 'El backend respondió sin confirmar la eliminación.', incierto: false }
    return { ok: true, mensaje: respuesta.mensaje, extraccion: respuesta.extraccion }
  } catch (error) {
    if (error instanceof ErrorApi) {
      const detalle = (error.detalle ?? {}) as { extraccion?: ExtraccionGuardada }
      return { ok: false, mensaje: error.message, incierto: error.code === 'savedata_incierto', extraccion: detalle.extraccion }
    }
    return { ok: false, mensaje: error instanceof Error ? error.message : 'No se pudo eliminar de SaveData.', incierto: false }
  }
}
