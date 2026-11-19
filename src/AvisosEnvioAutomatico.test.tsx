// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, Routes, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdjuntoAutomatico, EstadoAutomatico } from './services/automaticoApi'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import type { GmailMessage } from './services/gmailApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

let estadoAuto: EstadoAutomatico
let guardado: ExtraccionGuardada | null = null
let mensajes: GmailMessage[] = []

const { guardarMock, estadoMock } = vi.hoisted(() => ({ guardarMock: vi.fn(), estadoMock: vi.fn() }))
vi.mock('./services/automaticoApi', () => ({ automaticoApi: { estado: estadoMock, configurar: vi.fn(), configurarEnvio: vi.fn(), revisarAhora: vi.fn(), marcarAvisosLeidos: vi.fn() } }))
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => ({ configurada: true, campos: [], actualizado: null })), guardar: vi.fn(), sugerir: vi.fn(async () => []) },
  plantillaVigente: { actual: () => [], cargar: async () => [], fijar: vi.fn() },
}))
vi.mock('./services/geminiApi', () => ({ geminiApi: { status: vi.fn(async () => ({ configured: true, enabled: true, model: 'gemini-prueba', maskedKey: null })), extract: vi.fn() } }))
vi.mock('./services/extraccionesApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/extraccionesApi')>()
  return { ...real, extraccionesApi: { ...real.extraccionesApi, obtener: vi.fn(async () => guardado), guardar: guardarMock, listar: vi.fn() } }
})
vi.mock('./services/inboxStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/inboxStore')>()
  const listado = () => ({ clave: 'k', messages: mensajes, nextPageToken: null, sinRemitentes: false, remitentes: 0, descartados: 0, firmaFiltro: '', paginas: [null], fetchedAt: Date.now() })
  return {
    ...real,
    inboxStore: {
      ...real.inboxStore,
      loadStatus: vi.fn(async () => ({ connected: true, email: 'a@example.com', cuentaId: 'cuenta-1' })), cachedStatus: () => null,
      cachedListado: () => null, loadListado: vi.fn(async () => listado()), loadEstados: vi.fn(async () => ({})), lastFolder: () => 'inbox', setLastFolder: vi.fn(), invalidarEstados: vi.fn(),
    },
  }
})

const { FilteredGmailInboxPage, TarjetaExtraccionAutomatica, ExtractionTabsWorkspace } = await import('./App')
const { seleccionAdjuntos } = await import('./services/seleccionAdjuntos')

const estadoBase = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: true, activado_en: '2026-11-13T09:00:00Z', ultima_revision: '2026-11-13T09:24:00Z', proxima_revision: '2026-11-13T09:44:00Z', en_curso: false, intervalo_minutos: 20,
  ultimo_resultado: 'ok', ultimo_error: null, gemini_configurado: true, campos: [], adjuntos: {}, envio_activo: true, solo_si_cuadra: true, envio_activado_en: '2026-11-13T09:00:00Z', savedata_configurada: true, ...cambios,
})
const correo = (id: string, recibido: string): GmailMessage => ({
  id, threadId: id, sender: 'Banco', senderEmail: 'banco@example.com', to: '', subject: 'Estado de cuenta', snippet: '', body: '', receivedAt: recibido, unread: false, labels: [],
  attachments: [{ id: `att-${id}`, filename: `${id}.pdf`, mimeType: 'application/pdf', size: 1000, partId: '1' }],
})

beforeEach(() => {
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:prueba')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  seleccionAdjuntos.limpiar()
  estadoAuto = estadoBase()
  estadoMock.mockImplementation(async () => estadoAuto)
  mensajes = [correo('nuevo', '2026-11-13T09:30:00Z')]
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const TEXTO_CONFIG = 'No necesitas hacer nada: cada 20 minutos Nexora revisa los correos nuevos, los extrae y los envía a SaveData. Si extraes o editas un documento a mano, ya no se enviará automáticamente.'

describe('Configuración: aviso del envío automático', () => {
  it('se muestra con el envío automático encendido', async () => {
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    expect(await screen.findByText(TEXTO_CONFIG)).toBeTruthy()
  })

  it('no se muestra con el envío apagado ni con la extracción en pausa', async () => {
    estadoAuto = estadoBase({ envio_activo: false })
    const { unmount } = render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Extracción automática' }).getAttribute('aria-checked')).toBe('true'))
    expect(screen.queryByText(TEXTO_CONFIG)).toBeNull()
    unmount()
    estadoAuto = estadoBase({ activo: false })
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Envío automático a SaveData' }).getAttribute('aria-checked')).toBe('true'))
    expect(screen.queryByText(TEXTO_CONFIG)).toBeNull()
  })
})

describe('Correos: avisos y confirmación del envío automático', () => {
  const Ruta = () => <div data-testid="ruta">{useLocation().pathname}</div>
  const pintar = () => {
    render(<MemoryRouter initialEntries={['/emails']}><Ruta /><Routes><Route path="/emails" element={<FilteredGmailInboxPage />} /><Route path="/extraction" element={<div>Página de extracción</div>} /></Routes></MemoryRouter>)
    return { state: { get location() { return { pathname: screen.getByTestId('ruta').textContent } } } }
  }

  it('con el envío encendido muestra el aviso y la etiqueta en los adjuntos nuevos sin revisar', async () => {
    pintar()
    expect(await screen.findByText(/^Envío automático activo · los estados de cuenta nuevos se envían solos en la próxima revisión \([^)]+\)\. No es necesario pulsar Extraer\.$/)).toBeTruthy()
    expect(await screen.findByText('Pendiente de envío automático')).toBeTruthy()
  })

  it('no marca como pendiente lo anterior a la activación', async () => {
    mensajes = [correo('viejo', '2026-11-13T08:00:00Z')]
    pintar()
    await screen.findByText(/Envío automático activo/)
    await screen.findByText('viejo.pdf')
    expect(screen.queryByText('Pendiente de envío automático')).toBeNull()
  })

  it('no marca como pendiente lo que el proceso ya revisó', async () => {
    mensajes = [correo('hecho', '2026-11-13T09:30:00Z')]
    estadoAuto = estadoBase({ adjuntos: { hecho__1: { estado: 'omitido', intentos: 0, error: null, version: null, actualizado: null } } })
    pintar()
    await screen.findByText(/Envío automático activo/)
    await screen.findByText('hecho.pdf')
    expect(screen.queryByText('Pendiente de envío automático')).toBeNull()
  })

  it('con el envío apagado no muestra avisos, etiquetas ni confirmación', async () => {
    estadoAuto = estadoBase({ envio_activo: false })
    const router = pintar()
    await screen.findByText(/Extracción automática activa/)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Marcar nuevo.pdf para extraer' }))
    expect(screen.queryByText(/Envío automático activo/)).toBeNull()
    expect(screen.queryByText('Pendiente de envío automático')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Extraer (1)' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(router.state.location.pathname).toBe('/extraction'))
  })

  it('al extraer a mano un adjunto pendiente pide confirmación antes', async () => {
    const router = pintar()
    await screen.findByText('Pendiente de envío automático')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Marcar nuevo.pdf para extraer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Extraer (1)' }))
    const dialogo = await screen.findByRole('alertdialog')
    expect(dialogo.textContent).toContain('Estos documentos se enviarán solos en la próxima revisión. Si los extraes ahora, ya no se enviarán automáticamente y tendrás que enviarlos a mano. ¿Continuar?')
    fireEvent.click(screen.getByRole('button', { name: 'Esperar al envío automático' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/emails')
    expect(seleccionAdjuntos.total()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Extraer (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Extraer de todos modos' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/extraction'))
  })
})

describe('Extracción: confirmación al guardar un documento pendiente de envío automático', () => {
  const fila = (id: string): Transaccion => ({ id, fecha: '02/11/2026', concepto: `PAGO ${id}`, referencia: '', cargo: '100.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella: `h-${id}` })
  const autoExtraido = (cambios: Partial<AdjuntoAutomatico> = {}): AdjuntoAutomatico => ({ estado: 'extraido', intentos: 1, error: null, version: 1, actualizado: null, enviar_auto: true, envio: null, ...cambios })
  const pintar = async () => {
    guardado = {
      schema: 1, messageId: 'm-a', partId: 'a', attachmentId: 'att-a', filename: 'estado.png', estado: 'borrador', version: 1, creado: '2026-11-13T10:00:00Z', actualizado: '2026-11-13T10:00:00Z',
      revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'gemini-prueba', prompt_version: 'v', formato_numerico: 'us',
      resumen: { banco: 'BANCO', titular: '', cuenta: '', periodo: '', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
      transacciones: [fila('ia-1')], campos_extra: [], sugerencias_campos: [],
      validacion: {} as ExtraccionGuardada['validacion'], problemas: {} as ExtraccionGuardada['problemas'],
    }
    guardarMock.mockImplementation(() => new Promise(() => undefined))
    const archivo: ArchivoExtraccion = { clave: 'm-a:a', messageId: 'm-a', attachmentId: 'att-a', partId: 'a', filename: 'estado.png' }
    const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="gemini" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
    render(<RouterProvider router={router} />)
    const marcar = await screen.findByRole('button', { name: 'Marcar como revisado' })
    await waitFor(() => expect((marcar as HTMLButtonElement).disabled).toBe(false))
    await waitFor(() => expect(estadoMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    return marcar
  }
  // Guardar puede pasar antes por la confirmación de problemas contables; cualquiera de las dos indica que se siguió adelante.
  const siguioAdelante = () => guardarMock.mock.calls.length > 0 || screen.queryByText(/Quedan \d+ problema/) !== null
  const TEXTO = 'Este documento se enviará solo en la próxima revisión. Si lo guardas ahora, ya no se enviará automáticamente y tendrás que enviarlo a mano. ¿Continuar?'

  it('avisa antes de guardar; "Esperar" no guarda y "Guardar de todos modos" sí', async () => {
    estadoAuto = estadoBase({ adjuntos: { 'm-a__a': autoExtraido() } })
    const marcar = await pintar()
    fireEvent.click(marcar)
    expect(await screen.findByText(TEXTO)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Esperar al envío automático' }))
    expect(screen.queryByText(TEXTO)).toBeNull()
    expect(siguioAdelante()).toBe(false)
    fireEvent.click(marcar)
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar de todos modos' }))
    await waitFor(() => expect(siguioAdelante()).toBe(true))
  })

  it('sin aviso con el envío automático apagado', async () => {
    estadoAuto = estadoBase({ envio_activo: false, adjuntos: { 'm-a__a': autoExtraido() } })
    fireEvent.click(await pintar())
    await waitFor(() => expect(siguioAdelante()).toBe(true))
    expect(screen.queryByText(TEXTO)).toBeNull()
  })

  it('sin aviso si el envío automático ya terminó', async () => {
    estadoAuto = estadoBase({ adjuntos: { 'm-a__a': autoExtraido({ envio: { estado: 'enviado', intentos: 1, error: null, motivos: null, problemas: null, version: 1, actualizado: null } }) } })
    fireEvent.click(await pintar())
    await waitFor(() => expect(siguioAdelante()).toBe(true))
    expect(screen.queryByText(TEXTO)).toBeNull()
  })
})
