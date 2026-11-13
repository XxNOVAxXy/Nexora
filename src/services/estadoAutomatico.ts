import type { AdjuntoAutomatico, EstadoAutomatico } from './automaticoApi'
import type { EntradaListado, EstadoExtraccion } from './extraccionesApi'

/** Estado que muestra la bandeja por adjunto: el de la extracción guardada más los de la extracción automática. */
export type EstadoDocumento = EstadoExtraccion | 'sin_extraer' | 'automatico' | 'error_auto'

/**
 * - "Extraído automáticamente" mientras la extracción siga siendo la versión que guardó el proceso automático;
 *   en cuanto el usuario la guarda o la edita, se muestra su estado normal (Borrador, Revisado, Enviado).
 * - "Error al extraer" si el proceso agotó los intentos y no hay nada guardado.
 * - Lo guardado por el usuario siempre manda.
 */
export function estadoDocumento(guardado: EntradaListado | undefined, automatico: AdjuntoAutomatico | undefined): EstadoDocumento {
  if (guardado) {
    const intacto = automatico?.estado === 'extraido' && guardado.estado === 'borrador' && automatico.version !== null && guardado.version === automatico.version
    return intacto ? 'automatico' : guardado.estado
  }
  if (automatico?.estado === 'error') return 'error_auto'
  return 'sin_extraer'
}

const hora = (valor: string | null) => (valor ? new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(valor)) : null)

/** Texto del indicador discreto del proceso automático. */
export function textoIndicador(estado: EstadoAutomatico | null): string | null {
  if (!estado) return null
  if (!estado.activo) return 'Extracción automática en pausa'
  if (!estado.gemini_configurado) return 'Extracción automática activa · falta configurar Gemini'
  const partes = ['Extracción automática activa']
  if (estado.en_curso) partes.push('revisando ahora')
  const ultima = hora(estado.ultima_revision)
  const proxima = hora(estado.proxima_revision)
  partes.push(ultima ? `última revisión ${ultima}` : 'sin revisiones aún')
  if (proxima && !estado.en_curso) partes.push(`próxima ${proxima}`)
  return partes.join(' · ')
}

/** "Campos que se buscarán automáticamente: Nombre, RFC" (o que no hay ninguno). */
export const textoCamposAutomaticos = (campos: string[]) =>
  campos.length > 0 ? `Campos que se buscarán automáticamente: ${campos.join(', ')}` : 'Campos que se buscarán automáticamente: ninguno (agrega columnas con "+ Campo" en una extracción).'
