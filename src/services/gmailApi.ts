const API_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

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
  const response = await fetch(`${API_URL}${path}`, init)
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(payload?.detail ?? `La API respondió con ${response.status}.`)
  }
  return response.json() as Promise<T>
}

export const gmailApi = {
  status: () => request<GmailStatus>('/gmail/status'),
  messages: async (folder: string) => (await request<{ messages: GmailMessage[] }>(`/gmail/messages?folder=${folder}&limit=25`)).messages,
  message: (id: string) => request<GmailMessage>(`/gmail/messages/${encodeURIComponent(id)}`),
  disconnect: () => request<{ connected: boolean }>('/gmail/disconnect', { method: 'POST' }),
  startAuth: () => {
    window.location.assign(`${API_URL}/auth/gmail/start`)
  },
  attachmentUrl: (messageId: string, attachmentId: string) => `${API_URL}/gmail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
}
