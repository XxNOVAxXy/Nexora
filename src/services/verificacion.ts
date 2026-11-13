/**
 * Compara los datos reconocidos en el documento con lo capturado (resumen y movimientos) y da, por cada dato, su
 * recuadro y su estado: coincide, difiere, falta o no se captura (filas de saldo). Todo se calcula a partir del
 * documento editable, así que se recalcula con cada edición. Nada de esto se guarda.
 */
import type { CampoMonto, Resumen, Transaccion } from '../types'
import { esFilaDeSaldo, montoParaValidacion, normalizarMonto, type FormatoNumerico } from './contabilidad'
import { comparar } from './decimal'
import { CAMPOS_MONTO_MOVIMIENTO, CAMPOS_MONTO_RESUMEN_DOCUMENTO, normalizarEtiqueta, type CampoMovimientoDocumento, type CampoResumenDocumento, type DatosDocumento, type FilaDocumento, type Recuadro } from './deteccionDocumento'
import { esFilaVacia, nuevaTransaccion } from './transacciones'

export type EstadoVerificacion = 'coincide' | 'difiere' | 'falta' | 'no_se_captura'
export type CampoVerificable = CampoMovimientoDocumento | CampoResumenDocumento
export type MarcaVerificacion = {
  id: string
  /** 'texto': cualquier texto del documento, clicable para copiarlo a un dato del documento (RFC, etc.). */
  grupo: 'resumen' | 'movimientos' | 'texto'
  campo: CampoVerificable
  etiqueta: string
  textoDocumento: string
  valorCapturado: string
  estado: EstadoVerificacion
  recuadro: Recuadro
  /** Fila del documento (solo movimientos). */
  filaDocumento: number | null
  /** Movimiento capturado con el que se emparejó la fila (null si falta o es fila de saldo). */
  transaccionId: string | null
}
export type Conteo = { datos: number; coinciden: number; diferencias: number; faltantes: number }
export type ResultadoVerificacion = {
  marcas: MarcaVerificacion[]
  resumen: Conteo | null
  movimientos: Conteo | null
  filasDeSaldo: number
  /** Movimientos capturados que no aparecen en el documento (solo si la tabla se reconoció). */
  sinRespaldo: string[]
  /** Fila del documento → movimiento capturado. */
  emparejamiento: Map<number, string>
  formato: FormatoNumerico | null
}

export const ETIQUETA_CAMPO: Record<CampoVerificable, string> = {
  fecha: 'Fecha', concepto: 'Concepto', referencia: 'Referencia', cargo: 'Cargo', abono: 'Abono', saldo: 'Saldo',
  titular: 'Titular', cuenta: 'Cuenta', periodo: 'Periodo', moneda: 'Moneda', saldo_inicial: 'Saldo inicial', total_cargos: 'Total cargos', total_abonos: 'Total abonos', saldo_final: 'Saldo final',
}
export const ETIQUETA_ESTADO: Record<EstadoVerificacion, string> = { coincide: 'Coincide con el documento', difiere: 'Capturado con otro valor', falta: 'Falta capturar', no_se_captura: 'Fila de saldo, no se captura' }

export const esCampoMonto = (campo: string) => (CAMPOS_MONTO_MOVIMIENTO as string[]).includes(campo) || (CAMPOS_MONTO_RESUMEN_DOCUMENTO as string[]).includes(campo)

const textoComparable = (texto: string) => normalizarEtiqueta(texto)
const soloAlfanumerico = (texto: string) => textoComparable(texto).replace(/ /g, '')
const digitos = (texto: string) => texto.replace(/\D/g, '')

const MESES: Record<string, number> = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 }
/** Día, mes y (si viene) año de una fecha impresa o capturada; null si no se reconoce. */
function partesFecha(texto: string): { d: number; m: number; a: number | null } | null {
  const t = texto.trim().toLowerCase()
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  if (r) return { d: Number(r[3]), m: Number(r[2]), a: Number(r[1]) }
  r = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t)
  if (r) return { d: Number(r[1]), m: Number(r[2]), a: r[3] ? Number(r[3]) % 100 : null }
  r = /^(\d{1,2})[ /-]?([a-z]{3})[a-z]*\.?(?:[ /-]?(\d{2,4}))?$/.exec(t.normalize('NFD').replace(/\p{Mn}/gu, ''))
  if (r && MESES[r[2]]) return { d: Number(r[1]), m: MESES[r[2]], a: r[3] ? Number(r[3]) % 100 : null }
  return null
}

function mismaFecha(a: string, b: string): boolean {
  const pa = partesFecha(a)
  const pb = partesFecha(b)
  if (!pa || !pb) return soloAlfanumerico(a) === soloAlfanumerico(b)
  const anioA = pa.a === null ? null : pa.a % 100
  const anioB = pb.a === null ? null : pb.a % 100
  return pa.d === pb.d && pa.m === pb.m && (anioA === null || anioB === null || anioA === anioB)
}

function mismoMonto(campo: string, documento: string, capturado: string, formato: FormatoNumerico | null): boolean {
  const [valorDocumento] = montoParaValidacion(campo, documento, formato)
  const [valorCapturado] = montoParaValidacion(campo, capturado, formato)
  if (valorDocumento === null || valorCapturado === null) return soloAlfanumerico(documento) === soloAlfanumerico(capturado)
  return comparar(valorDocumento, valorCapturado) === 0
}

function mismaCuenta(documento: string, capturado: string): boolean {
  const a = digitos(documento)
  const b = digitos(capturado)
  if (!a || !b) return soloAlfanumerico(documento) === soloAlfanumerico(capturado)
  if (a === b) return true
  // Cuentas enmascaradas ("****1234"): basta con que coincidan los últimos dígitos visibles.
  const enmascarada = /[*x•]/i.test(documento) || /[*x•]/i.test(capturado)
  return enmascarada && Math.min(a.length, b.length) >= 4 && (a.endsWith(b) || b.endsWith(a))
}

/** ¿El valor capturado coincide con el del documento para este campo? */
export function mismoValor(campo: CampoVerificable, documento: string, capturado: string, formato: FormatoNumerico | null): boolean {
  if (esCampoMonto(campo)) return mismoMonto(campo, documento, capturado, formato)
  if (campo === 'fecha') return mismaFecha(documento, capturado)
  if (campo === 'cuenta') return mismaCuenta(documento, capturado)
  if (campo === 'referencia') return soloAlfanumerico(documento) === soloAlfanumerico(capturado)
  return textoComparable(documento) === textoComparable(capturado)
}

function estadoDe(campo: CampoVerificable, documento: string, capturado: string, formato: FormatoNumerico | null): EstadoVerificacion {
  if (!capturado.trim()) return 'falta'
  return mismoValor(campo, documento, capturado, formato) ? 'coincide' : 'difiere'
}

function similitudConcepto(a: string, b: string): number {
  const pa = new Set(textoComparable(a).split(' ').filter(Boolean))
  const pb = new Set(textoComparable(b).split(' ').filter(Boolean))
  if (pa.size === 0 || pb.size === 0) return 0
  let comunes = 0
  for (const palabra of pa) if (pb.has(palabra)) comunes += 1
  return comunes / Math.max(pa.size, pb.size)
}

/** Puntaje de una fila del documento contra un movimiento capturado; null si no hay base para emparejarlos. */
function puntaje(fila: FilaDocumento, transaccion: Transaccion, formato: FormatoNumerico | null): number | null {
  const celda = (campo: CampoMovimientoDocumento) => fila.celdas[campo]?.texto ?? ''
  const igual = (campo: CampoMovimientoDocumento) => Boolean(celda(campo)) && Boolean(transaccion[campo].trim()) && mismoValor(campo, celda(campo), transaccion[campo], formato)
  const importe = igual('cargo') || igual('abono')
  const fecha = igual('fecha')
  const saldo = igual('saldo')
  const referencia = igual('referencia')
  const concepto = celda('concepto') && transaccion.concepto ? similitudConcepto(celda('concepto'), transaccion.concepto) : 0
  if (!importe && !(fecha && (concepto >= 0.5 || referencia || saldo)) && !(referencia && concepto >= 0.5)) return null
  return (importe ? 4 : 0) + (saldo ? 2 : 0) + (fecha ? 2 : 0) + (referencia ? 2 : 0) + 2 * concepto
}

/** Empareja uno a uno, del mejor puntaje al peor; ante empate, el más cercano en el orden del documento. */
function emparejar(filas: FilaDocumento[], transacciones: Transaccion[], formato: FormatoNumerico | null): Map<number, string> {
  const candidatas = transacciones.filter((transaccion) => !esFilaVacia(transaccion) && !esFilaDeSaldo(transaccion.concepto))
  const filasMovimiento = filas.filter((fila) => !fila.esSaldo)
  const pares: { fila: number; id: string; valor: number }[] = []
  filasMovimiento.forEach((fila, posicionFila) => {
    candidatas.forEach((transaccion, posicion) => {
      const valor = puntaje(fila, transaccion, formato)
      if (valor !== null) pares.push({ fila: fila.indice, id: transaccion.id, valor: valor - 0.001 * Math.abs(posicionFila - posicion) })
    })
  })
  pares.sort((a, b) => b.valor - a.valor)
  const resultado = new Map<number, string>()
  const usados = new Set<string>()
  for (const par of pares) {
    if (resultado.has(par.fila) || usados.has(par.id)) continue
    resultado.set(par.fila, par.id)
    usados.add(par.id)
  }
  return resultado
}

const conteoDe = (marcas: MarcaVerificacion[]): Conteo => {
  const contadas = marcas.filter((marca) => marca.estado !== 'no_se_captura')
  return {
    datos: contadas.length,
    coinciden: contadas.filter((marca) => marca.estado === 'coincide').length,
    diferencias: contadas.filter((marca) => marca.estado === 'difiere').length,
    faltantes: contadas.filter((marca) => marca.estado === 'falta').length,
  }
}

export type DocumentoVerificable = { resumen: Resumen | null; transacciones: Transaccion[]; formato_numerico: FormatoNumerico | null }

export function verificar(datos: DatosDocumento, documento: DocumentoVerificable): ResultadoVerificacion {
  const formato = documento.formato_numerico ?? datos.formatoDetectado
  const marcas: MarcaVerificacion[] = []

  if (datos.resumenReconocido) {
    for (const dato of datos.resumen) {
      const capturado = documento.resumen?.[dato.campo] ?? ''
      marcas.push({ id: `resumen-${dato.campo}`, grupo: 'resumen', campo: dato.campo, etiqueta: ETIQUETA_CAMPO[dato.campo], textoDocumento: dato.texto, valorCapturado: capturado, estado: estadoDe(dato.campo, dato.texto, capturado, formato), recuadro: dato.recuadro, filaDocumento: null, transaccionId: null })
    }
  }

  const emparejamiento = datos.tablaReconocida ? emparejar(datos.filas, documento.transacciones, formato) : new Map<number, string>()
  const porId = new Map(documento.transacciones.map((transaccion) => [transaccion.id, transaccion]))
  if (datos.tablaReconocida) {
    for (const fila of datos.filas) {
      const id = emparejamiento.get(fila.indice) ?? null
      const transaccion = id ? porId.get(id) ?? null : null
      for (const celda of Object.values(fila.celdas)) {
        if (!celda) continue
        const capturado = transaccion ? transaccion[celda.campo] : ''
        const estado: EstadoVerificacion = fila.esSaldo ? 'no_se_captura' : estadoDe(celda.campo, celda.texto, capturado, formato)
        marcas.push({ id: `fila-${fila.indice}-${celda.campo}`, grupo: 'movimientos', campo: celda.campo, etiqueta: ETIQUETA_CAMPO[celda.campo], textoDocumento: celda.texto, valorCapturado: capturado, estado, recuadro: celda.recuadro, filaDocumento: fila.indice, transaccionId: id })
      }
    }
  }

  const emparejados = new Set(emparejamiento.values())
  const sinRespaldo = datos.tablaReconocida
    ? documento.transacciones.filter((transaccion) => !esFilaVacia(transaccion) && !esFilaDeSaldo(transaccion.concepto) && !emparejados.has(transaccion.id)).map((transaccion) => transaccion.id)
    : []
  return {
    marcas,
    resumen: datos.resumenReconocido ? conteoDe(marcas.filter((marca) => marca.grupo === 'resumen')) : null,
    movimientos: datos.tablaReconocida ? conteoDe(marcas.filter((marca) => marca.grupo === 'movimientos')) : null,
    filasDeSaldo: datos.filas.filter((fila) => fila.esSaldo).length,
    sinRespaldo,
    emparejamiento,
    formato,
  }
}

const plural = (n: number, singular: string, varios: string) => `${n} ${n === 1 ? singular : varios}`
/** "15 datos en el documento · 13 coinciden · 1 con diferencia · 1 faltante" */
export const textoConteo = (conteo: Conteo) =>
  `${plural(conteo.datos, 'dato', 'datos')} en el documento · ${conteo.coinciden} ${conteo.coinciden === 1 ? 'coincide' : 'coinciden'} · ${conteo.diferencias} con diferencia · ${plural(conteo.faltantes, 'faltante', 'faltantes')}`

// --- Clic para capturar -----------------------------------------------------------------------------------------

export type ValorCaptura = { ok: true; valor: string } | { ok: false; mensaje: string }

/** Valor a copiar en un campo desde el texto del documento; los importes se normalizan con el parser de importes. */
export function valorParaCaptura(campo: string, texto: string, formato: FormatoNumerico | null): ValorCaptura {
  const limpio = texto.trim()
  if (!esCampoMonto(campo)) return { ok: true, valor: limpio }
  const [normalizado, valor, dudoso] = normalizarMonto(campo, limpio, formato)
  if (valor === null) return { ok: false, mensaje: `No se pudo interpretar «${limpio}» como importe.` }
  if (dudoso) return { ok: false, mensaje: `El importe «${limpio}» es ambiguo para ${ETIQUETA_CAMPO[campo as CampoVerificable]?.toLowerCase() ?? campo}; captúralo a mano.` }
  return { ok: true, valor: normalizado }
}

/** ¿Se puede copiar un dato de este campo del documento a este campo capturado? Importe con importe, fecha con fecha. */
export function compatibles(destino: string, origen: CampoVerificable): boolean {
  if (esCampoMonto(destino) || esCampoMonto(origen)) return esCampoMonto(destino) && esCampoMonto(origen)
  if (destino === 'fecha' || origen === 'fecha') return destino === 'fecha' && origen === 'fecha'
  return true
}

/** Movimiento manual con los datos de una fila del documento (los importes normalizados; los que no, quedan dudosos). */
export function movimientoDesdeFila(fila: FilaDocumento, formato: FormatoNumerico | null): Transaccion {
  const transaccion = nuevaTransaccion()
  for (const campo of ['fecha', 'concepto', 'referencia'] as const) transaccion[campo] = fila.celdas[campo]?.texto ?? ''
  for (const campo of CAMPOS_MONTO_MOVIMIENTO as CampoMonto[]) {
    const texto = fila.celdas[campo]?.texto
    if (!texto) continue
    const [normalizado, valor, dudoso] = normalizarMonto(campo, texto, formato)
    transaccion[campo] = normalizado
    if (valor === null || dudoso) transaccion.dudosos = [...transaccion.dudosos, campo]
  }
  return transaccion
}

/** Posición donde insertar el movimiento de una fila del documento: tras el de la fila emparejada anterior. */
export function posicionParaInsertar(indiceFila: number, emparejamiento: Map<number, string>, transacciones: Transaccion[]): number {
  const posicion = (id: string | undefined) => (id ? transacciones.findIndex((transaccion) => transaccion.id === id) : -1)
  for (let indice = indiceFila - 1; indice >= 0; indice -= 1) {
    const encontrada = posicion(emparejamiento.get(indice))
    if (encontrada >= 0) return encontrada + 1
  }
  const siguientes = [...emparejamiento.entries()].filter(([indice]) => indice > indiceFila).sort((a, b) => a[0] - b[0])
  for (const [, id] of siguientes) {
    const encontrada = posicion(id)
    if (encontrada >= 0) return encontrada
  }
  return transacciones.length
}
