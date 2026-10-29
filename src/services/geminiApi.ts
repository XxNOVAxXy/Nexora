const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type GeminiStatus = {
  configured: boolean
  enabled: boolean
  model: string
  maskedKey: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(body?.detail ?? `La API respondió con ${response.status}.`)
  }
  return response.json() as Promise<T>
}

export const geminiApi = {
  status: () => request<GeminiStatus>('/gemini/status'),
  save: (apiKey: string, model: string) => request<GeminiStatus>('/gemini/config', { method: 'POST', body: JSON.stringify({ apiKey, model }) }),
  disable: () => request<GeminiStatus>('/gemini/config', { method: 'DELETE' }),
}
