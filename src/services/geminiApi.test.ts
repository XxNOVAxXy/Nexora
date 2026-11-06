import { afterEach, describe, expect, it, vi } from 'vitest'
import { geminiApi } from './geminiApi'

const estado = { configured: true, enabled: true, model: 'gemini-3.8-flash', maskedKey: '....7890' }
const respuesta = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('configuración de Gemini', () => {
  it('cambiar solo el modelo no envía apiKey (antes enviaba "" y el backend respondía 422)', async () => {
    for (const vacia of ['', '   ']) {
      const fetch = vi.fn().mockResolvedValue(respuesta(200, estado))
      vi.stubGlobal('fetch', fetch)
      await geminiApi.save(vacia, 'gemini-3.8-flash')
      const cuerpo = JSON.parse(fetch.mock.calls[0][1].body as string)
      expect(cuerpo).toEqual({ model: 'gemini-3.8-flash' })
      expect('apiKey' in cuerpo).toBe(false)
    }
  })

  it('una key nueva se envía recortada', async () => {
    const fetch = vi.fn().mockResolvedValue(respuesta(200, estado))
    vi.stubGlobal('fetch', fetch)
    await geminiApi.save('  AIzaClaveNueva1234567890  ', 'gemini-3.5-flash-lite')
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ apiKey: 'AIzaClaveNueva1234567890', model: 'gemini-3.5-flash-lite' })
  })

  it('el error del backend llega como mensaje legible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(422, { detail: 'La API key de Gemini es demasiado corta; revisa que este completa.' })))
    await expect(geminiApi.save('corta', 'm')).rejects.toThrow('demasiado corta')
  })

  it('una extracción truncada se rechaza con el mensaje del backend, nunca como resultado', async () => {
    const detail = { code: 'respuesta_truncada', message: 'El estado de cuenta es demasiado largo: la respuesta de Gemini se corto por el limite de salida (65536 tokens) y no se uso.', retryable: false }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(422, { detail })))
    await expect(geminiApi.extract('m1', 'a1')).rejects.toThrow('demasiado largo')
  })
})
