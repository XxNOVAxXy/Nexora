import type { AlcanceCampo, CampoExtra } from '../types'
import { errorNombreCampo, MAX_CAMPOS_EXTRA, nombreComparable } from './camposExtra'

/**
 * Configuración de campos: los campos que se capturan de cada estado de cuenta, definidos una vez por cuenta.
 * Misma lógica que backend/app/plantilla_campos.py (el backend la aplica al abrir un documento guardado; aquí se
 * aplica a los documentos nuevos antes de extraer y al editar la configuración).
 */
export type CampoPlantilla = { id: string; nombre: string; origen: 'ia' | 'manual'; alcance: AlcanceCampo; clave?: string }
export type Plantilla = { configurada: boolean; campos: CampoPlantilla[]; actualizado: string | null }
/** Campo que la IA encontró en el documento de ejemplo, con un valor de ejemplo y su tipo. */
export type SugerenciaPlantilla = { clave: string; nombre: string; ejemplo: string; alcance: AlcanceCampo; filas: number }

export const CAMPOS_FIJOS = ['Fecha', 'Concepto', 'Referencia', 'Cargo', 'Abono', 'Saldo']
export const etiquetaAlcance = (alcance: AlcanceCampo) => (alcance === 'documento' ? 'Una vez' : 'En cada movimiento')

let secuencia = 0
export function nuevoIdPlantilla(): string {
  secuencia += 1
  return `pl-${Date.now().toString(36)}-${secuencia}`
}

/** Error del nombre de un campo de la configuración, o null si es válido (mismas reglas que "+ Campo"). */
export function errorNombrePlantilla(nombre: string, campos: CampoPlantilla[], excepto?: string): string | null {
  return errorNombreCampo(nombre, campos.map((campo) => ({ id: campo.id, nombre: campo.nombre, origen: campo.origen })), excepto)
}

export function agregarAPlantilla(campos: CampoPlantilla[], campo: Omit<CampoPlantilla, 'id'> & { id?: string }): CampoPlantilla[] {
  if (campos.length >= MAX_CAMPOS_EXTRA || errorNombrePlantilla(campo.nombre, campos)) return campos
  const { id, ...resto } = campo
  return [...campos, { ...resto, id: id ?? nuevoIdPlantilla(), nombre: campo.nombre.replace(/\s+/g, ' ').trim() }]
}

export const renombrarEnPlantilla = (campos: CampoPlantilla[], id: string, nombre: string) =>
  errorNombrePlantilla(nombre, campos, id) ? campos : campos.map((campo) => (campo.id === id ? { ...campo, nombre: nombre.replace(/\s+/g, ' ').trim() } : campo))
export const cambiarTipoEnPlantilla = (campos: CampoPlantilla[], id: string, alcance: AlcanceCampo) => campos.map((campo) => (campo.id === id ? { ...campo, alcance } : campo))
export const quitarDePlantilla = (campos: CampoPlantilla[], id: string) => campos.filter((campo) => campo.id !== id)

/** Sugerencias del documento de ejemplo que todavía no están en la lista. */
export const sugerenciasNuevas = (sugerencias: SugerenciaPlantilla[], campos: CampoPlantilla[]) =>
  sugerencias.filter((sugerencia) => !campos.some((campo) => nombreComparable(campo.nombre) === nombreComparable(sugerencia.nombre)))

/**
 * Vincula y completa los campos de un documento con la configuración. Nunca borra ni cambia valores; si no cambia
 * nada devuelve la misma lista.
 * - Un campo vinculado (plantilla_id) toma el nombre actual de la configuración (si no choca con otro del documento).
 * - Un campo sin vínculo con el mismo nombre queda vinculado.
 * - Los campos configurados que faltan se agregan vacíos. Los campos solo del documento no cambian.
 */
export function aplicarPlantilla(campos: CampoExtra[], plantilla: CampoPlantilla[]): CampoExtra[] {
  if (plantilla.length === 0) return campos
  const resultado = campos.map((campo) => ({ ...campo }))
  let cambio = false
  for (const configurado of plantilla) {
    let vinculado = resultado.find((campo) => campo.plantilla_id === configurado.id)
    if (!vinculado) {
      vinculado = resultado.find((campo) => !campo.plantilla_id && nombreComparable(campo.nombre) === nombreComparable(configurado.nombre))
      if (vinculado) { vinculado.plantilla_id = configurado.id; cambio = true }
    }
    if (vinculado) {
      const choca = resultado.some((campo) => campo !== vinculado && nombreComparable(campo.nombre) === nombreComparable(configurado.nombre))
      if (vinculado.nombre !== configurado.nombre && !choca) { vinculado.nombre = configurado.nombre; cambio = true }
      continue
    }
    if (resultado.length >= MAX_CAMPOS_EXTRA || resultado.some((campo) => nombreComparable(campo.nombre) === nombreComparable(configurado.nombre))) continue
    const id = resultado.some((campo) => campo.id === configurado.id) ? `${configurado.id}-${resultado.length + 1}` : configurado.id
    resultado.push({ id, nombre: configurado.nombre, origen: configurado.origen, plantilla_id: configurado.id, ...(configurado.clave ? { clave: configurado.clave } : {}), ...(configurado.alcance === 'documento' ? { alcance: 'documento' as const, valor: '' } : {}) })
    cambio = true
  }
  return cambio ? resultado : campos
}
