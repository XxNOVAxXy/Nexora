import type { CampoMonto, Transaccion } from '../types'

export type CampoEditable = 'fecha' | 'concepto' | 'referencia' | CampoMonto

let secuencia = 0

export function nuevaTransaccion(): Transaccion {
  secuencia += 1
  return { id: `manual-${Date.now()}-${secuencia}`, fecha: '', concepto: '', referencia: '', cargo: '', abono: '', saldo: '', origen: 'manual', dudosos: [] }
}

/** Aplica una edición manual: una fila de la IA pasa a `ia_editada` y el monto editado deja de ser dudoso. */
export function editarCampo(transaccion: Transaccion, campo: CampoEditable, valor: string): Transaccion {
  if (transaccion[campo] === valor) return transaccion
  return {
    ...transaccion,
    [campo]: valor,
    origen: transaccion.origen === 'ia' ? 'ia_editada' : transaccion.origen,
    dudosos: transaccion.dudosos.filter((dudoso) => dudoso !== campo),
  }
}

export function etiquetaOrigen(origen: Transaccion['origen']): string {
  return { ia: 'IA', manual: 'Manual', ia_editada: 'IA editada' }[origen]
}

const CAMPOS_CAPTURA: CampoEditable[] = ['fecha', 'concepto', 'referencia', 'cargo', 'abono', 'saldo']

/** Una fila manual sin ningún dato capturado (tampoco en las columnas adicionales) no es una corrección. */
export const esFilaVacia = (transaccion: Transaccion) =>
  CAMPOS_CAPTURA.every((campo) => !transaccion[campo].trim()) && Object.values(transaccion.extras ?? {}).every((valor) => !valor.trim())

/** Correcciones que una re-extracción debe conservar: filas manuales con datos y filas de la IA editadas. */
export const contarCorrecciones = (transacciones: Transaccion[]) =>
  transacciones.filter((transaccion) => transaccion.origen === 'ia_editada' || (transaccion.origen === 'manual' && !esFilaVacia(transaccion))).length

export type ResultadoCombinacion = {
  transacciones: Transaccion[]
  /** Filas manuales e ia_editada que se mantuvieron (incluidas las que ya no aparecen en la extracción). */
  conservadas: number
  /** Filas ia_editada que la nueva extracción ya no contiene: se conservan marcadas para revisión. */
  noAparecen: number
}

/**
 * Combina una nueva extracción con la lista actual del documento sin perder correcciones:
 * - las filas `ia` sin editar se reemplazan por la nueva extracción (sus valores de columnas adicionales pasan a
 *   la fila nueva con la misma huella);
 * - una fila `ia_editada` cuya huella sigue presente ocupa el lugar de esa fila nueva;
 * - una fila `ia_editada` que ya no aparece se conserva con `revision: 'no_aparece_en_extraccion'`;
 * - las filas `manual` se conservan después de la fila que tenían delante (al inicio si no había ninguna).
 * `lote` hace únicos los ids de las filas nuevas frente a las conservadas de extracciones anteriores.
 */
export function combinarExtraccion(actual: Transaccion[], nuevas: Transaccion[], lote: string): ResultadoCombinacion {
  const base: Transaccion[] = nuevas.map((transaccion, indice) => ({ ...transaccion, id: `ia-${lote}-${indice + 1}`, origen: 'ia' }))
  const disponibles = new Map<string, number[]>()
  base.forEach((transaccion, indice) => {
    if (!transaccion.huella) return
    disponibles.set(transaccion.huella, [...(disponibles.get(transaccion.huella) ?? []), indice])
  })
  const tomar = (huella: string | undefined) => (huella ? disponibles.get(huella)?.shift() : undefined)

  // Las editadas eligen primero su fila equivalente, para que una fila ia duplicada no se la quite.
  const asignadas = new Map<string, number>()
  for (const origen of ['ia_editada', 'ia'] as const) {
    for (const transaccion of actual) {
      if (transaccion.origen !== origen) continue
      const indice = tomar(transaccion.huella)
      if (indice !== undefined) asignadas.set(transaccion.id, indice)
    }
  }

  const despues = new Map<number, Transaccion[]>()
  const insertar = (ancla: number, transaccion: Transaccion) => despues.set(ancla, [...(despues.get(ancla) ?? []), transaccion])
  let ancla = -1
  let conservadas = 0
  let noAparecen = 0
  for (const transaccion of actual) {
    const indice = asignadas.get(transaccion.id)
    if (transaccion.origen === 'manual') {
      if (esFilaVacia(transaccion)) continue
      insertar(ancla, transaccion)
      conservadas += 1
    } else if (transaccion.origen === 'ia_editada') {
      conservadas += 1
      if (indice !== undefined) {
        base[indice] = { ...transaccion, revision: transaccion.revision === 'no_aparece_en_extraccion' ? undefined : transaccion.revision }
        ancla = indice
      } else {
        insertar(ancla, { ...transaccion, revision: 'no_aparece_en_extraccion' })
        noAparecen += 1
      }
    } else if (indice !== undefined) {
      if (transaccion.extras) base[indice] = { ...base[indice], extras: transaccion.extras, ...(transaccion.extras_ia ? { extras_ia: transaccion.extras_ia } : {}) }
      ancla = indice
    }
  }

  const transacciones = [...(despues.get(-1) ?? [])]
  base.forEach((transaccion, indice) => transacciones.push(transaccion, ...(despues.get(indice) ?? [])))
  return { transacciones, conservadas, noAparecen }
}

/**
 * Mueve un movimiento al número `numero` (1 = primero), recorriendo los demás. Un número fuera de rango se lleva
 * al primero o al último. Si no cambia de lugar devuelve la misma lista.
 */
export function moverTransaccion(transacciones: Transaccion[], id: string, numero: number): Transaccion[] {
  const origen = transacciones.findIndex((transaccion) => transaccion.id === id)
  if (origen < 0 || !Number.isFinite(numero)) return transacciones
  const destino = Math.max(0, Math.min(transacciones.length - 1, Math.trunc(numero) - 1))
  if (destino === origen) return transacciones
  const resto = transacciones.filter((_, indice) => indice !== origen)
  return [...resto.slice(0, destino), transacciones[origen], ...resto.slice(destino)]
}

// --- Orden por fecha al extraer (mismo algoritmo que backend/app/orden_fechas.py) ------------------

const MESES: Record<string, number> = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 }
const normalizarFecha = (texto: string) => (texto ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const anioDe = (texto: string | undefined) => (texto ? (Number(texto) < 100 ? Number(texto) + 2000 : Number(texto)) : null)

/** [año o null, mes, día], o null si no es una fecha reconocible ("02/11/2026", "2026-11-02", "15 DIC"). */
export function leerFecha(texto: string): [number | null, number, number] | null {
  const limpio = normalizarFecha(texto)
  let anio: number | null
  let mes: number
  let dia: number
  const iso = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(limpio)
  const numerica = iso ? null : /(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?/.exec(limpio)
  const textual = iso || numerica ? null : /(\d{1,2})[\s/.-]*([a-z]{3,})\.?(?:[\s/.,-]*(\d{2,4}))?/.exec(limpio)
  if (iso) [anio, mes, dia] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (numerica) [dia, mes, anio] = [Number(numerica[1]), Number(numerica[2]), anioDe(numerica[3])]
  else if (textual && MESES[textual[2].slice(0, 3)]) [dia, mes, anio] = [Number(textual[1]), MESES[textual[2].slice(0, 3)], anioDe(textual[3])]
  else return null
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 ? [anio, mes, dia] : null
}

function inicioPeriodo(periodo: string): [number, number] | null {
  const fecha = leerFecha(periodo)
  if (fecha && fecha[0] !== null) return [fecha[0], fecha[1]]
  const anio = /\b(20\d{2})\b/.exec(periodo ?? '')
  if (!anio) return null
  const textual = /([a-z]{3,})/.exec(normalizarFecha(periodo))
  return [Number(anio[1]), (textual && MESES[textual[1].slice(0, 3)]) || 1]
}

/**
 * Ordena los movimientos por fecha al extraer. Estable: con la misma fecha se conserva el orden del documento. Un
 * movimiento con fecha ilegible se queda en su lugar. Sin año, se usa el del periodo (un mes anterior al de inicio
 * pasa al año siguiente); sin periodo, si los meses cruzan de fin a inicio de año, enero a junio van después.
 */
export function ordenarPorFecha<T extends { fecha: string }>(transacciones: T[], periodo = ''): T[] {
  const fechas = transacciones.map((transaccion) => leerFecha(transaccion.fecha))
  const inicio = inicioPeriodo(periodo)
  const sinAnio = fechas.filter((fecha): fecha is [null, number, number] => fecha !== null && fecha[0] === null).map((fecha) => fecha[1])
  const cruza = sinAnio.some((mes) => mes >= 10) && sinAnio.some((mes) => mes <= 3)
  const clave = (indice: number): number[] => {
    const [anio, mes, dia] = fechas[indice]!
    const resuelto = anio ?? (inicio ? (mes >= inicio[1] ? inicio[0] : inicio[0] + 1) : cruza && mes <= 6 ? 1 : 0)
    return [resuelto, mes, dia, indice]
  }
  const posiciones = fechas.flatMap((fecha, indice) => (fecha ? [indice] : []))
  const ordenadas = [...posiciones].sort((a, b) => {
    const [x, y] = [clave(a), clave(b)]
    const i = x.findIndex((valor, posicion) => valor !== y[posicion])
    return i === -1 ? 0 : x[i] - y[i]
  })
  const resultado = [...transacciones]
  posiciones.forEach((destino, i) => { resultado[destino] = transacciones[ordenadas[i]] })
  return resultado
}
