import { request } from './extraccionesApi'

/** Estado de un adjunto en el registro de la extracción automática del backend. */
export type EstadoAdjuntoAutomatico = 'pendiente' | 'en_curso' | 'extraido' | 'omitido' | 'error'

export type AdjuntoAutomatico = {
  estado: EstadoAdjuntoAutomatico
  intentos: number
  error: string | null
  /** Versión de la extracción que guardó el proceso automático. */
  version: number | null
  actualizado: string | null
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
  /** Por `messageId__partId`. */
  adjuntos: Record<string, AdjuntoAutomatico>
}

export const automaticoApi = {
  estado: () => request<EstadoAutomatico>('/automatico/estado'),
  configurar: (activo: boolean) => request<EstadoAutomatico>('/automatico', { method: 'PUT', body: JSON.stringify({ activo }) }),
  /** "Revisar ahora". El backend responde 409 si ya hay una revisión en curso. Nunca envía a SaveData. */
  revisarAhora: () => request<EstadoAutomatico>('/automatico/revisar', { method: 'POST' }),
}
