import { request } from './extraccionesApi'

/** Estado de un adjunto en el registro de la extracción automática del backend. */
export type EstadoAdjuntoAutomatico = 'pendiente' | 'en_curso' | 'extraido' | 'omitido' | 'error'

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
}

export const automaticoApi = {
  estado: () => request<EstadoAutomatico>('/automatico/estado'),
  configurar: (activo: boolean) => request<EstadoAutomatico>('/automatico', { method: 'PUT', body: JSON.stringify({ activo }) }),
  /** Interruptores del envío automático a SaveData. El backend responde 409 si falta SAVEDATA_URL. */
  configurarEnvio: (envioActivo: boolean, soloSiCuadra: boolean) =>
    request<EstadoAutomatico>('/automatico/envio', { method: 'PUT', body: JSON.stringify({ envio_activo: envioActivo, solo_si_cuadra: soloSiCuadra }) }),
  /** "Revisar ahora". El backend responde 409 si ya hay una revisión en curso. */
  revisarAhora: () => request<EstadoAutomatico>('/automatico/revisar', { method: 'POST' }),
}
