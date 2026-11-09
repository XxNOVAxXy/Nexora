import { describe, expect, it } from 'vitest'
import { crearColaExtraccion, type EventoCola } from './colaExtraccion'
import type { EstadoExtraccion } from './extraccionesApi'

type Archivo = { clave: string }
const archivos = (...claves: string[]): Archivo[] => claves.map((clave) => ({ clave }))

function diferida<T>() {
  let resolver!: (valor: T) => void
  let rechazar!: (error: unknown) => void
  const promesa = new Promise<T>((resolve, reject) => { resolver = resolve; rechazar = reject })
  return { promesa, resolver, rechazar }
}

const esperar = () => new Promise((resolve) => setTimeout(resolve, 0))

function preparar({ guardados = {}, borradores = [], fallan = [] }: { guardados?: Record<string, EstadoExtraccion>; borradores?: string[]; fallan?: string[] } = {}) {
  const eventos: { clave: string; evento: EventoCola<string> }[] = []
  const llamadasGemini: string[] = []
  let simultaneas = 0
  let maximoSimultaneas = 0
  const cola = crearColaExtraccion<Archivo, string>({
    consultarGuardado: async (archivo) => guardados[archivo.clave] ?? null,
    tieneBorradorLocal: async (archivo) => borradores.includes(archivo.clave),
    extraer: async (archivo) => {
      llamadasGemini.push(archivo.clave)
      simultaneas += 1
      maximoSimultaneas = Math.max(maximoSimultaneas, simultaneas)
      await esperar()
      simultaneas -= 1
      if (fallan.includes(archivo.clave)) throw new Error(`Gemini falló con ${archivo.clave}`)
      return `resultado de ${archivo.clave}`
    },
    alCambiar: (clave, evento) => eventos.push({ clave, evento }),
  })
  const terminados = () => Object.fromEntries(eventos.filter(({ evento }) => evento.estado === 'terminado').map(({ clave, evento }) => [clave, evento.estado === 'terminado' ? evento.resultado : null]))
  return { cola, eventos, llamadasGemini, maximo: () => maximoSimultaneas, terminados }
}

describe('cola de extracción en lote', () => {
  it('extrae en secuencia, uno a la vez y en el orden del lote', async () => {
    const { cola, llamadasGemini, maximo, terminados } = preparar()
    await cola.agregar(archivos('a', 'b', 'c'))
    expect(llamadasGemini).toEqual(['a', 'b', 'c'])
    expect(maximo()).toBe(1)
    expect(terminados()).toEqual({
      a: { tipo: 'extraido', resultado: 'resultado de a' },
      b: { tipo: 'extraido', resultado: 'resultado de b' },
      c: { tipo: 'extraido', resultado: 'resultado de c' },
    })
  })

  it('salta los que ya tienen extracción guardada y los que tienen borrador local, sin llamar a Gemini', async () => {
    const { cola, llamadasGemini, terminados } = preparar({ guardados: { a: 'revisado', c: 'enviado' }, borradores: ['d'] })
    await cola.agregar(archivos('a', 'b', 'c', 'd'))
    expect(llamadasGemini).toEqual(['b'])
    expect(terminados()).toEqual({
      a: { tipo: 'guardado', estado: 'revisado' },
      b: { tipo: 'extraido', resultado: 'resultado de b' },
      c: { tipo: 'guardado', estado: 'enviado' },
      d: { tipo: 'borrador_local' },
    })
  })

  it('si uno falla, los demás siguen; reintentar procesa solo ese archivo', async () => {
    const fallan = ['b']
    const { cola, llamadasGemini, terminados } = preparar({ fallan })
    await cola.agregar(archivos('a', 'b', 'c'))
    expect(llamadasGemini).toEqual(['a', 'b', 'c'])
    expect(terminados().b).toEqual({ tipo: 'error', mensaje: 'Gemini falló con b' })
    expect(terminados().c).toEqual({ tipo: 'extraido', resultado: 'resultado de c' })

    fallan.length = 0
    await cola.agregar(archivos('b'))
    expect(llamadasGemini).toEqual(['a', 'b', 'c', 'b'])
    expect(terminados().b).toEqual({ tipo: 'extraido', resultado: 'resultado de b' })
  })

  it('emite en cola → extrayendo → terminado, cada evento con la clave de su archivo', async () => {
    const { cola, eventos } = preparar({ guardados: { b: 'borrador' } })
    await cola.agregar(archivos('a', 'b'))
    expect(eventos.map(({ clave, evento }) => `${clave}:${evento.estado}`)).toEqual(['a:en_cola', 'b:en_cola', 'a:extrayendo', 'a:terminado', 'b:terminado'])
  })

  it('no duplica un archivo que ya espera o se procesa', async () => {
    const { cola, llamadasGemini } = preparar()
    const primera = cola.agregar(archivos('a', 'b'))
    void cola.agregar(archivos('a', 'b'))
    await primera
    expect(llamadasGemini).toEqual(['a', 'b'])
  })

  it('al cancelar descarta la respuesta tardía y no procesa los pendientes', async () => {
    const respuesta = diferida<string>()
    const eventos: string[] = []
    const senales: AbortSignal[] = []
    const cola = crearColaExtraccion<Archivo, string>({
      consultarGuardado: async () => null,
      tieneBorradorLocal: async () => false,
      extraer: (_archivo, signal) => { senales.push(signal); return respuesta.promesa },
      alCambiar: (clave, evento) => eventos.push(`${clave}:${evento.estado}`),
    })
    const corrida = cola.agregar(archivos('a', 'b'))
    await esperar()
    cola.cancelar()
    expect(senales[0].aborted).toBe(true)
    respuesta.resolver('resultado tardío de a')
    await corrida
    expect(eventos).toEqual(['a:en_cola', 'b:en_cola', 'a:extrayendo'])
    await cola.agregar(archivos('c'))
    expect(eventos).toHaveLength(3)
  })
})
