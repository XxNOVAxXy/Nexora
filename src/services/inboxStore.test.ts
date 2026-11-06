import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statusMock, listarMock, remitentesMock, clasificacionesMock, migrarMock } = vi.hoisted(() => ({
  statusMock: vi.fn(), listarMock: vi.fn(), remitentesMock: vi.fn(), clasificacionesMock: vi.fn(), migrarMock: vi.fn(),
}))
vi.mock('./gmailApi', () => ({ gmailApi: { status: statusMock, listar: listarMock } }))
vi.mock('./preferenciasApi', () => ({ preferenciasApi: { remitentes: remitentesMock, clasificaciones: clasificacionesMock, migrarClasificaciones: migrarMock } }))

import { claveListado, inboxStore } from './inboxStore'

const mensaje = (id: string) => ({ id, senderEmail: 'estados@banco.com', attachments: [] })
const pagina = (ids: string[], nextPageToken: string | null, firmaFiltro = 'firma-a') => ({ folder: 'inbox', filtro: 'remitentes', firmaFiltro, remitentes: 1, sinRemitentes: false, messages: ids.map(mensaje), nextPageToken, descartados: 0 })

describe('inboxStore: listados filtrados y paginados', () => {
  beforeEach(async () => {
    inboxStore.clear()
    for (const mock of [statusMock, listarMock, remitentesMock, clasificacionesMock, migrarMock]) mock.mockReset()
    statusMock.mockResolvedValue({ connected: true, provider: 'gmail', email: 'a@example.com', cuentaId: 'cuentaA' })
    remitentesMock.mockResolvedValue({ remitentes: ['estados@banco.com'], actualizado: null, firma: 'firma-a' })
    await inboxStore.loadStatus()
  })

  it('comparte una petición en vuelo y reutiliza la caché hasta forzar', async () => {
    listarMock.mockResolvedValue(pagina(['m1'], null))
    const [a, b] = await Promise.all([inboxStore.loadListado('inbox', 'remitentes'), inboxStore.loadListado('inbox', 'remitentes')])
    expect(a).toBe(b)
    await inboxStore.loadListado('inbox', 'remitentes')
    expect(listarMock).toHaveBeenCalledTimes(1)
    await inboxStore.loadListado('inbox', 'remitentes', { force: true })
    expect(listarMock).toHaveBeenCalledTimes(2)
  })

  it('"Cargar más" añade la siguiente página sin perder lo cargado ni repetir correos', async () => {
    listarMock.mockResolvedValueOnce(pagina(['m1', 'm2'], 'tok-2')).mockResolvedValueOnce(pagina(['m2', 'm3'], 'tok-3')).mockResolvedValueOnce(pagina(['m4'], null))
    await inboxStore.loadListado('inbox', 'remitentes')
    await inboxStore.loadMore('inbox', 'remitentes')
    const listado = await inboxStore.loadMore('inbox', 'remitentes')
    expect(listado?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(listado?.paginas).toEqual([null, 'tok-2', 'tok-3'])
    expect(listado?.nextPageToken).toBeNull()
    expect(listarMock.mock.calls.map((call) => call[1])).toEqual([{ filtro: 'remitentes' }, { filtro: 'remitentes', pageToken: 'tok-2' }, { filtro: 'remitentes', pageToken: 'tok-3' }])
    // Sin más páginas no se vuelve a llamar a Gmail.
    await inboxStore.loadMore('inbox', 'remitentes')
    expect(listarMock).toHaveBeenCalledTimes(3)
  })

  it('la clave de caché incluye filtro y remitentes; cambiar los remitentes invalida los listados', async () => {
    expect(claveListado('inbox', 'remitentes', 'firma-a')).not.toBe(claveListado('inbox', 'remitentes', 'firma-b'))
    expect(claveListado('inbox', 'todos', 'firma-a')).toBe(claveListado('inbox', 'todos', 'firma-b'))
    listarMock.mockResolvedValue(pagina(['m1'], null))
    await inboxStore.loadListado('inbox', 'remitentes')
    expect(inboxStore.cachedListado('inbox', 'remitentes')).not.toBeNull()
    inboxStore.setRemitentes({ remitentes: ['estados@banco.com', '@otro.mx'], actualizado: null, firma: 'firma-b' })
    expect(inboxStore.cachedListado('inbox', 'remitentes')).toBeNull()
    listarMock.mockResolvedValue(pagina(['m1', 'm9'], null, 'firma-b'))
    const nuevo = await inboxStore.loadListado('inbox', 'remitentes')
    expect(listarMock).toHaveBeenCalledTimes(2)
    expect(nuevo.firmaFiltro).toBe('firma-b')
  })

  it('una página que llega después de recargar la primera no se mezcla', async () => {
    listarMock.mockResolvedValueOnce(pagina(['m1'], 'tok-2'))
    await inboxStore.loadListado('inbox', 'remitentes')
    let resolver!: (valor: unknown) => void
    listarMock.mockImplementationOnce(() => new Promise((resolve) => { resolver = resolve }))
    const mas = inboxStore.loadMore('inbox', 'remitentes')
    listarMock.mockResolvedValueOnce(pagina(['n1'], 'otro-token'))
    await inboxStore.loadListado('inbox', 'remitentes', { force: true })
    resolver(pagina(['viejo'], null))
    await mas
    expect(inboxStore.cachedListado('inbox', 'remitentes')?.messages.map((m) => m.id)).toEqual(['n1'])
  })

  it('cambiar de cuenta descarta los listados de la anterior', async () => {
    listarMock.mockResolvedValue(pagina(['m1'], null))
    await inboxStore.loadListado('inbox', 'remitentes')
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'b@example.com', cuentaId: 'cuentaB' })
    await inboxStore.loadStatus()
    expect(inboxStore.cachedListado('inbox', 'remitentes')).toBeNull()
    expect(inboxStore.cachedRemitentes()).toBeNull()
  })
})

describe('inboxStore: migración única de clasificaciones al backend', () => {
  let datos: Map<string, string>

  beforeEach(async () => {
    datos = new Map()
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v) }, removeItem: (k: string) => { datos.delete(k) } } })
    inboxStore.clear()
    for (const mock of [statusMock, clasificacionesMock, migrarMock]) mock.mockReset()
    statusMock.mockResolvedValue({ connected: true, provider: 'gmail', email: 'a@example.com', cuentaId: 'cuentaA' })
    await inboxStore.loadStatus()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('envía las clasificaciones locales con huella nueva o "legado", renombra la clave y conserva el respaldo', async () => {
    const locales = { m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: '{"viejo":1}' }, m2: { classification: 'NO_ES_ESTADO_DE_CUENTA', fingerprint: '{"viejo":2}' }, 'id malo': { classification: 'ESTADO_DE_CUENTA', fingerprint: 'x' } }
    datos.set('nexora.classificationOverrides.cuentaA', JSON.stringify(locales))
    clasificacionesMock.mockResolvedValueOnce({ clasificaciones: {}, migrado_en: null }).mockResolvedValueOnce({ clasificaciones: { m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: 'v2:nuevo' } }, migrado_en: '2026-11-05T12:00:00+00:00' })
    migrarMock.mockResolvedValue({ migradas: 2, ya_migrado: false, migrado_en: '2026-11-05T12:00:00+00:00' })

    const resultado = await inboxStore.migrarClasificaciones('cuentaA', [mensaje('m1')] as never, () => 'v2:nuevo')

    expect(resultado).toEqual({ migradas: 2, yaMigrado: false })
    expect(migrarMock).toHaveBeenCalledWith({ m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: 'v2:nuevo' }, m2: { classification: 'NO_ES_ESTADO_DE_CUENTA', fingerprint: 'legado' } })
    expect(datos.has('nexora.classificationOverrides.cuentaA')).toBe(false)
    expect(JSON.parse(datos.get('nexora.classificationOverrides.cuentaA.migrado')!)).toEqual(locales)
    expect(inboxStore.cachedClasificaciones().m1.fingerprint).toBe('v2:nuevo')
  })

  it('si el backend ya migró, no vuelve a enviar nada ni toca el navegador', async () => {
    datos.set('nexora.classificationOverrides.cuentaA', JSON.stringify({ m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: 'x' } }))
    clasificacionesMock.mockResolvedValue({ clasificaciones: {}, migrado_en: '2026-11-01T00:00:00+00:00' })
    expect(await inboxStore.migrarClasificaciones('cuentaA', [], () => 'v2:x')).toEqual({ migradas: 0, yaMigrado: true })
    expect(migrarMock).not.toHaveBeenCalled()
    expect(datos.has('nexora.classificationOverrides.cuentaA')).toBe(true)
  })

  it('si la migración falla, la copia local se queda donde estaba', async () => {
    datos.set('nexora.classificationOverrides.cuentaA', JSON.stringify({ m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: 'x' } }))
    clasificacionesMock.mockResolvedValue({ clasificaciones: {}, migrado_en: null })
    migrarMock.mockRejectedValue(new Error('backend caído'))
    await expect(inboxStore.migrarClasificaciones('cuentaA', [], () => 'v2:x')).rejects.toThrow('backend caído')
    expect(datos.has('nexora.classificationOverrides.cuentaA')).toBe(true)
    expect(datos.has('nexora.classificationOverrides.cuentaA.migrado')).toBe(false)
  })

  it('las clasificaciones en caché son de la cuenta conectada', async () => {
    clasificacionesMock.mockResolvedValueOnce({ clasificaciones: { m1: { classification: 'ESTADO_DE_CUENTA', fingerprint: 'v2:a' } }, migrado_en: 'x' })
    await inboxStore.loadClasificaciones()
    expect(Object.keys(inboxStore.cachedClasificaciones())).toEqual(['m1'])
    statusMock.mockResolvedValueOnce({ connected: true, provider: 'gmail', email: 'b@example.com', cuentaId: 'cuentaB' })
    await inboxStore.loadStatus()
    expect(inboxStore.cachedClasificaciones()).toEqual({})
  })
})
