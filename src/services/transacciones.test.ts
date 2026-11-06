import { describe, expect, it } from 'vitest'
import type { Transaccion } from '../types'
import { combinarExtraccion, contarCorrecciones, editarCampo, nuevaTransaccion } from './transacciones'

const deIa = (): Transaccion => ({ id: 'ia-1', fecha: '02/10', concepto: 'PAGO', referencia: '', cargo: '1,234', abono: '', saldo: '', cargo_original: '1,234', origen: 'ia', dudosos: ['cargo'] })

const fila = (id: string, huella: string, concepto: string, cargo = ''): Transaccion => ({ id, fecha: '01/10', concepto, referencia: '', cargo, abono: '', saldo: '', origen: 'ia', dudosos: [], huella })

describe('transacciones', () => {
  it('crea filas manuales vacías con ids distintos', () => {
    const a = nuevaTransaccion()
    const b = nuevaTransaccion()
    expect(a.origen).toBe('manual')
    expect(a.dudosos).toEqual([])
    expect(a.id).not.toBe(b.id)
  })

  it('marca como ia_editada y quita la duda del monto editado, conservando el original', () => {
    const editada = editarCampo(deIa(), 'cargo', '1234.00')
    expect(editada.origen).toBe('ia_editada')
    expect(editada.cargo).toBe('1234.00')
    expect(editada.dudosos).toEqual([])
    expect(editada.cargo_original).toBe('1,234')
  })

  it('no cambia el origen si el valor no cambia y mantiene manual en filas manuales', () => {
    const original = deIa()
    expect(editarCampo(original, 'cargo', '1,234')).toBe(original)
    expect(editarCampo(nuevaTransaccion(), 'abono', '10.00').origen).toBe('manual')
  })
})

describe('combinarExtraccion', () => {
  it('re-extracción: reemplaza filas ia, conserva ia_editada en su lugar y las manuales tras su fila anterior', () => {
    const editada = editarCampo(fila('ia-a-2', 'h2', 'PAGO B', '200.00'), 'cargo', '250.00')
    const manual = { ...nuevaTransaccion(), concepto: 'COMISION CAPTURADA', cargo: '15.00' }
    const actual = [fila('ia-a-1', 'h1', 'PAGO A', '100.00'), editada, manual, fila('ia-a-3', 'h3', 'PAGO C', '300.00')]
    const nuevas = [fila('ia-1', 'h1', 'PAGO A (nuevo)', '100.00'), fila('ia-2', 'h2', 'PAGO B', '200.00'), fila('ia-3', 'h3', 'PAGO C', '300.00'), fila('ia-4', 'h4', 'PAGO D', '400.00')]

    const resultado = combinarExtraccion(actual, nuevas, 'b')

    expect(resultado.transacciones.map((t) => t.concepto)).toEqual(['PAGO A (nuevo)', 'PAGO B', 'COMISION CAPTURADA', 'PAGO C', 'PAGO D'])
    const conservada = resultado.transacciones[1]
    expect(conservada).toMatchObject({ id: editada.id, origen: 'ia_editada', cargo: '250.00' })
    expect(conservada.revision).toBeUndefined()
    expect(resultado.transacciones[2]).toBe(manual)
    expect(resultado.conservadas).toBe(2)
    expect(resultado.noAparecen).toBe(0)
    // Las filas nuevas reciben ids del lote para no chocar con los ids conservados.
    expect(new Set(resultado.transacciones.map((t) => t.id)).size).toBe(5)
    expect(resultado.transacciones[0].id).toBe('ia-b-1')
  })

  it('una fila ia_editada que desaparece se conserva marcada para revisión y se cuenta', () => {
    const editada = editarCampo(fila('ia-a-2', 'h2', 'PAGO B', '200.00'), 'concepto', 'PAGO B corregido')
    const actual = [fila('ia-a-1', 'h1', 'PAGO A', '100.00'), editada]
    const nuevas = [fila('ia-1', 'h1', 'PAGO A', '100.00')]

    const resultado = combinarExtraccion(actual, nuevas, 'b')

    expect(resultado.transacciones).toHaveLength(2)
    expect(resultado.transacciones[1]).toMatchObject({ id: editada.id, concepto: 'PAGO B corregido', origen: 'ia_editada', revision: 'no_aparece_en_extraccion' })
    expect(resultado.noAparecen).toBe(1)
    expect(resultado.conservadas).toBe(1)
  })

  it('con huellas repetidas empareja una a una y prioriza las filas editadas', () => {
    const editada = editarCampo(fila('ia-a-2', 'h', 'CUOTA', '10.00'), 'referencia', 'REF-2')
    const actual = [fila('ia-a-1', 'h', 'CUOTA', '10.00'), editada]
    const nuevas = [fila('ia-1', 'h', 'CUOTA', '10.00'), fila('ia-2', 'h', 'CUOTA', '10.00')]
    const resultado = combinarExtraccion(actual, nuevas, 'b')
    expect(resultado.transacciones).toHaveLength(2)
    expect(resultado.transacciones.filter((t) => t.origen === 'ia_editada')).toHaveLength(1)
    expect(resultado.noAparecen).toBe(0)
  })

  it('descarta filas manuales vacías y no las cuenta como correcciones', () => {
    const actual = [nuevaTransaccion()]
    expect(contarCorrecciones(actual)).toBe(0)
    const resultado = combinarExtraccion(actual, [fila('ia-1', 'h1', 'PAGO')], 'b')
    expect(resultado.transacciones.map((t) => t.concepto)).toEqual(['PAGO'])
    expect(resultado.conservadas).toBe(0)
  })
})
