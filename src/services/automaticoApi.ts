import { request } from './extraccionesApi'

/** Estado de un adjunto en el registro de la extracción automática del backend. */
/** `bandeja`: el diagnóstico no fue ok (contraseña, dañado, escaneado, formato) y quedó en la Bandeja de captura manual. */
export type EstadoAdjuntoAutomatico = 'pendiente' | 'en_curso' | 'extraido' | 'omitido' | 'error' | 'bandeja'

/** Estado del envío automático a SaveData de un adjunto extraído automáticamente. */
export type EstadoEnvioAutomatico = 'pendiente' | 'en_curso' | 'enviado' | 'requiere_revision' | 'error' | 'incierto' | 'sin_savedata' | 'omitido'

export type EnvioAutomatico = {
  estado: EstadoEnvioAutomatico
  intentos: number | null
  error: string | null
  /** Por qué no pasó la protección "Enviar solo si cuadra". */
  motivos: string[] | null
  /** Problemas encontrados (se anotan aunque se haya enviado con la protección apagada). */
  problemas: string[] | null
  /** Versión del documento que el proceso marcó como revisada (null si no llegó a marcarla). */
  version: number | null
  actualizado: string | null
}

export type AdjuntoAutomatico = {
  estado: EstadoAdjuntoAutomatico
  intentos: number
  error: string | null
  /** Versión de la extracción que guardó el proceso automático. */
  version: number | null
  actualizado: string | null
  /** Se extrajo con el envío automático encendido. */
  enviar_auto?: boolean
  envio?: EnvioAutomatico | null
}

/** Motivo por el que el proceso automático descartó un correo o adjunto. */
export type MotivoDescarte =
  | 'id_invalido' | 'sin_fecha' | 'anterior_a_activacion' | 'asunto_no_coincide' | 'sin_adjunto_valido' | 'adjunto_no_extraible'
  | 'ya_tenia_extraccion' | 'guardado_por_usuario' | 'envio_omitido' | 'sin_savedata'

export type DescarteCiclo = {
  clave: string
  message_id: string
  part_id: string | null
  motivo: MotivoDescarte | string
  detalle: string | null
  asunto: string | null
}

/** Registro persistente de descartes (máximo 200, los más recientes primero). */
export type Descartado = DescarteCiclo & {
  recibido: string | null
  primera_vez: string | null
  ultima_vez: string | null
  veces: number | null
}

export type ResultadoCiclo = 'ok' | 'sin_gmail' | 'limite_gmail' | 'sin_gemini' | 'pausado' | 'interrumpido' | 'interrumpido_reinicio' | 'error'

/** Resumen del último ciclo; también se registran los que terminan antes de revisar Gmail. */
export type UltimoCiclo = {
  inicio: string | null
  /** null si el ciclo se cortó por un reinicio del backend. */
  fin: string | null
  detectado_en?: string | null
  origen: 'programado' | 'manual'
  resultado: ResultadoCiclo | string
  error: string | null
  correos_encontrados: number
  extraidos: number
  enviados: number
  requieren_revision: number
  inciertos: number
  omitidos: number
  errores: number
  ya_revisados: number
  /** Adjuntos que pasaron a la Bandeja de captura manual en el ciclo (ausente en ciclos anteriores a la bandeja). */
  en_bandeja?: number
  /** Documentos con error temporal de la IA esperando su siguiente reintento (ausente en ciclos anteriores). */
  en_espera?: number
  descartes: DescarteCiclo[]
  descartes_total: number
  /** "Se enviaron 2 (1 Fianzas, 1 Autos individuales) · 1 requiere revisión (Gastos médicos mayores)". */
  texto_envios?: string | null
}

export type TipoAviso = 'enviado' | 'requiere_revision' | 'error' | 'incierto' | 'error_ciclo'

export type AvisoAutomatico = {
  id: string
  fecha: string | null
  tipo: TipoAviso | string
  texto: string
  claves: string[]
  leido: boolean
}

export type EstadoAutomatico = {
  activo: boolean
  activado_en: string | null
  ultima_revision: string | null
  proxima_revision: string | null
  en_curso: boolean
  intervalo_minutos: number
  ultimo_resultado: string | null
  ultimo_error: string | null
  gemini_configurado: boolean
  /** Columnas que se pedirán a Gemini: las que el usuario agregó o aceptó en sus extracciones guardadas. */
  campos: string[]
  /** Envío automático a SaveData (apagado por defecto). */
  envio_activo?: boolean
  /** Protección "Enviar solo si cuadra" (encendida por defecto). */
  solo_si_cuadra?: boolean
  envio_activado_en?: string | null
  /** SAVEDATA_URL configurada en el backend: sin ella no se puede encender el envío automático. */
  savedata_configurada?: boolean
  /** Por `messageId__partId`. */
  adjuntos: Record<string, AdjuntoAutomatico>
  /** Inicio del ciclo en curso (null si no hay ninguno). */
  ciclo_en_curso_desde?: string | null
  revision_solicitada_en?: string | null
  /** "Revisar ahora" se pidió y todavía no empieza un ciclo posterior. */
  revision_pendiente?: boolean
  ultimo_ciclo?: UltimoCiclo | null
  descartados?: Descartado[]
  /** Más recientes primero. */
  avisos?: AvisoAutomatico[]
  avisos_sin_leer?: number
}


export const automaticoApi = {
  estado: () => request<EstadoAutomatico>('/automatico/estado'),
  configurar: (activo: boolean) => request<EstadoAutomatico>('/automatico', { method: 'PUT', body: JSON.stringify({ activo }) }),
  /** Interruptores del envío automático a SaveData. El backend responde 409 si falta SAVEDATA_URL. */
  configurarEnvio: (envioActivo: boolean, soloSiCuadra: boolean) =>
    request<EstadoAutomatico>('/automatico/envio', { method: 'PUT', body: JSON.stringify({ envio_activo: envioActivo, solo_si_cuadra: soloSiCuadra }) }),
  /** "Revisar ahora". El backend responde 409 si ya hay una revisión en curso. */
  revisarAhora: () => request<EstadoAutomatico>('/automatico/revisar', { method: 'POST' }),
  /** Marca como leídos los avisos indicados (o todos). */
  marcarAvisosLeidos: (ids?: string[]) => request<EstadoAutomatico>('/automatico/avisos/leidos', { method: 'POST', body: JSON.stringify({ ids: ids ?? null }) }),
}
