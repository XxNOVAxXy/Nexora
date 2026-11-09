import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { construirPdf, type LineaPdf } from '../pruebas/pdfSintetico'
import { detectarDatos } from './deteccionDocumento'
import { extraerPaginas, tieneCapaDeTexto, type DocumentoPdf, type PaginaTexto } from './textoPdf'

import { readFileSync } from 'node:fs'

async function leerPdf(datos: Uint8Array): Promise<PaginaTexto[]> {
  const pdf = await getDocument({ data: new Uint8Array(datos), verbosity: 0 }).promise
  return extraerPaginas(pdf as unknown as DocumentoPdf)
}
const ficticio = () => leerPdf(readFileSync(new URL('../../backend/tests/fixtures/estado_cuenta_ficticio.pdf', import.meta.url)))
const fragmentos = (lineas: LineaPdf[]): PaginaTexto => ({
  numero: 1, ancho: 612, alto: 842,
  // Ancho aproximado de Helvetica: medio cuerpo por carácter.
  fragmentos: lineas.map(([x, y, t, texto]) => ({ texto, x, y: 842 - y - t * 0.9, ancho: texto.length * t * 0.5, alto: t * 1.15 })),
})

describe('detección de datos en el PDF ficticio', () => {
  it('lee el texto con coordenadas de página', async () => {
    const paginas = await ficticio()
    expect(paginas).toHaveLength(1)
    expect(paginas[0]).toMatchObject({ numero: 1, ancho: 612, alto: 842 })
    expect(tieneCapaDeTexto(paginas)).toBe(true)
    const referencia = paginas[0].fragmentos.find((fragmento) => fragmento.texto === 'REF-0001')!
    // El generador dibuja REF-0001 en x=300, línea base y=630 (origen abajo): en pantalla, y≈842-630.
    expect(referencia.x).toBeCloseTo(300, 0)
    expect(referencia.y + referencia.alto).toBeGreaterThan(842 - 630)
    expect(referencia.y).toBeLessThan(842 - 630)
  })

  it('reconoce el resumen, los 15 movimientos y la fila de saldo, con sus recuadros', async () => {
    const datos = detectarDatos(await ficticio())
    expect(datos.tablaReconocida).toBe(true)
    expect(datos.resumenReconocido).toBe(true)
    expect(datos.formatoDetectado).toBe('us')
    expect(Object.fromEntries(datos.resumen.map((dato) => [dato.campo, dato.texto]))).toEqual({
      titular: 'CLIENTE DE PRUEBA NEXORA',
      cuenta: '0000-0000-0000-1234',
      periodo: '01/10/2026 AL 31/10/2026',
      moneda: 'MXN',
      saldo_inicial: '25,000.00',
      total_cargos: '25,379.75',
      total_abonos: '30,935.40',
      saldo_final: '30,555.65',
    })
    // El saldo inicial del resumen es el del bloque de totales (x=510 en la línea de "SALDO INICIAL" de los totales).
    const saldoInicial = datos.resumen.find((dato) => dato.campo === 'saldo_inicial')!
    expect(saldoInicial.recuadro.x).toBeCloseTo(510, 0)

    const saldo = datos.filas.filter((fila) => fila.esSaldo)
    expect(saldo).toHaveLength(1)
    expect(saldo[0].celdas.concepto?.texto).toBe('SALDO INICIAL')
    const movimientos = datos.filas.filter((fila) => !fila.esSaldo)
    expect(movimientos).toHaveLength(15)
    const texto = (indice: number) => Object.fromEntries(Object.entries(movimientos[indice].celdas).map(([campo, celda]) => [campo, celda!.texto]))
    expect(texto(0)).toEqual({ fecha: '02/10/2026', concepto: 'TRANSFERENCIA RECIBIDA', referencia: 'REF-0001', abono: '12,000.00', saldo: '37,000.00' })
    expect(texto(1)).toEqual({ fecha: '03/10/2026', concepto: 'PAGO A PROVEEDOR', referencia: 'REF-0002', cargo: '4,250.00', saldo: '32,750.00' })
    expect(texto(14)).toMatchObject({ concepto: 'IVA COMISION', cargo: '24.00', saldo: '30,555.65' })
    expect(movimientos[1].celdas.cargo!.recuadro).toMatchObject({ pagina: 1 })
    expect(movimientos[1].celdas.cargo!.recuadro.x).toBeCloseTo(380, 0)
  })

  it('un PDF sin capa de texto (escaneado) se reconoce como tal y no falla', async () => {
    const paginas = await leerPdf(construirPdf([null]))
    expect(tieneCapaDeTexto(paginas)).toBe(false)
    expect(detectarDatos(paginas)).toMatchObject({ tablaReconocida: false, resumenReconocido: false, filas: [], resumen: [] })
  })

  it('un PDF con texto pero sin encabezado ni etiquetas reconocibles no inventa datos', async () => {
    const paginas = await leerPdf(construirPdf([[
      [50, 790, 12, 'INFORME MENSUAL DE ACTIVIDADES'],
      [50, 760, 9, 'Lote 7 de 12 enviado al almacen central'],
      [50, 745, 9, '02/10/2026 Entrega parcial 1,200.00'],
      [50, 730, 9, 'Observaciones generales del periodo de trabajo'],
    ]]))
    expect(tieneCapaDeTexto(paginas)).toBe(true)
    const datos = detectarDatos(paginas)
    expect(datos.tablaReconocida).toBe(false)
    expect(datos.resumenReconocido).toBe(false)
    expect(datos.filas).toEqual([])
  })
})

describe('detección: disposiciones de otros bancos', () => {
  it('importes alineados a la derecha, concepto en dos líneas y formato europeo', () => {
    const datos = detectarDatos([fragmentos([
      [40, 700, 9, 'Fecha'], [100, 700, 9, 'Descripción'], [330, 700, 9, 'Débitos'], [420, 700, 9, 'Créditos'], [510, 700, 9, 'Saldo'],
      [40, 685, 8, '02-oct'], [100, 685, 8, 'TRANSFERENCIA SPEI'], [330, 685, 8, '1.250,00'], [500, 685, 8, '8.750,00'],
      [100, 675, 8, 'A FAVOR DE PROVEEDOR'],
      [40, 660, 8, '05-oct'], [100, 660, 8, 'DEPOSITO'], [425, 660, 8, '300,00'], [500, 660, 8, '9.050,00'],
      [100, 630, 9, 'Saldo final'], [500, 630, 9, '9.050,00'],
    ])])
    expect(datos.tablaReconocida).toBe(true)
    expect(datos.formatoDetectado).toBe('eu')
    // "Saldo final" en la columna de concepto es una fila de saldo: se reconoce, pero no es un movimiento.
    expect(datos.filas.map((fila) => fila.esSaldo)).toEqual([false, false, true])
    expect(datos.filas[0].celdas.concepto?.texto).toBe('TRANSFERENCIA SPEI A FAVOR DE PROVEEDOR')
    expect(datos.filas[0].celdas.cargo?.texto).toBe('1.250,00')
    expect(datos.filas[1].celdas.abono?.texto).toBe('300,00')
    expect(datos.filas[1].celdas.saldo?.texto).toBe('9.050,00')
  })

  it('el encabezado repetido en cada página sigue la misma tabla', () => {
    const encabezado: LineaPdf[] = [[50, 760, 9, 'FECHA'], [115, 760, 9, 'CONCEPTO'], [380, 760, 9, 'CARGO'], [445, 760, 9, 'ABONO'], [510, 760, 9, 'SALDO']]
    const pagina1 = fragmentos([...encabezado, [50, 745, 8, '01/10/2026'], [115, 745, 8, 'PAGO'], [380, 745, 8, '10.00'], [510, 745, 8, '90.00']])
    const pagina2 = { ...fragmentos([...encabezado, [50, 745, 8, '02/10/2026'], [115, 745, 8, 'DEPOSITO'], [445, 745, 8, '5.00'], [510, 745, 8, '95.00']]), numero: 2 }
    const datos = detectarDatos([pagina1, pagina2])
    expect(datos.filas.map((fila) => [fila.celdas.concepto?.texto, fila.celdas.cargo?.recuadro.pagina ?? fila.celdas.abono?.recuadro.pagina])).toEqual([['PAGO', 1], ['DEPOSITO', 2]])
  })
})
