/**
 * Bandeja de captura manual y eventos del proceso (lectura, diagnóstico, extracción y envío), a través del backend.
 */
const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type CodigoDiagnostico = 'ok' | 'pdf_protegido' | 'pdf_danado' | 'pdf_escaneado' | 'formato_no_soportado'
export type CodigoBandeja = Exclude<CodigoDiagnostico, 'ok'> | 'error_extraccion' | 'ia_no_disponible'
/** `error`: documentos en error o que se quedaron sin terminar (`leido`); se reintentan con «Reintentar». */
export type EstadoBandeja = 'pendiente' | 'resuelto' | 'descartado' | 'error'
/** Estado del documento (en la base, columnas `estado` y `motivo`). */
export type EstadoDocumento = 'leido' | 'extraido' | 'enviado' | 'requiere_revision' | 'captura_manual' | 'error' | 'descartado'

export type DocumentoBandeja = {
  message_id: string
  part_id: string
  attachment_id: string | null
  nombre: string | null
  mime: string | null
  tamano: number | null
  recibido_en: string | null
  asunto: string | null
  remitente: string | null
  guardado_en: string | null
  actualizado: string | null
  tiene_original: boolean
  diagnostico: { codigo: CodigoDiagnostico; mensaje: string; formato: string | null; paginas?: number | null } | null
  bandeja: { estado: EstadoBandeja; codigo: CodigoBandeja; motivo: string; mensaje: string; entrada_en: string | null; resuelto_en: string | null; resolucion: string | null } | null
  estado?: EstadoDocumento
  /** Código del motivo: `gemini_http_502`, `ia_no_disponible`, `pdf_protegido`… */
  motivo?: string | null
  proceso?: { estado: EstadoDocumento; motivo: string | null; mensaje: string | null; actualizado: string | null } | null
  /** Solo en «Con error»: intentos de la extracción automática y cuándo es el siguiente. */
  reintento?: { intentos: number; max: number; proximo_intento: string | null; en_espera: boolean; causa: string | null; automatico: boolean }
}

export type EventoProceso = {
  id: string
  fecha: string
  etapa: 'lectura' | 'diagnostico' | 'extraccion' | 'envio'
  codigo: string
  mensaje: string
  message_id: string | null
  part_id: string | null
  origen: string | null
}

export type ResultadoReproceso = {
  estado: 'extraido' | 'sigue_en_bandeja' | 'ya_extraido'
  mensaje: string | null
  documento: DocumentoBandeja | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new Error('No se pudo contactar el backend.')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null
    const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message
    throw new Error(detail ?? `La API respondió con ${response.status}.`)
  }
  return response.json() as Promise<T>
}

const ruta = (messageId: string, partId: string) => `${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`

export const bandejaApi = {
  listar: (estado: EstadoBandeja = 'pendiente') => request<{ documentos: DocumentoBandeja[]; motivos: Record<string, string> }>(`/bandeja?estado=${estado}`),
  reprocesar: (messageId: string, partId: string) => request<ResultadoReproceso>(`/bandeja/${ruta(messageId, partId)}/reprocesar`, { method: 'POST' }),
  /** «Reintentar» un documento en error (o que se quedó sin terminar): lo vuelve a diagnosticar y extraer ya. */
  reintentar: (messageId: string, partId: string) => request<ResultadoReproceso>(`/documentos/${ruta(messageId, partId)}/reintentar`, { method: 'POST' }),
  descartar: (messageId: string, partId: string) => request<{ documento: DocumentoBandeja }>(`/bandeja/${ruta(messageId, partId)}/descartar`, { method: 'POST' }),
  eventos: (messageId: string, partId: string) => request<{ eventos: EventoProceso[] }>(`/documentos/${ruta(messageId, partId)}/eventos`),
  urlOriginal: (messageId: string, partId: string) => `${API_URL}/documentos/${ruta(messageId, partId)}/original`,
}
