import { describe, expect, it } from 'vitest'
import type { GmailMessage } from './gmailApi'
import { classifyMessagesWithCache, detectStatementEmail, emailClassificationFingerprint, preliminaryClassification } from './emailClassification'

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
      attachments: [{ id: 'attachment-1', filename: 'statement-april.pdf', mimeType: 'application/pdf', size: 1000, partId: '1' }],
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
      attachments: [{ id: 'attachment-1', filename: 'documento.pdf', mimeType: 'application/pdf', size: 5000, partId: '1' }],
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

describe('clasificación por remitente configurado', () => {
  const pdf = { id: 'att-rotativo-1', filename: 'estado.pdf', mimeType: 'application/pdf', size: 1000, partId: '1' }
  const imagen = { id: 'att-2', filename: 'estado.jpg', mimeType: 'image/jpeg', size: 1000, partId: '1' }

  it('remitente configurado con PDF: estado de cuenta por defecto, aunque no haya palabras clave', () => {
    const detection = detectStatementEmail(message({ subject: 'Documentos', remitenteCoincide: true, attachments: [pdf] }))
    expect(detection.matched).toBe(false)
    expect(preliminaryClassification(detection)).toBe('ESTADO_DE_CUENTA')
  })

  it('remitente configurado con imagen y sin PDF: pendiente de verificar', () => {
    expect(preliminaryClassification(detectStatementEmail(message({ remitenteCoincide: true, attachments: [imagen] })))).toBe('REQUIERE_REVISION')
  })

  it('palabras clave y PDF sin remitente configurado: solo apoyo, queda pendiente', () => {
    expect(preliminaryClassification(detectStatementEmail(message({ subject: 'Estado de cuenta', remitenteCoincide: false, attachments: [pdf] })))).toBe('REQUIERE_REVISION')
  })

  it('la huella usa partId: no cambia cuando Gmail rota el id del adjunto', () => {
    const a = emailClassificationFingerprint(message({ attachments: [pdf] }))
    const b = emailClassificationFingerprint(message({ attachments: [{ ...pdf, id: 'att-rotativo-2' }] }))
    expect(a).toBe(b)
    expect(a.startsWith('v2:')).toBe(true)
    expect(emailClassificationFingerprint(message({ attachments: [{ ...pdf, partId: '2' }] }))).not.toBe(a)
  })

  it('cambiar la coincidencia de remitente reclasifica aunque el correo no cambie', () => {
    const antes = classifyMessagesWithCache([message({ attachments: [pdf], remitenteCoincide: false })], {})
    const despues = classifyMessagesWithCache([message({ attachments: [pdf], remitenteCoincide: true })], antes)
    expect(antes['message-1'].classification).toBe('REQUIERE_REVISION')
    expect(despues['message-1'].classification).toBe('ESTADO_DE_CUENTA')
  })
})

describe('filtro automático por asunto', () => {
  const pdf = { id: 'a-1', filename: 'EdoCta.pdf', mimeType: 'application/pdf', size: 1000, partId: '1' }
  const imagen = { id: 'a-2', filename: 'estado_octubre.jpg', mimeType: 'image/jpeg', size: 1000, partId: '1' }

  it('asunto validado por el backend + PDF es estado de cuenta, sin remitente configurado', () => {
    const detection = detectStatementEmail(message({ subject: 'Tu estado de cuenta', asuntoCoincide: true, attachments: [pdf] }))
    expect(detection.subjectMatches).toBe(true)
    expect(detection.senderMatches).toBe(false)
    expect(preliminaryClassification(detection)).toBe('ESTADO_DE_CUENTA')
  })

  it('asunto de estado de cuenta con solo una imagen: estado de cuenta', () => {
    const detection = detectStatementEmail(message({ subject: 'Estado de cuenta', asuntoCoincide: true, attachments: [imagen] }))
    expect(detection.hasImageAttachment).toBe(true)
    expect(detection.hasPdfAttachment).toBe(false)
    expect(preliminaryClassification(detection)).toBe('ESTADO_DE_CUENTA')
  })

  it('una clasificación guardada con las reglas anteriores (solo PDF) se recalcula', () => {
    const correo = message({ subject: 'Estado de cuenta', asuntoCoincide: true, attachments: [imagen] })
    const viejo = classifyMessagesWithCache([correo], {})
    const { hasImageAttachment: _omitido, ...sinCampo } = viejo['message-1']
    const despues = classifyMessagesWithCache([correo], { 'message-1': { ...sinCampo, classification: 'REQUIERE_REVISION' } as never })
    expect(despues['message-1'].classification).toBe('ESTADO_DE_CUENTA')
  })

  it('asunto validado sin PDF queda pendiente de verificar', () => {
    const detection = detectStatementEmail(message({ subject: 'Tu estado de cuenta', asuntoCoincide: true, attachments: [] }))
    expect(preliminaryClassification(detection)).toBe('REQUIERE_REVISION')
  })

  it('reclasifica si cambia la coincidencia de asunto aunque el correo sea igual', () => {
    const correo = message({ subject: 'Documentos', attachments: [pdf] })
    const antes = classifyMessagesWithCache([correo], {})
    expect(antes[correo.id].classification).toBe('REQUIERE_REVISION')
    const despues = classifyMessagesWithCache([{ ...correo, asuntoCoincide: true }], antes)
    expect(despues[correo.id].classification).toBe('ESTADO_DE_CUENTA')
  })
})
