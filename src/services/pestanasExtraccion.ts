import type { EstadoExtraccion } from './extraccionesApi'
import { LIMITE_LOTE, type ArchivoSeleccionado } from './seleccionAdjuntos'

/** Un archivo abierto en Extracción: una pestaña. `clave` es la misma clave de documento que usa el workspace. */
export type ArchivoExtraccion = { clave: string; messageId: string; attachmentId: string; partId: string | null; filename: string }

export const claveDocumento = (messageId: string, attachmentId: string, partId: string | null) => `${messageId}:${partId ?? attachmentId}`

/**
 * Lee los archivos de la URL.
 * - Lote (desde "Extraer" en Correos): un parámetro `doc` por archivo; la cola extrae los que no tienen nada guardado.
 * - Enlace antiguo `?message=&attachment=&part=&filename=`: una sola pestaña y sin extracción automática.
 */
export function leerArchivos(params: URLSearchParams): { archivos: ArchivoExtraccion[]; lote: boolean } {
  const docs = params.getAll('doc')
  if (docs.length > 0) {
    const archivos: ArchivoExtraccion[] = []
    for (const valor of docs) {
      const archivo = leerDoc(valor)
      if (archivo && !archivos.some((otro) => otro.clave === archivo.clave)) archivos.push(archivo)
      if (archivos.length === LIMITE_LOTE) break
    }
    return { archivos, lote: true }
  }
  const messageId = params.get('message')
  const attachmentId = params.get('attachment')
  if (!messageId || !attachmentId) return { archivos: [], lote: false }
  const partId = params.get('part') || null
  return { archivos: [{ clave: claveDocumento(messageId, attachmentId, partId), messageId, attachmentId, partId, filename: params.get('filename') ?? 'Documento recibido' }], lote: false }
}

function leerDoc(valor: string): ArchivoExtraccion | null {
  try {
    const datos: unknown = JSON.parse(valor)
    if (!Array.isArray(datos) || datos.length !== 4 || !datos.every((item) => typeof item === 'string')) return null
    const [messageId, attachmentId, partId, filename] = datos as string[]
    if (!messageId || !attachmentId || !partId) return null
    return { clave: claveDocumento(messageId, attachmentId, partId), messageId, attachmentId, partId, filename: filename || 'Documento recibido' }
  } catch {
    return null
  }
}

export function urlExtraccionLote(archivos: ArchivoSeleccionado[]): string {
  const params = new URLSearchParams({ mode: 'gemini' })
  for (const archivo of archivos.slice(0, LIMITE_LOTE)) params.append('doc', JSON.stringify([archivo.messageId, archivo.attachmentId, archivo.partId, archivo.filename]))
  return `/extraction?${params.toString()}`
}

/** Estado de un archivo en la cola de extracción automática. */
export type EstadoCola = 'en_cola' | 'extrayendo' | 'extraido' | 'error' | 'guardado' | 'borrador_local'

export type EstadoPestana = 'en_cola' | 'extrayendo' | 'extraido' | 'error' | EstadoExtraccion | 'borrador_local' | 'sin_extraer'

/**
 * Lo que muestra la pestaña. La cola manda mientras trabaja (o si falló); después, lo guardado en el backend (que
 * informa la propia pestaña al cargar o guardar, o la cola si la pestaña aún no se abrió).
 */
export function estadoPestana(cola: EstadoCola | undefined, guardadoPestana: EstadoExtraccion | null | undefined, guardadoCola: EstadoExtraccion | null): EstadoPestana {
  if (cola === 'en_cola' || cola === 'extrayendo' || cola === 'error') return cola
  const guardado = guardadoPestana !== undefined ? guardadoPestana : guardadoCola
  if (guardado) return guardado
  if (cola === 'extraido' || cola === 'borrador_local') return cola
  return 'sin_extraer'
}
