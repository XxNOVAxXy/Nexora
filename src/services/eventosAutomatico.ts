import type { EstadoAutomatico } from './automaticoApi'
/** Evento con el último estado consultado: la campanita se actualiza sin esperar su propia consulta. */
export const EVENTO_ESTADO_AUTOMATICO = 'nexora:estado-automatico'

export function publicarEstadoAutomatico(estado: EstadoAutomatico) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<EstadoAutomatico>(EVENTO_ESTADO_AUTOMATICO, { detail: estado }))
  return estado
}
