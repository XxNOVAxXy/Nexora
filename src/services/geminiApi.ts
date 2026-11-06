import type { Resumen, Transaccion } from '../types'
import type { FormatoNumerico, ValidacionContable } from './contabilidad'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type GeminiStatus = {
  configured: boolean
  enabled: boolean
  model: string
  maskedKey: string | null
}

export type GeminiExtractionResponse = {
  filename: string
  model: string
  /** Versión del prompt con que se extrajo; se guarda junto a la extracción. */
  prompt_version: string
  formato_numerico: FormatoNumerico | null
  resumen: Resumen
  transacciones: Transaccion[]
  validacion: ValidacionContable
  warnings: string[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch (error) {
    if (init?.signal?.aborted) throw error
    throw new Error('No se pudo contactar FastAPI para la extracción con Gemini.')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null
    const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message
    throw new Error(detail ?? `La API respondió con ${response.status}.`)
  }
  return response.json() as Promise<T>
}

export const geminiApi = {
  status: () => request<GeminiStatus>('/gemini/status'),
  /** Sin `apiKey` (o vacía) el backend conserva la key guardada: así se cambia solo el modelo. */
  save: (apiKey: string, model: string) => {
    const key = apiKey.trim()
    return request<GeminiStatus>('/gemini/config', { method: 'POST', body: JSON.stringify(key ? { apiKey: key, model } : { model }) })
  },
  disable: () => request<GeminiStatus>('/gemini/config', { method: 'DELETE' }),
  /** `forzar` ignora la caché del backend (re-extracción); `signal` cancela la petición al cambiar de documento. */
  extract: (messageId: string, attachmentId: string, { forzar = false, signal }: { forzar?: boolean; signal?: AbortSignal } = {}) =>
    request<GeminiExtractionResponse>('/gemini/extract', { method: 'POST', body: JSON.stringify({ messageId, attachmentId, forzar }), signal }),
}
