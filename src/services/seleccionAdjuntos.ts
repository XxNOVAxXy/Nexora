import type { GmailAttachment } from './gmailApi'

/**
 * Adjuntos marcados en Correos para extraer en lote. Vive en memoria (como la caché de la bandeja): se conserva al
 * cambiar de correo o de carpeta y al ir a Extracción y volver; se borra al limpiar o al cambiar de cuenta de Gmail.
 */
export type ArchivoSeleccionado = { messageId: string; attachmentId: string; partId: string; filename: string; mimeType: string }

/** Máximo de archivos por lote: limita la longitud del enlace y el gasto de cuota de Gemini. */
export const LIMITE_LOTE = 20

export const claveArchivo = (messageId: string, partId: string) => `${messageId}__${partId}`

/** Solo PDF e imágenes, y con partId (la clave estable con que se guarda la extracción). */
export function esSeleccionable(attachment: Pick<GmailAttachment, 'mimeType' | 'filename' | 'partId'>): boolean {
  if (!attachment.partId) return false
  const mime = attachment.mimeType.toLowerCase()
  return mime === 'application/pdf' || mime.startsWith('image/') || /\.(pdf|png|jpe?g|webp|gif)$/i.test(attachment.filename)
}

export type ResultadoMarcar = 'marcado' | 'desmarcado' | 'no_seleccionable' | 'limite'

export function crearSeleccion(limite = LIMITE_LOTE) {
  // Map conserva el orden de inserción: el lote se extrae en el orden en que se marcó.
  const marcados = new Map<string, ArchivoSeleccionado>()
  const listeners = new Set<() => void>()
  let version = 0
  const notificar = () => { version += 1; listeners.forEach((listener) => listener()) }

  return {
    suscribir: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    version: () => version,
    estaMarcado: (messageId: string, partId: string) => marcados.has(claveArchivo(messageId, partId)),
    /** Marca o desmarca un adjunto. Al llegar al límite no marca más (desmarcar siempre se puede). */
    alternar(messageId: string, attachment: GmailAttachment): ResultadoMarcar {
      if (!esSeleccionable(attachment)) return 'no_seleccionable'
      const clave = claveArchivo(messageId, attachment.partId)
      if (marcados.has(clave)) {
        marcados.delete(clave)
        notificar()
        return 'desmarcado'
      }
      if (marcados.size >= limite) return 'limite'
      marcados.set(clave, { messageId, attachmentId: attachment.id, partId: attachment.partId, filename: attachment.filename, mimeType: attachment.mimeType })
      notificar()
      return 'marcado'
    },
    contarEnCorreo: (messageId: string) => [...marcados.values()].filter((archivo) => archivo.messageId === messageId).length,
    total: () => marcados.size,
    lista: (): ArchivoSeleccionado[] => [...marcados.values()],
    limpiar() {
      if (marcados.size === 0) return
      marcados.clear()
      notificar()
    },
  }
}

export type SeleccionAdjuntos = ReturnType<typeof crearSeleccion>

export const seleccionAdjuntos = crearSeleccion()
