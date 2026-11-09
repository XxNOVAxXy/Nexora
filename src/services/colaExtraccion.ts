import type { EstadoExtraccion } from './extraccionesApi'

/**
 * Cola de extracción en lote: procesa los archivos de uno en uno (nunca en paralelo, para no agotar la cuota de
 * Gemini). Para cada archivo, primero consulta lo guardado: si existe, no llama a Gemini; si hay un borrador local
 * sin guardar, tampoco (la pestaña ofrece restaurarlo). Un error en un archivo no detiene a los demás.
 *
 * Cada evento lleva la clave de su archivo, así que un resultado solo puede llegar a la pestaña de ese archivo.
 * Tras `cancelar()` (al salir de la pantalla) no se emite nada más: las respuestas tardías se descartan.
 */
export type ResultadoArchivo<T> =
  | { tipo: 'guardado'; estado: EstadoExtraccion }
  | { tipo: 'borrador_local' }
  | { tipo: 'extraido'; resultado: T }
  | { tipo: 'error'; mensaje: string }

export type EventoCola<T> = { estado: 'en_cola' } | { estado: 'extrayendo' } | { estado: 'terminado'; resultado: ResultadoArchivo<T> }

export type OpcionesCola<A, T> = {
  /** Estado de la extracción guardada en el backend, o null si no hay. */
  consultarGuardado: (archivo: A) => Promise<EstadoExtraccion | null>
  tieneBorradorLocal: (archivo: A) => Promise<boolean>
  extraer: (archivo: A, signal: AbortSignal) => Promise<T>
  alCambiar: (clave: string, evento: EventoCola<T>) => void
}

const mensajeDe = (error: unknown) => (error instanceof Error ? error.message : 'Error desconocido.')

export function crearColaExtraccion<A extends { clave: string }, T>(opciones: OpcionesCola<A, T>) {
  const pendientes: A[] = []
  let enCurso: string | null = null
  let corriendo = false
  let cancelada = false
  const controller = new AbortController()

  const procesar = async (archivo: A): Promise<ResultadoArchivo<T> | null> => {
    try {
      const guardado = await opciones.consultarGuardado(archivo)
      if (cancelada) return null
      if (guardado) return { tipo: 'guardado', estado: guardado }
      const borrador = await opciones.tieneBorradorLocal(archivo)
      if (cancelada) return null
      if (borrador) return { tipo: 'borrador_local' }
      opciones.alCambiar(archivo.clave, { estado: 'extrayendo' })
      const resultado = await opciones.extraer(archivo, controller.signal)
      return cancelada ? null : { tipo: 'extraido', resultado }
    } catch (error) {
      return cancelada ? null : { tipo: 'error', mensaje: mensajeDe(error) }
    }
  }

  const correr = async () => {
    if (corriendo) return
    corriendo = true
    try {
      while (!cancelada && pendientes.length > 0) {
        const archivo = pendientes.shift()!
        enCurso = archivo.clave
        const resultado = await procesar(archivo)
        enCurso = null
        if (resultado === null) return
        opciones.alCambiar(archivo.clave, { estado: 'terminado', resultado })
      }
    } finally {
      corriendo = false
    }
  }

  return {
    /** Agrega archivos al final (los que ya esperan o se procesan no se duplican) y arranca si estaba parada. */
    agregar(archivos: A[]): Promise<void> {
      if (cancelada) return Promise.resolve()
      for (const archivo of archivos) {
        if (archivo.clave === enCurso || pendientes.some((otro) => otro.clave === archivo.clave)) continue
        pendientes.push(archivo)
        opciones.alCambiar(archivo.clave, { estado: 'en_cola' })
      }
      return correr()
    },
    cancelar() {
      cancelada = true
      pendientes.length = 0
      controller.abort()
    },
  }
}

export type ColaExtraccion<A extends { clave: string }, T> = ReturnType<typeof crearColaExtraccion<A, T>>
