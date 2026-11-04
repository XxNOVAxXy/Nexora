import type { Transaction } from '../types'

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
  statement: GeminiStatement
  transactions: Transaction[]
  balanceValidation: GeminiBalanceValidation
  warnings: string[]
}

export type GeminiStatement = {
  bank: string
  account_holder: string
  account_number: string
  statement_period: string
  currency: string
  opening_balance: string
  closing_balance: string
  total_credits: string
  total_debits: string
}

export type GeminiBalanceValidation = {
  consistent: boolean | null
  difference: string
  message: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
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
  save: (apiKey: string, model: string) => request<GeminiStatus>('/gemini/config', { method: 'POST', body: JSON.stringify({ apiKey, model }) }),
  disable: () => request<GeminiStatus>('/gemini/config', { method: 'DELETE' }),
  extract: (messageId: string, attachmentId: string) => request<GeminiExtractionResponse>('/gemini/extract', { method: 'POST', body: JSON.stringify({ messageId, attachmentId }) }),
}
