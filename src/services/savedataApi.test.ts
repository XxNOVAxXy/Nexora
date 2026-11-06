import { afterEach, describe, expect, it, vi } from 'vitest'
import { ejecutarEnvio, savedataApi } from './savedataApi'

const respuesta = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } })
const datos = { version_base: 2, sucursal: 3102, articulo: '10000453', carga_inicial: false, confirmar_reenvio: false }
const enviar = () => ejecutarEnvio(() => savedataApi.enviar('m1', '1', datos))
const extraccion = { version: 2, estado: 'revisado', envios: [] }
const intento = { id: 'i1', resultado: 'error', http_status: 200, respuesta: '{"code": 500}' }

afterEach(() => vi.unstubAllGlobals())

describe('envío a SaveData desde el navegador', () => {
  it('siempre llama al backend propio, nunca a SaveData', async () => {
    const fetch = vi.fn().mockResolvedValue(respuesta(200, { resultado: 'exito', mensaje: 'SaveData confirmo el envio: Exito.', intento: { ...intento, resultado: 'exito' }, extraccion: { ...extraccion, estado: 'enviado' } }))
    vi.stubGlobal('fetch', fetch)
    const resultado = await enviar()
    expect(resultado.ok).toBe(true)
    expect(fetch.mock.calls[0][0]).toBe('/api/extracciones/m1/1/enviar')
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual(datos)
  })

  it('HTTP 200 de SaveData con code distinto de 200 llega como error con el mensaje real y la extracción auditada', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(502, { detail: { code: 'savedata_error', message: "SaveData respondio HTTP 200 con code=500: Articulo inexistente.", intento, extraccion } })))
    const resultado = await enviar()
    expect(resultado).toMatchObject({ ok: false, tipo: 'error', mensaje: 'SaveData respondio HTTP 200 con code=500: Articulo inexistente.' })
    expect(resultado.ok === false && resultado.extraccion).toEqual(extraccion)
  })

  it('timeout: resultado incierto, no éxito', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(502, { detail: { code: 'savedata_incierto', message: 'SaveData no respondio en 30 s; no se sabe si recibio el envio.', intento: { ...intento, resultado: 'incierto' }, extraccion } })))
    expect(await enviar()).toMatchObject({ ok: false, tipo: 'incierto' })
  })

  it('reenvío sin confirmar: pide confirmación', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(409, { detail: { code: 'requiere_confirmar_reenvio', message: 'Confirma', envio_previo: intento } })))
    expect(await enviar()).toMatchObject({ ok: false, tipo: 'requiere_confirmar_reenvio' })
  })

  it('error de red con el backend o respuesta sin confirmar: no es éxito', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await enviar()).toMatchObject({ ok: false, tipo: 'error', mensaje: 'No se pudo contactar el backend FastAPI.' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(200, { mensaje: 'ok' })))
    expect((await enviar()).ok).toBe(false)
  })

  it('no revisado o versión vieja: mensajes del backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(409, { detail: { code: 'no_revisado', message: 'Solo se pueden enviar extracciones en estado revisado.' } })))
    expect(await enviar()).toMatchObject({ ok: false, tipo: 'error', mensaje: 'Solo se pueden enviar extracciones en estado revisado.' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(409, { detail: { code: 'conflicto_version', message: 'La extraccion guardada cambio.' } })))
    expect(await enviar()).toMatchObject({ ok: false, tipo: 'conflicto' })
  })
})
