const configuredApiUrl = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')
const API_URL = import.meta.env.DEV ? '/api' : configuredApiUrl

export type GmailAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  /** Estable entre consultas (el id del adjunto no lo es): identifica el documento guardado. */
  partId: string
}

export type GmailMessage = {
  id: string
  threadId: string
  sender: string
  senderEmail: string
  to: string
  subject: string
  snippet: string
  body: string
  receivedAt: string | null
  unread: boolean
  attachments: GmailAttachment[]
  labels: string[]
  /** El backend comprobó que la dirección del remitente coincide con un remitente configurado. */
  remitenteCoincide?: boolean
  reglaRemitente?: string | null
  /** Filtro automático: el asunto contiene una frase de estado de cuenta (ver backend/app/filtro_estados.py). */
  asuntoCoincide?: boolean
  terminoAsunto?: string | null
}

/** `estados`: automático por asunto + PDF o imagen (por defecto). `remitentes`: por lista configurada. `todos`: sin filtro. */
export type FiltroCorreo = 'estados' | 'remitentes' | 'todos'

/** Una página del listado de Gmail. */
export type PaginaGmail = {
  folder: string
  filtro: FiltroCorreo
  /** Identifica la configuración de remitentes con que se filtró (clave de caché). */
  firmaFiltro: string
  remitentes: number
  /** No hay remitentes configurados: no se consultó Gmail. */
  sinRemitentes: boolean
  messages: GmailMessage[]
  nextPageToken: string | null
  /** Correos que Gmail devolvió pero cuya dirección no coincide exactamente con un remitente. */
  descartados: number
}

export type GmailStatus = {
  connected: boolean
  provider: 'gmail'
  email?: string | null
  /** Hash de la cuenta conectada; separa datos locales y guardados entre cuentas. */
  cuentaId?: string | null
  messagesTotal?: number
  threadsTotal?: number
  error?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    console.error('[Nexora][Gmail] No se pudo contactar FastAPI', { url, error })
    throw new Error('No se pudo contactar el backend FastAPI. Ejecuta npm run dev:all.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null
    console.error('[Nexora][Gmail] Error de API', { url, status: response.status, detail: payload?.detail })
    throw new Error(payload?.detail ?? `La API respondió con ${response.status}.`)
  }
  console.info('[Nexora][Gmail] Respuesta correcta', { url, status: response.status })
  return response.json() as Promise<T>
}

export const gmailApi = {
  status: () => request<GmailStatus>('/gmail/status'),
  listar: (folder: string, { filtro, pageToken }: { filtro: FiltroCorreo; pageToken?: string | null }) =>
    request<PaginaGmail>(`/gmail/messages?folder=${encodeURIComponent(folder)}&limit=25&filtro=${filtro}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`),
  message: (id: string) => request<GmailMessage>(`/gmail/messages/${encodeURIComponent(id)}`),
  disconnect: () => request<{ connected: boolean }>('/gmail/disconnect', { method: 'POST' }),
  startAuth: () => {
    console.info('[Nexora][Gmail] Abriendo OAuth', { url: `${API_URL}/auth/gmail/start` })
    window.location.assign(`${API_URL}/auth/gmail/start`)
  },
  attachmentUrl: (messageId: string, attachmentId: string) => `${API_URL}/gmail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
}
