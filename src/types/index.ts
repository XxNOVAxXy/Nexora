export type DocumentKind = 'PDF' | 'JPG' | 'PNG' | 'WEBP'
export type TransactionStatus = 'Revisar' | 'Validada' | 'Borrador'

export type DocumentItem = {
  id: string
  name: string
  type: DocumentKind
  date: string
  size: string
  source: string
  pages: number
  status: 'Pendiente' | 'Procesado' | 'En revisión'
  color: string
}

export type Transaction = {
  id: string
  date: string
  bank: string
  sender: string
  beneficiary: string
  origin: string
  destination: string
  reference: string
  concept: string
  operation: string
  amount: string
  currency: string
  status: TransactionStatus
}

export type IntegrationStatus = 'connected' | 'disconnected' | 'demo'

export type ExtractionResult = {
  documentId: string
  method: 'manual' | 'gemini'
  transactions: Transaction[]
  savedAt: string
}
