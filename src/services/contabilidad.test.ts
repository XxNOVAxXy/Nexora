import { describe, expect, it } from 'vitest'
import casosJson from '../../backend/tests/fixtures/contabilidad_casos.json'
import { esFilaDeSaldo, parseMoney, validarContabilidad, type FormatoNumerico, type MovimientoValidable, type ResumenValidable } from './contabilidad'
import { comparar, decimal } from './decimal'

// Mismos casos que backend/tests/test_contabilidad_compartida.py.
type Casos = {
  parse_money: { texto: string; formato: FormatoNumerico | null; valor: string | null; dudoso: boolean; indicador: 'cargo' | 'abono' | null }[]
  fila_de_saldo: { concepto: string; esperado: boolean }[]
  validacion: {
    nombre: string
    formato: FormatoNumerico | null
    resumen: ResumenValidable
    transacciones: MovimientoValidable[]
    esperado: {
      cuadra: boolean | null
      suma_cargos: string | null
      suma_abonos: string | null
      comprobaciones: Record<string, { estado: string; diferencia: string | null }>
      filas_discontinuas: unknown[]
      filas_excluidas: string[]
      importes_invalidos: unknown[]
    }
  }[]
}
const casos = casosJson as unknown as Casos

describe('casos contables compartidos con el backend', () => {
  it.each(casos.parse_money)('parseMoney($texto, $formato)', (caso) => {
    const resultado = parseMoney(caso.texto, caso.formato)
    if (caso.valor === null) expect(resultado.valor).toBeNull()
    else {
      expect(resultado.valor).not.toBeNull()
      expect(comparar(resultado.valor!, decimal(caso.valor))).toBe(0)
    }
    expect(resultado.dudoso).toBe(caso.dudoso)
    expect(resultado.indicador).toBe(caso.indicador)
  })

  it.each(casos.fila_de_saldo)('esFilaDeSaldo($concepto)', (caso) => {
    expect(esFilaDeSaldo(caso.concepto)).toBe(caso.esperado)
  })

  it.each(casos.validacion)('validación: $nombre', (caso) => {
    const resultado = validarContabilidad(caso.resumen, caso.transacciones, caso.formato)
    const esperado = caso.esperado
    expect(resultado.cuadra).toBe(esperado.cuadra)
    expect(resultado.suma_cargos).toBe(esperado.suma_cargos)
    expect(resultado.suma_abonos).toBe(esperado.suma_abonos)
    expect(Object.fromEntries(resultado.comprobaciones.map((item) => [item.id, { estado: item.estado, diferencia: item.diferencia }]))).toEqual(esperado.comprobaciones)
    expect(resultado.filas_discontinuas).toEqual(esperado.filas_discontinuas)
    expect(resultado.filas_excluidas).toEqual(esperado.filas_excluidas)
    expect(resultado.importes_invalidos).toEqual(esperado.importes_invalidos)
    expect(resultado.tolerancia).toBe('0.01')
  })
})
