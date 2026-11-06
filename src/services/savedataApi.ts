/**
 * Envío a SaveData a través del backend. El navegador nunca contacta SaveData directamente:
 * el backend construye el cuerpo, lo envía y audita cada intento.
 */
import { ErrorApi, type ExtraccionGuardada, type IntentoEnvio } from './extraccionesApi'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type ConfigSaveData = { sucursal_predeterminada: number | null; url_configurada: boolean; url: string | null }

export type DatosEnvio = { sucursal: number; articulo: string; carga_inicial: boolean }

export type VistaPreviaEnvio = {
  /** Cuerpo exacto que se enviaría a SaveData. */
  cuerpo: string
  interno: { CargaInicial: boolean; Saldos: { Sucursal: number; Articulo: string; Saldo: number; Clave: string }[] }
  totales: { abonos: string; cargos: string }
  version: number
  estado: string
  url_configurada: boolean
  puede_enviar: boolean
  motivos: string[]
  requiere_confirmar_reenvio: boolean
  envio_previo: IntentoEnvio | null
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
  guardarConfig: (sucursal: number | null) => request<ConfigSaveData>('/savedata/config', { method: 'PUT', body: JSON.stringify({ sucursal_predeterminada: sucursal }) }),
  vistaPrevia: (messageId: string, partId: string, datos: DatosEnvio, signal?: AbortSignal) =>
    request<VistaPreviaEnvio>(`${ruta(messageId, partId)}/vista-previa`, { method: 'POST', body: JSON.stringify(datos), signal }),
  enviar: (messageId: string, partId: string, datos: DatosEnvio & { version_base: number; confirmar_reenvio: boolean }) =>
    request<RespuestaEnvio>(ruta(messageId, partId), { method: 'POST', body: JSON.stringify(datos) }),
}

export type ResultadoEnvio =
  | { ok: true; mensaje: string; intento: IntentoEnvio; extraccion: ExtraccionGuardada }
  | { ok: false; tipo: 'requiere_confirmar_reenvio' | 'incierto' | 'error' | 'conflicto'; mensaje: string; intento?: IntentoEnvio; extraccion?: ExtraccionGuardada }

/** Solo es éxito si el backend confirmó HTTP 200 + code 200 de SaveData. Los fallos traen la extracción ya auditada. */
export async function ejecutarEnvio(enviar: () => Promise<RespuestaEnvio>): Promise<ResultadoEnvio> {
  try {
    const respuesta = await enviar()
    if (respuesta?.resultado !== 'exito' || !respuesta.extraccion || !respuesta.intento) return { ok: false, tipo: 'error', mensaje: 'El backend respondió sin confirmar el envío.' }
    return { ok: true, mensaje: respuesta.mensaje, intento: respuesta.intento, extraccion: respuesta.extraccion }
  } catch (error) {
    if (error instanceof ErrorApi) {
      const detalle = (error.detalle ?? {}) as { intento?: IntentoEnvio; extraccion?: ExtraccionGuardada }
      const tipo = error.code === 'requiere_confirmar_reenvio' ? 'requiere_confirmar_reenvio' : error.code === 'savedata_incierto' ? 'incierto' : error.code === 'conflicto_version' ? 'conflicto' : 'error'
      return { ok: false, tipo, mensaje: error.message, intento: detalle.intento, extraccion: detalle.extraccion }
    }
    return { ok: false, tipo: 'error', mensaje: error instanceof Error ? error.message : 'No se pudo enviar a SaveData.' }
  }
}
