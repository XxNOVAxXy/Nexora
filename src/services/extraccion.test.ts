import { describe, expect, it, vi } from 'vitest'
import { crearControladorExtraccion, ejecutarExtraccion } from './extraccion'

function diferida<T>() {
  let resolver!: (valor: T) => void
  let rechazar!: (error: unknown) => void
  const promesa = new Promise<T>((resolve, reject) => { resolver = resolve; rechazar = reject })
  return { promesa, resolver, rechazar }
}

const manejadores = () => ({ exito: vi.fn(), error: vi.fn(), fin: vi.fn() })

describe('carrera al cambiar de documento', () => {
  it('descarta la respuesta tardía de un documento anterior y aplica la del documento actual', async () => {
    const controlador = crearControladorExtraccion()
    const respuestaA = diferida<string>()
    const respuestaB = diferida<string>()
    const senales: AbortSignal[] = []
    const a = manejadores()
    const b = manejadores()

    const extraccionA = ejecutarExtraccion(controlador, 'mensaje-1:adjunto-A', (signal) => { senales.push(signal); return respuestaA.promesa }, a)
    // El usuario cambia de documento mientras Gemini procesa A.
    const extraccionB = ejecutarExtraccion(controlador, 'mensaje-2:adjunto-B', (signal) => { senales.push(signal); return respuestaB.promesa }, b)
    expect(senales[0].aborted).toBe(true)
    expect(senales[1].aborted).toBe(false)

    respuestaB.resolver('resultado B')
    await expect(extraccionB).resolves.toBe('aplicada')
    respuestaA.resolver('resultado A tardío')
    await expect(extraccionA).resolves.toBe('descartada')

    expect(a.exito).not.toHaveBeenCalled()
    expect(a.error).not.toHaveBeenCalled()
    expect(a.fin).not.toHaveBeenCalled()
    expect(b.exito).toHaveBeenCalledWith('resultado B')
    expect(b.fin).toHaveBeenCalledTimes(1)
  })

  it('al cancelar (cambio de documento sin nueva extracción) descarta también los errores de la petición abortada', async () => {
    const controlador = crearControladorExtraccion()
    const respuesta = diferida<string>()
    const m = manejadores()
    const extraccion = ejecutarExtraccion(controlador, 'mensaje-1:adjunto-A', () => respuesta.promesa, m)
    controlador.cancelar()
    respuesta.rechazar(new DOMException('Abortada', 'AbortError'))
    await expect(extraccion).resolves.toBe('descartada')
    expect(m.error).not.toHaveBeenCalled()
    expect(m.fin).not.toHaveBeenCalled()
  })

  it('aplica errores del documento vigente', async () => {
    const controlador = crearControladorExtraccion()
    const m = manejadores()
    await expect(ejecutarExtraccion(controlador, 'doc', () => Promise.reject(new Error('cuota')), m)).resolves.toBe('aplicada')
    expect(m.error).toHaveBeenCalledTimes(1)
    expect(m.fin).toHaveBeenCalledTimes(1)
  })
})
