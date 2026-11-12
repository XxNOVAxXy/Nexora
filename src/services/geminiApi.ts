import type { Resumen, ResultadoCampo, SugerenciaCampo, Transaccion } from '../types'
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
  /** Campos que la IA encontró en el documento y no están entre los estándar (como máximo 8). */
  sugerencias_campos?: SugerenciaCampo[]
  /** Lo que encontró la IA para cada columna manual que se le pidió buscar. */
  resultados_campos?: ResultadoCampo[]
  warnings: string[]
}

/** Respuesta de "Llenar con IA": valores por índice de las filas enviadas, o un valor único del documento. */
export type RespuestaLlenarCampo = {
  nombre: string
  encontrado: boolean
  valores: { indice: number; valor: string }[]
  valor_documento?: string
}

export type FilaParaCampo = Pick<Transaccion, 'fecha' | 'concepto' | 'referencia' | 'cargo' | 'abono'>

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
  /** `campos` son los nombres de las columnas manuales que Gemini debe buscar en el documento. */
  extract: (messageId: string, attachmentId: string, { forzar = false, signal, campos = [] }: { forzar?: boolean; signal?: AbortSignal; campos?: string[] } = {}) =>
    request<GeminiExtractionResponse>('/gemini/extract', { method: 'POST', body: JSON.stringify({ messageId, attachmentId, forzar, ...(campos.length > 0 ? { campos_solicitados: campos } : {}) }), signal }),
  /** "Llenar con IA": busca una sola columna para las filas actuales, sin re-extraer los movimientos. */
  llenarCampo: (messageId: string, attachmentId: string, nombre: string, filas: FilaParaCampo[]) =>
    request<RespuestaLlenarCampo>('/gemini/campos', { method: 'POST', body: JSON.stringify({ messageId, attachmentId, nombre, filas }) }),
}
