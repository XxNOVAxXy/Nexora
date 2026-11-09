import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { Resumen, Transaccion } from '../types'
import { construirPdf } from '../pruebas/pdfSintetico'
import { detectarDatos, type DatosDocumento } from './deteccionDocumento'
import { extraerPaginas, type DocumentoPdf } from './textoPdf'
import { editarCampo } from './transacciones'
import { compatibles, movimientoDesdeFila, posicionParaInsertar, textoConteo, valorParaCaptura, verificar, type DocumentoVerificable } from './verificacion'

import { readFileSync } from 'node:fs'
const leer = async (datos: Uint8Array) => detectarDatos(await extraerPaginas(await getDocument({ data: new Uint8Array(datos), verbosity: 0 }).promise as unknown as DocumentoPdf))
const datosFicticio: DatosDocumento = await leer(readFileSync(new URL('../../backend/tests/fixtures/estado_cuenta_ficticio.pdf', import.meta.url)))

const resumenCapturado: Resumen = {
  banco: 'BANCO FICTICIO DE PRUEBA S.A.', titular: 'Cliente de Prueba Nexora', cuenta: '0000000000001234', periodo: '01/10/2026 al 31/10/2026', moneda: 'MXN',
  saldo_inicial: '25000.00', total_cargos: '25379.75', total_abonos: '30935.40', saldo_final: '30555.65', dudosos: [],
}
/** Lo que capturaría la IA: los 15 movimientos del documento con importes normalizados y fechas en ISO. */
const capturadoCompleto = (): Transaccion[] => datosFicticio.filas.filter((fila) => !fila.esSaldo).map((fila, indice) => {
  const [d, m, a] = fila.celdas.fecha!.texto.split('/')
  const monto = (campo: 'cargo' | 'abono' | 'saldo') => (fila.celdas[campo]?.texto ?? '').replace(/,/g, '')
  return { id: `ia-${indice}`, fecha: `${a}-${m}-${d}`, concepto: fila.celdas.concepto!.texto, referencia: fila.celdas.referencia!.texto, cargo: monto('cargo'), abono: monto('abono'), saldo: monto('saldo'), origen: 'ia', dudosos: [] }
})
const documento = (transacciones: Transaccion[], resumen: Resumen | null = resumenCapturado): DocumentoVerificable => ({ resumen, transacciones, formato_numerico: null })
const marca = (resultado: ReturnType<typeof verificar>, id: string) => resultado.marcas.find((item) => item.id === id)!

describe('comparación con lo capturado', () => {
  it('todo coincide: fechas en otro formato, mayúsculas, cuenta sin guiones e importes normalizados', () => {
    const resultado = verificar(datosFicticio, documento(capturadoCompleto()))
    expect(resultado.resumen).toEqual({ datos: 8, coinciden: 8, diferencias: 0, faltantes: 0 })
    expect(resultado.movimientos).toEqual({ datos: 75, coinciden: 75, diferencias: 0, faltantes: 0 })
    expect(resultado.sinRespaldo).toEqual([])
    expect(textoConteo(resultado.movimientos!)).toBe('75 datos en el documento · 75 coinciden · 0 con diferencia · 0 faltantes')
  })

  it('difiere: el importe capturado no es el del documento', () => {
    const transacciones = capturadoCompleto()
    transacciones[1].cargo = '4205.00'
    const resultado = verificar(datosFicticio, documento(transacciones, { ...resumenCapturado, saldo_final: '30555.66' }))
    // La fila sigue emparejada por fecha, concepto y saldo.
    expect(marca(resultado, 'fila-2-cargo')).toMatchObject({ estado: 'difiere', textoDocumento: '4,250.00', valorCapturado: '4205.00', transaccionId: 'ia-1' })
    expect(marca(resultado, 'fila-2-concepto').estado).toBe('coincide')
    expect(marca(resultado, 'resumen-saldo_final').estado).toBe('difiere')
    expect(resultado.movimientos).toMatchObject({ coinciden: 74, diferencias: 1, faltantes: 0 })
  })

  it('falta: un movimiento no capturado deja su fila en rojo y una celda vacía también cuenta', () => {
    const transacciones = capturadoCompleto().filter((transaccion) => transaccion.id !== 'ia-4')
    transacciones[0].referencia = ''
    const resultado = verificar(datosFicticio, documento(transacciones, null))
    const faltante = resultado.marcas.filter((item) => item.filaDocumento === 5)
    expect(faltante.map((item) => item.estado)).toEqual(['falta', 'falta', 'falta', 'falta', 'falta'])
    expect(faltante.every((item) => item.transaccionId === null)).toBe(true)
    expect(marca(resultado, 'fila-1-referencia')).toMatchObject({ estado: 'falta', transaccionId: 'ia-0' })
    expect(resultado.movimientos).toEqual({ datos: 75, coinciden: 69, diferencias: 0, faltantes: 6 })
    // Sin resumen capturado, sus 8 datos faltan.
    expect(resultado.resumen).toEqual({ datos: 8, coinciden: 0, diferencias: 0, faltantes: 8 })
  })

  it('la fila de saldo se marca en gris y no cuenta como dato ni como faltante', () => {
    const resultado = verificar(datosFicticio, documento([]))
    const saldo = resultado.marcas.filter((item) => item.filaDocumento === 0)
    expect(saldo.map((item) => item.campo)).toEqual(['fecha', 'concepto', 'saldo'])
    expect(saldo.every((item) => item.estado === 'no_se_captura')).toBe(true)
    expect(resultado.filasDeSaldo).toBe(1)
    expect(resultado.movimientos).toEqual({ datos: 75, coinciden: 0, diferencias: 0, faltantes: 75 })
  })

  it('movimientos capturados que no aparecen en el documento (las filas de saldo y vacías no cuentan)', () => {
    const transacciones = [
      ...capturadoCompleto(),
      { id: 'extra', fecha: '15/10/2026', concepto: 'CARGO INVENTADO', referencia: '', cargo: '99.00', abono: '', saldo: '', origen: 'manual', dudosos: [] } as Transaccion,
      { id: 'saldo', fecha: '01/10/2026', concepto: 'SALDO INICIAL', referencia: '', cargo: '', abono: '', saldo: '25000.00', origen: 'ia', dudosos: [] } as Transaccion,
      { id: 'vacia', fecha: '', concepto: '', referencia: '', cargo: '', abono: '', saldo: '', origen: 'manual', dudosos: [] } as Transaccion,
    ]
    expect(verificar(datosFicticio, documento(transacciones)).sinRespaldo).toEqual(['extra'])
  })

  it('el conteo se recalcula al editar la tabla', () => {
    const transacciones = capturadoCompleto()
    expect(verificar(datosFicticio, documento(transacciones)).movimientos?.diferencias).toBe(0)
    const editadas = transacciones.map((transaccion) => (transaccion.id === 'ia-2' ? editarCampo(transaccion, 'saldo', '1.00') : transaccion))
    const despues = verificar(datosFicticio, documento(editadas))
    expect(despues.movimientos).toMatchObject({ coinciden: 74, diferencias: 1 })
    expect(textoConteo(despues.movimientos!)).toBe('75 datos en el documento · 74 coinciden · 1 con diferencia · 0 faltantes')
    const corregidas = editadas.map((transaccion) => (transaccion.id === 'ia-2' ? editarCampo(transaccion, 'saldo', '32600.00') : transaccion))
    expect(verificar(datosFicticio, documento(corregidas)).movimientos?.diferencias).toBe(0)
  })

  it('sin tabla ni etiquetas reconocibles no marca nada en rojo', async () => {
    const datos = await leer(construirPdf([[[50, 790, 12, 'INFORME MENSUAL DE ACTIVIDADES'], [50, 745, 9, '02/10/2026 Entrega parcial 1,200.00'], [50, 730, 9, 'Observaciones generales del periodo']]]))
    const resultado = verificar(datos, documento([], null))
    expect(resultado.marcas).toEqual([])
    expect(resultado.resumen).toBeNull()
    expect(resultado.movimientos).toBeNull()
    expect(resultado.sinRespaldo).toEqual([])
  })
})

describe('clic para capturar', () => {
  it('normaliza los importes con el parser de importes y copia el texto tal cual', () => {
    expect(valorParaCaptura('cargo', '4,250.00', 'us')).toEqual({ ok: true, valor: '4250.00' })
    expect(valorParaCaptura('saldo_final', '30.555,65', 'eu')).toEqual({ ok: true, valor: '30555.65' })
    expect(valorParaCaptura('concepto', '  PAGO A PROVEEDOR ', 'us')).toEqual({ ok: true, valor: 'PAGO A PROVEEDOR' })
    expect(valorParaCaptura('cargo', 'REF-0002', 'us').ok).toBe(false)
    expect(compatibles('cargo', 'saldo')).toBe(true)
    expect(compatibles('cargo', 'concepto')).toBe(false)
    expect(compatibles('fecha', 'fecha')).toBe(true)
    expect(compatibles('titular', 'concepto')).toBe(true)
  })

  it('arma el movimiento faltante con sus datos y lo inserta en el orden del documento', () => {
    const transacciones = capturadoCompleto().filter((transaccion) => transaccion.id !== 'ia-4')
    const resultado = verificar(datosFicticio, documento(transacciones))
    const fila = datosFicticio.filas[5]
    const nuevo = movimientoDesdeFila(fila, resultado.formato)
    expect(nuevo).toMatchObject({ fecha: '09/10/2026', concepto: 'PAGO DE SERVICIOS', referencia: 'REF-0005', cargo: '1875.50', abono: '', saldo: '37474.50', origen: 'manual', dudosos: [] })
    // Va justo después del movimiento de la fila 4 del documento (ia-3, en la posición 3).
    expect(posicionParaInsertar(5, resultado.emparejamiento, transacciones)).toBe(4)
    const conNuevo = [...transacciones.slice(0, 4), nuevo, ...transacciones.slice(4)]
    expect(verificar(datosFicticio, documento(conNuevo)).movimientos?.faltantes).toBe(0)
  })
})
