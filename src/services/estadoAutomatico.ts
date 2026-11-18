import type { AdjuntoAutomatico, AvisoAutomatico, EstadoAutomatico, UltimoCiclo } from './automaticoApi'
import type { EntradaListado, EstadoExtraccion } from './extraccionesApi'

/** Estado que muestra la bandeja por adjunto: el de la extracción guardada más los de la extracción automática. */
export type EstadoDocumento = EstadoExtraccion | 'sin_extraer' | 'automatico' | 'error_auto' | 'enviado_auto' | 'requiere_revision' | 'error_envio' | 'incierto_envio'

/** Estados del envío automático que se muestran en la bandeja y en Envíos. */
const ESTADO_ENVIO_VISIBLE: Partial<Record<NonNullable<AdjuntoAutomatico['envio']>['estado'], EstadoDocumento>> = {
  enviado: 'enviado_auto',
  requiere_revision: 'requiere_revision',
  error: 'error_envio',
  incierto: 'incierto_envio',
}

/**
 * - "Extraído automáticamente" mientras la extracción siga siendo la versión que guardó el proceso automático;
 *   en cuanto el usuario la guarda o la edita, se muestra su estado normal (Borrador, Revisado, Enviado).
 * - Envío automático: "Enviado automáticamente", "Requiere revisión", "Error al enviar" o "Incierto, verificar"
 *   mientras el documento siga en la versión que dejó el proceso automático.
 * - "Error al extraer" si el proceso agotó los intentos y no hay nada guardado.
 * - Lo guardado por el usuario siempre manda.
 */
export function estadoDocumento(guardado: EntradaListado | undefined, automatico: AdjuntoAutomatico | undefined): EstadoDocumento {
  if (guardado) {
    const envio = automatico?.estado === 'extraido' ? automatico.envio : null
    const visible = envio ? ESTADO_ENVIO_VISIBLE[envio.estado] : undefined
    if (envio && visible && guardado.version === (envio.version ?? automatico?.version)) return visible
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
  // "Revisando" solo mientras hay un ciclo en curso; una solicitud que aún no empieza se muestra aparte.
  if (estado.en_curso) partes.push('revisando ahora')
  else if (estado.revision_pendiente) partes.push('revisión solicitada')
  const ultima = hora(estado.ultima_revision)
  const proxima = hora(estado.proxima_revision)
  partes.push(ultima ? `última revisión ${ultima}` : 'sin revisiones aún')
  if (proxima && !estado.en_curso) partes.push(`próxima ${proxima}`)
  return partes.join(' · ')
}

/** "Campos que se buscarán automáticamente: Nombre, RFC" (o que no hay ninguno). */
export const textoCamposAutomaticos = (campos: string[]) =>
  campos.length > 0 ? `Campos que se buscarán automáticamente: ${campos.join(', ')}` : 'Campos que se buscarán automáticamente: ninguno (agrega columnas con "+ Campo" en una extracción).'

const plural = (n: number, singular: string, varios: string) => `${n} ${n === 1 ? singular : varios}`

/** Texto de cada motivo de descarte. */
export const ETIQUETA_MOTIVO: Record<string, string> = {
  id_invalido: 'Identificador no válido',
  sin_fecha: 'Sin fecha de recepción',
  anterior_a_activacion: 'Anterior a la activación',
  asunto_no_coincide: 'El asunto no coincide',
  sin_adjunto_valido: 'Sin adjunto válido',
  adjunto_no_extraible: 'Adjunto que no es PDF ni imagen',
  ya_tenia_extraccion: 'Ya tenía extracción',
  guardado_por_usuario: 'Guardado por el usuario durante la extracción',
  envio_omitido: 'Envío automático omitido',
  sin_savedata: 'SaveData sin configurar',
}
export const textoMotivo = (motivo: string) => ETIQUETA_MOTIVO[motivo] ?? motivo

const ETIQUETA_RESULTADO: Record<string, string> = {
  ok: 'Completado',
  sin_gmail: 'Sin Gmail conectado',
  limite_gmail: 'Gmail limitó las consultas',
  sin_gemini: 'Falta configurar Gemini',
  pausado: 'En pausa',
  interrumpido: 'Interrumpido (se retoma en la siguiente revisión)',
  interrumpido_reinicio: 'Interrumpido por reinicio del backend',
  error: 'Terminó con error',
}
export const textoResultadoCiclo = (resultado: string) => ETIQUETA_RESULTADO[resultado] ?? resultado

/** Contadores del último ciclo: "3 correos encontrados · 1 extraído · 1 enviado · 2 omitidos · 0 errores". */
export function resumenCiclo(ciclo: UltimoCiclo): string {
  const partes = [
    plural(ciclo.correos_encontrados, 'correo encontrado', 'correos encontrados'),
    plural(ciclo.extraidos, 'extraído', 'extraídos'),
    plural(ciclo.enviados, 'enviado', 'enviados'),
  ]
  if (ciclo.requieren_revision > 0) partes.push(plural(ciclo.requieren_revision, 'requiere revisión', 'requieren revisión'))
  if (ciclo.inciertos > 0) partes.push(plural(ciclo.inciertos, 'envío incierto', 'envíos inciertos'))
  partes.push(plural(ciclo.omitidos, 'omitido', 'omitidos'), plural(ciclo.errores, 'error', 'errores'))
  return partes.join(' · ')
}

/** Omitidos del ciclo agrupados por motivo: "Sin adjunto válido (2), El asunto no coincide (1)". */
export function motivosAgrupados(ciclo: UltimoCiclo): string {
  const conteo = new Map<string, number>()
  for (const descarte of ciclo.descartes) conteo.set(descarte.motivo, (conteo.get(descarte.motivo) ?? 0) + 1)
  return [...conteo].map(([motivo, n]) => `${textoMotivo(motivo)} (${n})`).join(', ')
}

/** Avisos que se resaltan: los que no se han leído. */
export const avisosSinLeer = (estado: EstadoAutomatico | null): AvisoAutomatico[] => (estado?.avisos ?? []).filter((aviso) => !aviso.leido)

/** Cada cuánto se consulta el estado: rápido mientras hay un ciclo en curso o una revisión pedida. */
export const intervaloConsulta = (estado: EstadoAutomatico | null) => (estado?.en_curso || estado?.revision_pendiente ? 3_000 : 60_000)
