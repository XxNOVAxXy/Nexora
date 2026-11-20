// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtraccionGuardada } from './services/extraccionesApi'
import type { ArchivoExtraccion } from './services/pestanasExtraccion'
import type { DocumentoRecibido, ResultadoConfigurar, TipoDocumento } from './services/tiposDocumentoApi'

const { listarMock, documentosMock, sugerirMock, configurarMock, editarMock, editarEstructuraMock, guardarMock, restaurarMock, resolverMock } = vi.hoisted(() => ({
  listarMock: vi.fn(), documentosMock: vi.fn(), sugerirMock: vi.fn(), configurarMock: vi.fn(), editarMock: vi.fn(), editarEstructuraMock: vi.fn(), guardarMock: vi.fn(), restaurarMock: vi.fn(), resolverMock: vi.fn(),
}))
vi.mock('./services/tiposDocumentoApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/tiposDocumentoApi')>()
  return { ...real, tiposDocumentoApi: { ...real.tiposDocumentoApi, listar: listarMock, documentos: documentosMock, sugerir: sugerirMock, configurarDocumento: configurarMock, editar: editarMock, editarEstructura: editarEstructuraMock, restaurarPlantilla: restaurarMock, resolverSugerencia: resolverMock } }
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
const { PanelVerificacion } = await import('./VisorPdf')

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
    const resultado: ResultadoConfigurar = { tipos: [EC, FLOTILLA], umbral_confianza: 0.7, tipo: { ...FLOTILLA, id: 'tipo-g', nombre: 'Gastos médicos', codigo: 'G' }, estructura: null, envio: 'enviado', motivos: [], mensaje: null, code: 200 }
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
    expect(sugerirMock).toHaveBeenCalledWith('m1', 'att-1', 'Gastos médicos', 'Asegurados', [])
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
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Tipo guardado y documento enviado a SaveData (code 200).'))
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

describe('Pólizas: datos legibles, sección con su nombre y sin verificación de movimientos', () => {
  const UNA_VEZ = ['Número de póliza', 'Contratante', 'RFC', 'Vigencia desde', 'Vigencia hasta', 'Suma asegurada', 'Deducible', 'Coaseguro', 'Tope de coaseguro', 'Prima total', 'Forma de pago', 'Producto']
  const POR_FILA = ['Asegurado', 'Parentesco', 'Fecha de nacimiento', 'Prima']
  const GMM: TipoDocumento = { id: 'tipo-g', nombre: 'Gastos médicos mayores', codigo: 'G', color: '#d97706', seccion: { nombre: 'Asegurados' }, contable: false, configurado: true, estructuras: [],
    campos: [...UNA_VEZ.map((nombre, i) => ({ id: `u${i}`, nombre, origen: 'ia' as const, alcance: 'documento' as const })), ...POR_FILA.map((nombre, i) => ({ id: `f${i}`, nombre, origen: 'manual' as const, alcance: 'movimiento' as const }))] }
  const fila = (n: number) => ({ id: `ia-${n}`, fecha: '', concepto: '', referencia: '', cargo: '', abono: '', saldo: '', origen: 'ia' as const, dudosos: [], extras: Object.fromEntries(POR_FILA.map((nombre, i) => [`f${i}`, `${nombre} ${n}`])) })
  const gmm = (cambios: Partial<ExtraccionGuardada> = {}): ExtraccionGuardada => ({
    schema: 1, messageId: 'm-g', partId: '1', attachmentId: 'att-g', filename: 'poliza_gastos_medicos_prueba.pdf', estado: 'borrador', version: 1, creado: '2026-11-19T10:00:00Z', actualizado: '2026-11-19T10:00:00Z',
    revisado_en: null, revisado_con_problemas: false, enviado_en: null, envios: [], modelo: 'm', prompt_version: 'v', formato_numerico: null,
    resumen: { banco: '', titular: '', cuenta: '', periodo: '', moneda: '', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
    transacciones: [fila(1), fila(2), fila(3)],
    campos_extra: GMM.campos.map((campo) => (campo.alcance === 'documento'
      ? { id: campo.id, nombre: campo.nombre, origen: campo.origen, alcance: 'documento' as const, valor: `valor de ${campo.nombre}`, valor_ia: true, plantilla_id: campo.id }
      : { id: campo.id, nombre: campo.nombre, origen: campo.origen, plantilla_id: campo.id })),
    sugerencias_campos: [], validacion: { cuadra: null } as ExtraccionGuardada['validacion'], problemas: { total: 0 } as ExtraccionGuardada['problemas'],
    tipo_documento: { tipo_id: 'tipo-g', codigo: 'G', nombre: 'Gastos médicos mayores', color: '#d97706', contable: false, metodo: 'manual', confianza: null, requiere_revision: false, motivo: null },
    ...cambios,
  })
  const pintar = () => {
    const archivo: ArchivoExtraccion = { clave: 'm-g:1', messageId: 'm-g', attachmentId: 'att-g', partId: '1', filename: 'poliza_gastos_medicos_prueba.pdf' }
    const router = createMemoryRouter([{ path: '*', element: <ExtractionTabsWorkspace archivos={[archivo]} lote={false} mode="gemini" onModeChange={() => undefined} /> }], { initialEntries: ['/extraction'] })
    render(<RouterProvider router={router} />)
  }
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:prueba')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  })

  it('gastos médicos: los 12 datos "Una vez" se ven con su valor y la sección "Asegurados" trae sus 3 filas', async () => {
    tiposVigentes.fijar([EC, GMM])
    guardado = gmm()
    pintar()
    const datos = await screen.findByRole('region', { name: 'Datos del documento' })
    for (const nombre of UNA_VEZ) expect((within(datos).getByLabelText(`${nombre} del documento`) as HTMLInputElement).value).toBe(`valor de ${nombre}`)
    const tabla = screen.getByRole('table', { name: 'Asegurados del documento' })
    expect(within(tabla).getAllByRole('columnheader').length).toBe(1 + 3)
    expect((within(tabla).getByLabelText('Parentesco del movimiento 3') as HTMLInputElement).value).toBe('Parentesco 3')
    // Los datos "Una vez" no se repiten dentro de la tabla y la columna de nombres es ancha.
    expect(within(tabla).queryByLabelText('RFC del documento')).toBeNull()
    expect(tabla.querySelector('col')?.className).toBe('w-44')
    expect(screen.getByText('3 filas en Asegurados.')).toBeTruthy()
    expect(screen.queryByText('Filas')).toBeNull()
  })

  it('un tipo sin sección no muestra una tabla "Filas"', async () => {
    const sinSeccion: TipoDocumento = { ...GMM, seccion: null, campos: GMM.campos.filter((campo) => campo.alcance === 'documento') }
    tiposVigentes.fijar([EC, sinSeccion])
    guardado = gmm({ transacciones: [], campos_extra: gmm().campos_extra?.filter((campo) => campo.alcance === 'documento') })
    pintar()
    const datos = await screen.findByRole('region', { name: 'Datos del documento' })
    expect((within(datos).getByLabelText('Contratante del documento') as HTMLInputElement).value).toBe('valor de Contratante')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('Filas')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Agregar' })).toBeNull()
    expect(screen.getByText('Este tipo no tiene sección repetible.')).toBeTruthy()
  })

  it('la verificación visual dice claramente que no aplica', () => {
    render(<PanelVerificacion noAplica="La verificación visual compara los movimientos de un estado de cuenta; no aplica a Gastos médicos mayores." estado="listo" visible resultado={null} destino={null} onCancelarDestino={vi.fn()} mensaje={null} onCerrarMensaje={vi.fn()} filaPorAgregar={null} onAgregar={vi.fn()} onCancelarAgregar={vi.fn()} />)
    expect(screen.getByRole('note').textContent).toContain('no aplica a Gastos médicos mayores')
    expect(screen.queryByText(/tabla de movimientos/)).toBeNull()
  })

  it('en Tipos y reglas se agrega la sección a un tipo existente y sus campos por fila', async () => {
    const sinSeccion: TipoDocumento = { ...GMM, seccion: null, campos: GMM.campos.filter((campo) => campo.alcance === 'documento') }
    listarMock.mockImplementation(async () => ({ tipos: [EC, sinSeccion], umbral_confianza: 0.7 }))
    editarMock.mockImplementation(async (_id: string, solicitud: { seccion: TipoDocumento['seccion']; campos: TipoDocumento['campos'] }) => {
      const tipo = { ...sinSeccion, seccion: solicitud.seccion, campos: solicitud.campos }
      return { tipos: [EC, tipo], umbral_confianza: 0.7, tipo }
    })
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Gastos médicos mayores/ }))
    fireEvent.change(screen.getByLabelText('Sección repetible'), { target: { value: 'Asegurados' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tipo' }))
    await waitFor(() => expect(editarMock).toHaveBeenCalledTimes(1))
    expect(editarMock.mock.calls[0][1].seccion).toEqual({ nombre: 'Asegurados' })
    await waitFor(() => expect(screen.getByTestId('tipo-configurando').textContent).toContain('Sección repetible: Asegurados'))
    // Campo por fila nuevo en la sección, y renombrar la sección después.
    fireEvent.change(screen.getByLabelText('Nombre del campo nuevo'), { target: { value: 'Asegurado' } })
    fireEvent.change(screen.getByLabelText('Dónde va el campo nuevo'), { target: { value: 'movimiento' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a mano' }))
    expect((screen.getByLabelText('Dónde va Asegurado') as HTMLSelectElement).selectedOptions[0].textContent).toBe('En asegurados')
    fireEvent.click(screen.getByRole('button', { name: 'Guardar campos' }))
    await waitFor(() => expect(editarMock).toHaveBeenCalledTimes(2))
    const conCampo = editarMock.mock.calls[1][1]
    expect(conCampo.seccion).toEqual({ nombre: 'Asegurados' })
    expect(conCampo.campos.slice(-1)[0]).toMatchObject({ nombre: 'Asegurado', alcance: 'movimiento' })
    fireEvent.change(screen.getByLabelText('Sección repetible'), { target: { value: 'Personas aseguradas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tipo' }))
    await waitFor(() => expect(editarMock).toHaveBeenCalledTimes(3))
    expect(editarMock.mock.calls[2][1].seccion).toEqual({ nombre: 'Personas aseguradas' })
    expect(editarMock.mock.calls[2][1].campos.slice(-1)[0]).toMatchObject({ nombre: 'Asegurado', alcance: 'movimiento' })
  })

  it('"Configurar con este documento" avisa si la IA ve una tabla y el tipo no tiene sección', async () => {
    sugerirMock.mockImplementation(async () => ({ aseguradora: null, sugerencias: [
      { clave: 'contratante', nombre: 'Contratante', ejemplo: 'X', alcance: 'documento', filas: 0 },
      { clave: 'asegurado', nombre: 'Asegurado', ejemplo: 'Y', alcance: 'movimiento', filas: 3 },
    ] }))
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar con este documento' }))
    const panel = screen.getByRole('dialog', { name: 'poliza-axa.pdf' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Proponer campos con IA' }))
    const aviso = await within(panel).findByRole('note')
    expect(aviso.textContent).toContain('La IA ve una tabla que se repite (Asegurado)')
  })
})

describe('Plantillas predeterminadas', () => {
  const FIANZAS: TipoDocumento = { id: 'tipo-f', nombre: 'Fianzas', codigo: 'F', color: '#059669', seccion: null, contable: false, configurado: true, estructuras: [],
    plantilla: { codigo: 'F', version: 1 }, plantilla_faltantes: ['Agente'],
    campos: [{ id: 'pd-numero-de-fianza', nombre: 'Número de fianza', origen: 'manual', alcance: 'documento' }] }

  it('el tipo precargado muestra "Plantilla predeterminada" y restaura los campos que faltan después de confirmar', async () => {
    listarMock.mockImplementation(async () => ({ tipos: [EC, FIANZAS], umbral_confianza: 0.7 }))
    const restaurado = { ...FIANZAS, plantilla_faltantes: [], campos: [...FIANZAS.campos, { id: 'pd-agente', nombre: 'Agente', origen: 'manual' as const, alcance: 'documento' as const }] }
    restaurarMock.mockImplementation(async () => ({ tipos: [EC, restaurado], umbral_confianza: 0.7, tipo: restaurado, agregados: ['Agente'] }))
    const onNotice = vi.fn()
    render(<TiposDocumentoSeccion onNotice={onNotice} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Fianzas/ }))
    expect(screen.getByTestId('tipo-configurando').textContent).toContain('Plantilla predeterminada')
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar campos predeterminados' }))
    const confirmar = screen.getByRole('alertdialog', { name: 'Confirmar restaurar campos' })
    expect(confirmar.textContent).toContain('Agente')
    expect(restaurarMock).not.toHaveBeenCalled()
    fireEvent.click(within(confirmar).getByRole('button', { name: 'Sí, agregar' }))
    await waitFor(() => expect(restaurarMock).toHaveBeenCalledWith('tipo-f'))
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Se agregó 1 campo predeterminado a «Fianzas»: Agente.'))
    // La lista de campos del editor ya trae el campo restaurado y el botón queda sin nada que restaurar.
    expect(within(screen.getByRole('list', { name: 'Campos de Fianzas' })).getByText('Agente')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Restaurar campos predeterminados' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('muestra los cambios de estructura por aseguradora con "Agregar" e "Ignorar" y los campos que dejaron de aparecer', async () => {
    const conAvisos: TipoDocumento = { ...FIANZAS,
      sugerencias_estructura: [{ aseguradora: 'AFIANZADORA NORTE', clave: 'folio interno', nombre: 'Folio interno', alcance: 'documento', veces: 4, documentos: 5, ejemplo: 'FI-1' },
        { aseguradora: 'AFIANZADORA SUR', clave: 'color', nombre: 'Color', alcance: 'documento', veces: 2, documentos: 2, ejemplo: 'Azul' }],
      campos_ausentes: [{ aseguradora: 'AFIANZADORA NORTE', nombre: 'Agente', racha: 3 }] }
    listarMock.mockImplementation(async () => ({ tipos: [EC, conAvisos], umbral_confianza: 0.7 }))
    const agregado = { ...conAvisos, sugerencias_estructura: conAvisos.sugerencias_estructura!.slice(1), campos: [...conAvisos.campos, { id: 'pl-folio-interno', nombre: 'Folio interno', origen: 'ia' as const, alcance: 'documento' as const }] }
    resolverMock.mockImplementationOnce(async () => ({ tipos: [EC, agregado], umbral_confianza: 0.7, tipo: agregado }))
    const onNotice = vi.fn()
    render(<TiposDocumentoSeccion onNotice={onNotice} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Fianzas/ }))
    const lista = screen.getByRole('list', { name: 'Sugerencias de estructura' })
    expect(lista.textContent).toContain('AFIANZADORA NORTE trae «Folio interno» (4 de 5 documentos). ¿Agregar al tipo?')
    expect(within(lista).getByRole('note').textContent).toBe('«Agente»: No se encontró en los últimos 3 documentos de AFIANZADORA NORTE.')
    fireEvent.click(within(lista).getByRole('button', { name: 'Agregar Folio interno de AFIANZADORA NORTE' }))
    await waitFor(() => expect(resolverMock).toHaveBeenCalledWith('tipo-f', 'agregar', 'AFIANZADORA NORTE', 'folio interno'))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Campos de Fianzas' })).getByText('Folio interno')).toBeTruthy())
    resolverMock.mockImplementationOnce(async () => ({ tipos: [EC, { ...agregado, sugerencias_estructura: [] }], umbral_confianza: 0.7, tipo: agregado }))
    fireEvent.click(screen.getByRole('button', { name: 'Ignorar Color de AFIANZADORA SUR' }))
    await waitFor(() => expect(resolverMock).toHaveBeenLastCalledWith('tipo-f', 'ignorar', 'AFIANZADORA SUR', 'color'))
    await waitFor(() => expect(onNotice).toHaveBeenLastCalledWith('«Color» ya no se sugerirá para AFIANZADORA SUR.'))
  })

  it('en un tipo que no es Estado de cuenta se puede agregar un campo «Fecha»', async () => {
    listarMock.mockImplementation(async () => ({ tipos: [EC, FIANZAS], umbral_confianza: 0.7 }))
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Fianzas/ }))
    fireEvent.change(screen.getByLabelText('Nombre del campo nuevo'), { target: { value: 'Fecha' } })
    expect(screen.queryByText('Ese campo ya es una columna de la tabla.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a mano' }))
    expect(within(screen.getByRole('list', { name: 'Campos de Fianzas' })).getByText('Fecha')).toBeTruthy()
  })
})


describe('Que se vea si se envió o no', () => {
  const envio = (cambios: Partial<NonNullable<DocumentoRecibido['estado_envio']>>): NonNullable<DocumentoRecibido['estado_envio']> => ({
    estado: 'enviado', filtro: 'enviados', etiqueta: 'Enviado automáticamente', motivo: null, fecha: '2026-11-19T10:00:00Z', code: 200, respuesta: 'code 200: Exito', origen: 'automatico', ...cambios,
  })
  const FZ = { tipo_id: 'tipo-f', codigo: 'F', nombre: 'Fianzas', color: '#059669', metodo: 'ia' as const, confianza: 0.92, requiere_revision: false, motivo: null }
  const lista = () => [
    recibido({ messageId: 'a', filename: 'auto.pdf', tipo_documento: detectado(FZ), estado_envio: envio({}) }),
    recibido({ messageId: 'b', filename: 'configurar.pdf', tipo_documento: detectado(FZ), estado_envio: envio({ etiqueta: 'Enviado al configurar', origen: 'configurar' }) }),
    recibido({ messageId: 'c', filename: 'pendiente.pdf', tipo_documento: detectado(FZ), estado_envio: envio({ estado: 'pendiente', filtro: 'pendientes', etiqueta: 'Pendiente de envío (pedido al configurar)', motivo: 'No se pudo conectar con SaveData; no se envió nada. Se reintentará en la próxima revisión.', code: null, respuesta: null, origen: 'configurar' }) }),
    recibido({ messageId: 'd', filename: 'revision.pdf', estado_envio: envio({ estado: 'no_enviado', filtro: 'no_enviados', etiqueta: 'No se envió: no cuadra', motivo: 'no cuadra', code: null, respuesta: null, origen: null }) }),
    recibido({ messageId: 'e', filename: 'incierto.pdf', tipo_documento: detectado(FZ), estado_envio: envio({ estado: 'incierto', filtro: 'con_error', etiqueta: 'Incierto, verificar', motivo: 'SaveData no respondió.', code: null, respuesta: null }) }),
  ]
  const TIPO_F: TipoDocumento = { id: 'tipo-f', nombre: 'Fianzas', codigo: 'F', color: '#059669', seccion: null, contable: false, configurado: true, estructuras: [], campos: [],
    resumen_envios: { dias: 30, recibidos: 12, enviados_automatico: 10, enviados_configurar: 0, enviados_manual: 0, pendientes: 1, no_enviados: 1, con_error: 0 } }

  it('cada documento muestra su estado de envío con su motivo, y los filtros separan Enviados, Pendientes, No enviados y Con error', async () => {
    documentosMock.mockImplementation(async () => ({ documentos: lista(), umbral_confianza: 0.7 }))
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    const documentos = await screen.findByRole('list', { name: 'Documentos que llegaron' })
    const filas = within(documentos).getAllByRole('listitem')
    expect(filas.map((fila) => within(fila).getByTestId('estado-envio').textContent)).toEqual(['Enviado automáticamente', 'Enviado al configurar', 'Pendiente de envío (pedido al configurar)', 'No se envió: no cuadra', 'Incierto, verificar'])
    expect(filas[0].textContent).toContain('SaveData: code 200: Exito')
    expect(filas[2].textContent).toContain('Motivo: No se pudo conectar con SaveData; no se envió nada. Se reintentará en la próxima revisión.')
    const filtros = screen.getByRole('group', { name: 'Filtrar por envío' })
    const nombres = (texto: string) => { fireEvent.click(within(filtros).getByRole('button', { name: new RegExp(`^${texto}`) })); return within(screen.getByRole('list', { name: 'Documentos que llegaron' })).queryAllByRole('listitem').map((fila) => fila.querySelector('div > div')?.textContent) }
    expect(nombres('Enviados')).toEqual(['auto.pdf', 'configurar.pdf'])
    expect(nombres('Pendientes')).toEqual(['pendiente.pdf'])
    expect(nombres('No enviados')).toEqual(['revision.pdf'])
    expect(nombres('Con error')).toEqual(['incierto.pdf'])
    expect(nombres('Todos')).toHaveLength(5)
  })

  it('el resumen de Tipos y reglas lleva a Documentos que llegaron filtrado por ese tipo', async () => {
    listarMock.mockImplementation(async () => ({ tipos: [EC, TIPO_F], umbral_confianza: 0.7 }))
    documentosMock.mockImplementation(async () => ({ documentos: lista(), umbral_confianza: 0.7 }))
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tipos y reglas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Fianzas/ }))
    expect(screen.getByTestId('resumen-envios').textContent).toBe('Últimos 30 días: 12 recibidos · 10 enviados automáticamente · 1 pendiente · 1 requiere revisión')
    fireEvent.click(screen.getByRole('button', { name: 'Ver en Documentos que llegaron' }))
    const documentos = await screen.findByRole('list', { name: 'Documentos que llegaron' })
    expect(within(documentos).getAllByRole('listitem')).toHaveLength(4)  // sin el que no es Fianzas
    fireEvent.click(screen.getByRole('button', { name: 'Quitar filtro de tipo' }))
    expect(within(screen.getByRole('list', { name: 'Documentos que llegaron' })).getAllByRole('listitem')).toHaveLength(5)
  })

  it('"Configurar con este documento" dice el resultado real: no se pudo enviar y se reintentará', async () => {
    configurarMock.mockImplementation(async () => ({ tipos: [EC, FLOTILLA], umbral_confianza: 0.7, tipo: FLOTILLA, estructura: null, envio: 'pendiente', motivos: [], reintentara: true, code: null,
      mensaje: 'No se pudo conectar con SaveData; no se envió nada.' }))
    const onError = vi.fn()
    render(<TiposDocumentoSeccion onNotice={vi.fn()} onError={onError} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar con este documento' }))
    const panel = screen.getByRole('dialog', { name: 'poliza-axa.pdf' })
    fireEvent.click(within(panel).getByRole('radio', { name: 'Usar un tipo que ya existe' }))
    fireEvent.change(within(panel).getByLabelText('Tipo de documento'), { target: { value: 'tipo-ac' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Guardar configuración' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Tipo guardado; no se pudo enviar: No se pudo conectar con SaveData; no se envió nada. Se reintentará en la próxima revisión.'))
  })
})
