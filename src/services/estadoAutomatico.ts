import type { AdjuntoAutomatico, AvisoAutomatico, EstadoAutomatico, UltimoCiclo } from './automaticoApi'
import type { EntradaListado, EstadoExtraccion } from './extraccionesApi'
import { formatoMexico } from './fechas'

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

const hora = (valor: string | null) => (valor ? formatoMexico({ hour: '2-digit', minute: '2-digit' }).format(new Date(valor)) : null)

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
/** «Autos individuales (manual, sin IA): Número de póliza, Placas…» por cada tipo de documento. */
export function textoCamposPorTipo(porTipo: { nombre: string; modo: 'manual' | 'ia' | null; campos: string[] }[]): string[] {
  return porTipo.map((tipo) => `${tipo.nombre} (${tipo.modo === 'ia' ? 'IA' : 'manual, sin IA'}): ${tipo.campos.length ? tipo.campos.join(', ') : 'sin campos configurados'}`)
}

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
  if ((ciclo.en_bandeja ?? 0) > 0) partes.push(`${ciclo.en_bandeja} a captura manual`)
  if ((ciclo.en_espera ?? 0) > 0) partes.push(`${ciclo.en_espera} en espera de reintento`)
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

/** El envío automático solo trabaja si también está activa la extracción automática. */
export const envioAutomaticoEncendido = (estado: EstadoAutomatico | null): boolean => Boolean(estado?.activo && estado.envio_activo)

/** Texto visible en Configuración cuando el envío automático está encendido. */
export const TEXTO_ENVIO_AUTOMATICO_CONFIG = 'No necesitas hacer nada: cada 20 minutos Nexora revisa los correos nuevos, los extrae y los envía a SaveData. Si extraes o editas un documento a mano, ya no se enviará automáticamente.'

/** Aviso de la bandeja (null si el envío automático está apagado). */
export function textoAvisoEnvioAutomatico(estado: EstadoAutomatico | null): string | null {
  if (!envioAutomaticoEncendido(estado)) return null
  const proxima = hora(estado?.proxima_revision ?? null)
  return `Envío automático activo · los estados de cuenta nuevos se envían solos en la próxima revisión${proxima ? ` (${proxima})` : ''}. No es necesario pulsar Extraer.`
}

/**
 * Adjunto de un correo nuevo que el proceso todavía no revisó y que, por tanto, se enviará solo:
 * mismos criterios que el backend (llegó después de activar, sin extracción guardada, sin descartar y sin resultado del proceso).
 */
export function pendienteEnvioAutomatico(estado: EstadoAutomatico | null, guardado: EntradaListado | undefined, messageId: string, partId: string | null, recibidoEn: string | null | undefined): boolean {
  if (!estado || !envioAutomaticoEncendido(estado) || !partId || guardado) return false
  const automatico = estado.adjuntos[`${messageId}__${partId}`]
  if (automatico && automatico.estado !== 'pendiente' && automatico.estado !== 'en_curso') return false
  if ((estado.descartados ?? []).some((descarte) => descarte.message_id === messageId && (!descarte.part_id || descarte.part_id === partId))) return false
  const recibido = recibidoEn ? Date.parse(recibidoEn) : NaN
  const activado = estado.activado_en ? Date.parse(estado.activado_en) : NaN
  return Number.isFinite(recibido) && Number.isFinite(activado) && recibido > activado
}

const ENVIO_TERMINADO = new Set(['enviado', 'requiere_revision', 'error', 'incierto', 'sin_savedata', 'omitido'])

/** Documento extraído automáticamente, pendiente de envío automático y todavía en la versión que dejó el proceso. */
export function envioAutomaticoSinEnviar(estado: EstadoAutomatico | null, messageId: string | null, partId: string | null, versionGuardada: number | null): boolean {
  if (!estado || !envioAutomaticoEncendido(estado) || !messageId || !partId || versionGuardada === null) return false
  const automatico = estado.adjuntos[`${messageId}__${partId}`]
  if (!automatico || automatico.estado !== 'extraido' || !automatico.enviar_auto) return false
  if (automatico.envio && ENVIO_TERMINADO.has(automatico.envio.estado)) return false
  return automatico.version !== null && versionGuardada === (automatico.envio?.version ?? automatico.version)
}

/** Fecha y hora con el mismo formato que el historial de envíos. */
export const fechaHoraEnvio = (valor: string | null | undefined) => (valor ? formatoMexico({ dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(valor)) : '—')

/** Cómo afecta el envío automático a un adjunto que se va a extraer a mano. */
export type GrupoEnvio = 'pendiente' | 'enviado_auto' | 'manual'
export type AdjuntoAExtraer = { grupo: GrupoEnvio; enviadoEn: string | null }

/** Clasifica un adjunto marcado: ya enviado por el proceso, pendiente de envío automático o manual (todo lo demás). */
export function grupoEnvioAutomatico(estado: EstadoAutomatico | null, guardado: EntradaListado | undefined, messageId: string, partId: string, recibidoEn: string | null | undefined): AdjuntoAExtraer {
  const automatico = estado?.adjuntos[`${messageId}__${partId}`]
  if (automatico?.estado === 'extraido' && automatico.envio?.estado === 'enviado') return { grupo: 'enviado_auto', enviadoEn: automatico.envio.actualizado }
  if (pendienteEnvioAutomatico(estado, guardado, messageId, partId, recibidoEn)) return { grupo: 'pendiente', enviadoEn: null }
  return { grupo: 'manual', enviadoEn: null }
}

/** Botones del aviso: pendiente (Esperar / Extraer de todos modos), enviado, manual, mixto y mixto con pendientes. */
export type TipoConfirmacion = 'pendiente' | 'enviado_auto' | 'manual' | 'mixto' | 'mixto_con_pendientes'
export type ConfirmacionExtraer = { tipo: TipoConfirmacion; texto: string; lineas: string[] }

const TEXTO_PENDIENTES = 'Estos documentos se enviarán solos en la próxima revisión. Si los extraes ahora, ya no se enviarán automáticamente y tendrás que enviarlos a mano. ¿Continuar?'

/** Un solo aviso para la selección: el texto del grupo si todos son iguales, o una línea por grupo si se mezclan. */
export function confirmacionExtraer(adjuntos: AdjuntoAExtraer[]): ConfirmacionExtraer {
  const de = (grupo: GrupoEnvio) => adjuntos.filter((adjunto) => adjunto.grupo === grupo)
  const pendientes = de('pendiente').length
  const enviados = de('enviado_auto')
  const manuales = de('manual').length
  const grupos = [pendientes, enviados.length, manuales].filter((n) => n > 0).length
  if (grupos <= 1) {
    if (pendientes > 0) return { tipo: 'pendiente', texto: TEXTO_PENDIENTES, lineas: [] }
    if (enviados.length === 1) return { tipo: 'enviado_auto', texto: `Este documento ya se envió automáticamente a SaveData el ${fechaHoraEnvio(enviados[0].enviadoEn)}. Vas a abrirlo en modo manual: si cambias algo, tendrás que reenviarlo a mano como actualización. ¿Continuar?`, lineas: [] }
    if (enviados.length > 1) {
      const ultimo = enviados.map((adjunto) => adjunto.enviadoEn).filter((valor): valor is string => Boolean(valor)).sort().slice(-1)[0] ?? null
      return { tipo: 'enviado_auto', texto: `Estos ${enviados.length} documentos ya se enviaron automáticamente a SaveData (el último el ${fechaHoraEnvio(ultimo)}). Vas a abrirlos en modo manual: si cambias algo, tendrás que reenviarlos a mano como actualización. ¿Continuar?`, lineas: [] }
    }
    return manuales > 1
      ? { tipo: 'manual', texto: `Vas a trabajar estos ${manuales} documentos en modo manual. Recuerda enviarlos a SaveData a mano cuando termines. ¿Continuar?`, lineas: [] }
      : { tipo: 'manual', texto: 'Vas a trabajar este documento en modo manual. Recuerda enviarlo a SaveData a mano cuando termines. ¿Continuar?', lineas: [] }
  }
  const resumen: string[] = []
  const lineas: string[] = []
  if (pendientes > 0) {
    resumen.push(pendientes === 1 ? '1 se enviará solo' : `${pendientes} se enviarán solos`)
    lineas.push('Los que se enviarán solos dejarán de enviarse automáticamente si los extraes ahora.')
  }
  if (enviados.length > 0) {
    resumen.push(enviados.length === 1 ? '1 ya se envió automáticamente' : `${enviados.length} ya se enviaron automáticamente`)
    lineas.push('Los ya enviados se abrirán en modo manual: si cambias algo, reenvíalos a mano como actualización.')
  }
  if (manuales > 0) {
    resumen.push(manuales === 1 ? '1 es manual' : `${manuales} son manuales`)
    lineas.push('Los manuales tendrás que enviarlos a SaveData a mano cuando termines.')
  }
  return { tipo: pendientes > 0 ? 'mixto_con_pendientes' : 'mixto', texto: resumen.join(' · '), lineas: [...lineas, '¿Continuar?'] }
}

/** `message` y `code` de la respuesta JSON de SaveData (null si no es JSON con esa forma). */
export function respuestaSaveData(texto: string | null | undefined): { message: string | null; code: string | null } | null {
  if (!texto) return null
  try {
    const datos: unknown = JSON.parse(texto)
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null
    const { message, code } = datos as Record<string, unknown>
    return { message: message === undefined || message === null ? null : String(message), code: code === undefined || code === null ? null : String(code) }
  } catch {
    return null
  }
}

type IntentoAuto = { resultado: string; accion?: string; automatico?: boolean; terminado_en: string | null; iniciado_en: string; respuesta: string | null }

/** Último envío automático exitoso del documento (o null). */
export const ultimoEnvioAutomatico = <T extends IntentoAuto>(envios: T[]): T | null =>
  envios.filter((intento) => intento.automatico && intento.resultado === 'exito' && intento.accion !== 'eliminar').slice(-1)[0] ?? null

/** Aviso fijo de Extracción para un documento enviado automáticamente. */
export function textoAvisoEnviadoAuto(intento: IntentoAuto): string {
  const respuesta = respuestaSaveData(intento.respuesta)
  return `Enviado automáticamente a SaveData el ${fechaHoraEnvio(intento.terminado_en ?? intento.iniciado_en)} · respuesta: ${respuesta?.message ?? 'sin mensaje'} (code ${respuesta?.code ?? '—'}). Si lo modificas, reenvíalo a mano como actualización.`
}
