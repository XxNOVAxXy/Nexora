import type { GmailMessage } from './gmailApi'

export type EmailClassification = 'ESTADO_DE_CUENTA' | 'NO_ES_ESTADO_DE_CUENTA' | 'REQUIERE_REVISION'
export type ClassificationSource = 'preliminar' | 'manual' | 'gemini'

export type PreliminaryDetection = {
  matched: boolean
  matchedTerms: string[]
  hasDocumentAttachment: boolean
  /** Tiene un PDF adjunto (las imágenes no cuentan para la clasificación automática). */
  hasPdfAttachment: boolean
  /** El backend comprobó que la dirección del remitente coincide con un remitente configurado. */
  senderMatches: boolean
  /** El backend comprobó que el asunto contiene una frase de estado de cuenta (filtro automático). */
  subjectMatches: boolean
}

export type PreliminaryClassificationResult = PreliminaryDetection & {
  classification: EmailClassification
  fingerprint: string
  analyzedAt: string
  source: 'preliminar'
}

export type ClassificationCache = Record<string, PreliminaryClassificationResult>
type MensajeClasificable = Pick<GmailMessage, 'subject' | 'sender' | 'senderEmail' | 'body' | 'snippet' | 'attachments'> & Partial<Pick<GmailMessage, 'remitenteCoincide' | 'asuntoCoincide'>>

const statementTerms = [
  'estado de cuenta',
  'extracto bancario',
  'resumen de movimientos',
  'movimientos de cuenta',
  'movimientos bancarios',
  'bank statement',
  'account statement',
]

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const esPdf = (attachment: GmailMessage['attachments'][number]) => attachment.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(attachment.filename)

export function detectStatementEmail(message: MensajeClasificable): PreliminaryDetection {
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
    hasPdfAttachment: message.attachments.some(esPdf),
    senderMatches: message.remitenteCoincide === true,
    subjectMatches: message.asuntoCoincide === true,
  }
}

/**
 * (Asunto de estado de cuenta o remitente configurado) + PDF adjunto => estado de cuenta por defecto. Las palabras clave solo apoyan:
 * con remitente sin PDF (p. ej. una imagen), palabras clave o un documento, queda pendiente de verificar.
 */
export function preliminaryClassification(detection: PreliminaryDetection): EmailClassification {
  if ((detection.senderMatches || detection.subjectMatches) && detection.hasPdfAttachment) return 'ESTADO_DE_CUENTA'
  return detection.senderMatches || detection.matched || detection.hasDocumentAttachment ? 'REQUIERE_REVISION' : 'NO_ES_ESTADO_DE_CUENTA'
}

/** Hash no criptográfico de 64 bits (cyrb53 doble) para huellas compactas. */
function hash64(texto: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

/** Huella que detecta cambios del correo. Usa `partId` (estable), no el id de adjunto que Gmail rota. */
export const FINGERPRINT_PREFIX = 'v2:'
/** Clasificación migrada sin huella moderna: se adopta la huella actual la primera vez que se ve el correo. */
export const FINGERPRINT_LEGADO = 'legado'

export function emailClassificationFingerprint(message: MensajeClasificable): string {
  return FINGERPRINT_PREFIX + hash64(JSON.stringify({
    subject: message.subject,
    sender: message.sender,
    senderEmail: message.senderEmail,
    body: message.body,
    snippet: message.snippet,
    attachments: message.attachments.map((attachment) => ({ partId: attachment.partId, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size })),
  }))
}

export function classifyEmailPreliminarily(message: MensajeClasificable, analyzedAt = new Date().toISOString()): PreliminaryClassificationResult {
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
    // Las coincidencias de remitente y asunto las decide el backend: si cambian, se reclasifica aunque el correo no cambie.
    cache[message.id] = previous?.fingerprint === fingerprint && previous.senderMatches === (message.remitenteCoincide === true) && previous.subjectMatches === (message.asuntoCoincide === true) ? previous : classifyEmailPreliminarily(message, analyzedAt)
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
