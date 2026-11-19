// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { DocumentoRecibido, ResultadoConfigurar, TipoDocumento } from './services/tiposDocumentoApi'

const { listarMock, documentosMock, sugerirMock, configurarMock, editarMock, editarEstructuraMock, guardarMock } = vi.hoisted(() => ({
  listarMock: vi.fn(), documentosMock: vi.fn(), sugerirMock: vi.fn(), configurarMock: vi.fn(), editarMock: vi.fn(), editarEstructuraMock: vi.fn(), guardarMock: vi.fn(),
}))
vi.mock('./services/tiposDocumentoApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/tiposDocumentoApi')>()
  return { ...real, tiposDocumentoApi: { ...real.tiposDocumentoApi, listar: listarMock, documentos: documentosMock, sugerir: sugerirMock, configurarDocumento: configurarMock, editar: editarMock, editarEstructura: editarEstructuraMock } }
})
vi.mock('./services/plantillaCamposApi', () => ({
  plantillaCamposApi: { obtener: vi.fn(async () => ({ configurada: true, campos: [], actualizado: null })), guardar: vi.fn(), sugerir: vi.fn(async () => []) },
  plantillaVigente: { actual: () => [], cargar: async () => [], fijar: vi.fn() },
}))
vi.mock('./services/geminiApi', () => ({ geminiApi: { status: vi.fn(async () => ({ configured: true, enabled: true, model: 'gemini-prueba', maskedKey: null })), extract: vi.fn() } }))
vi.mock('./services/automaticoApi', () => ({ automaticoApi: { estado: vi.fn(async () => null) } }))
let guardado: ExtraccionGuardada | null = null
vi.mock('./services/extraccionesApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/extraccionesApi')>()
  return { ...real, extraccionesApi: { ...real.extraccionesApi, obtener: vi.fn(async () => guardado), guardar: guardarMock, listar: vi.fn() } }
})
vi.mock('./services/inboxStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/inboxStore')>()
  return { ...real, inboxStore: { ...real.inboxStore, loadStatus: vi.fn(async () => ({ connected: true, email: 'a@example.com', cuentaId: 'cuenta-1' })), cachedStatus: () => null, invalidarEstados: vi.fn() } }
})

const { TiposDocumentoSeccion } = await import('./TiposDocumento')
const { ExtractionTabsWorkspace } = await import('./App')
const { tiposVigentes } = await import('./services/tiposDocumentoApi')

const EC: TipoDocumento = { id: 'tipo-ec', nombre: 'Estado de cuenta', codigo: 'EC', color: '#2563eb', seccion: { nombre: 'Movimientos' }, campos: [], contable: true, configurado: true, documentos: 3,
  estructuras: [{ id: 'est-ec', nombre: 'Predeterminada', version: 1, reglas: { remitentes: [], aseguradoras: [] }, documentos: 3 }] }
const FLOTILLA: TipoDocumento = { id: 'tipo-ac', nombre: 'Autos flotilla', codigo: 'AC', color: '#059669', seccion: { nombre: 'Incisos' }, contable: false, configurado: true, documentos: 1,
  campos: [{ id: 'c-poliza', nombre: 'Número de póliza', origen: 'ia', alcance: 'documento' }, { id: 'c-placas', nombre: 'Placas', origen: 'ia', alcance: 'movimiento' }],
  estructuras: [{ id: 'est-gnp', nombre: 'GNP', version: 2, reglas: { remitentes: ['@gnp.com.mx'], aseguradoras: ['GNP Seguros'] }, documentos: 1 }] }

const detectado = (cambios: Partial<DocumentoRecibido['tipo_documento']> = {}): DocumentoRecibido['tipo_documento'] => ({
  tipo_id: null, codigo: null, nombre: null, color: null, contable: false, metodo: 'ia', confianza: 0.42, aseguradora: 'AXA Seguros', remitente: 'polizas@axa.com.mx', requiere_revision: true,
  motivo: 'No se reconoció el tipo de documento: configúralo con este documento.', ...cambios,
})
const recibido = (cambios: Partial<DocumentoRecibido> = {}): DocumentoRecibido => ({
  messageId: 'm1', partId: '1', filename: 'poliza-axa.pdf', estado: 'borrador', version: 1, actualizado: '2026-11-18T10:00:00Z', creado: '2026-11-18T10:00:00Z', cuadra: null, problemas: 0,
  attachmentId: 'att-1', envio_automatico: 'requiere_revision', tipo_documento: detectado(), ...cambios,
})

beforeEach(() => {
  listarMock.mockImplementation(async () => ({ tipos: [EC, FLOTILLA], umbral_confianza: 0.7 }))
  documentosMock.mockImplementation(async () => ({ documentos: [
    recibido(),
    recibido({ messageId: 'm2', filename: 'flotilla-gnp.pdf', estado: 'enviado', envio_automatico: 'enviado', tipo_documento: detectado({ tipo_id: 'tipo-ac', codigo: 'AC', nombre: 'Autos flotilla', color: '#059669', metodo: 'remitente', regla: '@gnp.com.mx', confianza: null, requiere_revision: false, motivo: null }) }),
  ], umbral_confianza: 0.7 }))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Configuración → Tipos de documento: documentos que llegaron', () => {
  it('muestra el tipo detectado, cómo se detectó y resalta los que requieren configuración', async () => {
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    const lista = await screen.findByRole('list', { name: 'Documentos que llegaron' })
    const [sinConfigurar, configurado] = within(lista).getAllByRole('listitem')
    expect(sinConfigurar.getAttribute('data-requiere')).toBe('true')
    expect(sinConfigurar.textContent).toContain('Sin configurar')
    expect(sinConfigurar.textContent).toContain('IA · confianza 42%')
    expect(sinConfigurar.textContent).toContain('Sin configurar / Requiere revisión')
    expect(within(sinConfigurar).getByRole('button', { name: 'Configurar con este documento' })).toBeTruthy()
    expect(configurado.textContent).toContain('Autos flotilla · AC')
    expect(configurado.textContent).toContain('Regla de remitente (@gnp.com.mx)')
    expect(configurado.textContent).toContain('enviado automáticamente')
    expect(within(configurado).queryByRole('button', { name: 'Configurar con este documento' })).toBeNull()
    // Contador de pendientes en la pestaña.
    expect(screen.getByRole('tab', { name: /Documentos que llegaron/ }).textContent).toContain('1')
  })

  it('"Configurar con este documento": crea el tipo, la regla y los campos, y lo extrae y envía', async () => {
    sugerirMock.mockImplementation(async () => ({ aseguradora: 'AXA Seguros', sugerencias: [
      { clave: 'numero-de-poliza', nombre: 'Número de póliza', ejemplo: 'POL-001', alcance: 'documento', filas: 0 },
      { clave: 'asegurado', nombre: 'Asegurado', ejemplo: 'Ana López', alcance: 'movimiento', filas: 3 },
      { clave: 'vigencia', nombre: 'Vigencia', ejemplo: '2026-2027', alcance: 'documento', filas: 0 },
    ] }))
    const resultado: ResultadoConfigurar = { tipos: [EC, FLOTILLA], umbral_confianza: 0.7, tipo: { ...FLOTILLA, id: 'tipo-g', nombre: 'Gastos médicos', codigo: 'G' }, estructura: null, envio: 'enviado', motivos: [], mensaje: null }
    configurarMock.mockImplementation(async () => resultado)
    const onNotice = vi.fn()
    render(<TiposDocumentoSeccion onNotice={onNotice} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar con este documento' }))
    const panel = screen.getByRole('dialog', { name: 'poliza-axa.pdf' })
    // Paso 1: tipo nuevo con su código y sección.
    expect((within(panel).getByRole('radio', { name: 'Crear un tipo nuevo' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(within(panel).getByLabelText('Nombre del tipo nuevo'), { target: { value: 'Gastos médicos' } })
    fireEvent.change(within(panel).getByLabelText('Código del tipo nuevo'), { target: { value: 'g' } })
    fireEvent.change(within(panel).getByLabelText('Sección repetible del tipo nuevo'), { target: { value: 'Asegurados' } })
    // Paso 2: reglas para reconocerlo.
    expect(within(panel).getByText('polizas@axa.com.mx')).toBeTruthy()
    expect((within(panel).getByRole('checkbox', { name: /Todo lo que llegue de/ }) as HTMLInputElement).checked).toBe(true)
    expect((within(panel).getByRole('checkbox', { name: 'Todo lo de la aseguradora' }) as HTMLInputElement).checked).toBe(true)
    // Paso 3: la IA lee el mismo documento y propone campos con un ejemplo.
    fireEvent.click(within(panel).getByRole('button', { name: 'Proponer campos con IA' }))
    const propuestos = await within(panel).findByRole('list', { name: 'Campos propuestos por la IA' })
    expect(sugerirMock).toHaveBeenCalledWith('m1', 'att-1', 'Gastos médicos', 'Asegurados')
    expect(propuestos.textContent).toContain('Ej.: Ana López')
    expect((within(propuestos).getByLabelText('Dónde va Asegurado') as HTMLSelectElement).value).toBe('movimiento')
    fireEvent.click(within(propuestos).getByRole('checkbox', { name: 'Usar Vigencia' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Agregar seleccionados' }))
    // Agregar a mano, renombrar y quitar.
    fireEvent.change(within(panel).getByLabelText('Nombre del campo nuevo'), { target: { value: 'Prima total' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Agregar a mano' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Renombrar Número de póliza' }))
    fireEvent.change(within(panel).getByLabelText('Nuevo nombre de Número de póliza'), { target: { value: 'Póliza' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Listo' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Quitar Prima total' }))
    const lista = within(panel).getByRole('list', { name: 'Campos del tipo' })
    expect(within(lista).getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent)).toEqual(['Póliza', 'Asegurado'])
    expect((within(panel).getByRole('checkbox', { name: 'Al guardar, extraer y enviar este documento con la nueva configuración' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: 'Guardar configuración' }))
    await waitFor(() => expect(configurarMock).toHaveBeenCalledTimes(1))
    const solicitud = configurarMock.mock.calls[0][0]
    expect(solicitud).toMatchObject({
      messageId: 'm1', partId: '1', attachmentId: 'att-1',
      nuevo: { nombre: 'Gastos médicos', codigo: 'G', seccion: 'Asegurados' },
      reglas: { remitente: 'polizas@axa.com.mx', aseguradora: 'AXA Seguros' },
      extraer_y_enviar: true,
    })
    expect(solicitud.campos.map((campo: { nombre: string; alcance: string }) => [campo.nombre, campo.alcance])).toEqual([['Póliza', 'documento'], ['Asegurado', 'movimiento']])
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('se envió a SaveData')))
  })
})

describe('Configuración → Tipos de documento: tipos y reglas', () => {
  it('al elegir un tipo muestra "Estás configurando…", sus estructuras y su editor de campos', async () => {
    editarMock.mockImplementation(async (_id: string, solicitud: { campos: TipoDocumento['campos'] }) => ({ tipos: [EC, { ...FLOTILLA, campos: solicitud.campos }], umbral_confianza: 0.7, tipo: { ...FLOTILLA, campos: solicitud.campos } }))
    editarEstructuraMock.mockImplementation(async () => ({ tipos: [EC, FLOTILLA], umbral_confianza: 0.7 }))
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} editorEstadoDeCuenta={<div>Editor de estado de cuenta</div>} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    // Estado de cuenta primero, con el editor de campos de siempre.
    expect((await screen.findByTestId('tipo-configurando')).textContent).toContain('Estás configurando el tipo Estado de cuenta · código EC')
    expect(screen.getByText('Editor de estado de cuenta')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Autos flotilla/ }))
    const banner = screen.getByTestId('tipo-configurando')
    expect(banner.textContent).toContain('Estás configurando el tipo Autos flotilla · código AC')
    expect(banner.getAttribute('style')).toContain('rgb(5, 150, 105)')
    const estructuras = screen.getByRole('list', { name: 'Estructuras de Autos flotilla' })
    expect(estructuras.textContent).toContain('GNP')
    expect(estructuras.textContent).toContain('v2')
    expect(estructuras.textContent).toContain('@gnp.com.mx')
    expect(estructuras.textContent).toContain('GNP Seguros')
    expect(estructuras.textContent).toContain('1 documento')
    fireEvent.change(screen.getByLabelText('Remitente nuevo para GNP'), { target: { value: 'flotillas@gnp.com.mx' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remitente' }))
    await waitFor(() => expect(editarEstructuraMock).toHaveBeenCalledWith('tipo-ac', 'est-gnp', { nombre: 'GNP', reglas: { remitentes: ['@gnp.com.mx', 'flotillas@gnp.com.mx'], aseguradoras: ['GNP Seguros'] } }))
    // Editor de campos del tipo, con la sección por nombre.
    expect((screen.getByLabelText('Dónde va Placas') as HTMLSelectElement).selectedOptions[0].textContent).toBe('En incisos')
    fireEvent.change(screen.getByLabelText('Nombre del campo nuevo'), { target: { value: 'Serie' } })
    fireEvent.change(screen.getByLabelText('Dónde va el campo nuevo'), { target: { value: 'movimiento' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a mano' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar campos' }))
    await waitFor(() => expect(editarMock).toHaveBeenCalledTimes(1))
    expect(editarMock.mock.calls[0][1].campos.map((campo: { nombre: string }) => campo.nombre)).toEqual(['Número de póliza', 'Placas', 'Serie'])
  })
})

describe('Extracción con tipo de documento', () => {
  const polizaGuardada = (): ExtraccionGuardada => ({
    schema: 1, messageId: 'm-p', partId: '1', attachmentId: 'att-p', filename: 'flotilla.pdf', estado: 'borrador', version: 1, creado: '2026-11-18T10:00:00Z', actualizado: '2026-11-18T10:00:00Z',
    revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'm', prompt_version: 'v', formato_numerico: null,
    resumen: { banco: '', titular: '', cuenta: '', periodo: '', moneda: '', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
    transacciones: [
      { id: 'ia-1', fecha: '', concepto: '', referencia: '', cargo: '', abono: '', saldo: '', origen: 'ia', dudosos: [], extras: { 'c-placas': 'ABC-123' } },
      { id: 'ia-2', fecha: '', concepto: '', referencia: '', cargo: '', abono: '', saldo: '', origen: 'ia', dudosos: [], extras: { 'c-placas': 'XYZ-987' } },
    ],
    campos_extra: [{ id: 'c-poliza', nombre: 'Número de póliza', origen: 'ia', alcance: 'documento', valor: 'POL-77', plantilla_id: 'c-poliza' }, { id: 'c-placas', nombre: 'Placas', origen: 'ia', plantilla_id: 'c-placas' }],
    sugerencias_campos: [],
    validacion: { cuadra: null } as ExtraccionGuardada['validacion'], problemas: { total: 0 } as ExtraccionGuardada['problemas'],
    tipo_documento: { tipo_id: 'tipo-ac', codigo: 'AC', nombre: 'Autos flotilla', color: '#059669', contable: false, metodo: 'remitente', regla: '@gnp.com.mx', confianza: null, requiere_revision: false, motivo: null },
  })
  const pintar = () => {
    const archivo: ArchivoExtraccion = { clave: 'm-p:1', messageId: 'm-p', attachmentId: 'att-p', partId: '1', filename: 'flotilla.pdf' }
    const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="gemini" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
    render(<RouterProvider router={router} />)
  }
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:prueba')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    tiposVigentes.fijar([EC, FLOTILLA])
    guardado = polizaGuardada()
  })

  it('muestra el tipo con su color, la sección "Incisos" sin columnas fijas y sin validación contable', async () => {
    pintar()
    const tabla = await screen.findByRole('table', { name: 'Incisos del documento' })
    const etiqueta = screen.getByTestId('tipo-documento')
    expect(etiqueta.textContent).toBe('Autos flotilla · AC')
    expect(etiqueta.getAttribute('style')).toContain('rgb(5, 150, 105)')
    expect(etiqueta.getAttribute('title')).toBe('Regla de remitente (@gnp.com.mx)')
    expect(screen.getByText('Incisos')).toBeTruthy()
    expect(within(tabla).queryByRole('rowheader', { name: 'Fecha' })).toBeNull()
    expect((within(tabla).getByLabelText('Placas del movimiento 2') as HTMLInputElement).value).toBe('XYZ-987')
    expect(screen.queryByRole('region', { name: /Validación/ })).toBeNull()
    expect(document.getElementById('titulo-validacion')).toBeNull()
    expect(document.getElementById('titulo-resumen')).toBeNull()
  })

  it('permite cambiar el tipo; al guardar se envía el tipo elegido a mano', async () => {
    guardarMock.mockImplementation(async (_m: string, _p: string, solicitud: Record<string, unknown>) => ({ ...polizaGuardada(), ...solicitud, version: 2 }))
    pintar()
    await screen.findByRole('table', { name: 'Incisos del documento' })
    fireEvent.change(screen.getByLabelText('Cambiar tipo de documento'), { target: { value: 'tipo-ec' } })
    expect(screen.getByTestId('tipo-documento').textContent).toBe('Estado de cuenta · EC')
    // Estado de cuenta vuelve a tener columnas fijas y validación contable.
    expect(await screen.findByRole('table', { name: 'Movimientos del estado de cuenta' })).toBeTruthy()
    expect(document.getElementById('titulo-validacion')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(guardarMock).toHaveBeenCalledTimes(1))
    expect(guardarMock.mock.calls[0][2].tipo_documento).toMatchObject({ tipo_id: 'tipo-ec', codigo: 'EC', metodo: 'manual' })
  })

  it('un estado de cuenta sin tipo se ve como siempre', async () => {
    guardado = { ...polizaGuardada(), tipo_documento: undefined, filename: 'estado.pdf', campos_extra: [] }
    pintar()
    expect(await screen.findByRole('table', { name: 'Movimientos del estado de cuenta' })).toBeTruthy()
    expect(screen.getByTestId('tipo-documento').textContent).toBe('Estado de cuenta · EC')
    expect(document.getElementById('titulo-validacion')).not.toBeNull()
  })
})
