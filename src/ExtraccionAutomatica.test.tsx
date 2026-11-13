// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { EstadoAutomatico } from './services/automaticoApi'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

let guardado: ExtraccionGuardada | null = null
let estadoAuto: EstadoAutomatico

const { configurarMock, revisarMock, enviarMock } = vi.hoisted(() => ({ configurarMock: vi.fn(), revisarMock: vi.fn(), enviarMock: vi.fn() }))

vi.mock('./services/automaticoApi', () => ({ automaticoApi: { estado: vi.fn(async () => estadoAuto), configurar: configurarMock, revisarAhora: revisarMock } }))
const plantillaPrueba = vi.hoisted(() => ({ campos: [] as { id: string; nombre: string; origen: 'ia' | 'manual'; alcance: 'documento' | 'movimiento'; clave?: string }[] }))
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => ({ configurada: true, campos: plantillaPrueba.campos, actualizado: null })), guardar: vi.fn(async (campos: unknown[]) => ({ configurada: true, campos, actualizado: null })), sugerir: vi.fn(async () => []) },
  plantillaVigente: { actual: () => plantillaPrueba.campos, cargar: async () => plantillaPrueba.campos, fijar: vi.fn() },
}))
vi.mock('./services/geminiApi', () => ({
  geminiApi: { status: vi.fn(async () => ({ configured: true, enabled: true, model: 'gemini-prueba', maskedKey: null })), extract: vi.fn() },
}))
vi.mock('./services/savedataApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/savedataApi')>()
  return { ...real, savedataApi: { ...real.savedataApi, enviar: enviarMock } }
})
vi.mock('./services/extraccionesApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/extraccionesApi')>()
  return { ...real, extraccionesApi: { ...real.extraccionesApi, obtener: vi.fn(async () => guardado), guardar: vi.fn(), listar: vi.fn() } }
})
vi.mock('./services/inboxStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/inboxStore')>()
  return { ...real, inboxStore: { ...real.inboxStore, loadStatus: vi.fn(async () => ({ connected: true, email: 'a@example.com', cuentaId: 'cuenta-1' })), cachedStatus: () => null, invalidarEstados: vi.fn() } }
})

const { ExtractionTabsWorkspace, TarjetaExtraccionAutomatica } = await import('./App')

const fila = (id: string, huella: string): Transaccion => ({ id, fecha: '02/11/2026', concepto: `PAGO ${id}`, referencia: '', cargo: '100.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella })
const estadoBase = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: false, activado_en: null, ultima_revision: null, proxima_revision: null, en_curso: false, intervalo_minutos: 20, ultimo_resultado: null, ultimo_error: null,
  gemini_configurado: true, campos: ['Nombre', 'RFC'], adjuntos: {}, ...cambios,
})

beforeEach(() => {
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:prueba')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  estadoAuto = estadoBase()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Configuración: extracción automática', () => {
  it('muestra los campos que se buscarán y activa o pausa con el interruptor', async () => {
    configurarMock.mockImplementation(async (activo: boolean) => ({ ...estadoAuto, activo, activado_en: '2026-11-13T09:00:00Z' }))
    const onNotice = vi.fn()
    render(<TarjetaExtraccionAutomatica onNotice={onNotice} onError={vi.fn()} />)
    expect(await screen.findByText('Campos que se buscarán automáticamente: Nombre, RFC')).toBeTruthy()
    const interruptor = screen.getByRole('switch', { name: 'Extracción automática' })
    expect(interruptor.getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('button', { name: 'Revisar ahora' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(interruptor)
    await waitFor(() => expect(interruptor.getAttribute('aria-checked')).toBe('true'))
    expect(configurarMock).toHaveBeenCalledWith(true)
    expect(onNotice).toHaveBeenCalled()
  })

  it('"Revisar ahora" pide la revisión y nunca envía a SaveData', async () => {
    estadoAuto = estadoBase({ activo: true, activado_en: '2026-11-13T09:00:00Z' })
    revisarMock.mockImplementation(async () => ({ ...estadoAuto, en_curso: true }))
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    const boton = await screen.findByRole('button', { name: 'Revisar ahora' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)
    await waitFor(() => expect(revisarMock).toHaveBeenCalledTimes(1))
    expect(enviarMock).not.toHaveBeenCalled()
  })
})

describe('Extracción: sugerencias pendientes', () => {
  it('avisa de las sugerencias de la IA y el aviso abre el menú "+ Campo"', async () => {
    guardado = {
      schema: 1, messageId: 'm-a', partId: 'a', attachmentId: 'att-a', filename: 'estado.png', estado: 'borrador', version: 1, creado: '2026-11-13T10:00:00Z', actualizado: '2026-11-13T10:00:00Z',
      revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'gemini-prueba', prompt_version: 'v', formato_numerico: 'us',
      resumen: { banco: 'BANCO', titular: '', cuenta: '', periodo: '', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
      transacciones: [fila('ia-1', 'h1'), fila('ia-2', 'h2')],
      campos_extra: [{ id: 'c1', nombre: 'Nombre', origen: 'manual' }],
      sugerencias_campos: [{ clave: 'folio', nombre: 'Folio', valores: [{ huella: 'h1', valor: 'F1' }] }, { clave: 'nombre', nombre: 'Nombre', valores: [], valor_documento: 'X' }],
      validacion: {} as ExtraccionGuardada['validacion'],
      problemas: {} as ExtraccionGuardada['problemas'],
    }
    const archivo: ArchivoExtraccion = { clave: 'm-a:a', messageId: 'm-a', attachmentId: 'att-a', partId: 'a', filename: 'estado.png' }
    const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="gemini" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
    render(<RouterProvider router={router} />)
    // Solo cuenta la sugerencia que aún no es columna ("Nombre" ya lo es).
    expect(await screen.findByText(/La IA detectó 1 campo que no está en la tabla/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ver sugerencias' }))
    const menu = await screen.findByRole('dialog', { name: 'Agregar campo' })
    expect(menu.textContent).toContain('Folio')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso de sugerencias' }))
    expect(screen.queryByText(/La IA detectó/)).toBeNull()
  })
})
