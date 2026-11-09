// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { GeminiExtractionResponse } from './services/geminiApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

const RequestDeNode = globalThis.Request
const pendientes = new Map<string, { resolver: (valor: GeminiExtractionResponse) => void; signal?: AbortSignal }>()

vi.mock('./services/geminiApi', () => ({
  geminiApi: {
    status: vi.fn(async () => ({ configured: true, enabled: true, model: 'gemini-prueba', maskedKey: null })),
    extract: vi.fn((_messageId: string, attachmentId: string, opciones: { signal?: AbortSignal } = {}) => new Promise<GeminiExtractionResponse>((resolver) => { pendientes.set(attachmentId, { resolver, signal: opciones.signal }) })),
  },
}))

vi.mock('./services/extraccionesApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/extraccionesApi')>()
  return { ...real, extraccionesApi: { ...real.extraccionesApi, obtener: vi.fn(async () => null), guardar: vi.fn(), listar: vi.fn() } }
})

vi.mock('./services/inboxStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/inboxStore')>()
  return { ...real, inboxStore: { ...real.inboxStore, loadStatus: vi.fn(async () => ({ connected: true, email: 'a@example.com', cuentaId: 'cuenta-1' })), cachedStatus: () => null, invalidarEstados: vi.fn() } }
})

const { ExtractionTabsWorkspace } = await import('./App')
const { geminiApi } = await import('./services/geminiApi')
const { borradoresLocales, claveBorrador } = await import('./services/guardado')

const archivo = (letra: string): ArchivoExtraccion => ({ clave: `m-${letra}:${letra}`, messageId: `m-${letra}`, attachmentId: `att-${letra}`, partId: letra, filename: `estado-${letra}.pdf` })
const A = archivo('a')
const B = archivo('b')

const movimiento = (concepto: string): Transaccion => ({ id: `ia-${concepto}`, fecha: '01/10', concepto, referencia: '', cargo: '10.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella: concepto })
const respuesta = (concepto: string): GeminiExtractionResponse => ({
  filename: `${concepto}.pdf`,
  model: 'gemini-prueba',
  prompt_version: 'v-prueba',
  formato_numerico: null,
  resumen: { banco: 'Banco', titular: 'Titular', cuenta: '1234', periodo: 'Octubre', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
  transacciones: [movimiento(concepto)],
  validacion: {} as GeminiExtractionResponse['validacion'],
  warnings: [],
})

function montar(archivos: ArchivoExtraccion[], lote: boolean) {
  const router = createMemoryRouter([
    { path: '/emails', element: <div>Pantalla de correos</div> },
    { path: '*', element: <ExtractionTabsWorkspace archivos={archivos} lote={lote} mode="gemini" onModeChange={() => undefined} /> },
  ], { initialEntries: ['/extraction'] })
  return { router, ...render(<RouterProvider router={router} />) }
}

const panel = (archivoBuscado: ArchivoExtraccion) => {
  const pestana = screen.getByRole('tab', { name: new RegExp(archivoBuscado.filename) })
  return document.getElementById(pestana.getAttribute('aria-controls')!)
}
const abrir = (archivoBuscado: ArchivoExtraccion) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(archivoBuscado.filename) }))
const pestana = (archivoBuscado: ArchivoExtraccion, estado: string) => screen.getByRole('tab', { name: new RegExp(`${archivoBuscado.filename.replace('.', '\.')}.*${estado}`) })
const resolverGemini = async (archivoBuscado: ArchivoExtraccion, concepto: string) => {
  await waitFor(() => expect(pendientes.has(archivoBuscado.attachmentId)).toBe(true))
  await act(async () => { pendientes.get(archivoBuscado.attachmentId)!.resolver(respuesta(concepto)) })
}
const conceptosDelBorrador = (archivoBuscado: ArchivoExtraccion) => borradoresLocales().leer(claveBorrador('cuenta-1', archivoBuscado.messageId, archivoBuscado.partId!))?.documento.transacciones.map((fila) => fila.concepto) ?? null
const volver = (archivoBuscado: ArchivoExtraccion) => fireEvent.click(within(panel(archivoBuscado)!).getByRole('button', { name: /^Volver$/ }))
const agregarListo = async (elemento: HTMLElement) => {
  const boton = within(elemento).getByRole('button', { name: /Agregar/ }) as HTMLButtonElement
  await waitFor(() => expect(boton.disabled).toBe(false))
  return boton
}

beforeEach(() => {
  pendientes.clear()
  window.localStorage.clear()
  // Visor del documento y SaveData: sus peticiones quedan pendientes; no intervienen en estas pruebas.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  // Solo del entorno de prueba: al navegar, React Router crea un Request con la AbortSignal de jsdom, que el Request de
  // Node rechaza (y la navegación nunca termina). Se crea sin esa señal; en el navegador no ocurre.
  vi.stubGlobal('Request', class extends RequestDeNode { constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init ? { ...init, signal: undefined } : init) } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('pestañas de extracción', () => {
  it('las ediciones de una pestaña no afectan a otra y se conservan al cambiar de pestaña', async () => {
    montar([A, B], false)
    const panelA = panel(A)!
    fireEvent.click(await agregarListo(panelA))
    fireEvent.change(within(panelA).getByLabelText('Concepto del movimiento 1'), { target: { value: 'SOLO-A' } })
    // Indicador de cambios sin guardar en la pestaña A.
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /estado-a\.pdf/ })).getByLabelText('Cambios sin guardar')).toBeTruthy())

    abrir(B)
    const panelB = panel(B)!
    await agregarListo(panelB)
    expect(within(panelB).queryByDisplayValue('SOLO-A')).toBeNull()
    expect(within(panelB).getByText(/Sin movimientos/)).toBeTruthy()
    fireEvent.click(within(panelB).getByRole('button', { name: /Agregar/ }))
    fireEvent.change(within(panelB).getByLabelText('Concepto del movimiento 1'), { target: { value: 'SOLO-B' } })

    abrir(A)
    expect(panel(A)!.hidden).toBe(false)
    expect(panel(B)!.hidden).toBe(true)
    expect(within(panel(A)!).getByDisplayValue('SOLO-A')).toBeTruthy()
    expect(within(panel(A)!).queryByDisplayValue('SOLO-B')).toBeNull()
    expect(within(panel(B)!).getByDisplayValue('SOLO-B')).toBeTruthy()
    // Ambas pestañas marcan cambios sin guardar.
    expect(within(screen.getByRole('tab', { name: /estado-b\.pdf/ })).getByLabelText('Cambios sin guardar')).toBeTruthy()
  })

  it('una respuesta tardía de Gemini solo cae en la pestaña de su archivo, y la cola va en secuencia', async () => {
    montar([A, B], true)
    await waitFor(() => expect(pendientes.has('att-a')).toBe(true))
    // En secuencia: B no se pide a Gemini mientras A no termina.
    expect(pendientes.has('att-b')).toBe(false)
    expect(screen.getByRole('tab', { name: /estado-a\.pdf.*Extrayendo/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /estado-b\.pdf.*En cola/ })).toBeTruthy()

    // El usuario se cambia a B mientras Gemini procesa A; luego llega la respuesta de A.
    abrir(B)
    await agregarListo(panel(B)!)
    await act(async () => { pendientes.get('att-a')!.resolver(respuesta('MOV-A')) })

    await waitFor(() => expect(within(panel(A)!).getByDisplayValue('MOV-A')).toBeTruthy())
    expect(within(panel(B)!).queryByDisplayValue('MOV-A')).toBeNull()

    await waitFor(() => expect(pendientes.has('att-b')).toBe(true))
    await act(async () => { pendientes.get('att-b')!.resolver(respuesta('MOV-B')) })
    await waitFor(() => expect(within(panel(B)!).getByDisplayValue('MOV-B')).toBeTruthy())
    expect(within(panel(A)!).queryByDisplayValue('MOV-B')).toBeNull()
    expect(geminiApi.extract).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('tab', { name: /estado-a\.pdf.*Extraído/ })).toBeTruthy()
  })

  it('una pestaña con error muestra el error y reintenta solo ese archivo; los demás siguen', async () => {
    vi.mocked(geminiApi.extract).mockImplementationOnce(async () => { throw new Error('Cuota agotada') })
    montar([A, B], true)
    await waitFor(() => expect(within(panel(A)!).getByRole('alert').textContent).toMatch(/Cuota agotada/))
    expect(screen.getByRole('tab', { name: /estado-a\.pdf.*Error/ })).toBeTruthy()
    // B sigue en la cola a pesar del error de A.
    await waitFor(() => expect(pendientes.has('att-b')).toBe(true))
    await act(async () => { pendientes.get('att-b')!.resolver(respuesta('MOV-B')) })

    fireEvent.click(within(panel(A)!).getByRole('button', { name: /Reintentar este archivo/ }))
    await waitFor(() => expect(pendientes.has('att-a')).toBe(true))
    await act(async () => { pendientes.get('att-a')!.resolver(respuesta('MOV-A')) })
    await waitFor(() => expect(within(panel(A)!).getByDisplayValue('MOV-A')).toBeTruthy())
    expect(geminiApi.extract).toHaveBeenCalledTimes(3)
  })

  it('con un solo archivo (enlace antiguo) muestra una pestaña y no extrae automáticamente', async () => {
    montar([A], false)
    await agregarListo(panel(A)!)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(geminiApi.extract).not.toHaveBeenCalled()
  })

  it('el resultado de una pestaña sin abrir se conserva, cuenta como sin guardar y aparece al abrirla', async () => {
    montar([A, B], true)
    await resolverGemini(A, 'MOV-A')
    await resolverGemini(B, 'MOV-B')
    await waitFor(() => expect(pestana(B, 'Extraído')).toBeTruthy())
    expect(panel(B)).toBeNull() // la pestaña B nunca se montó
    expect(within(pestana(B, 'Extraído')).getByLabelText('Cambios sin guardar')).toBeTruthy()

    abrir(B)
    await waitFor(() => expect(within(panel(B)!).getByDisplayValue('MOV-B')).toBeTruthy())
    expect(within(panel(A)!).queryByDisplayValue('MOV-B')).toBeNull()
    expect(geminiApi.extract).toHaveBeenCalledTimes(2)
  })

  it('al salir con pestañas sin abrir avisa nombrándolas, escribe su borrador local y al volver no llama otra vez a Gemini', async () => {
    const { router } = montar([A, B], true)
    await resolverGemini(A, 'MOV-A')
    await resolverGemini(B, 'MOV-B')
    await waitFor(() => expect(within(panel(A)!).getByDisplayValue('MOV-A')).toBeTruthy())
    await waitFor(() => expect(pestana(B, 'Extraído')).toBeTruthy())

    volver(A)
    const dialogo = await screen.findByRole('alertdialog', { name: 'Hay cambios sin guardar' })
    expect(dialogo.textContent).toMatch(/estado-a.pdf/)
    expect(dialogo.textContent).toMatch(/estado-b.pdf/)
    expect(dialogo.textContent).not.toMatch(/por extraer/)
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salir sin guardar' }))
    await screen.findByText('Pantalla de correos')
    expect(conceptosDelBorrador(A)).toEqual(['MOV-A'])
    expect(conceptosDelBorrador(B)).toEqual(['MOV-B'])

    await act(async () => { await router.navigate('/extraction') })
    await waitFor(() => expect(pestana(A, 'Borrador local')).toBeTruthy())
    await waitFor(() => expect(pestana(B, 'Borrador local')).toBeTruthy())
    await waitFor(() => expect(within(panel(A)!).getByRole('button', { name: 'Restaurar borrador local' })).toBeTruthy())
    abrir(B)
    await waitFor(() => expect(within(panel(B)!).getByRole('button', { name: 'Restaurar borrador local' })).toBeTruthy())
    expect(geminiApi.extract).toHaveBeenCalledTimes(2)
  })

  it('al salir a media cola avisa cuántos archivos quedan y los cancela', async () => {
    montar([A, B], true)
    await waitFor(() => expect(pendientes.has('att-a')).toBe(true))
    await agregarListo(panel(A)!)

    volver(A)
    const dialogo = await screen.findByRole('alertdialog', { name: 'La extracción sigue en curso' })
    expect(dialogo.textContent).toContain('Quedan 2 archivos por extraer; se cancelarán.')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salir y cancelar' }))
    await screen.findByText('Pantalla de correos')
    expect(pendientes.get('att-a')!.signal!.aborted).toBe(true)

    // La respuesta tardía de A se descarta y B nunca se pide a Gemini.
    await act(async () => { pendientes.get('att-a')!.resolver(respuesta('MOV-A')) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(geminiApi.extract).toHaveBeenCalledTimes(1)
    expect(conceptosDelBorrador(A)).toBeNull()
    expect(conceptosDelBorrador(B)).toBeNull()
  })
})
