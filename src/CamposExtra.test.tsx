// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { extraccionesApi, type ExtraccionGuardada, type SolicitudGuardado } from './services/extraccionesApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

let guardado: ExtraccionGuardada | null = null

const plantillaPrueba = vi.hoisted(() => ({ campos: [] as { id: string; nombre: string; origen: 'ia' | 'manual'; alcance: 'documento' | 'movimiento'; clave?: string }[] }))
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => ({ configurada: true, campos: plantillaPrueba.campos, actualizado: null })), guardar: vi.fn(async (campos: unknown[]) => ({ configurada: true, campos, actualizado: null })), sugerir: vi.fn(async () => []) },
  plantillaVigente: { actual: () => plantillaPrueba.campos, cargar: async () => plantillaPrueba.campos, fijar: vi.fn() },
}))
vi.mock('./services/geminiApi', () => ({
  geminiApi: { status: vi.fn(async () => ({ configured: false, enabled: false, model: 'gemini-prueba', maskedKey: null })), extract: vi.fn() },
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

const fila = (id: string, huella: string, concepto: string): Transaccion => ({ id, fecha: '02/10/2026', concepto, referencia: '', cargo: '100.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella })
const base = (cambios: Partial<ExtraccionGuardada> = {}): ExtraccionGuardada => ({
  schema: 1, messageId: 'm-a', partId: 'a', attachmentId: 'att-a', filename: 'estado.png', estado: 'borrador', version: 1, creado: '2026-11-01T10:00:00Z', actualizado: '2026-11-01T10:00:00Z',
  revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'gemini-prueba', prompt_version: 'v', formato_numerico: 'us',
  resumen: { banco: 'BANCO', titular: '', cuenta: '', periodo: '', moneda: 'MXN', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
  transacciones: [fila('ia-1', 'h1', 'PAGO A'), fila('ia-2', 'h2', 'PAGO B')],
  validacion: {} as ExtraccionGuardada['validacion'],
  problemas: {} as ExtraccionGuardada['problemas'],
  ...cambios,
})

function montar() {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  const archivo: ArchivoExtraccion = { clave: 'm-a:a', messageId: 'm-a', attachmentId: 'att-a', partId: 'a', filename: 'estado.png' }
  const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="manual" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
  return render(<RouterProvider router={router} />)
}
const abrirMenu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Campo' }))
  return screen.getByRole('dialog', { name: 'Agregar campo' })
}

beforeEach(() => {
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:prueba')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('botón "+ Campo"', () => {
  it('agrega columnas desde las sugerencias de la IA y a mano, y las guarda', async () => {
    guardado = base({
      sugerencias_campos: [
        { clave: 'vsm', nombre: 'VSM', valores: [{ huella: 'h1', valor: '12.5' }, { huella: 'h2', valor: '13' }] },
        { clave: 'numero-de-credito', nombre: 'Número de crédito', valores: [], valor_documento: 'CR-778' },
      ],
    })
    vi.mocked(extraccionesApi.guardar).mockImplementation(async (_m: string, _p: string, solicitud: SolicitudGuardado) => base({ version: 2, transacciones: solicitud.transacciones, campos_extra: solicitud.campos_extra, sugerencias_campos: solicitud.sugerencias_campos }))
    montar()

    let menu = await abrirMenu()
    expect(within(menu).getByText('2 filas con dato')).toBeTruthy()
    expect(within(menu).getByText('Valor único del documento')).toBeTruthy()
    expect(within(menu).getByText('Va una sola vez para todos los movimientos.')).toBeTruthy()
    fireEvent.click(within(menu).getByText('VSM'))
    expect((screen.getByLabelText('VSM del movimiento 1') as HTMLInputElement).value).toBe('12.5')
    expect((screen.getByLabelText('VSM del movimiento 2') as HTMLInputElement).value).toBe('13')

    menu = await abrirMenu()
    expect(within(menu).queryByText('VSM')).toBeNull()
    fireEvent.click(within(menu).getByText('Número de crédito'))
    // Un dato único del documento aparece una sola vez, no en cada movimiento.
    expect((screen.getByLabelText('Número de crédito del documento') as HTMLInputElement).value).toBe('CR-778')
    expect(screen.queryByLabelText('Número de crédito del movimiento 1')).toBeNull()

    menu = await abrirMenu()
    expect(within(menu).getByText('Ya agregaste todos los campos que sugirió la IA.')).toBeTruthy()
    fireEvent.change(within(menu).getByLabelText('Manual'), { target: { value: 'vsm' } })
    fireEvent.click(within(menu).getByRole('button', { name: 'Agregar' }))
    expect(within(menu).getByRole('alert').textContent).toBe('Ya existe un campo con ese nombre.')
    fireEvent.change(within(menu).getByLabelText('Manual'), { target: { value: 'Sucursal' } })
    fireEvent.click(within(menu).getByLabelText(/En cada movimiento/))
    fireEvent.click(within(menu).getByRole('button', { name: 'Agregar' }))
    fireEvent.change(screen.getByLabelText('Sucursal del movimiento 1'), { target: { value: 'Centro' } })
    expect(screen.getAllByText('IA editada')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Renombrar el campo Sucursal' }))
    fireEvent.change(screen.getByLabelText('Nuevo nombre del campo Sucursal'), { target: { value: 'Plaza' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar el nuevo nombre' }))
    expect((screen.getByLabelText('Plaza del movimiento 1') as HTMLInputElement).value).toBe('Centro')

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar el campo Número de crédito' }))
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Eliminar el campo Número de crédito' })).getByRole('button', { name: 'Eliminar' }))
    expect(screen.queryByLabelText('Número de crédito del documento')).toBeNull()
    expect(within(await abrirMenu()).getByText('Número de crédito')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(extraccionesApi.guardar).toHaveBeenCalledTimes(1))
    const solicitud = vi.mocked(extraccionesApi.guardar).mock.calls[0][2]
    expect(solicitud.campos_extra?.map((campo) => [campo.nombre, campo.origen])).toEqual([['VSM', 'ia'], ['Plaza', 'manual']])
    const [vsm, plaza] = solicitud.campos_extra!.map((campo) => campo.id)
    expect(solicitud.transacciones.map((t) => t.extras)).toEqual([{ [vsm]: '12.5', [plaza]: 'Centro' }, { [vsm]: '13' }])
    expect(solicitud.campos_extra!.every((campo) => campo.alcance !== 'documento')).toBe(true)
    expect(solicitud.sugerencias_campos).toHaveLength(2)
    expect(await screen.findByText(/versión 2/)).toBeTruthy()
  })

  it('un dato agregado a mano como «una vez en el documento» aparece una sola vez y se guarda así', async () => {
    guardado = base()
    vi.mocked(extraccionesApi.guardar).mockImplementation(async (_m: string, _p: string, solicitud: SolicitudGuardado) => base({ version: 2, transacciones: solicitud.transacciones, campos_extra: solicitud.campos_extra }))
    montar()
    const menu = await abrirMenu()
    fireEvent.change(within(menu).getByLabelText('Manual'), { target: { value: 'RFC' } })
    expect((within(menu).getByLabelText(/Una vez para todos/) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(menu).getByRole('button', { name: 'Agregar' }))

    fireEvent.change(screen.getByLabelText('RFC del documento'), { target: { value: 'XAXX010101000' } })
    expect(screen.queryByLabelText('RFC del movimiento 1')).toBeNull()
    expect(screen.queryByLabelText('RFC del movimiento 2')).toBeNull()
    expect(screen.getByText('Cambios sin guardar')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(extraccionesApi.guardar).toHaveBeenCalledTimes(1))
    const solicitud = vi.mocked(extraccionesApi.guardar).mock.calls[0][2]
    expect(solicitud.campos_extra).toEqual([expect.objectContaining({ nombre: 'RFC', origen: 'manual', alcance: 'documento', valor: 'XAXX010101000' })])
    expect(solicitud.transacciones.every((t) => !t.extras)).toBe(true)
  })

  it('abre documentos guardados sin columnas y explica que hay que extraer para ver sugerencias', async () => {
    guardado = base({ resumen: null as never, transacciones: [{ ...fila('manual-1', '', 'A MANO'), origen: 'manual', huella: undefined }] })
    montar()
    const menu = await abrirMenu()
    expect(within(menu).getByText('Extrae con Gemini para ver los campos que la IA encuentre en el documento.')).toBeTruthy()
    expect(screen.queryByText('Cambios sin guardar')).toBeNull()
  })
})
