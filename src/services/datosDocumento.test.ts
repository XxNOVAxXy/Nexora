import { describe, expect, it } from 'vitest'
import type { CampoExtra, Transaccion } from '../types'
import { cambiarAlcance, migrarColumnasUnicas, puedeSerDelDocumento } from './camposExtra'
import { borradoresLocales, documentoDesdeExtraccion, documentoVacio } from './guardado'
import type { GeminiExtractionResponse } from './geminiApi'
import { leerFecha, moverTransaccion, ordenarPorFecha } from './transacciones'

const fila = (id: string, cambios: Partial<Transaccion> = {}): Transaccion => ({ id, fecha: '02/11/2026', concepto: id, referencia: '', cargo: '1.00', abono: '', saldo: '', origen: 'ia', dudosos: [], huella: `h-${id}`, ...cambios })
const rfc: CampoExtra = { id: 'rfc', nombre: 'RFC', origen: 'manual' }

describe('corregir el tipo de un campo', () => {
  it('dato del documento → en cada movimiento: el valor se copia a cada movimiento', () => {
    const documento = { campos_extra: [{ ...rfc, alcance: 'documento' as const, valor: 'XAXX', valor_ia: true }], transacciones: [fila('a'), fila('b')] }
    const cambiado = cambiarAlcance(documento, 'rfc', 'movimiento')
    expect(cambiado.campos_extra).toEqual([rfc])
    expect(cambiado.transacciones.map((t) => t.extras)).toEqual([{ rfc: 'XAXX' }, { rfc: 'XAXX' }])
    expect(cambiado.transacciones.map((t) => t.extras_ia)).toEqual([['rfc'], ['rfc']])
  })

  it('en cada movimiento → dato del documento solo si no se pierde nada', () => {
    const iguales = { campos_extra: [rfc], transacciones: [fila('a', { extras: { rfc: 'XAXX' } }), fila('b', { extras: { rfc: 'XAXX' } }), fila('c')] }
    expect(puedeSerDelDocumento(iguales.transacciones, rfc)).toBe(true)
    const cambiado = cambiarAlcance(iguales, 'rfc', 'documento')
    expect(cambiado.campos_extra).toEqual([{ ...rfc, alcance: 'documento', valor: 'XAXX' }])
    expect(cambiado.transacciones.every((t) => !t.extras)).toBe(true)

    const distintos = { campos_extra: [rfc], transacciones: [fila('a', { extras: { rfc: 'A' } }), fila('b', { extras: { rfc: 'B' } })] }
    expect(puedeSerDelDocumento(distintos.transacciones, rfc)).toBe(false)
    expect(cambiarAlcance(distintos, 'rfc', 'documento')).toBe(distintos)
  })
})

describe('migración de extracciones anteriores', () => {
  it('una columna con el mismo valor en todas las filas pasa a dato del documento', () => {
    const documento = { ...documentoVacio(), campos_extra: [rfc, { id: 'fol', nombre: 'Folio', origen: 'manual' as const }], transacciones: [fila('a', { extras: { rfc: 'XAXX', fol: '1' }, extras_ia: ['rfc'] }), fila('b', { extras: { rfc: 'XAXX', fol: '2' }, extras_ia: ['rfc'] })] }
    const migrado = migrarColumnasUnicas(documento)
    expect(migrado.campos_extra[0]).toEqual({ ...rfc, alcance: 'documento', valor: 'XAXX', valor_ia: true })
    expect(migrado.campos_extra[1]).toEqual({ id: 'fol', nombre: 'Folio', origen: 'manual' })
    expect(migrado.transacciones.map((t) => t.extras)).toEqual([{ fol: '1' }, { fol: '2' }])
  })

  it('no cambia nada con valores distintos, vacíos o un solo movimiento', () => {
    for (const transacciones of [[fila('a', { extras: { rfc: 'A' } }), fila('b', { extras: { rfc: 'B' } })], [fila('a', { extras: { rfc: 'A' } }), fila('b')], [fila('a', { extras: { rfc: 'A' } })]]) {
      const documento = { ...documentoVacio(), campos_extra: [rfc], transacciones }
      expect(migrarColumnasUnicas(documento)).toBe(documento)
    }
  })

  it('los borradores locales anteriores también se migran al leerlos', () => {
    const datos = new Map<string, string>()
    const almacen = borradoresLocales({ getItem: (clave) => datos.get(clave) ?? null, setItem: (clave, valor) => { datos.set(clave, valor) }, removeItem: (clave) => { datos.delete(clave) } })
    almacen.guardar('k', { version_base: 1, guardadoEn: '2026-11-13T10:00:00Z', documento: { ...documentoVacio(), campos_extra: [rfc], transacciones: [fila('a', { extras: { rfc: 'X' } }), fila('b', { extras: { rfc: 'X' } })] } })
    const leido = almacen.leer('k')!
    expect(leido.documento.campos_extra).toEqual([{ ...rfc, alcance: 'documento', valor: 'X' }])
  })
})

describe('orden de los movimientos', () => {
  const ids = (items: { id: string }[]) => items.map((item) => item.id).join('')

  it('lee los formatos habituales de fecha', () => {
    expect(leerFecha('02/11/2026')).toEqual([2026, 11, 2])
    expect(leerFecha('2026-11-02')).toEqual([2026, 11, 2])
    expect(leerFecha('15 DIC')).toEqual([null, 12, 15])
    expect(leerFecha('3-ene-26')).toEqual([2026, 1, 3])
    expect(leerFecha('SALDO')).toBeNull()
  })

  it('ordena por fecha de forma estable y deja en su lugar las fechas ilegibles', () => {
    const filas = [{ id: 'a', fecha: '05/11/2026' }, { id: 'b', fecha: '02/11/2026' }, { id: 'x', fecha: '?' }, { id: 'c', fecha: '02/11/2026' }, { id: 'd', fecha: '01/11/2026' }]
    expect(ids(ordenarPorFecha(filas))).toBe('dbxca')
  })

  it('sin año usa el periodo y resuelve el cruce de diciembre a enero (igual que el backend)', () => {
    const filas = [{ id: 'e', fecha: '03/01' }, { id: 'd', fecha: '28/12' }, { id: 'n', fecha: '20/12' }]
    expect(ids(ordenarPorFecha(filas, '15/12/2025 al 14/01/2026'))).toBe('nde')
    expect(ids(ordenarPorFecha(filas))).toBe('nde')
    expect(ids(ordenarPorFecha([{ id: 'b', fecha: '10/03' }, { id: 'a', fecha: '02/03' }], 'Marzo 2026'))).toBe('ab')
  })

  it('al extraer los movimientos quedan ordenados por fecha y numerados en ese orden', () => {
    const resultado = { model: 'm', prompt_version: 'p', formato_numerico: 'us', resumen: { periodo: '' }, transacciones: [fila('x', { fecha: '20/11/2026' }), fila('y', { fecha: '05/11/2026' })], sugerencias_campos: [], resultados_campos: [] } as unknown as GeminiExtractionResponse
    const { documento } = documentoDesdeExtraccion(resultado, [], 'L')
    expect(documento.transacciones.map((t) => [t.id, t.concepto])).toEqual([['ia-L-1', 'y'], ['ia-L-2', 'x']])
  })

  it('después se puede renumerar a mano', () => {
    const lista = ['a', 'b', 'c', 'd'].map((id) => fila(id))
    expect(ids(moverTransaccion(lista, 'd', 2))).toBe('adbc')
    expect(ids(moverTransaccion(lista, 'b', 99))).toBe('acdb')
    expect(moverTransaccion(lista, 'b', 2)).toBe(lista)
    expect(moverTransaccion(lista, 'x', 1)).toBe(lista)
  })
})
