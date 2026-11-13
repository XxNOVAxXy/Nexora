// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import { geminiApi, type GeminiExtractionResponse } from './services/geminiApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

let guardado: ExtraccionGuardada | null = null

vi.mock('./services/geminiApi', () => ({
  geminiApi: { status: vi.fn(async () => ({ configured: true, enabled: true, model: 'gemini-prueba', maskedKey: '....1234' })), extract: vi.fn(), llenarCampo: vi.fn() },
}))
vi.mock('./services/extraccionesApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/extraccionesApi')>()
  return { ...real, extraccionesApi: { ...real.extraccionesApi, obtener: vi.fn(async () => guardado), guardar: vi.fn(), listar: vi.fn() } }
})
vi.mock('./services/inboxStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/inboxStore')>()
  return { ...real, inboxStore: { ...real.inboxStore, loadStatus: vi.fn(async () => ({ connected: true, email: 'a@example.com', cuentaId: 'cuenta-1' })), cachedStatus: () => null, invalidarEstados: vi.fn() } }
})

const { ExtractionTabsWorkspace } = await import('./App')

const fila = (id: string, huella: string, concepto: string, extras?: Record<string, string>): Transaccion => ({ id, fecha: '02/10/2026', concepto, referencia: '', cargo: '100.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella, ...(extras ? { extras } : {}) })
const resumen = { banco: 'BANCO', titular: '', cuenta: '', periodo: '', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] }
const base = (): ExtraccionGuardada => ({
  schema: 1, messageId: 'm-a', partId: 'a', attachmentId: 'att-a', filename: 'estado.png', estado: 'borrador', version: 1, creado: '2026-11-01T10:00:00Z', actualizado: '2026-11-01T10:00:00Z',
  revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'gemini-prueba', prompt_version: 'v', formato_numerico: 'us', resumen,
  transacciones: [fila('ia-1', 'h1', 'PAGO A', { 'c-nom': 'Juan' }), fila('ia-2', 'h2', 'PAGO B'), fila('ia-3', 'h3', 'PAGO C')],
  campos_extra: [{ id: 'c-nom', nombre: 'Nombre', origen: 'manual' }, { id: 'c-fol', nombre: 'Folio', origen: 'manual' }],
  sugerencias_campos: [],
  validacion: {} as ExtraccionGuardada['validacion'],
  problemas: {} as ExtraccionGuardada['problemas'],
})

function montar() {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  const archivo: ArchivoExtraccion = { clave: 'm-a:a', messageId: 'm-a', attachmentId: 'att-a', partId: 'a', filename: 'estado.png' }
  const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="gemini" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
  return render(<RouterProvider router={router} />)
}
const celda = (campo: string, fila: number) => screen.getByLabelText(`${campo} del movimiento ${fila}`) as HTMLInputElement
const encabezado = (campo: string) => screen.getByRole('button', { name: `Renombrar el campo ${campo}` }).closest('[data-campo]') as HTMLElement

beforeEach(() => {
  guardado = base()
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:prueba')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('la IA llena columnas manuales', () => {
  it('"Llenar con IA" busca una sola columna y llena solo sus celdas vacías', async () => {
    vi.mocked(geminiApi.llenarCampo).mockResolvedValue({ nombre: 'Nombre', encontrado: true, valores: [{ indice: 0, valor: 'Pedro' }, { indice: 1, valor: 'Ana' }, { indice: 2, valor: 'Luis' }] })
    montar()
    const boton = await screen.findByRole('button', { name: 'Llenar con IA el campo Nombre' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)

    expect(await within(encabezado('Nombre')).findByText('Se llenaron 2 celdas de «Nombre».')).toBeTruthy()
    expect(vi.mocked(geminiApi.llenarCampo).mock.calls[0].slice(0, 3)).toEqual(['m-a', 'att-a', 'Nombre'])
    expect(vi.mocked(geminiApi.llenarCampo).mock.calls[0][3]).toHaveLength(3)
    expect([1, 2, 3].map((n) => celda('Nombre', n).value)).toEqual(['Juan', 'Ana', 'Luis'])
    expect([1, 2, 3].map((n) => celda('Nombre', n).dataset.ia)).toEqual([undefined, 'true', 'true'])
    // Las demás columnas no se tocan y llenar no cuenta como edición manual.
    expect([1, 2, 3].map((n) => celda('Folio', n).value)).toEqual(['', '', ''])
    expect(screen.queryByText('IA editada')).toBeNull()
    expect(screen.getByText('Cambios sin guardar')).toBeTruthy()

    fireEvent.change(celda('Nombre', 2), { target: { value: 'Ana María' } })
    expect(celda('Nombre', 2).dataset.ia).toBeUndefined()
    expect(screen.getAllByText('IA editada')).toHaveLength(1)
  })

  it('si el dato no está en el documento lo dice junto a la columna y no cambia nada', async () => {
    vi.mocked(geminiApi.llenarCampo).mockResolvedValue({ nombre: 'Folio', encontrado: false, valores: [] })
    montar()
    const boton = await screen.findByRole('button', { name: 'Llenar con IA el campo Folio' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)
    expect(await within(encabezado('Folio')).findByText('No se encontró «Folio» en el documento.')).toBeTruthy()
    expect([1, 2, 3].map((n) => celda('Folio', n).value)).toEqual(['', '', ''])
    expect(screen.queryByText('Cambios sin guardar')).toBeNull()
  })

  it('al re-extraer pide las columnas manuales y resume lo que llenó en el aviso', async () => {
    const resultado: GeminiExtractionResponse = {
      filename: 'estado.png', model: 'gemini-prueba', prompt_version: 'v2', formato_numerico: 'us', resumen, warnings: [], validacion: {} as never,
      transacciones: [fila('ia-1', 'h1', 'PAGO A'), fila('ia-2', 'h2', 'PAGO B'), fila('ia-3', 'h3', 'PAGO C')],
      sugerencias_campos: [],
      resultados_campos: [
        { nombre: 'Nombre', clave: 'nombre', encontrado: true, valores: [], valor_documento: 'Persona Prueba' },
        { nombre: 'Folio', clave: 'folio', encontrado: false, valores: [] },
      ],
    }
    vi.mocked(geminiApi.extract).mockResolvedValue(resultado)
    montar()
    const boton = await screen.findByRole('button', { name: 'Re-extraer con Gemini' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)

    const aviso = await screen.findByText('Extracción combinada con tus correcciones.')
    const contenedor = aviso.closest('[role="status"]') as HTMLElement
    expect(within(contenedor).getByText('La IA encontró «Nombre» una sola vez en el documento (Persona Prueba); no se repitió en cada movimiento y lo capturado no cambió.')).toBeTruthy()
    expect(within(contenedor).getByText('No se encontró «Folio» en el documento.')).toBeTruthy()
    expect(vi.mocked(geminiApi.extract).mock.calls[0][2]).toMatchObject({ forzar: true, campos: ['Nombre', 'Folio'] })
    // «Nombre» ya tenía «Juan» en un movimiento: el dato único del documento no se repite en cada fila.
    expect([1, 2, 3].map((n) => celda('Nombre', n).value)).toEqual(['Juan', '', ''])
    expect(within(encabezado('Folio')).getByText('No se encontró «Folio» en el documento.')).toBeTruthy()
  })
})

describe('datos del documento y movimientos numerados', () => {
  it('"Llenar con IA" en un dato del documento llena su único valor, sin repetirlo en los movimientos', async () => {
    guardado = { ...base(), campos_extra: [...base().campos_extra!, { id: 'c-rfc', nombre: 'RFC', origen: 'manual', alcance: 'documento', valor: '' }] }
    vi.mocked(geminiApi.llenarCampo).mockResolvedValue({ nombre: 'RFC', encontrado: true, valores: [], valor_documento: 'XAXX010101000' })
    montar()
    const boton = await screen.findByRole('button', { name: 'Llenar con IA el campo RFC' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)
    expect(await within(encabezado('RFC')).findByText('«RFC» aparece una sola vez en el documento: se guardó una vez, no en cada movimiento.')).toBeTruthy()
    expect((screen.getByLabelText('RFC del documento') as HTMLInputElement).value).toBe('XAXX010101000')
    expect(screen.queryByLabelText('RFC del movimiento 1')).toBeNull()
  })

  it('el usuario corrige el tipo de un campo en las dos direcciones, sin perder datos', async () => {
    montar()
    await screen.findByLabelText('Folio del movimiento 1')
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar Folio a dato del documento' }))
    expect(screen.getByLabelText('Folio del documento')).toBeTruthy()
    expect(screen.queryByLabelText('Folio del movimiento 1')).toBeNull()
    fireEvent.change(screen.getByLabelText('Folio del documento'), { target: { value: 'F-9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar Folio a un valor en cada movimiento' }))
    expect([1, 2, 3].map((n) => celda('Folio', n).value)).toEqual(['F-9', 'F-9', 'F-9'])

    // «Nombre» con valores distintos no puede ser un dato único del documento.
    fireEvent.change(celda('Nombre', 2), { target: { value: 'Ana' } })
    expect((screen.getByRole('button', { name: 'Cambiar Nombre a dato del documento' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cada movimiento es una columna numerada y escribir otro número lo mueve', async () => {
    montar()
    await screen.findByLabelText('Concepto del movimiento 1')
    expect(screen.getAllByRole('columnheader', { name: /^Movimiento \d+$/ })).toHaveLength(3)
    const numero = screen.getByLabelText('Número del movimiento 3')
    fireEvent.change(numero, { target: { value: '1' } })
    fireEvent.blur(numero)
    expect([1, 2, 3].map((n) => (screen.getByLabelText(`Concepto del movimiento ${n}`) as HTMLTextAreaElement).value)).toEqual(['PAGO C', 'PAGO A', 'PAGO B'])
    expect(screen.getByText('Cambios sin guardar')).toBeTruthy()
  })
})
