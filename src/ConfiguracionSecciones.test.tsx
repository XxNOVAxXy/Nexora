// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EstadoAutomatico } from './services/automaticoApi'
import type { GmailStatus } from './services/gmailApi'
import type { GeminiStatus } from './services/geminiApi'
import type { ConfigSaveData } from './services/savedataApi'

let gmail: GmailStatus
let gemini: GeminiStatus
let savedata: ConfigSaveData
let estadoAuto: EstadoAutomatico
const { estadoMock, configurarMock } = vi.hoisted(() => ({ estadoMock: vi.fn(), configurarMock: vi.fn() }))
vi.mock('./services/automaticoApi', () => ({ automaticoApi: { estado: estadoMock, configurar: configurarMock, configurarEnvio: vi.fn(), revisarAhora: vi.fn(), marcarAvisosLeidos: vi.fn(async () => undefined) } }))
vi.mock('./services/geminiApi', () => ({ geminiApi: { status: vi.fn(async () => gemini), save: vi.fn(), disable: vi.fn() } }))
vi.mock('./services/savedataApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/savedataApi')>()
  return { ...real, savedataApi: { ...real.savedataApi, config: vi.fn(async () => savedata), guardarConfig: vi.fn() } }
})
vi.mock('./services/gmailApi', () => ({ gmailApi: { disconnect: vi.fn(), startAuth: vi.fn() } }))
vi.mock('./services/inboxStore', () => ({
  claveEstado: (messageId: string, partId: string) => `${messageId}:${partId}`,
  inboxStore: {
    subscribe: () => () => undefined, version: () => 0, loadStatus: vi.fn(async () => gmail), cachedStatus: () => gmail, cachedListado: () => null,
    lastFiltro: () => 'estados', lastFolder: () => 'inbox', clear: vi.fn(),
  },
}))
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => ({ configurada: true, campos: [], actualizado: null })), guardar: vi.fn(), sugerir: vi.fn() },
  plantillaVigente: { actual: () => [], cargar: async () => [], fijar: vi.fn() },
}))

vi.mock('./services/tiposDocumentoApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/tiposDocumentoApi')>()
  const ec = { id: 'tipo-ec', nombre: 'Estado de cuenta', codigo: 'EC', color: '#2563eb', seccion: { nombre: 'Movimientos' }, campos: [], estructuras: [], contable: true, configurado: true, documentos: 0 }
  return { ...real, tiposDocumentoApi: { ...real.tiposDocumentoApi, listar: vi.fn(async () => ({ tipos: [ec], umbral_confianza: 0.7 })), documentos: vi.fn(async () => ({ documentos: [], umbral_confianza: 0.7 })) } }
})

const { default: App } = await import('./App')

const estadoBase = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: false, activado_en: null, ultima_revision: null, proxima_revision: null, en_curso: false, intervalo_minutos: 20, ultimo_resultado: null, ultimo_error: null,
  gemini_configurado: true, campos: [], adjuntos: {}, envio_activo: false, solo_si_cuadra: true, envio_activado_en: null, savedata_configurada: true,
  ultimo_ciclo: null, descartados: [], avisos: [], avisos_sin_leer: 0, revision_pendiente: false, ...cambios,
})

function Controles() {
  const ubicacion = useLocation()
  const navegar = useNavigate()
  return <><div data-testid="ruta">{ubicacion.pathname}</div><button type="button" onClick={() => navegar(-1)}>Atrás del navegador</button></>
}
const pintar = (ruta: string) => render(<MemoryRouter initialEntries={[ruta]}><App /><Controles /></MemoryRouter>)
const menu = () => screen.getByRole('navigation', { name: 'Secciones de configuración' })
const enlace = (nombre: string) => within(menu()).getByRole('link', { name: new RegExp(`^${nombre}`) })
const indicador = (id: string) => screen.getByTestId(`indicador-${id}`).getAttribute('data-estado')
const seccion = (id: string) => document.getElementById(`titulo-seccion-${id}`)?.closest('section') as HTMLElement
const visible = (id: string) => !seccion(id).hidden

beforeEach(() => {
  gmail = { connected: true, email: 'cuenta@example.com' } as GmailStatus
  gemini = { configured: true, enabled: true, model: 'gemini-3.5-flash-lite', maskedKey: 'AI…xyz' } as GeminiStatus
  savedata = { sucursal_predeterminada: 3102, url_configurada: true, url: 'https://savedata.example/api' }
  estadoAuto = estadoBase({ activo: true, activado_en: '2026-11-13T09:00:00Z' })
  estadoMock.mockImplementation(async () => estadoAuto)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Configuración por secciones', () => {
  it('/configuracion y /settings abren Conexiones; una sección desconocida también', async () => {
    for (const ruta of ['/configuracion', '/settings', '/configuracion/no-existe']) {
      pintar(ruta)
      await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/conexiones'))
      expect(enlace('Conexiones').getAttribute('aria-current')).toBe('page')
      expect(visible('conexiones')).toBe(true)
      cleanup()
    }
  })

  it('el menú lleva a cada sección por URL, resalta la activa y Atrás regresa a la anterior', async () => {
    pintar('/configuracion/conexiones')
    expect(await screen.findByText('Conexión real mediante OAuth 2.0.')).toBeTruthy()
    expect(screen.getByText('Las claves se guardan en FastAPI y nunca se muestran completas ni se almacenan en el navegador.')).toBeTruthy()
    fireEvent.click(enlace('SaveData'))
    expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/savedata')
    expect(enlace('SaveData').getAttribute('aria-current')).toBe('page')
    expect(enlace('Conexiones').getAttribute('aria-current')).toBeNull()
    expect(visible('savedata')).toBe(true)
    expect(visible('conexiones')).toBe(false)
    expect(screen.getByRole('button', { name: 'Guardar sucursal' })).toBeTruthy()
    fireEvent.click(enlace('Automatización'))
    expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/automatizacion')
    expect(await screen.findByRole('switch', { name: 'Extracción automática' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Atrás del navegador' }))
    expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/savedata')
    expect(visible('savedata')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Atrás del navegador' }))
    expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/conexiones')
  })

  it('cada tarjeta está en su sección; al cambiar de sección se conserva lo escrito', async () => {
    pintar('/configuracion/tipos-documento')
    // Los campos del estado de cuenta están en Tipos y reglas → Estado de cuenta.
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    expect(await screen.findByText('Estás configurando el tipo Estado de cuenta · código EC')).toBeTruthy()
    expect(await screen.findByRole('list', { name: 'Campos que se capturan' })).toBeTruthy()
    fireEvent.click(enlace('SaveData'))
    const sucursal = screen.getByPlaceholderText('Ej. 3102') as HTMLInputElement
    await waitFor(() => expect(sucursal.value).toBe('3102'))
    fireEvent.change(sucursal, { target: { value: '45' } })
    fireEvent.click(enlace('Conexiones'))
    fireEvent.click(enlace('SaveData'))
    expect((screen.getByPlaceholderText('Ej. 3102') as HTMLInputElement).value).toBe('45')
  })

  it('indicadores en verde: Gmail y Gemini conectados, URL configurada y automatización activa', async () => {
    pintar('/configuracion/conexiones')
    await waitFor(() => expect(indicador('conexiones')).toBe('ok'))
    await waitFor(() => expect(indicador('savedata')).toBe('ok'))
    await waitFor(() => expect(indicador('automatizacion')).toBe('ok'))
    expect(screen.queryByTestId('indicador-tipos-documento')).toBeNull()
    expect(enlace('Automatización').textContent).toContain('Activa')
  })

  it('indicadores en rojo: Gemini desactivado, sin URL y automatización en pausa', async () => {
    gemini = { ...gemini, enabled: false }
    savedata = { ...savedata, url_configurada: false, url: null }
    estadoAuto = estadoBase({ activo: false })
    pintar('/configuracion/conexiones')
    await waitFor(() => expect(indicador('conexiones')).toBe('error'))
    await waitFor(() => expect(indicador('savedata')).toBe('error'))
    await waitFor(() => expect(indicador('automatizacion')).toBe('error'))
    expect(enlace('Automatización').textContent).toContain('En pausa')
  })

  it('el punto de Automatización cambia al instante al pulsar el interruptor', async () => {
    estadoAuto = estadoBase({ activo: false })
    configurarMock.mockImplementation(async (activo: boolean) => ({ ...estadoAuto, activo, activado_en: '2026-11-19T09:00:00Z' }))
    pintar('/configuracion/automatizacion')
    await waitFor(() => expect(indicador('automatizacion')).toBe('error'))
    const interruptor = await screen.findByRole('switch', { name: 'Extracción automática' })
    await waitFor(() => expect((interruptor as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(interruptor)
    await waitFor(() => expect(indicador('automatizacion')).toBe('ok'))
    expect(configurarMock).toHaveBeenCalledWith(true)
    expect(estadoMock).toHaveBeenCalled()
  })

  it('sin Gmail: Tipos de documento y Automatización muestran el aviso con "Ir a Conexiones"', async () => {
    gmail = { connected: false, email: null } as unknown as GmailStatus
    pintar('/configuracion/tipos-documento')
    await screen.findByRole('heading', { name: 'Tipos de documento' })
    expect(await within(seccion('tipos-documento')).findByText('Conecta Gmail en Conexiones para ver esta sección')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Campos que se capturan' })).toBeNull()
    await waitFor(() => expect(indicador('conexiones')).toBe('error'))
    fireEvent.click(enlace('Automatización'))
    const auto = seccion('automatizacion')
    expect(within(auto).getByText('Conecta Gmail en Conexiones para ver esta sección')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Extracción automática' })).toBeNull()
    fireEvent.click(within(auto).getByRole('button', { name: 'Ir a Conexiones' }))
    expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/conexiones')
    expect(screen.getByRole('button', { name: 'Conectar Gmail' })).toBeTruthy()
  })

  it('el menú principal lleva a Configuración y la barra superior muestra su título', async () => {
    pintar('/configuracion/savedata')
    act(() => { fireEvent.click(screen.getByRole('link', { name: 'Configuración' })) })
    await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/configuracion/conexiones'))
    expect(screen.getByText('Workspace / Configuración')).toBeTruthy()
  })
})
