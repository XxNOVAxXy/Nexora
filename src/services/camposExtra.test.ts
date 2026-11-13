import { describe, expect, it } from 'vitest'
import type { CampoExtra, ResultadoCampo, SugerenciaCampo, Transaccion } from '../types'
import { agregarCampoManual, aplicarSugerencia, camposParaSolicitar, editarExtra, editarValorDocumento, eliminarCampo, errorNombreCampo, esCeldaDeIa, filasConValor, fuenteDeLlenado, llenarColumnaManual, mensajeLlenado, rellenarColumnas, renombrarCampo, sugerenciasDisponibles } from './camposExtra'
import { borradoresLocales, documentoDesdeExtraccion, documentoDesdeGuardado, documentoVacio, firmaContenido, hayCambios } from './guardado'
import type { ExtraccionGuardada } from './extraccionesApi'
import type { GeminiExtractionResponse } from './geminiApi'
import { esFilaVacia, nuevaTransaccion } from './transacciones'

const fila = (id: string, huella: string | undefined, cambios: Partial<Transaccion> = {}): Transaccion => ({ id, fecha: '01/10', concepto: id, referencia: '', cargo: '1.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella, ...cambios })
const vsm: SugerenciaCampo = { clave: 'vsm', nombre: 'VSM', valores: [{ huella: 'h1', valor: '12.5' }, { huella: 'h2', valor: '13' }] }
const credito: SugerenciaCampo = { clave: 'numero-de-credito', nombre: 'Número de crédito', valores: [], valor_documento: 'CR-778' }

describe('aplicar sugerencias', () => {
  it('crea la columna con los valores de la IA por huella, sin marcar las filas como editadas', () => {
    const { campos_extra, transacciones } = aplicarSugerencia({ transacciones: [fila('a', 'h1'), fila('b', 'h2'), fila('c', 'h3')], campos_extra: [] }, vsm)
    expect(campos_extra).toEqual([expect.objectContaining({ nombre: 'VSM', origen: 'ia', clave: 'vsm' })])
    const id = campos_extra[0].id
    expect(transacciones.map((t) => t.extras?.[id])).toEqual(['12.5', '13', undefined])
    expect(transacciones.every((t) => t.origen === 'ia')).toBe(true)
    expect('extras' in transacciones[2]).toBe(false)
  })

  it('reparte en orden los valores de filas con la misma huella', () => {
    const repetidas: SugerenciaCampo = { clave: 'folio', nombre: 'Folio', valores: [{ huella: 'h', valor: 'F1' }, { huella: 'h', valor: 'F2' }] }
    const { campos_extra, transacciones } = aplicarSugerencia({ transacciones: [fila('a', 'h'), fila('b', 'h')], campos_extra: [] }, repetidas)
    expect(transacciones.map((t) => t.extras?.[campos_extra[0].id])).toEqual(['F1', 'F2'])
  })

  it('un valor único del documento se guarda una sola vez en el campo, no en cada movimiento', () => {
    const manual = { ...nuevaTransaccion(), concepto: 'A MANO' }
    const actuales = [fila('a', 'h1'), manual]
    const { campos_extra, transacciones } = aplicarSugerencia({ transacciones: actuales, campos_extra: [] }, credito)
    expect(campos_extra).toEqual([expect.objectContaining({ nombre: 'Número de crédito', origen: 'ia', alcance: 'documento', valor: 'CR-778' })])
    expect(transacciones).toBe(actuales)
    expect(transacciones.every((t) => t.extras === undefined)).toBe(true)
    expect(filasConValor(credito)).toBeNull()
    expect(filasConValor(vsm)).toBe(2)
  })

  it('una sugerencia ya agregada (por clave o nombre) deja de ofrecerse y vuelve al eliminar la columna', () => {
    const documento = aplicarSugerencia({ transacciones: [fila('a', 'h1')], campos_extra: [] }, vsm)
    const manual = agregarCampoManual(documento.campos_extra, 'número  de CRÉDITO')
    expect(sugerenciasDisponibles([vsm, credito], manual)).toEqual([])
    const sinVsm = eliminarCampo(documento, documento.campos_extra[0].id)
    expect(sinVsm.transacciones[0].extras).toBeUndefined()
    expect(sugerenciasDisponibles([vsm, credito], sinVsm.campos_extra)).toEqual([vsm, credito])
  })
})

describe('columnas manuales', () => {
  const campos: CampoExtra[] = [{ id: 'c1', nombre: 'Sucursal', origen: 'manual' }]

  it('valida nombres vacíos, repetidos y estándar', () => {
    expect(errorNombreCampo('   ', campos)).toMatch(/Escribe/)
    expect(errorNombreCampo(' sucursal ', campos)).toMatch(/Ya existe/)
    expect(errorNombreCampo('Saldo', campos)).toMatch(/ya es una columna/)
    expect(errorNombreCampo('Sucursal', campos, 'c1')).toBeNull()
    expect(agregarCampoManual(campos, 'Sucursal')).toBe(campos)
    expect(agregarCampoManual(campos, '  Folio  interno ').map((c) => c.nombre)).toEqual(['Sucursal', 'Folio interno'])
  })

  it('renombra sin perder los valores y edita celdas como las demás columnas', () => {
    expect(renombrarCampo(campos, 'c1', 'Plaza')).toEqual([{ id: 'c1', nombre: 'Plaza', origen: 'manual' }])
    const editada = editarExtra(fila('a', 'h1'), 'c1', 'Centro')
    expect(editada).toMatchObject({ origen: 'ia_editada', extras: { c1: 'Centro' } })
    expect(editarExtra(editada, 'c1', '').extras).toBeUndefined()
  })

  it('una fila manual con datos solo en columnas nuevas no cuenta como vacía', () => {
    const manual = nuevaTransaccion()
    expect(esFilaVacia(manual)).toBe(true)
    expect(esFilaVacia(editarExtra(manual, 'c1', 'x'))).toBe(false)
  })
})

describe('re-extracción con columnas adicionales', () => {
  const resultado = (sugerencias: SugerenciaCampo[]): GeminiExtractionResponse => ({
    filename: 'estado.pdf', model: 'm', prompt_version: 'v', formato_numerico: 'us', resumen: { banco: '', titular: '', cuenta: '', periodo: '', moneda: '', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] },
    transacciones: [fila('ia-1', 'h1'), fila('ia-2', 'h2'), fila('ia-3', 'h3')], validacion: {} as never, warnings: [], sugerencias_campos: sugerencias,
  })

  it('conserva columnas y lo editado, pasa valores de filas sin editar y rellena celdas vacías de la IA', () => {
    const campos: CampoExtra[] = [{ id: 'c-ia', nombre: 'VSM', origen: 'ia', clave: 'vsm' }, { id: 'c-man', nombre: 'Notas', origen: 'manual' }]
    const actuales = [
      fila('x-1', 'h1', { extras: { 'c-ia': '99', 'c-man': 'nota' } }),
      fila('x-2', 'h2', { origen: 'ia_editada', extras: { 'c-ia': 'editado' } }),
      fila('x-3', 'h3'),
    ]
    const nuevaVsm: SugerenciaCampo = { clave: 'vsm', nombre: 'VSM', valores: [{ huella: 'h1', valor: '1' }, { huella: 'h2', valor: '2' }, { huella: 'h3', valor: '3' }] }
    const { documento } = documentoDesdeExtraccion(resultado([nuevaVsm, credito]), actuales, 'lote', campos)
    expect(documento.campos_extra).toBe(campos)
    expect(documento.sugerencias_campos).toEqual([nuevaVsm, credito])
    expect(documento.transacciones.map((t) => t.extras)).toEqual([{ 'c-ia': '99', 'c-man': 'nota' }, { 'c-ia': 'editado' }, { 'c-ia': '3' }])
  })

  it('un resultado sin sugerencias (caché antigua) deja la lista vacía', () => {
    const sinCampo = { ...resultado([]), sugerencias_campos: undefined }
    expect(documentoDesdeExtraccion(sinCampo, [], 'lote').documento.sugerencias_campos).toEqual([])
  })
})

describe('documentos y borradores anteriores', () => {
  it('un documento guardado sin columnas abre con listas vacías y sin cambios', () => {
    const guardado = { estado: 'borrador', resumen: null, transacciones: [fila('a', 'h1')], formato_numerico: 'us', modelo: null, prompt_version: null } as unknown as ExtraccionGuardada
    const documento = documentoDesdeGuardado(guardado)
    expect(documento.campos_extra).toEqual([])
    expect(documento.sugerencias_campos).toEqual([])
    expect(hayCambios(documento, firmaContenido(documento))).toBe(false)
  })

  it('un borrador local antiguo se lee con columnas vacías y la misma firma que lo guardado', () => {
    const datos = new Map<string, string>()
    const almacen = { getItem: (clave: string) => datos.get(clave) ?? null, setItem: (clave: string, valor: string) => { datos.set(clave, valor) }, removeItem: (clave: string) => { datos.delete(clave) } }
    const { campos_extra: _c, sugerencias_campos: _s, ...antiguo } = { ...documentoVacio(), transacciones: [fila('a', 'h1')] }
    almacen.setItem('k', JSON.stringify({ version_base: 1, guardadoEn: '2026-11-01T00:00:00Z', documento: antiguo }))
    const leido = borradoresLocales(almacen).leer('k')
    expect(leido?.documento.campos_extra).toEqual([])
    expect(firmaContenido(leido!.documento)).toBe(firmaContenido({ ...documentoVacio(), transacciones: [fila('a', 'h1')] }))
  })

  it('una columna nueva sin filas cuenta como cambio sin guardar', () => {
    expect(hayCambios({ ...documentoVacio(), campos_extra: [{ id: 'c', nombre: 'X', origen: 'manual' }] }, null)).toBe(true)
  })
})

describe('la IA llena columnas manuales', () => {
  const nombre: CampoExtra = { id: 'c-nom', nombre: 'Nombre', origen: 'manual' }
  const filas = () => [fila('a', 'h1'), fila('b', 'h2'), fila('c', undefined, { origen: 'manual' })]
  const resultado = (cambios: Partial<ResultadoCampo>): ResultadoCampo => ({ nombre: 'Nombre', clave: 'nombre', encontrado: true, valores: [], ...cambios })

  it('llena una columna manual vacía, marca las celdas como de la IA y no cambia el origen', () => {
    const { transacciones, llenado } = rellenarColumnas(filas(), [nombre], [], [resultado({ valores: [{ huella: 'h1', valor: 'Ana' }, { huella: 'h2', valor: 'Luis' }] })])
    expect(transacciones.map((t) => t.extras?.['c-nom'])).toEqual(['Ana', 'Luis', undefined])
    expect(transacciones.map((t) => esCeldaDeIa(t, 'c-nom'))).toEqual([true, true, false])
    expect(transacciones.map((t) => t.origen)).toEqual(['ia', 'ia', 'manual'])
    expect(llenado.map(mensajeLlenado)).toEqual(['Se llenaron 2 celdas de «Nombre».'])
  })

  it('en una columna parcialmente llena solo llena las vacías y conserva "Juan"', () => {
    const actuales = [fila('a', 'h1', { extras: { 'c-nom': 'Juan' } }), fila('b', 'h2')]
    const { transacciones, llenado } = rellenarColumnas(actuales, [nombre], [], [resultado({ valores: [{ huella: 'h1', valor: 'Ana' }, { huella: 'h2', valor: 'Luis' }] })])
    expect(transacciones.map((t) => t.extras?.['c-nom'])).toEqual(['Juan', 'Luis'])
    expect(esCeldaDeIa(transacciones[0], 'c-nom')).toBe(false)
    expect(llenado[0]).toMatchObject({ estado: 'llenado', llenadas: 1 })
  })

  it('un dato inexistente da el mensaje y no cambia nada', () => {
    const actuales = filas()
    const { transacciones, llenado } = rellenarColumnas(actuales, [nombre], [], [resultado({ encontrado: false })])
    expect(transacciones).toBe(actuales)
    expect(llenado.map(mensajeLlenado)).toEqual(['No se encontró «Nombre» en el documento.'])
  })

  it('un dato único del documento no se repite en cada fila: el campo pasa a ser del documento', () => {
    const actuales = filas()
    const { transacciones, campos, llenado } = rellenarColumnas(actuales, [nombre], [], [resultado({ valor_documento: 'Persona Prueba' })])
    expect(transacciones).toBe(actuales)
    expect(campos).toEqual([{ ...nombre, alcance: 'documento', valor: 'Persona Prueba', valor_ia: true }])
    expect(llenado.map(mensajeLlenado)).toEqual(['«Nombre» aparece una sola vez en el documento: se guardó una vez, no en cada movimiento.'])
  })

  it('si el campo ya tiene valores por movimiento, un dato único no los toca ni se repite', () => {
    const actuales = [fila('a', 'h1', { extras: { 'c-nom': 'Juan' } }), ...filas().slice(1)]
    const { transacciones, campos, llenado } = rellenarColumnas(actuales, [nombre], [], [resultado({ valor_documento: 'Persona Prueba' })])
    expect(transacciones).toBe(actuales)
    expect(campos).toEqual([nombre])
    expect(llenado[0]).toMatchObject({ estado: 'unico_con_valores', llenadas: 0 })
  })

  it('un campo del documento se llena una sola vez, no se sobrescribe y se edita a mano', () => {
    const rfc: CampoExtra = { id: 'c-rfc', nombre: 'RFC', origen: 'manual', alcance: 'documento', valor: '' }
    const actuales = filas()
    const lleno = llenarColumnaManual(actuales, rfc, true, { unico: 'XAXX010101000' })
    expect(lleno.transacciones).toBe(actuales)
    expect(lleno.campo).toEqual({ ...rfc, valor: 'XAXX010101000', valor_ia: true })
    expect(llenarColumnaManual(actuales, lleno.campo, true, { unico: 'OTRO' }).resultado.estado).toBe('completa')
    expect(llenarColumnaManual(actuales, rfc, true, { porId: new Map([['a', 'X']]) }).resultado.estado).toBe('por_movimiento')
    expect(editarValorDocumento([lleno.campo], 'c-rfc', 'XAXX010101001')).toEqual([{ ...rfc, valor: 'XAXX010101001' }])
    expect(agregarCampoManual([], 'RFC', 'documento')).toEqual([expect.objectContaining({ nombre: 'RFC', origen: 'manual', alcance: 'documento', valor: '' })])
  })

  it('una columna completa no cambia y lo dice', () => {
    const actuales = [fila('a', 'h1', { extras: { 'c-nom': 'Juan' } })]
    const { transacciones, resultado: r } = llenarColumnaManual(actuales, nombre, true, { porId: new Map([['a', 'Otro']]) })
    expect(transacciones).toBe(actuales)
    expect(mensajeLlenado(r)).toBe('La columna ya estaba completa; no se cambió nada.')
  })

  it('"Llenar con IA" asocia por índice a las filas enviadas e ignora las borradas', () => {
    const fuente = fuenteDeLlenado({ valores: [{ indice: 0, valor: 'Ana' }, { indice: 2, valor: 'Eva' }, { indice: 9, valor: 'x' }] }, ['a', 'b', 'c'])
    const sinB = [fila('a', 'h1'), fila('c', undefined, { origen: 'manual' })]
    const { transacciones, resultado: r } = llenarColumnaManual(sinB, nombre, true, fuente)
    expect(transacciones.map((t) => t.extras?.['c-nom'])).toEqual(['Ana', 'Eva'])
    expect(r.llenadas).toBe(2)
  })

  it('editar una celda llenada por la IA le quita la marca y pasa la fila a "IA editada"', () => {
    const [llena] = rellenarColumnas([fila('a', 'h1')], [nombre], [], [resultado({ valores: [{ huella: 'h1', valor: 'Ana' }] })]).transacciones
    expect(esCeldaDeIa(llena, 'c-nom')).toBe(true)
    const editada = editarExtra(llena, 'c-nom', 'Ana María')
    expect(esCeldaDeIa(editada, 'c-nom')).toBe(false)
    expect(editada.origen).toBe('ia_editada')
    expect('extras_ia' in editada).toBe(false)
  })

  it('solo se piden a Gemini las columnas manuales', () => {
    expect(camposParaSolicitar([nombre, { id: 'x', nombre: 'VSM', origen: 'ia', clave: 'vsm' }])).toEqual(['Nombre'])
  })
})
