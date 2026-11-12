import type { CampoExtra, SugerenciaCampo, Transaccion } from '../types'

/**
 * Columnas adicionales de la tabla de Movimientos (botón "+ Campo").
 * Se editan, se guardan y se conservan al re-extraer como las demás columnas, pero no entran en la validación
 * contable ni se envían a SaveData.
 */

export const MAX_CAMPOS_EXTRA = 30
export const MAX_NOMBRE_CAMPO = 60
export const MAX_VALOR_CAMPO = 500

let secuencia = 0
const nuevoIdCampo = () => {
  secuencia += 1
  return `campo-${Date.now().toString(36)}-${secuencia}`
}

/** Nombre comparable: sin acentos, sin mayúsculas y con espacios simples ("Número  de crédito" = "numero de credito"). */
export const nombreComparable = (nombre: string) => nombre.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

const limpiarNombre = (nombre: string) => nombre.replace(/\s+/g, ' ').trim()

/** Cuántas filas tienen dato en la sugerencia; null si es un valor único del documento. */
export const filasConValor = (sugerencia: SugerenciaCampo): number | null => (sugerencia.valores.length > 0 ? sugerencia.valores.length : sugerencia.valor_documento ? null : 0)

/** Sugerencias que aún no son columna: ni la misma clave ni un nombre ya usado. */
export function sugerenciasDisponibles(sugerencias: SugerenciaCampo[], campos: CampoExtra[]): SugerenciaCampo[] {
  const claves = new Set(campos.map((campo) => campo.clave).filter(Boolean))
  const nombres = new Set(campos.map((campo) => nombreComparable(campo.nombre)))
  return sugerencias.filter((sugerencia) => !claves.has(sugerencia.clave) && !nombres.has(nombreComparable(sugerencia.nombre)))
}

/** Error de validación del nombre de una columna, o null si es válido. `excepto` permite conservar el propio nombre al renombrar. */
export function errorNombreCampo(nombre: string, campos: CampoExtra[], excepto?: string): string | null {
  const limpio = limpiarNombre(nombre)
  if (!limpio) return 'Escribe un nombre para el campo.'
  if (limpio.length > MAX_NOMBRE_CAMPO) return `El nombre admite hasta ${MAX_NOMBRE_CAMPO} caracteres.`
  const comparable = nombreComparable(limpio)
  if (['fecha', 'concepto', 'referencia', 'cargo', 'abono', 'saldo'].includes(comparable)) return 'Ese campo ya es una columna de la tabla.'
  if (campos.some((campo) => campo.id !== excepto && nombreComparable(campo.nombre) === comparable)) return 'Ya existe un campo con ese nombre.'
  return null
}

const conExtras = (transaccion: Transaccion, extras: Record<string, string>): Transaccion => {
  const { extras: _anteriores, ...resto } = transaccion
  return Object.keys(extras).length > 0 ? { ...resto, extras } : resto
}

/** Fija el valor de una columna en una fila; un valor vacío quita la celda para no guardar datos vacíos. */
function fijarExtra(transaccion: Transaccion, campoId: string, valor: string): Transaccion {
  const extras = { ...(transaccion.extras ?? {}) }
  if (valor) extras[campoId] = valor
  else delete extras[campoId]
  return conExtras(transaccion, extras)
}

/** Edición manual de una celda adicional: una fila de la IA pasa a `ia_editada`, igual que con las demás columnas. */
export function editarExtra(transaccion: Transaccion, campoId: string, valor: string): Transaccion {
  if ((transaccion.extras?.[campoId] ?? '') === valor) return transaccion
  const editada = fijarExtra(transaccion, campoId, valor.slice(0, MAX_VALOR_CAMPO))
  return { ...editada, origen: transaccion.origen === 'ia' ? 'ia_editada' : transaccion.origen }
}

/**
 * Llena una columna con los valores de una sugerencia. Con `soloVacias` respeta lo ya capturado (re-extracción).
 * Un valor único del documento se repite en cada fila; los valores por fila van a la fila con la misma huella.
 */
function llenarDesdeSugerencia(transacciones: Transaccion[], campoId: string, sugerencia: SugerenciaCampo, soloVacias: boolean): Transaccion[] {
  const porHuella = new Map<string, string[]>()
  for (const { huella, valor } of sugerencia.valores) porHuella.set(huella, [...(porHuella.get(huella) ?? []), valor])
  const unico = sugerencia.valores.length === 0 ? sugerencia.valor_documento ?? '' : ''
  return transacciones.map((transaccion) => {
    const valor = unico || (transaccion.huella ? porHuella.get(transaccion.huella)?.shift() ?? '' : '')
    if (!valor || (soloVacias && transaccion.extras?.[campoId]?.trim())) return transaccion
    return fijarExtra(transaccion, campoId, valor)
  })
}

export type ColumnasDocumento = { transacciones: Transaccion[]; campos_extra: CampoExtra[] }

/** Agrega la columna de una sugerencia de la IA con los valores que encontró. Aplicarla no cuenta como edición manual. */
export function aplicarSugerencia(documento: ColumnasDocumento, sugerencia: SugerenciaCampo): ColumnasDocumento {
  if (documento.campos_extra.length >= MAX_CAMPOS_EXTRA) return documento
  const campo: CampoExtra = { id: nuevoIdCampo(), nombre: limpiarNombre(sugerencia.nombre).slice(0, MAX_NOMBRE_CAMPO), origen: 'ia', clave: sugerencia.clave }
  return { campos_extra: [...documento.campos_extra, campo], transacciones: llenarDesdeSugerencia(documento.transacciones, campo.id, sugerencia, false) }
}

/** Agrega una columna vacía con el nombre que escribió el usuario (validado antes con errorNombreCampo). */
export function agregarCampoManual(campos: CampoExtra[], nombre: string): CampoExtra[] {
  if (campos.length >= MAX_CAMPOS_EXTRA || errorNombreCampo(nombre, campos)) return campos
  return [...campos, { id: nuevoIdCampo(), nombre: limpiarNombre(nombre), origen: 'manual' }]
}

export function renombrarCampo(campos: CampoExtra[], id: string, nombre: string): CampoExtra[] {
  if (errorNombreCampo(nombre, campos, id)) return campos
  return campos.map((campo) => (campo.id === id ? { ...campo, nombre: limpiarNombre(nombre) } : campo))
}

/** Quita la columna y sus valores de todas las filas. Si venía de la IA, su sugerencia vuelve a estar disponible. */
export function eliminarCampo(documento: ColumnasDocumento, id: string): ColumnasDocumento {
  return {
    campos_extra: documento.campos_extra.filter((campo) => campo.id !== id),
    transacciones: documento.transacciones.map((transaccion) => (transaccion.extras && id in transaccion.extras ? fijarExtra(transaccion, id, '') : transaccion)),
  }
}

/**
 * Tras re-extraer: las columnas y lo capturado se conservan (combinarExtraccion ya pasó los valores de las filas
 * de la IA sin editar a su fila nueva); las celdas vacías de las columnas de la IA se rellenan con la nueva extracción.
 */
export function rellenarColumnasIa(transacciones: Transaccion[], campos: CampoExtra[], sugerencias: SugerenciaCampo[]): Transaccion[] {
  let resultado = transacciones
  for (const campo of campos) {
    if (campo.origen !== 'ia' || !campo.clave) continue
    const sugerencia = sugerencias.find((item) => item.clave === campo.clave)
    if (sugerencia) resultado = llenarDesdeSugerencia(resultado, campo.id, sugerencia, true)
  }
  return resultado
}
