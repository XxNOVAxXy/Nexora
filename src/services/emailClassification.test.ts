import { describe, expect, it } from 'vitest'
import type { GmailMessage } from './gmailApi'
import { classifyMessagesWithCache, detectStatementEmail, preliminaryClassification } from './emailClassification'

const message = (overrides: Partial<GmailMessage> = {}): GmailMessage => ({
  id: 'message-1',
  threadId: 'thread-1',
  sender: 'Banco Centro',
  senderEmail: 'estados@banco.example',
  to: 'finanzas@example.com',
  subject: 'Documentos',
  snippet: '',
  body: '',
  receivedAt: null,
  unread: false,
  attachments: [],
  labels: ['INBOX'],
  ...overrides,
})

describe('detección preliminar de estados de cuenta', () => {
  it('marca como pendiente una coincidencia en el asunto', () => {
    const detection = detectStatementEmail(message({ subject: 'Estado de cuenta de abril' }))

    expect(detection.matched).toBe(true)
    expect(detection.matchedTerms).toContain('estado de cuenta')
    expect(preliminaryClassification(detection)).toBe('REQUIERE_REVISION')
  })

  it('revisa remitente, cuerpo y adjuntos incluyendo términos en inglés', () => {
    const detection = detectStatementEmail(message({
      senderEmail: 'notices@bank.example',
      body: 'Your account statement is ready.',
      attachments: [{ id: 'attachment-1', filename: 'statement-april.pdf', mimeType: 'application/pdf', size: 1000 }],
    }))

    expect(detection.matchedTerms).toContain('account statement')
    expect(detection.hasDocumentAttachment).toBe(true)
  })

  it('no confirma un documento solo por una coincidencia preliminar', () => {
    const detection = detectStatementEmail(message({ subject: 'Resumen de movimientos' }))

    expect(preliminaryClassification(detection)).not.toBe('ESTADO_DE_CUENTA')
  })

  it('clasifica como otro correo cuando no encuentra señales', () => {
    const detection = detectStatementEmail(message({
      sender: 'Recursos Humanos',
      senderEmail: 'rh@example.com',
      subject: 'Reunión de equipo',
      body: 'Agenda de la reunión del viernes.',
    }))

    expect(detection.matched).toBe(false)
    expect(preliminaryClassification(detection)).toBe('NO_ES_ESTADO_DE_CUENTA')
  })

  it('deja pendiente un PDF genérico para la futura verificación de Gemini', () => {
    const detection = detectStatementEmail(message({
      subject: 'Documentos del mes',
      attachments: [{ id: 'attachment-1', filename: 'documento.pdf', mimeType: 'application/pdf', size: 5000 }],
    }))

    expect(detection.matched).toBe(false)
    expect(detection.hasDocumentAttachment).toBe(true)
    expect(preliminaryClassification(detection)).toBe('REQUIERE_REVISION')
  })

  it('reutiliza una clasificación si la huella del mensaje no cambia', () => {
    const first = classifyMessagesWithCache([message()], {}, '2026-10-30T10:00:00.000Z')
    const second = classifyMessagesWithCache([message()], first, '2026-10-30T11:00:00.000Z')
    const changed = classifyMessagesWithCache([message({ body: 'Contenido actualizado' })], second, '2026-10-30T12:00:00.000Z')

    expect(second['message-1']).toBe(first['message-1'])
    expect(changed['message-1']).not.toBe(first['message-1'])
    expect(changed['message-1'].fingerprint).not.toBe(first['message-1'].fingerprint)
  })
})
