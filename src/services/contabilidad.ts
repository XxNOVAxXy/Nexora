/**
 * Port a TypeScript de backend/app/contabilidad.py: interpretación de importes y validación contable.
 * Ambas implementaciones ejecutan los casos de backend/tests/fixtures/contabilidad_casos.json;
 * cualquier cambio de reglas debe hacerse en los dos lados y reflejarse en esos casos.
 */
import { CERO, abs, comparar, decimal, esCero, formatear, formatear2, negar, redondear2, restar, sumar, type Decimal } from './decimal'

export type FormatoNumerico = 'us' | 'eu'
export type Indicador = 'cargo' | 'abono'
export type MontoParseado = { valor: Decimal | null; dudoso: boolean; indicador: Indicador | null; motivo: string }

export const CAMPOS_MONTO_RESUMEN = ['saldo_inicial', 'total_cargos', 'total_abonos', 'saldo_final'] as const
const TOLERANCIA = decimal('0.01')

// --- Interpretación de importes ---------------------------------------------------------------

// NBSP, espacio fino estrecho y espacio fino se tratan como espacios; el signo menos tipográfico como "-".
const ESPACIOS = new RegExp(`[${String.fromCharCode(0x00a0, 0x202f, 0x2009)}]`, 'g')
const SIGNO_MENOS = new RegExp(String.fromCharCode(0x2212), 'g')
const INDICADOR = /(?<![A-Z])(CR|DR|CARGO|ABONO)\.?$/
const MONEDA = new RegExp(`(?<![A-Z])(?:MXN|MXP|USD|EUR|DLS|M\\.\\s?N\\.?|MN)(?![A-Z])|[$${String.fromCharCode(0x20ac)}]`, 'g')
const CUERPO_NUMERICO = /^\d(?:[\d., ]*\d)?$/
const CANONICO = /^-?\d+(?:\.\d+)?$/
// "2.500" parece canónico pero en un documento europeo significa 2500: se interpreta con el formato del documento.
const CANONICO_AMBIGUO = /^-?[1-9]\d{0,2}\.\d{3}$/
const escaparRegex = (texto: string) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type MontoLimpio = { cuerpo: string; negativo: boolean; indicador: Indicador | null; error: string }

function limpiarMonto(texto: string): MontoLimpio {
  let t = texto.replace(ESPACIOS, ' ').replace(SIGNO_MENOS, '-').toUpperCase().trim()
  let indicador: Indicador | null = null
  const match = INDICADOR.exec(t)
  if (match) {
    indicador = match[1] === 'CR' || match[1] === 'ABONO' ? 'abono' : 'cargo'
    t = t.slice(0, match.index).trim()
  }
  t = t.replace(MONEDA, ' ').trim()
  let signos = 0
  if (t.startsWith('(') && t.endsWith(')')) {
    signos += 1
    t = t.slice(1, -1).trim()
  }
  if (t.startsWith('-')) {
    signos += 1
    t = t.slice(1).trim()
  } else if (t.startsWith('+')) {
    t = t.slice(1).trim()
  }
  if (t.endsWith('-')) {
    signos += 1
    t = t.slice(0, -1).trim()
  }
  t = t.replace(/\s+/g, ' ')
  if (signos > 1) return { cuerpo: t, negativo: true, indicador, error: 'el importe tiene mas de un signo negativo' }
  if (!CUERPO_NUMERICO.test(t)) return { cuerpo: t, negativo: signos === 1, indicador, error: 'texto no reconocido como importe' }
  return { cuerpo: t, negativo: signos === 1, indicador, error: '' }
}

const contar = (texto: string, caracter: string) => texto.split(caracter).length - 1

function interpretarCuerpo(cuerpo: string, formato: FormatoNumerico | null): [Decimal | null, string] {
  if (cuerpo.includes(' ')) {
    const match = /^(\d{1,3}(?: \d{3})+)(?:[.,](\d+))?$/.exec(cuerpo)
    if (!match) return [null, 'agrupacion de miles con espacios invalida']
    const entero = match[1].replace(/ /g, '')
    return [decimal(match[2] ? `${entero}.${match[2]}` : entero), '']
  }
  const puntos = contar(cuerpo, '.')
  const comas = contar(cuerpo, ',')
  if (!puntos && !comas) return [decimal(cuerpo), '']

  if (puntos && comas) {
    const separadorDecimal = cuerpo.lastIndexOf('.') > cuerpo.lastIndexOf(',') ? '.' : ','
    const miles = separadorDecimal === '.' ? ',' : '.'
    const match = new RegExp(`^(\\d{1,3}(?:${escaparRegex(miles)}\\d{3})*)${escaparRegex(separadorDecimal)}(\\d+)$`).exec(cuerpo)
    if (!match) return [null, 'separadores de miles y decimales inconsistentes']
    return [decimal(`${match[1].split(miles).join('')}.${match[2]}`), '']
  }

  const separador = puntos ? '.' : ','
  if (contar(cuerpo, separador) > 1) {
    if (!new RegExp(`^\\d{1,3}(?:${escaparRegex(separador)}\\d{3})+$`).test(cuerpo)) return [null, 'separadores de miles invalidos']
    return [decimal(cuerpo.split(separador).join('')), '']
  }

  const [entero, fraccion] = cuerpo.split(separador)
  if (fraccion.length !== 3 || entero.startsWith('0') || entero.length > 3) return [decimal(`${entero}.${fraccion}`), '']
  if (formato === null) return [null, 'separador ambiguo sin pista de formato en el documento']
  const separadorDecimal = formato === 'us' ? '.' : ','
  return [decimal(separador === separadorDecimal ? `${entero}.${fraccion}` : entero + fraccion), '']
}

function pistaFormato(texto: string): FormatoNumerico | null {
  const limpio = limpiarMonto(texto)
  if (limpio.error) return null
  const cuerpo = limpio.cuerpo
  if (interpretarCuerpo(cuerpo, null)[0] === null) return null
  if (cuerpo.includes(' ')) return cuerpo.includes(',') ? 'eu' : cuerpo.includes('.') ? 'us' : null
  const puntos = contar(cuerpo, '.')
  const comas = contar(cuerpo, ',')
  if (puntos && comas) return cuerpo.lastIndexOf('.') > cuerpo.lastIndexOf(',') ? 'us' : 'eu'
  if (!puntos && !comas) return null
  const separador = puntos ? '.' : ','
  if (contar(cuerpo, separador) > 1) return separador === ',' ? 'us' : 'eu'
  return separador === '.' ? 'us' : 'eu'
}

/** Formato numérico del documento y si hay pistas contradictorias (en cuyo caso no se elige ninguno). */
export function detectarFormato(textos: string[]): [FormatoNumerico | null, boolean] {
  const pistas = new Set<FormatoNumerico>()
  for (const texto of textos) {
    if (typeof texto !== 'string' || !texto.trim()) continue
    const pista = pistaFormato(texto)
    if (pista) pistas.add(pista)
  }
  if (pistas.size === 1) return [[...pistas][0], false]
  return [null, pistas.size > 1]
}

export function parseMoney(value: unknown, formato: FormatoNumerico | null = null): MontoParseado {
  if (typeof value !== 'string' || !value.trim()) return { valor: null, dudoso: false, indicador: null, motivo: '' }
  const limpio = limpiarMonto(value)
  if (limpio.error) return { valor: null, dudoso: true, indicador: limpio.indicador, motivo: limpio.error }
  const [valor, motivo] = interpretarCuerpo(limpio.cuerpo, formato)
  if (valor === null) return { valor: null, dudoso: true, indicador: limpio.indicador, motivo }
  if (limpio.negativo) {
    const negativo = negar(valor)
    if (limpio.indicador === 'abono') return { valor: negativo, dudoso: true, indicador: limpio.indicador, motivo: 'signo negativo con indicador de abono' }
    return { valor: negativo, dudoso: false, indicador: limpio.indicador, motivo: '' }
  }
  return { valor, dudoso: false, indicador: limpio.indicador, motivo: '' }
}

const esNegativo = (valor: Decimal) => valor.n < 0n

/** (texto normalizado "1234.56", valor, dudoso) según el tipo de campo, igual que normalizar_monto en Python. */
export function normalizarMonto(campo: string, texto: string, formato: FormatoNumerico | null): [string, Decimal | null, boolean] {
  const parseado = parseMoney(texto, formato)
  if (parseado.valor === null) return [typeof texto === 'string' ? texto.trim() : '', null, parseado.dudoso]
  let valor = parseado.valor
  let dudoso = parseado.dudoso
  if (campo === 'cargo' || campo === 'total_cargos') {
    dudoso = dudoso || parseado.indicador === 'abono'
    valor = abs(valor)
  } else if (campo === 'abono' || campo === 'total_abonos') {
    dudoso = dudoso || parseado.indicador === 'cargo' || esNegativo(valor)
    valor = abs(valor)
  } else if (parseado.indicador === 'cargo') {
    dudoso = dudoso || esNegativo(valor)
    valor = negar(abs(valor))
  }
  return [formatear(valor), valor, dudoso]
}

// --- Filas de saldo ---------------------------------------------------------------------------

const FILA_DE_SALDO = /^saldo\s+(?:inicial|anterior|previo|final|al\s+corte)\b/

/** True para filas como "SALDO INICIAL", "Saldo anterior al 30/09" o "SALDO AL CORTE", que no son movimientos. */
export function esFilaDeSaldo(concepto: unknown): boolean {
  if (typeof concepto !== 'string') return false
  const sinAcentos = concepto.normalize('NFD').replace(/\p{Mn}/gu, '')
  return FILA_DE_SALDO.test(sinAcentos.trim().toLowerCase().replace(/\s+/g, ' '))
}

// --- Validación contable ----------------------------------------------------------------------

export type EstadoComprobacion = 'ok' | 'diferencia' | 'no_verificable'
export type Comprobacion = { id: 'total_cargos' | 'total_abonos' | 'saldo_final' | 'continuidad'; estado: EstadoComprobacion; esperado: string | null; calculado: string | null; diferencia: string | null; mensaje: string }
export type FilaDiscontinua = { id: string; indice: number; saldo_esperado: string; saldo_reportado: string; diferencia: string }
export type ImporteInvalido = { id: string; campo: 'cargo' | 'abono' | 'saldo' | 'cargo_y_abono' }
export type ValidacionContable = {
  cuadra: boolean | null
  tolerancia: string
  suma_cargos: string | null
  suma_abonos: string | null
  comprobaciones: Comprobacion[]
  filas_discontinuas: FilaDiscontinua[]
  filas_excluidas: string[]
  importes_invalidos: ImporteInvalido[]
}
export type ResumenValidable = Partial<Record<(typeof CAMPOS_MONTO_RESUMEN)[number], string>>
export type MovimientoValidable = { id: string; concepto: string; cargo: string; abono: string; saldo: string }

const ETIQUETAS: Record<(typeof CAMPOS_MONTO_RESUMEN)[number], string> = { saldo_inicial: 'saldo inicial', total_cargos: 'total de cargos', total_abonos: 'total de abonos', saldo_final: 'saldo final' }

/** Importe de un campo tal como lo interpreta la validación contable: [valor, inválido]. */
export function montoParaValidacion(campo: string, texto: unknown, formato: FormatoNumerico | null): [Decimal | null, boolean] {
  if (typeof texto !== 'string' || !texto.trim()) return [null, false]
  const t = texto.trim()
  if (CANONICO.test(t) && !CANONICO_AMBIGUO.test(t)) {
    const valor = decimal(t)
    if (campo === 'cargo' || campo === 'total_cargos') return [abs(valor), false]
    if ((campo === 'abono' || campo === 'total_abonos') && esNegativo(valor)) return [null, true]
    return [valor, false]
  }
  const [, valor, dudoso] = normalizarMonto(campo, t, formato)
  if (valor === null || dudoso) return [null, true]
  return [valor, false]
}

const texto = (valor: Decimal | null) => (valor === null ? null : formatear(valor))
const fueraDeTolerancia = (diferencia: Decimal) => comparar(abs(redondear2(diferencia)), TOLERANCIA) > 0
const presente = (valor: Decimal | null): valor is Decimal => valor !== null && !esCero(valor)

function comprobacion(id: Comprobacion['id'], etiqueta: string, esperado: Decimal | null, calculado: Decimal | null, motivo: string): Comprobacion {
  if (motivo || esperado === null || calculado === null) return { id, estado: 'no_verificable', esperado: texto(esperado), calculado: texto(calculado), diferencia: null, mensaje: motivo }
  const diferencia = restar(calculado, esperado)
  const ok = !fueraDeTolerancia(diferencia)
  const diferenciaTexto = formatear2(diferencia)
  return { id, estado: ok ? 'ok' : 'diferencia', esperado: texto(esperado), calculado: texto(calculado), diferencia: diferenciaTexto, mensaje: ok ? `${etiqueta} cuadra.` : `${etiqueta}: diferencia de ${diferenciaTexto}.` }
}

/** Misma validación que validar_contabilidad() del backend, para ejecutarla sobre la lista editada. */
export function validarContabilidad(resumen: ResumenValidable, transacciones: MovimientoValidable[], formato: FormatoNumerico | null = null): ValidacionContable {
  const valores = Object.fromEntries(CAMPOS_MONTO_RESUMEN.map((campo) => [campo, montoParaValidacion(campo, resumen[campo] ?? '', formato)])) as Record<(typeof CAMPOS_MONTO_RESUMEN)[number], [Decimal | null, boolean]>
  const motivoResumen = (campo: (typeof CAMPOS_MONTO_RESUMEN)[number]) => {
    const [valor, invalido] = valores[campo]
    if (invalido) return `El ${ETIQUETAS[campo]} del resumen es dudoso o invalido.`
    if (valor === null) return `El resumen no incluye el ${ETIQUETAS[campo]}.`
    return ''
  }

  const importesInvalidos: ImporteInvalido[] = []
  const filasExcluidas: string[] = []
  let sumaCargos = CERO
  let sumaAbonos = CERO
  let movimientosValidos = true
  for (const transaccion of transacciones) {
    const [, saldoInvalido] = montoParaValidacion('saldo', transaccion.saldo, formato)
    if (saldoInvalido) importesInvalidos.push({ id: transaccion.id, campo: 'saldo' })
    if (esFilaDeSaldo(transaccion.concepto)) {
      filasExcluidas.push(transaccion.id)
      continue
    }
    const [cargo, cargoInvalido] = montoParaValidacion('cargo', transaccion.cargo, formato)
    const [abono, abonoInvalido] = montoParaValidacion('abono', transaccion.abono, formato)
    if (cargoInvalido) importesInvalidos.push({ id: transaccion.id, campo: 'cargo' })
    if (abonoInvalido) importesInvalidos.push({ id: transaccion.id, campo: 'abono' })
    const ambos = presente(cargo) && presente(abono)
    if (ambos) importesInvalidos.push({ id: transaccion.id, campo: 'cargo_y_abono' })
    if (cargoInvalido || abonoInvalido || ambos) {
      movimientosValidos = false
      continue
    }
    sumaCargos = sumar(sumaCargos, cargo ?? CERO)
    sumaAbonos = sumar(sumaAbonos, abono ?? CERO)
  }

  const motivoMovimientos = movimientosValidos ? '' : 'Hay importes dudosos o invalidos en los movimientos.'
  const saldoInicial = valores.saldo_inicial[0]
  const comprobaciones: Comprobacion[] = [
    comprobacion('total_cargos', 'El total de cargos', valores.total_cargos[0], sumaCargos, motivoMovimientos || motivoResumen('total_cargos')),
    comprobacion('total_abonos', 'El total de abonos', valores.total_abonos[0], sumaAbonos, motivoMovimientos || motivoResumen('total_abonos')),
    comprobacion('saldo_final', 'Saldo inicial + abonos - cargos = saldo final', valores.saldo_final[0], saldoInicial === null ? null : restar(sumar(saldoInicial, sumaAbonos), sumaCargos), motivoMovimientos || motivoResumen('saldo_inicial') || motivoResumen('saldo_final')),
  ]

  const [filasDiscontinuas, verificadas] = continuidad(transacciones, saldoInicial, formato)
  const base = { id: 'continuidad' as const, esperado: null, calculado: null, diferencia: null }
  if (filasDiscontinuas.length) comprobaciones.push({ ...base, estado: 'diferencia', mensaje: `La continuidad de saldos se rompe en ${filasDiscontinuas.length} fila(s).` })
  else if (verificadas === 0) comprobaciones.push({ ...base, estado: 'no_verificable', mensaje: 'No hay saldos por fila suficientes para verificar la continuidad.' })
  else comprobaciones.push({ ...base, estado: 'ok', mensaje: `La continuidad de saldos cuadra en ${verificadas} fila(s).` })

  const cuadra = comprobaciones.some((item) => item.estado === 'diferencia') ? false : movimientosValidos && comprobaciones[2].estado === 'ok' ? true : null
  return {
    cuadra,
    tolerancia: '0.01',
    suma_cargos: movimientosValidos ? texto(sumaCargos) : null,
    suma_abonos: movimientosValidos ? texto(sumaAbonos) : null,
    comprobaciones,
    filas_discontinuas: filasDiscontinuas,
    filas_excluidas: filasExcluidas,
    importes_invalidos: importesInvalidos,
  }
}

function continuidad(transacciones: MovimientoValidable[], saldoInicial: Decimal | null, formato: FormatoNumerico | null): [FilaDiscontinua[], number] {
  let anterior = saldoInicial
  let pendiente = CERO
  let verificadas = 0
  const discontinuas: FilaDiscontinua[] = []
  transacciones.forEach((transaccion, indice) => {
    const [saldo, saldoInvalido] = montoParaValidacion('saldo', transaccion.saldo, formato)
    if (!esFilaDeSaldo(transaccion.concepto)) {
      const [cargo, cargoInvalido] = montoParaValidacion('cargo', transaccion.cargo, formato)
      const [abono, abonoInvalido] = montoParaValidacion('abono', transaccion.abono, formato)
      if (cargoInvalido || abonoInvalido || (presente(cargo) && presente(abono))) {
        // Movimiento desconocido: no se puede verificar hasta el siguiente saldo confiable.
        anterior = saldoInvalido ? null : saldo
        pendiente = CERO
        return
      }
      pendiente = sumar(pendiente, restar(abono ?? CERO, cargo ?? CERO))
    }
    if (saldoInvalido) {
      anterior = null
      pendiente = CERO
      return
    }
    if (saldo === null) return
    if (anterior !== null) {
      verificadas += 1
      const esperado = sumar(anterior, pendiente)
      const diferencia = restar(saldo, esperado)
      if (fueraDeTolerancia(diferencia)) discontinuas.push({ id: transaccion.id, indice, saldo_esperado: formatear(esperado), saldo_reportado: formatear(saldo), diferencia: formatear2(diferencia) })
    }
    anterior = saldo
    pendiente = CERO
  })
  return [discontinuas, verificadas]
}
