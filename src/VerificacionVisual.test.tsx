// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { construirPdf } from './pruebas/pdfSintetico'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { Transaccion } from './types'

let guardado: ExtraccionGuardada | null = null

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
// pdf.js real (versión de Node) para leer el texto; jsdom no tiene canvas, así que el dibujo de la página se omite.
vi.mock('./services/cargadorPdf', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return {
    abrirPdf: async (datos: Uint8Array) => {
      const tarea = getDocument({ data: datos, verbosity: 0 })
      const documento = await tarea.promise
      return { numPages: documento.numPages, getPage: (numero: number) => documento.getPage(numero), destroy: () => tarea.destroy() }
    },
    dibujarPagina: () => ({ promesa: Promise.resolve(), cancelar: () => undefined }),
  }
})

const { ExtractionTabsWorkspace } = await import('./App')

const FICTICIO = readFileSync('backend/tests/fixtures/estado_cuenta_ficticio.pdf')
// Los movimientos del PDF ficticio (backend/tests/fixtures/generar_pdf_prueba.py): fecha, concepto, referencia, cargo, abono.
const MOVIMIENTOS: [string, string, string, string, string][] = [
  ['02/10/2026', 'TRANSFERENCIA RECIBIDA', 'REF-0001', '', '12000.00'],
  ['03/10/2026', 'PAGO A PROVEEDOR', 'REF-0002', '4250.00', ''],
  ['05/10/2026', 'COMISION POR MANEJO DE CUENTA', 'REF-0003', '150.00', ''],
  ['07/10/2026', 'DEPOSITO REFERENCIADO', 'REF-0004', '', '6750.00'],
  ['09/10/2026', 'PAGO DE SERVICIOS', 'REF-0005', '1875.50', ''],
  ['11/10/2026', 'TRANSFERENCIA SALIENTE', 'REF-0006', '3300.00', ''],
  ['13/10/2026', 'DEPOSITO EN EFECTIVO', 'REF-0007', '', '2500.00'],
  ['15/10/2026', 'PAGO CON TARJETA', 'REF-0008', '980.25', ''],
  ['17/10/2026', 'TRANSFERENCIA RECIBIDA', 'REF-0009', '', '8400.00'],
  ['19/10/2026', 'PAGO DE NOMINA', 'REF-0010', '7200.00', ''],
  ['21/10/2026', 'INTERESES GANADOS', 'REF-0011', '', '35.40'],
  ['23/10/2026', 'RETIRO EN CAJERO', 'REF-0012', '2000.00', ''],
  ['25/10/2026', 'DEPOSITO REFERENCIADO', 'REF-0013', '', '1250.00'],
  ['28/10/2026', 'PAGO A PROVEEDOR', 'REF-0014', '5600.00', ''],
  ['30/10/2026', 'IVA COMISION', 'REF-0015', '24.00', ''],
]
function capturados(): Transaccion[] {
  let saldo = 25000
  return MOVIMIENTOS.map(([fecha, concepto, referencia, cargo, abono], indice) => {
    saldo = Math.round((saldo - Number(cargo || 0) + Number(abono || 0)) * 100) / 100
    return { id: `ia-${indice + 1}`, fecha, concepto, referencia, cargo, abono, saldo: saldo.toFixed(2), origen: 'ia', dudosos: [], huella: `h-${indice + 1}` }
  })
}
const extraccionGuardada = (transacciones: Transaccion[]): ExtraccionGuardada => ({
  schema: 1, messageId: 'm-a', partId: 'a', attachmentId: 'att-a', filename: 'estado-a.pdf', estado: 'borrador', version: 1, creado: '2026-11-01T10:00:00Z', actualizado: '2026-11-01T10:00:00Z',
  revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'gemini-prueba', prompt_version: 'v', formato_numerico: 'us',
  resumen: { banco: 'BANCO FICTICIO DE PRUEBA S.A.', titular: 'CLIENTE DE PRUEBA NEXORA', cuenta: '0000-0000-0000-1234', periodo: '01/10/2026 AL 31/10/2026', moneda: 'MXN', saldo_inicial: '25000.00', total_cargos: '25379.75', total_abonos: '30935.40', saldo_final: '30555.65', dudosos: [] },
  transacciones,
  validacion: {} as ExtraccionGuardada['validacion'],
  problemas: {} as ExtraccionGuardada['problemas'],
})

const archivo = (filename: string): ArchivoExtraccion => ({ clave: 'm-a:a', messageId: 'm-a', attachmentId: 'att-a', partId: 'a', filename })
function montar(filename: string, contenido: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).includes('/attachments/') ? Promise.resolve(new Response(new Uint8Array(contenido))) : new Promise(() => undefined))))
  const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo(filename)]} lote={false} mode="manual" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
  return render(<RouterProvider router={router} />)
}
const cobertura = async (grupo: 'resumen' | 'movimientos') => (await screen.findByTestId(`cobertura-${grupo}`, {}, { timeout: 5000 })).textContent
const recuadro = (inicio: string) => screen.getByRole('button', { name: new RegExp(`^${inicio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })

beforeEach(() => {
  guardado = null
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:prueba')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Encabezado «Movimiento N» de la columna a la que pertenece una casilla (ahí están sus etiquetas). */
const columnaDe = (casilla: HTMLElement) => {
  const numero = /del movimiento (\d+)$/.exec(casilla.getAttribute('aria-label') ?? '')?.[1]
  return screen.getByRole('columnheader', { name: `Movimiento ${numero}` })
}

describe('verificación visual', () => {
  it('un dato del documento (como el RFC) se copia haciendo clic en cualquier texto del documento', async () => {
    guardado = { ...extraccionGuardada(capturados()), campos_extra: [{ id: 'c-cli', nombre: 'Cliente', origen: 'manual', alcance: 'documento', valor: '' }] }
    montar('estado-a.pdf', FICTICIO)
    await cobertura('movimientos')

    fireEvent.focus(screen.getByLabelText('Cliente del documento'))
    expect(await screen.findByText('Cliente del documento')).toBeTruthy()
    // Todo el texto del documento se puede pulsar, no solo los datos reconocidos.
    fireEvent.click(screen.getAllByRole('button', { name: /^Texto del documento «.*CLIENTE DE PRUEBA NEXORA.*»/ })[0])
    expect((screen.getByLabelText('Cliente del documento') as HTMLInputElement).value).toMatch(/CLIENTE DE PRUEBA NEXORA$/)
    expect(screen.getByText(/^Copiado a Cliente del documento:/)).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^Texto del documento/ })).toHaveLength(0)
    expect(screen.getAllByText('Cambios sin guardar').length).toBeGreaterThan(0)
  })

  it('marca lo capturado contra el PDF y copia un importe normalizado al hacer clic en el documento', async () => {
    const transacciones = capturados()
    transacciones[1] = { ...transacciones[1], cargo: '' }
    guardado = extraccionGuardada(transacciones)
    montar('estado-a.pdf', FICTICIO)

    expect(await cobertura('resumen')).toContain('8 datos en el documento · 8 coinciden · 0 con diferencia · 0 faltantes')
    expect(await cobertura('movimientos')).toContain('75 datos en el documento · 74 coinciden · 0 con diferencia · 1 faltante · 1 fila de saldo (no se captura)')
    expect(screen.getByText('La verificación se basa en el texto del PDF y puede no reconocer el formato de algunos bancos.')).toBeTruthy()
    expect(screen.getByText('Verde = coincide con el documento')).toBeTruthy()
    expect(recuadro('Concepto: documento «SALDO INICIAL»').getAttribute('aria-label')).toContain('Fila de saldo, no se captura')

    fireEvent.focus(screen.getByLabelText('Cargo del movimiento 2'))
    expect(screen.getByText(/Haz clic en el documento para copiar a:/).textContent).toContain('Cargo del movimiento 2')
    fireEvent.click(recuadro('Cargo: documento «4,250.00», capturado «vacío». Falta capturar'))

    expect((screen.getByLabelText('Cargo del movimiento 2') as HTMLInputElement).value).toBe('4250.00')
    const fila = columnaDe(screen.getByLabelText('Cargo del movimiento 2'))
    expect(within(fila).getByText('IA editada')).toBeTruthy()
    expect(await cobertura('movimientos')).toContain('75 coinciden · 0 con diferencia · 0 faltantes')
    // Es un cambio sin guardar como cualquier edición.
    expect(screen.getAllByText('Cambios sin guardar').length).toBeGreaterThan(0)
  })

  it('no copia un dato incompatible (texto a un importe)', async () => {
    guardado = extraccionGuardada(capturados())
    montar('estado-a.pdf', FICTICIO)
    await cobertura('movimientos')
    fireEvent.focus(screen.getByLabelText('Saldo del movimiento 1'))
    // El concepto del primer movimiento (aparece dos veces en el documento).
    fireEvent.click(screen.getAllByRole('button', { name: /^Concepto: documento «TRANSFERENCIA RECIBIDA»/ })[0])
    expect(screen.getByRole('alert').textContent).toMatch(/No se copió/)
    expect((screen.getByLabelText('Saldo del movimiento 1') as HTMLInputElement).value).toBe('37000.00')
  })

  it('copia al resumen editable y lo marca como cambio sin guardar', async () => {
    guardado = extraccionGuardada(capturados())
    guardado.resumen = { ...guardado.resumen, saldo_final: '' }
    montar('estado-a.pdf', FICTICIO)
    expect(await cobertura('resumen')).toContain('7 coinciden · 0 con diferencia · 1 faltante')
    fireEvent.focus(screen.getByLabelText('Saldo final del resumen'))
    fireEvent.click(recuadro('Saldo final: documento «30,555.65»'))
    expect((screen.getByLabelText('Saldo final del resumen') as HTMLInputElement).value).toBe('30555.65')
    expect(await cobertura('resumen')).toContain('8 coinciden')
  })

  it('agrega un movimiento faltante con sus datos y marca los capturados que no aparecen en el documento', async () => {
    const transacciones = capturados().filter((transaccion) => transaccion.concepto !== 'PAGO DE SERVICIOS')
    transacciones.push({ id: 'extra', fecha: '31/10/2026', concepto: 'MOVIMIENTO INVENTADO', referencia: '', cargo: '99.00', abono: '', saldo: '', origen: 'manual', dudosos: [] })
    guardado = extraccionGuardada(transacciones)
    montar('estado-a.pdf', FICTICIO)

    expect(await cobertura('movimientos')).toContain('5 faltantes')
    expect(screen.getByText('1 movimiento capturado no aparece en el documento')).toBeTruthy()
    const extra = columnaDe(screen.getByDisplayValue('MOVIMIENTO INVENTADO'))
    expect(within(extra).getByText('No aparece en el documento')).toBeTruthy()

    fireEvent.click(recuadro('Concepto: documento «PAGO DE SERVICIOS», capturado «vacío». Falta capturar'))
    const dialogo = screen.getByRole('dialog', { name: 'Movimiento sin capturar' })
    expect(dialogo.textContent).toContain('Cargo: 1,875.50')
    fireEvent.click(within(dialogo).getByRole('button', { name: /Agregar este movimiento/ }))

    // Queda en su lugar del documento (después del movimiento 4) con los importes normalizados y origen manual.
    expect((screen.getByLabelText('Concepto del movimiento 5') as HTMLTextAreaElement).value).toBe('PAGO DE SERVICIOS')
    expect((screen.getByLabelText('Cargo del movimiento 5') as HTMLInputElement).value).toBe('1875.50')
    expect((screen.getByLabelText('Saldo del movimiento 5') as HTMLInputElement).value).toBe('37474.50')
    expect(within(columnaDe(screen.getByLabelText('Cargo del movimiento 5'))).getByText('Manual')).toBeTruthy()
    expect(await cobertura('movimientos')).toContain('75 coinciden · 0 con diferencia · 0 faltantes')
  })

  it('el interruptor oculta y vuelve a mostrar los recuadros', async () => {
    guardado = extraccionGuardada(capturados())
    montar('estado-a.pdf', FICTICIO)
    await cobertura('movimientos')
    const interruptor = screen.getByRole('switch', { name: /Verificación visual/ })
    expect(screen.queryAllByRole('button', { name: /^Cargo: documento/ }).length).toBeGreaterThan(0)
    fireEvent.click(interruptor)
    expect(interruptor.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryAllByRole('button', { name: /^Cargo: documento/ })).toHaveLength(0)
    expect(screen.queryByTestId('cobertura-movimientos')).toBeNull()
    fireEvent.click(interruptor)
    expect(screen.queryAllByRole('button', { name: /^Cargo: documento/ }).length).toBeGreaterThan(0)
  })

  it('PDF con texto pero sin tabla ni etiquetas reconocibles: lo avisa y no marca nada en rojo', async () => {
    montar('estado-a.pdf', construirPdf([[[50, 790, 12, 'INFORME MENSUAL DE ACTIVIDADES'], [50, 745, 9, '02/10/2026 Entrega parcial 1,200.00'], [50, 730, 9, 'Observaciones generales del periodo de trabajo']]]))
    expect(await cobertura('movimientos')).toContain('No se pudo reconocer la tabla de movimientos de este documento.')
    expect(await cobertura('resumen')).toContain('No se reconoció ninguna etiqueta del resumen')
    expect(screen.queryAllByRole('button', { name: /Falta capturar/ })).toHaveLength(0)
  })

  it('PDF escaneado: muestra el aviso y el visor del navegador, sin fallar', async () => {
    montar('estado-a.pdf', construirPdf([null]))
    expect(await screen.findByText('La verificación visual aún no está disponible para imágenes o documentos escaneados.', {}, { timeout: 5000 })).toBeTruthy()
    expect(document.querySelector('iframe[title="estado-a.pdf"]')).not.toBeNull()
    expect(screen.queryByRole('switch', { name: /Verificación visual/ })).toBeNull()
  })

  it('imagen: muestra el aviso y la imagen, sin fallar', async () => {
    montar('estado-a.png', new Uint8Array([137, 80, 78, 71]))
    expect(await screen.findByText('La verificación visual aún no está disponible para imágenes o documentos escaneados.')).toBeTruthy()
    expect((await screen.findByAltText('estado-a.png')).tagName).toBe('IMG')
  })
})
