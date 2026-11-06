/** Remitentes de estados de cuenta y clasificaciones manuales, guardados en el backend por cuenta de Gmail. */
import type { EmailClassification } from './emailClassification'
import { ErrorApi } from './extraccionesApi'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type ConfigRemitentes = { remitentes: string[]; actualizado: string | null; firma: string }
export type ClasificacionGuardada = { classification: EmailClassification; fingerprint: string; actualizado?: string; migrado?: boolean }
export type EstadoClasificaciones = { clasificaciones: Record<string, ClasificacionGuardada>; migrado_en: string | null }
export type ErrorRemitente = { valor: string; motivo: string }

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
    const mensaje = typeof detalle === 'string' ? detalle : Array.isArray(detalle) ? 'Datos inválidos.' : (detalle as { message?: string } | undefined)?.message ?? `La API respondió con ${response.status}.`
    const code = detalle && typeof detalle === 'object' && !Array.isArray(detalle) ? (detalle as { code?: string }).code ?? null : null
    throw new ErrorApi(mensaje, response.status, code, detalle)
  }
  return response.json() as Promise<T>
}

export const preferenciasApi = {
  remitentes: () => request<ConfigRemitentes>('/configuracion/remitentes'),
  guardarRemitentes: (remitentes: string[]) => request<ConfigRemitentes>('/configuracion/remitentes', { method: 'PUT', body: JSON.stringify({ remitentes }) }),
  clasificaciones: () => request<EstadoClasificaciones>('/clasificaciones'),
  ponerClasificacion: (messageId: string, clasificacion: { classification: EmailClassification; fingerprint: string }) =>
    request<ClasificacionGuardada>(`/clasificaciones/${encodeURIComponent(messageId)}`, { method: 'PUT', body: JSON.stringify(clasificacion) }),
  quitarClasificacion: (messageId: string) => request<{ automatica: boolean }>(`/clasificaciones/${encodeURIComponent(messageId)}`, { method: 'DELETE' }),
  migrarClasificaciones: (clasificaciones: Record<string, { classification: EmailClassification; fingerprint: string }>) =>
    request<{ migradas: number; ya_migrado: boolean; migrado_en: string }>('/clasificaciones/migrar', { method: 'POST', body: JSON.stringify({ clasificaciones }) }),
}

/** Errores por remitente que devuelve el backend al rechazar la lista (422). */
export function erroresDeRemitentes(error: unknown): ErrorRemitente[] {
  if (!(error instanceof ErrorApi) || error.code !== 'remitentes_invalidos') return []
  return ((error.detalle as { errores?: ErrorRemitente[] } | null)?.errores) ?? []
}
