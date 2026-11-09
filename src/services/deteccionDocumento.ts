/**
 * Datos de un estado de cuenta reconocidos en el texto del PDF, cada uno con su recuadro en la página.
 *
 * Se reconoce por la disposición del texto, no por el banco: líneas a la misma altura, el encabezado de la tabla de
 * movimientos (sus títulos definen las columnas) y etiquetas del resumen ("TITULAR:", "SALDO FINAL"…). Si algo no se
 * reconoce se informa como no reconocido, para no marcar como faltante lo que simplemente no se supo leer.
 */
import { detectarFormato, esFilaDeSaldo, type FormatoNumerico } from './contabilidad'
import type { PaginaTexto } from './textoPdf'

export type Recuadro = { pagina: number; x: number; y: number; ancho: number; alto: number }
export type CampoMovimientoDocumento = 'fecha' | 'concepto' | 'referencia' | 'cargo' | 'abono' | 'saldo'
export type CampoResumenDocumento = 'titular' | 'cuenta' | 'periodo' | 'moneda' | 'saldo_inicial' | 'total_cargos' | 'total_abonos' | 'saldo_final'
export type CeldaDocumento = { campo: CampoMovimientoDocumento; texto: string; recuadro: Recuadro }
export type FilaDocumento = { indice: number; esSaldo: boolean; celdas: Partial<Record<CampoMovimientoDocumento, CeldaDocumento>> }
export type DatoResumenDocumento = { campo: CampoResumenDocumento; texto: string; recuadro: Recuadro }
export type DatosDocumento = {
  tablaReconocida: boolean
  resumenReconocido: boolean
  filas: FilaDocumento[]
  resumen: DatoResumenDocumento[]
  /** Formato numérico de los importes impresos (null si no se pudo decidir). */
  formatoDetectado: FormatoNumerico | null
}

export const CAMPOS_MONTO_MOVIMIENTO: CampoMovimientoDocumento[] = ['cargo', 'abono', 'saldo']
export const CAMPOS_MONTO_RESUMEN_DOCUMENTO: CampoResumenDocumento[] = ['saldo_inicial', 'total_cargos', 'total_abonos', 'saldo_final']

type Segmento = { id: number; texto: string; x: number; y: number; ancho: number; alto: number; pagina: number }
type Linea = { pagina: number; centro: number; alto: number; segmentos: Segmento[] }
type Columna = { campo: CampoMovimientoDocumento; x0: number; x1: number }

/** Minúsculas, sin acentos, sin puntuación y con espacios simples: "No. de Cuenta:" → "no de cuenta". */
export function normalizarEtiqueta(texto: string): string {
  return texto.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const ENCABEZADOS: [CampoMovimientoDocumento, RegExp][] = [
  ['fecha', /^(fecha( (de )?(operacion|oper|valor|liquidacion|movimiento|aplicacion))?|dia|f oper(acion)?)$/],
  ['concepto', /^(concepto|conceptos|descripcion|detalle|descripcion del movimiento|concepto del movimiento|movimiento|movimientos)$/],
  ['referencia', /^(referencia|ref|no ref|no de referencia|numero de referencia|referencia numerica|folio|no de folio)$/],
  ['cargo', /^(cargos?|retiros?|debitos?)$/],
  ['abono', /^(abonos?|depositos?|creditos?)$/],
  ['saldo', /^(saldos?|saldo (de )?(operacion|liquidacion))$/],
]

const ETIQUETAS_RESUMEN: [CampoResumenDocumento, RegExp][] = [
  ['titular', /^(titular|nombre|nombre del (cliente|titular)|cliente)$/],
  ['cuenta', /^(cuenta|no de cuenta|no cuenta|numero de cuenta|num de cuenta|n de cuenta|cuenta no|cuenta numero)$/],
  ['periodo', /^(periodo|periodo del estado de cuenta|periodo de consulta)$/],
  ['moneda', /^(moneda|divisa|tipo de moneda)$/],
  ['saldo_inicial', /^(saldo (inicial|anterior|previo)( del periodo)?)$/],
  ['total_cargos', /^(total(es)? (de )?(cargos|retiros|debitos))$/],
  ['total_abonos', /^(total(es)? (de )?(abonos|depositos|creditos))$/],
  ['saldo_final', /^(saldo (final|al corte|actual)( del periodo)?|nuevo saldo)$/],
]

const MESES = '(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\\.?'
const FECHA = new RegExp(`^(\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[ /-]?${MESES}([ /-]?\\d{2,4})?)$`, 'i')
/** Un importe impreso: dígitos con separadores y dos decimales, con signo, $, paréntesis o indicador opcionales. */
const IMPORTE = /^[-+(]?\s?\$?\s?\d{1,3}([.,' ]?\d{3})*[.,]\d{2}\s?\)?\s?(-|cr|db|cargo|abono)?$/i

export const esFecha = (texto: string) => FECHA.test(texto.trim())
export const esImporte = (texto: string) => IMPORTE.test(texto.trim())

/** Agrupa los fragmentos en líneas (misma altura) y une los que están casi pegados dentro de una línea. */
function lineasDePagina(pagina: PaginaTexto, siguienteId: () => number): Linea[] {
  const fragmentos = [...pagina.fragmentos].sort((a, b) => a.y + a.alto / 2 - (b.y + b.alto / 2) || a.x - b.x)
  const lineas: { centro: number; alto: number; fragmentos: typeof fragmentos }[] = []
  for (const fragmento of fragmentos) {
    const centro = fragmento.y + fragmento.alto / 2
    const linea = lineas.find((candidata) => Math.abs(candidata.centro - centro) <= Math.min(candidata.alto, fragmento.alto) * 0.45)
    if (linea) linea.fragmentos.push(fragmento)
    else lineas.push({ centro, alto: fragmento.alto, fragmentos: [fragmento] })
  }
  return lineas.sort((a, b) => a.centro - b.centro).map((linea) => {
    const ordenados = linea.fragmentos.sort((a, b) => a.x - b.x)
    const segmentos: Segmento[] = []
    for (const fragmento of ordenados) {
      const previo = segmentos[segmentos.length - 1]
      const hueco = previo ? fragmento.x - (previo.x + previo.ancho) : Infinity
      // Un hueco menor a media letra es la misma palabra o frase partida por el PDF; uno mayor separa columnas.
      if (previo && hueco < Math.min(previo.alto, fragmento.alto) * 0.45) {
        const y = Math.min(previo.y, fragmento.y)
        previo.texto = `${previo.texto}${hueco > fragmento.alto * 0.08 ? ' ' : ''}${fragmento.texto}`
        previo.alto = Math.max(previo.y + previo.alto, fragmento.y + fragmento.alto) - y
        previo.y = y
        previo.ancho = fragmento.x + fragmento.ancho - previo.x
      } else {
        segmentos.push({ id: siguienteId(), texto: fragmento.texto, x: fragmento.x, y: fragmento.y, ancho: fragmento.ancho, alto: fragmento.alto, pagina: pagina.numero })
      }
    }
    return { pagina: pagina.numero, centro: linea.centro, alto: linea.alto, segmentos }
  })
}

/** Columnas de la tabla si la línea es su encabezado: al menos tres títulos distintos, uno de ellos de importe. */
function columnasDeEncabezado(linea: Linea): Columna[] | null {
  const columnas: Columna[] = []
  for (const segmento of linea.segmentos) {
    const etiqueta = normalizarEtiqueta(segmento.texto)
    const encontrado = ENCABEZADOS.find(([, patron]) => patron.test(etiqueta))
    if (encontrado && !columnas.some((columna) => columna.campo === encontrado[0])) columnas.push({ campo: encontrado[0], x0: segmento.x, x1: segmento.x + segmento.ancho })
  }
  if (columnas.length < 3 || !columnas.some((columna) => CAMPOS_MONTO_MOVIMIENTO.includes(columna.campo))) return null
  return columnas.sort((a, b) => a.x0 - b.x0)
}

/** Columna de un segmento de una fila: los importes por cercanía (suelen ir alineados a la derecha) y el texto por franja. */
function columnaDe(segmento: Segmento, columnas: Columna[]): CampoMovimientoDocumento | null {
  const izquierda = segmento.x
  const derecha = segmento.x + segmento.ancho
  const centro = (izquierda + derecha) / 2
  if (esImporte(segmento.texto)) {
    const deImporte = columnas.filter((columna) => CAMPOS_MONTO_MOVIMIENTO.includes(columna.campo))
    let mejor: Columna | null = null
    let distancia = Infinity
    for (const columna of deImporte) {
      const d = Math.min(Math.abs(derecha - columna.x1), Math.abs(izquierda - columna.x0), Math.abs(centro - (columna.x0 + columna.x1) / 2))
      if (d < distancia) { distancia = d; mejor = columna }
    }
    return mejor?.campo ?? null
  }
  const tolerancia = segmento.alto * 0.6
  let elegida: Columna | null = null
  for (const columna of columnas) if (columna.x0 <= izquierda + tolerancia) elegida = columna
  if (!elegida) return null
  // Texto que cae bajo una columna de importe no es un importe: se descarta en lugar de adivinar su columna.
  return CAMPOS_MONTO_MOVIMIENTO.includes(elegida.campo) ? null : elegida.campo
}

const recuadroDe = (segmento: Segmento): Recuadro => ({ pagina: segmento.pagina, x: segmento.x, y: segmento.y, ancho: segmento.ancho, alto: segmento.alto })
function unir(a: Recuadro, b: Recuadro): Recuadro {
  if (a.pagina !== b.pagina) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { pagina: a.pagina, x, y, ancho: Math.max(a.x + a.ancho, b.x + b.ancho) - x, alto: Math.max(a.y + a.alto, b.y + b.alto) - y }
}

const esLineaDeTotales = (linea: Linea) => linea.segmentos.some((segmento) => /^total(es)?\b/.test(normalizarEtiqueta(segmento.texto)))

/** Valor de una etiqueta del resumen: lo que sigue a los dos puntos, o el segmento a su derecha en la misma línea. */
function valorDeEtiqueta(campo: CampoResumenDocumento, segmento: Segmento, linea: Linea, usados: Set<number>): { texto: string; recuadro: Recuadro } | null {
  const esMonto = CAMPOS_MONTO_RESUMEN_DOCUMENTO.includes(campo)
  const dosPuntos = segmento.texto.indexOf(':')
  if (dosPuntos >= 0) {
    const resto = segmento.texto.slice(dosPuntos + 1).trim()
    if (resto && (!esMonto || esImporte(resto))) {
      // Recuadro aproximado de la parte del valor, en proporción a los caracteres.
      const inicio = segmento.texto.length - segmento.texto.slice(dosPuntos + 1).trimStart().length
      const desplazamiento = segmento.ancho * (inicio / segmento.texto.length)
      return { texto: resto, recuadro: { ...recuadroDe(segmento), x: segmento.x + desplazamiento, ancho: segmento.ancho - desplazamiento } }
    }
  }
  const siguiente = linea.segmentos.filter((otro) => otro.x > segmento.x + segmento.ancho - 0.5 && !usados.has(otro.id)).sort((a, b) => a.x - b.x)
  const valor = esMonto ? siguiente.find((otro) => esImporte(otro.texto)) : siguiente[0]
  if (!valor) return null
  usados.add(valor.id)
  return { texto: valor.texto.replace(/^:\s*/, ''), recuadro: recuadroDe(valor) }
}

function etiquetaResumen(texto: string): CampoResumenDocumento | null {
  const antes = texto.includes(':') ? texto.slice(0, texto.indexOf(':')) : texto
  const etiqueta = normalizarEtiqueta(antes)
  return ETIQUETAS_RESUMEN.find(([, patron]) => patron.test(etiqueta))?.[0] ?? null
}

export function detectarDatos(paginas: PaginaTexto[]): DatosDocumento {
  let id = 0
  const siguienteId = () => (id += 1)
  const lineas = paginas.flatMap((pagina) => lineasDePagina(pagina, siguienteId))
  const usados = new Set<number>()
  const filas: FilaDocumento[] = []
  let columnas: Columna[] | null = null
  let tablaReconocida = false
  let enTabla = false
  let ultima: { fila: FilaDocumento; linea: Linea } | null = null

  for (const linea of lineas) {
    const encabezado = columnasDeEncabezado(linea)
    if (encabezado) {
      columnas = encabezado
      tablaReconocida = true
      enTabla = true
      ultima = null
      linea.segmentos.forEach((segmento) => usados.add(segmento.id))
      continue
    }
    if (!columnas || !enTabla) continue
    if (esLineaDeTotales(linea)) {
      enTabla = false
      continue
    }
    const asignadas = linea.segmentos.map((segmento) => ({ segmento, campo: columnaDe(segmento, columnas!) }))
    const fecha = asignadas.find(({ segmento, campo }) => campo === 'fecha' && esFecha(segmento.texto))
    const concepto = asignadas.filter(({ campo }) => campo === 'concepto').map(({ segmento }) => segmento.texto).join(' ')
    const deSaldo = esFilaDeSaldo(concepto)
    if (fecha || (deSaldo && asignadas.some(({ segmento }) => esImporte(segmento.texto)))) {
      const fila: FilaDocumento = { indice: filas.length, esSaldo: deSaldo, celdas: {} }
      for (const { segmento, campo } of asignadas) {
        if (!campo) continue
        const previa = fila.celdas[campo]
        fila.celdas[campo] = previa ? { campo, texto: `${previa.texto} ${segmento.texto}`, recuadro: unir(previa.recuadro, recuadroDe(segmento)) } : { campo, texto: segmento.texto, recuadro: recuadroDe(segmento) }
        usados.add(segmento.id)
      }
      filas.push(fila)
      ultima = { fila, linea }
      continue
    }
    // Una línea sin fecha que solo trae texto de concepto, justo debajo de una fila, continúa su concepto.
    const soloConcepto = asignadas.length > 0 && asignadas.every(({ campo, segmento }) => (campo === 'concepto' || campo === 'referencia') && !esImporte(segmento.texto))
    if (ultima && soloConcepto && linea.pagina === ultima.linea.pagina && linea.centro - ultima.linea.centro <= linea.alto * 2.2 && !esFilaDeSaldo(concepto)) {
      for (const { segmento, campo } of asignadas) {
        const previa = ultima.fila.celdas[campo!]
        ultima.fila.celdas[campo!] = previa ? { campo: campo!, texto: `${previa.texto} ${segmento.texto}`, recuadro: unir(previa.recuadro, recuadroDe(segmento)) } : { campo: campo!, texto: segmento.texto, recuadro: recuadroDe(segmento) }
        usados.add(segmento.id)
      }
      ultima = { fila: ultima.fila, linea }
    }
  }

  // Resumen: etiquetas fuera de la tabla. Gana la primera aparición de cada campo.
  const resumen: DatoResumenDocumento[] = []
  for (const linea of lineas) {
    for (const segmento of linea.segmentos) {
      if (usados.has(segmento.id)) continue
      const campo = etiquetaResumen(segmento.texto)
      if (!campo || resumen.some((dato) => dato.campo === campo)) continue
      const valor = valorDeEtiqueta(campo, segmento, linea, usados)
      if (!valor) continue
      usados.add(segmento.id)
      resumen.push({ campo, ...valor })
    }
  }

  const importes = [
    ...filas.flatMap((fila) => CAMPOS_MONTO_MOVIMIENTO.map((campo) => fila.celdas[campo]?.texto ?? '')),
    ...resumen.filter((dato) => CAMPOS_MONTO_RESUMEN_DOCUMENTO.includes(dato.campo)).map((dato) => dato.texto),
  ]
  const [formatoDetectado] = detectarFormato(importes)
  return { tablaReconocida, resumenReconocido: resumen.length > 0, filas: tablaReconocida ? filas : [], resumen, formatoDetectado }
}
