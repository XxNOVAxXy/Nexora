import type { AlcanceCampo, CampoExtra, ResultadoCampo, SugerenciaCampo, Transaccion } from '../types'

/**
 * Campos adicionales de Movimientos (botón "+ Campo"). Hay dos tipos:
 * - del documento (`alcance: 'documento'`): un dato que aparece una sola vez (RFC, número de crédito…). Se guarda
 *   una sola vez en el propio campo y nunca se repite en cada movimiento;
 * - por movimiento: un valor en cada movimiento (`extras`).
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

/** ¿El campo es un dato único del documento (no uno por movimiento)? */
export const esDelDocumento = (campo: CampoExtra) => campo.alcance === 'documento'

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
  // Un valor único del documento se guarda una sola vez en el campo, no en cada movimiento.
  if (sugerencia.valores.length === 0) return { ...documento, campos_extra: [...documento.campos_extra, { ...campo, alcance: 'documento', valor: (sugerencia.valor_documento ?? '').slice(0, MAX_VALOR_CAMPO) }] }
  return { campos_extra: [...documento.campos_extra, campo], transacciones: llenarColumna(documento.transacciones, campo.id, fuenteDeSugerencia(sugerencia), { soloVacias: false, marcar: false }).transacciones }
}

/** Agrega un campo vacío con el nombre que escribió el usuario (validado antes con errorNombreCampo). */
export function agregarCampoManual(campos: CampoExtra[], nombre: string, alcance: AlcanceCampo = 'movimiento'): CampoExtra[] {
  if (campos.length >= MAX_CAMPOS_EXTRA || errorNombreCampo(nombre, campos)) return campos
  const campo: CampoExtra = { id: nuevoIdCampo(), nombre: limpiarNombre(nombre), origen: 'manual' }
  return [...campos, alcance === 'documento' ? { ...campo, alcance, valor: '' } : campo]
}

/** Edición a mano del valor de un campo del documento: deja de contar como llenado por la IA. */
export function editarValorDocumento(campos: CampoExtra[], id: string, valor: string): CampoExtra[] {
  return campos.map((campo) => {
    if (campo.id !== id || (campo.valor ?? '') === valor) return campo
    const { valor_ia: _ia, ...resto } = campo
    return { ...resto, valor: valor.slice(0, MAX_VALOR_CAMPO) }
  })
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
  estado: 'no_encontrado' | 'llenado' | 'completa' | 'sin_valores_para_vacias' | 'dato_del_documento' | 'unico_con_valores' | 'por_movimiento'
  llenadas: number
  /** Valor único que encontró la IA (para explicar por qué no se repitió en cada movimiento). */
  valor?: string
}

export function mensajeLlenado(resultado: ResultadoLlenado): string {
  const { nombre, llenadas } = resultado
  switch (resultado.estado) {
    case 'no_encontrado': return `No se encontró «${nombre}» en el documento.`
    case 'llenado': return `Se llenaron ${llenadas} celda${llenadas === 1 ? '' : 's'} de «${nombre}».`
    case 'completa': return 'La columna ya estaba completa; no se cambió nada.'
    case 'sin_valores_para_vacias': return `La IA encontró «${nombre}», pero no para las celdas vacías; no se cambió nada.`
    case 'dato_del_documento': return `«${nombre}» aparece una sola vez en el documento: se guardó una vez, no en cada movimiento.`
    case 'unico_con_valores': return `La IA encontró «${nombre}» una sola vez en el documento (${resultado.valor ?? ''}); no se repitió en cada movimiento y lo capturado no cambió.`
    case 'por_movimiento': return `La IA encontró «${nombre}» en cada movimiento, no como un dato único; no se cambió nada.`
  }
}

/** Nombres de las columnas manuales que se piden a Gemini al extraer. */
export const camposParaSolicitar = (campos: CampoExtra[]) => campos.filter((campo) => campo.origen === 'manual').map((campo) => campo.nombre)

/**
 * Llena un campo manual con lo que encontró la IA y describe el resultado. Nunca sobrescribe lo ya capturado.
 * Un valor único del documento no se repite en cada movimiento: se guarda una vez en el campo (si el campo todavía
 * no tiene valores por movimiento, pasa a ser un dato del documento).
 */
export function llenarColumnaManual(transacciones: Transaccion[], campo: CampoExtra, encontrado: boolean, fuente: FuenteValores): { transacciones: Transaccion[]; campo: CampoExtra; resultado: ResultadoLlenado } {
  const base = { campoId: campo.id, nombre: campo.nombre }
  const sinCambios = (estado: ResultadoLlenado['estado'], extra: Partial<ResultadoLlenado> = {}) => ({ transacciones, campo, resultado: { ...base, estado, llenadas: 0, ...extra } })
  if (!encontrado) return sinCambios('no_encontrado')
  const unico = 'unico' in fuente ? fuente.unico.trim().slice(0, MAX_VALOR_CAMPO) : null
  if (unico !== null && !unico) return sinCambios('no_encontrado')
  if (esDelDocumento(campo)) {
    if (unico === null) return sinCambios('por_movimiento')
    if (campo.valor?.trim()) return sinCambios('completa')
    return { transacciones, campo: { ...campo, valor: unico, valor_ia: true }, resultado: { ...base, estado: 'dato_del_documento', llenadas: 1 } }
  }
  if (unico !== null) {
    const conValores = transacciones.some((transaccion) => transaccion.extras?.[campo.id]?.trim())
    if (conValores) return sinCambios('unico_con_valores', { valor: unico })
    return { transacciones, campo: { ...campo, alcance: 'documento', valor: unico, valor_ia: true }, resultado: { ...base, estado: 'dato_del_documento', llenadas: 1 } }
  }
  const tieneVacias = transacciones.some((transaccion) => !transaccion.extras?.[campo.id]?.trim())
  if (!tieneVacias) return sinCambios('completa')
  const llenado = llenarColumna(transacciones, campo.id, fuente, { soloVacias: true, marcar: true })
  return { transacciones: llenado.transacciones, campo, resultado: { ...base, estado: llenado.llenadas > 0 ? 'llenado' : 'sin_valores_para_vacias', llenadas: llenado.llenadas } }
}

/**
 * Tras extraer o re-extraer: los campos y lo capturado se conservan (combinarExtraccion ya pasó los valores de las
 * filas de la IA sin editar a su fila nueva). Los campos de la IA se completan con las nuevas sugerencias y los
 * manuales con lo que la IA encontró al buscarlos. Solo se llena lo vacío; un dato único del documento se guarda una
 * sola vez en su campo, nunca en cada movimiento.
 */
export function rellenarColumnas(transacciones: Transaccion[], campos: CampoExtra[], sugerencias: SugerenciaCampo[], resultados: ResultadoCampo[]): { transacciones: Transaccion[]; campos: CampoExtra[]; llenado: ResultadoLlenado[] } {
  let actuales = transacciones
  const llenado: ResultadoLlenado[] = []
  const nuevos = campos.map((campo) => {
    if (campo.origen === 'ia') {
      const sugerencia = campo.clave ? sugerencias.find((item) => item.clave === campo.clave) : undefined
      if (!sugerencia) return campo
      if (esDelDocumento(campo)) return !campo.valor?.trim() && sugerencia.valor_documento ? { ...campo, valor: sugerencia.valor_documento.slice(0, MAX_VALOR_CAMPO) } : campo
      if (sugerencia.valores.length > 0) actuales = llenarColumna(actuales, campo.id, fuenteDeSugerencia(sugerencia), { soloVacias: true, marcar: false }).transacciones
      return campo
    }
    const resultado = resultados.find((item) => nombreComparable(item.nombre) === nombreComparable(campo.nombre))
    if (!resultado) return campo
    const paso = llenarColumnaManual(actuales, campo, resultado.encontrado, fuenteDeSugerencia(resultado))
    actuales = paso.transacciones
    llenado.push(paso.resultado)
    return paso.campo
  })
  const cambiaron = nuevos.some((campo, indice) => campo !== campos[indice])
  return { transacciones: actuales, campos: cambiaron ? nuevos : campos, llenado }
}

/** Respuesta de "Llenar con IA" (por índice de las filas enviadas) → fuente por id de fila. */
export function fuenteDeLlenado(respuesta: { valores: { indice: number; valor: string }[]; valor_documento?: string }, idsEnviados: string[]): FuenteValores {
  if (respuesta.valores.length === 0) return { unico: respuesta.valor_documento ?? '' }
  return { porId: new Map(respuesta.valores.filter((item) => idsEnviados[item.indice] !== undefined).map((item) => [idsEnviados[item.indice], item.valor])) }
}

// --- Corregir el tipo de un campo y migrar extracciones anteriores --------------------------------

/** Valores distintos (no vacíos) que tiene un campo por movimiento. */
const valoresDeFilas = (transacciones: Transaccion[], id: string) => [...new Set(transacciones.map((transaccion) => transaccion.extras?.[id]?.trim() ?? '').filter(Boolean))]

/** Un campo por movimiento puede pasar a dato del documento solo si no se pierde nada: todos sus valores son iguales. */
export const puedeSerDelDocumento = (transacciones: Transaccion[], campo: CampoExtra) => esDelDocumento(campo) || valoresDeFilas(transacciones, campo.id).length <= 1

/**
 * El usuario corrige el tipo que eligió la IA.
 * - documento → movimiento: el valor se copia a cada movimiento (marcado como de la IA si lo llenó la IA).
 * - movimiento → documento: solo si todos los valores capturados son iguales; ese valor queda una sola vez.
 * Si el cambio perdería datos, devuelve el mismo documento.
 */
export function cambiarAlcance(documento: ColumnasDocumento, id: string, alcance: AlcanceCampo): ColumnasDocumento {
  const campo = documento.campos_extra.find((item) => item.id === id)
  if (!campo || (alcance === 'documento') === esDelDocumento(campo)) return documento
  const { alcance: _alcance, valor: _valor, valor_ia: _valorIa, ...base } = campo
  if (alcance === 'movimiento') {
    const valor = campo.valor?.trim() ?? ''
    return {
      campos_extra: documento.campos_extra.map((item) => (item.id === id ? base : item)),
      transacciones: valor ? llenarColumna(documento.transacciones, id, { unico: valor }, { soloVacias: false, marcar: Boolean(campo.valor_ia) }).transacciones : documento.transacciones,
    }
  }
  const valores = valoresDeFilas(documento.transacciones, id)
  if (valores.length > 1) return documento
  const conValor = documento.transacciones.filter((transaccion) => transaccion.extras?.[id]?.trim())
  const deIa = conValor.length > 0 && conValor.every((transaccion) => esCeldaDeIa(transaccion, id))
  return {
    campos_extra: documento.campos_extra.map((item) => (item.id === id ? { ...base, alcance: 'documento', valor: valores[0] ?? '', ...(deIa ? { valor_ia: true } : {}) } : item)),
    transacciones: documento.transacciones.map((transaccion) => (transaccion.extras && id in transaccion.extras ? fijarExtra(transaccion, id, '') : transaccion)),
  }
}

/**
 * Extracciones y borradores anteriores a los datos del documento: una columna por movimiento con el mismo valor
 * (no vacío) en todos los movimientos (2 o más) pasa a ser dato del documento. Mismo criterio que el backend
 * (migrar_columnas_unicas). Si no hay nada que migrar devuelve el mismo documento.
 */
export function migrarColumnasUnicas<T extends ColumnasDocumento>(documento: T): T {
  if (documento.transacciones.length < 2) return documento
  let actual: ColumnasDocumento = documento
  for (const campo of documento.campos_extra) {
    if (esDelDocumento(campo)) continue
    const todas = documento.transacciones.map((transaccion) => transaccion.extras?.[campo.id]?.trim() ?? '')
    if (todas.some((valor) => !valor) || new Set(todas).size !== 1) continue
    actual = cambiarAlcance(actual, campo.id, 'documento')
  }
  return actual === documento ? documento : { ...documento, ...actual }
}
