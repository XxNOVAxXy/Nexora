/**
 * Asocia cada extracción al documento que la pidió. Iniciar una nueva, o cancelar al cambiar de documento,
 * aborta la anterior; una respuesta que llega tarde se descarta sin tocar el estado de la interfaz.
 */
export type TurnoExtraccion = { documentKey: string; signal: AbortSignal; vigente: () => boolean }

export function crearControladorExtraccion() {
  let contador = 0
  let actual: { token: number; documentKey: string; controller: AbortController } | null = null

  const cancelar = () => {
    actual?.controller.abort()
    actual = null
  }

  return {
    iniciar(documentKey: string): TurnoExtraccion {
      cancelar()
      contador += 1
      const token = contador
      const controller = new AbortController()
      actual = { token, documentKey, controller }
      return { documentKey, signal: controller.signal, vigente: () => actual?.token === token && actual.documentKey === documentKey }
    },
    cancelar,
    terminar(turno: TurnoExtraccion) {
      if (turno.vigente()) actual = null
    },
  }
}

export type ControladorExtraccion = ReturnType<typeof crearControladorExtraccion>

/**
 * Ejecuta `solicitar` dentro de un turno. Los manejadores (éxito, error y fin) solo corren si el turno
 * sigue vigente al terminar: así una respuesta tardía de otro documento no cambia datos, errores,
 * el indicador de extracción ni el progreso.
 */
export async function ejecutarExtraccion<T>(
  controlador: ControladorExtraccion,
  documentKey: string,
  solicitar: (signal: AbortSignal) => Promise<T>,
  manejadores: { exito: (resultado: T) => void; error: (error: unknown) => void; fin: () => void },
): Promise<'aplicada' | 'descartada'> {
  const turno = controlador.iniciar(documentKey)
  let resultado: { ok: true; valor: T } | { ok: false; error: unknown }
  try {
    resultado = { ok: true, valor: await solicitar(turno.signal) }
  } catch (error) {
    resultado = { ok: false, error }
  }
  if (!turno.vigente()) return 'descartada'
  controlador.terminar(turno)
  if (resultado.ok) manejadores.exito(resultado.valor)
  else manejadores.error(resultado.error)
  manejadores.fin()
  return 'aplicada'
}
