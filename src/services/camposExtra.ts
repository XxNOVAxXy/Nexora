import type { CampoExtra, ResultadoCampo, SugerenciaCampo, Transaccion } from '../types'

/**
 * Columnas adicionales de la tabla de Movimientos (botón "+ Campo").
 * Se editan, se guardan y se conservan al re-extraer como las demás columnas, pero no entran en la validación
 * contable ni se envían a SaveData. La IA puede llenar las celdas vacías de las columnas manuales; esas celdas
 * quedan marcadas en `extras_ia` hasta que el usuario las edite.
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

/** ¿La celda la llenó la IA (y el usuario no la ha editado)? */
export const esCeldaDeIa = (transaccion: Transaccion, campoId: string) => Boolean(transaccion.extras_ia?.includes(campoId))

/**
 * Fija el valor de una columna en una fila. Un valor vacío quita la celda para no guardar datos vacíos.
 * `deIa` marca la celda como llenada por la IA; cualquier otro cambio le quita la marca.
 */
function fijarExtra(transaccion: Transaccion, campoId: string, valor: string, deIa = false): Transaccion {
  const extras = { ...(transaccion.extras ?? {}) }
  if (valor) extras[campoId] = valor
  else delete extras[campoId]
  const marcadas = (transaccion.extras_ia ?? []).filter((id) => id !== campoId)
  if (deIa && valor) marcadas.push(campoId)
  const { extras: _extras, extras_ia: _marcadas, ...resto } = transaccion
  return { ...resto, ...(Object.keys(extras).length > 0 ? { extras } : {}), ...(marcadas.length > 0 ? { extras_ia: marcadas } : {}) }
}

/** Edición manual de una celda adicional: una fila de la IA pasa a `ia_editada`, igual que con las demás columnas. */
export function editarExtra(transaccion: Transaccion, campoId: string, valor: string): Transaccion {
  if ((transaccion.extras?.[campoId] ?? '') === valor) return transaccion
  const editada = fijarExtra(transaccion, campoId, valor.slice(0, MAX_VALOR_CAMPO))
  return { ...editada, origen: transaccion.origen === 'ia' ? 'ia_editada' : transaccion.origen }
}

/** De dónde salen los valores: uno único del documento, por huella (en orden) o por id de fila ("Llenar con IA"). */
export type FuenteValores = { unico: string } | { porHuella: { huella: string; valor: string }[] } | { porId: Map<string, string> }

/**
 * Llena una columna con valores de la IA. Con `soloVacias` nunca sobrescribe lo ya capturado. Llenar no cuenta
 * como edición manual: el origen de la fila no cambia. Devuelve cuántas celdas se llenaron.
 */
function llenarColumna(transacciones: Transaccion[], campoId: string, fuente: FuenteValores, { soloVacias, marcar }: { soloVacias: boolean; marcar: boolean }) {
  const porHuella = new Map<string, string[]>()
  if ('porHuella' in fuente) for (const { huella, valor } of fuente.porHuella) porHuella.set(huella, [...(porHuella.get(huella) ?? []), valor])
  let llenadas = 0
  const resultado = transacciones.map((transaccion) => {
    const valor = 'unico' in fuente ? fuente.unico : 'porId' in fuente ? fuente.porId.get(transaccion.id) ?? '' : transaccion.huella ? porHuella.get(transaccion.huella)?.shift() ?? '' : ''
    if (!valor || (soloVacias && transaccion.extras?.[campoId]?.trim())) return transaccion
    llenadas += 1
    return fijarExtra(transaccion, campoId, valor.slice(0, MAX_VALOR_CAMPO), marcar)
  })
  return { transacciones: resultado, llenadas }
}

const fuenteDeSugerencia = (sugerencia: { valores: { huella: string; valor: string }[]; valor_documento?: string }): FuenteValores =>
  sugerencia.valores.length === 0 ? { unico: sugerencia.valor_documento ?? '' } : { porHuella: sugerencia.valores }

export type ColumnasDocumento = { transacciones: Transaccion[]; campos_extra: CampoExtra[] }

/** Agrega la columna de una sugerencia de la IA con los valores que encontró. Aplicarla no cuenta como edición manual. */
export function aplicarSugerencia(documento: ColumnasDocumento, sugerencia: SugerenciaCampo): ColumnasDocumento {
  if (documento.campos_extra.length >= MAX_CAMPOS_EXTRA) return documento
  const campo: CampoExtra = { id: nuevoIdCampo(), nombre: limpiarNombre(sugerencia.nombre).slice(0, MAX_NOMBRE_CAMPO), origen: 'ia', clave: sugerencia.clave }
  return { campos_extra: [...documento.campos_extra, campo], transacciones: llenarColumna(documento.transacciones, campo.id, fuenteDeSugerencia(sugerencia), { soloVacias: false, marcar: false }).transacciones }
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

// --- La IA llena columnas manuales ----------------------------------------------------------------

/** Resultado de buscar una columna manual en el documento, para los mensajes junto a la columna y en el aviso. */
export type ResultadoLlenado = {
  campoId: string
  nombre: string
  estado: 'no_encontrado' | 'llenado' | 'completa' | 'sin_valores_para_vacias'
  llenadas: number
}

export function mensajeLlenado(resultado: ResultadoLlenado): string {
  const { nombre, llenadas } = resultado
  switch (resultado.estado) {
    case 'no_encontrado': return `No se encontró «${nombre}» en el documento.`
    case 'llenado': return `Se llenaron ${llenadas} celda${llenadas === 1 ? '' : 's'} de «${nombre}».`
    case 'completa': return 'La columna ya estaba completa; no se cambió nada.'
    case 'sin_valores_para_vacias': return `La IA encontró «${nombre}», pero no para las celdas vacías; no se cambió nada.`
  }
}

/** Nombres de las columnas manuales que se piden a Gemini al extraer. */
export const camposParaSolicitar = (campos: CampoExtra[]) => campos.filter((campo) => campo.origen === 'manual').map((campo) => campo.nombre)

/** Llena las celdas vacías de una columna manual con lo que encontró la IA y describe el resultado. */
export function llenarColumnaManual(transacciones: Transaccion[], campo: CampoExtra, encontrado: boolean, fuente: FuenteValores): { transacciones: Transaccion[]; resultado: ResultadoLlenado } {
  const base = { campoId: campo.id, nombre: campo.nombre }
  const tieneVacias = transacciones.some((transaccion) => !transaccion.extras?.[campo.id]?.trim())
  if (!encontrado) return { transacciones, resultado: { ...base, estado: 'no_encontrado', llenadas: 0 } }
  if (!tieneVacias) return { transacciones, resultado: { ...base, estado: 'completa', llenadas: 0 } }
  const llenado = llenarColumna(transacciones, campo.id, fuente, { soloVacias: true, marcar: true })
  return { transacciones: llenado.transacciones, resultado: { ...base, estado: llenado.llenadas > 0 ? 'llenado' : 'sin_valores_para_vacias', llenadas: llenado.llenadas } }
}

/**
 * Tras extraer o re-extraer: las columnas y lo capturado se conservan (combinarExtraccion ya pasó los valores de las
 * filas de la IA sin editar a su fila nueva). Las celdas vacías de las columnas de la IA se rellenan con las nuevas
 * sugerencias, y las de las columnas manuales con lo que la IA encontró al buscarlas. Solo se llenan celdas vacías.
 */
export function rellenarColumnas(transacciones: Transaccion[], campos: CampoExtra[], sugerencias: SugerenciaCampo[], resultados: ResultadoCampo[]): { transacciones: Transaccion[]; llenado: ResultadoLlenado[] } {
  let actuales = transacciones
  const llenado: ResultadoLlenado[] = []
  for (const campo of campos) {
    if (campo.origen === 'ia') {
      const sugerencia = campo.clave ? sugerencias.find((item) => item.clave === campo.clave) : undefined
      if (sugerencia) actuales = llenarColumna(actuales, campo.id, fuenteDeSugerencia(sugerencia), { soloVacias: true, marcar: false }).transacciones
      continue
    }
    const resultado = resultados.find((item) => nombreComparable(item.nombre) === nombreComparable(campo.nombre))
    if (!resultado) continue
    const paso = llenarColumnaManual(actuales, campo, resultado.encontrado, fuenteDeSugerencia(resultado))
    actuales = paso.transacciones
    llenado.push(paso.resultado)
  }
  return { transacciones: actuales, llenado }
}

/** Respuesta de "Llenar con IA" (por índice de las filas enviadas) → fuente por id de fila. */
export function fuenteDeLlenado(respuesta: { valores: { indice: number; valor: string }[]; valor_documento?: string }, idsEnviados: string[]): FuenteValores {
  if (respuesta.valores.length === 0) return { unico: respuesta.valor_documento ?? '' }
  return { porId: new Map(respuesta.valores.filter((item) => idsEnviados[item.indice] !== undefined).map((item) => [idsEnviados[item.indice], item.valor])) }
}
