import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statusMock, listarMock } = vi.hoisted(() => ({ statusMock: vi.fn(), listarMock: vi.fn() }))
vi.mock('./gmailApi', () => ({ gmailApi: { status: statusMock, messages: vi.fn() } }))
vi.mock('./extraccionesApi', () => ({ extraccionesApi: { listar: listarMock } }))

import { inboxStore } from './inboxStore'

const override = (classification: string) => ({ classification, fingerprint: 'f' })

describe('aislamiento por cuenta en el navegador', () => {
  let datos: Map<string, string>

  beforeEach(() => {
    datos = new Map()
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v) }, removeItem: (k: string) => { datos.delete(k) } } })
    inboxStore.clear()
    statusMock.mockReset()
    listarMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('las clasificaciones de una cuenta no aparecen en otra', () => {
    inboxStore.saveOverrides('cuentaA', { m1: override('ESTADO_DE_CUENTA') } as never)
    expect(Object.keys(inboxStore.loadOverrides('cuentaA'))).toEqual(['m1'])
    expect(inboxStore.loadOverrides('cuentaB')).toEqual({})
    expect(inboxStore.loadOverrides(null)).toEqual({})
  })

  it('la clave antigua solo se asigna con correos de la cuenta conectada y se conserva como respaldo', () => {
    const antiguas = { m1: override('ESTADO_DE_CUENTA'), m2: override('NO_ES_ESTADO_DE_CUENTA'), mX: override('ESTADO_DE_CUENTA') }
    datos.set('nexora.classificationOverrides', JSON.stringify(antiguas))
    expect(inboxStore.asignarOverridesLegados('cuentaA', ['m1', 'm2', 'm3'])).toBe(2)
    expect(Object.keys(inboxStore.loadOverrides('cuentaA')).sort()).toEqual(['m1', 'm2'])
    // La original se renombra (no se pierde) y la de otra cuenta no recibe nada que no le pertenezca.
    expect(datos.has('nexora.classificationOverrides')).toBe(false)
    expect(JSON.parse(datos.get('nexora.classificationOverrides.respaldo')!)).toEqual(antiguas)
    expect(inboxStore.asignarOverridesLegados('cuentaB', ['m9'])).toBe(0)
    expect(inboxStore.loadOverrides('cuentaB')).toEqual({})
    // Una corrección ya hecha en la cuenta no se sobrescribe con el respaldo.
    inboxStore.saveOverrides('cuentaC', { mX: override('REQUIERE_REVISION') } as never)
    expect(inboxStore.asignarOverridesLegados('cuentaC', ['mX'])).toBe(0)
    expect(inboxStore.loadOverrides('cuentaC').mX.classification).toBe('REQUIERE_REVISION')
  })

  it('no muestra estados de extracción de otra cuenta y los limpia al cambiar de cuenta', async () => {
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'a@example.com', cuentaId: 'cuentaA' })
    await inboxStore.loadStatus()
    listarMock.mockResolvedValueOnce({ cuentaId: 'cuentaB', extracciones: [{ messageId: 'm1', partId: '1', estado: 'revisado' }] })
    expect(await inboxStore.loadEstados()).toEqual({})
    listarMock.mockResolvedValueOnce({ cuentaId: 'cuentaA', extracciones: [{ messageId: 'm1', partId: '1', estado: 'borrador' }] })
    expect(Object.keys(await inboxStore.loadEstados({ force: true }))).toEqual(['m1__1'])
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'b@example.com', cuentaId: 'cuentaB' })
    await inboxStore.loadStatus()
    listarMock.mockResolvedValueOnce({ cuentaId: 'cuentaB', extracciones: [] })
    expect(await inboxStore.loadEstados()).toEqual({})
    expect(listarMock).toHaveBeenCalledTimes(3)
  })
})
