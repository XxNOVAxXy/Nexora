const configuredApiUrl = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')
const API_URL = import.meta.env.DEV ? '/api' : configuredApiUrl

export type GmailAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
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
}

export type GmailStatus = {
  connected: boolean
  provider: 'gmail'
  email?: string | null
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
  messages: async (folder: string) => (await request<{ messages: GmailMessage[] }>(`/gmail/messages?folder=${folder}&limit=25`)).messages,
  message: (id: string) => request<GmailMessage>(`/gmail/messages/${encodeURIComponent(id)}`),
  disconnect: () => request<{ connected: boolean }>('/gmail/disconnect', { method: 'POST' }),
  startAuth: () => {
    console.info('[Nexora][Gmail] Abriendo OAuth', { url: `${API_URL}/auth/gmail/start` })
    window.location.assign(`${API_URL}/auth/gmail/start`)
  },
  attachmentUrl: (messageId: string, attachmentId: string) => `${API_URL}/gmail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
}
