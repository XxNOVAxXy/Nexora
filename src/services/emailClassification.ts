import type { GmailMessage } from './gmailApi'

export type EmailClassification = 'ESTADO_DE_CUENTA' | 'NO_ES_ESTADO_DE_CUENTA' | 'REQUIERE_REVISION'
export type ClassificationSource = 'preliminar' | 'manual' | 'gemini'

export type PreliminaryDetection = {
  matched: boolean
  matchedTerms: string[]
  hasDocumentAttachment: boolean
}

export type PreliminaryClassificationResult = PreliminaryDetection & {
  classification: EmailClassification
  fingerprint: string
  analyzedAt: string
  source: 'preliminar'
}

export type ClassificationCache = Record<string, PreliminaryClassificationResult>

const statementTerms = [
  'estado de cuenta',
  'extracto bancario',
  'resumen de movimientos',
  'movimientos de cuenta',
  'movimientos bancarios',
  'bank statement',
  'account statement',
]

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export function detectStatementEmail(message: Pick<GmailMessage, 'subject' | 'sender' | 'senderEmail' | 'body' | 'snippet' | 'attachments'>): PreliminaryDetection {
  const searchableText = normalize([
    message.subject,
    message.sender,
    message.senderEmail,
    message.body,
    message.snippet,
    ...message.attachments.map((attachment) => `${attachment.filename} ${attachment.mimeType}`),
  ].join(' '))
  const matchedTerms = statementTerms.filter((term) => searchableText.includes(term))

  return {
    matched: matchedTerms.length > 0,
    matchedTerms,
    hasDocumentAttachment: message.attachments.some((attachment) => {
      const mimeType = attachment.mimeType.toLowerCase()
      return mimeType === 'application/pdf' || mimeType.startsWith('image/') || /\.(pdf|png|jpe?g|webp|gif)$/i.test(attachment.filename)
    }),
  }
}

export function preliminaryClassification(detection: PreliminaryDetection): EmailClassification {
  return detection.matched || detection.hasDocumentAttachment ? 'REQUIERE_REVISION' : 'NO_ES_ESTADO_DE_CUENTA'
}

export function emailClassificationFingerprint(message: Pick<GmailMessage, 'subject' | 'sender' | 'senderEmail' | 'body' | 'snippet' | 'attachments'>): string {
  return JSON.stringify({
    subject: message.subject,
    sender: message.sender,
    senderEmail: message.senderEmail,
    body: message.body,
    snippet: message.snippet,
    attachments: message.attachments.map((attachment) => ({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size })),
  })
}

export function classifyEmailPreliminarily(message: Pick<GmailMessage, 'subject' | 'sender' | 'senderEmail' | 'body' | 'snippet' | 'attachments'>, analyzedAt = new Date().toISOString()): PreliminaryClassificationResult {
  const detection = detectStatementEmail(message)
  return {
    ...detection,
    classification: preliminaryClassification(detection),
    fingerprint: emailClassificationFingerprint(message),
    analyzedAt,
    source: 'preliminar',
  }
}

export function classifyMessagesWithCache(messages: GmailMessage[], previousCache: ClassificationCache, analyzedAt = new Date().toISOString()): ClassificationCache {
  return messages.reduce<ClassificationCache>((cache, message) => {
    const fingerprint = emailClassificationFingerprint(message)
    const previous = previousCache[message.id]
    cache[message.id] = previous?.fingerprint === fingerprint ? previous : classifyEmailPreliminarily(message, analyzedAt)
    return cache
  }, { ...previousCache })
}

export function classificationLabel(classification: EmailClassification): string {
  return {
    ESTADO_DE_CUENTA: 'Estado de cuenta',
    NO_ES_ESTADO_DE_CUENTA: 'Otro correo',
    REQUIERE_REVISION: 'Pendiente de verificar',
  }[classification]
}
