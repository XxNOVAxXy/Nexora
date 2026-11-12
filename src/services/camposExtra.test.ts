import { describe, expect, it } from 'vitest'
import type { CampoExtra, SugerenciaCampo, Transaccion } from '../types'
import { agregarCampoManual, aplicarSugerencia, editarExtra, eliminarCampo, errorNombreCampo, filasConValor, renombrarCampo, sugerenciasDisponibles } from './camposExtra'
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

  it('un valor único del documento llena todas las filas, también las manuales', () => {
    const manual = { ...nuevaTransaccion(), concepto: 'A MANO' }
    const { campos_extra, transacciones } = aplicarSugerencia({ transacciones: [fila('a', 'h1'), manual], campos_extra: [] }, credito)
    expect(transacciones.map((t) => t.extras?.[campos_extra[0].id])).toEqual(['CR-778', 'CR-778'])
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
