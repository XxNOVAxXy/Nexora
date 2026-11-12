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
      if (transaccion.extras) base[indice] = { ...base[indice], extras: transaccion.extras }
      ancla = indice
    }
  }

  const transacciones = [...(despues.get(-1) ?? [])]
  base.forEach((transaccion, indice) => transacciones.push(transaccion, ...(despues.get(indice) ?? [])))
  return { transacciones, conservadas, noAparecen }
}
