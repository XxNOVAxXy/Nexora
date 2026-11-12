import type { CampoExtra, Resumen, SugerenciaCampo, Transaccion } from '../types'
import { rellenarColumnasIa } from './camposExtra'
import type { FormatoNumerico, ValidacionContable } from './contabilidad'
import { ErrorApi, type EstadoExtraccion, type ExtraccionGuardada, type ProblemasRevision } from './extraccionesApi'
import type { GeminiExtractionResponse } from './geminiApi'
import { combinarExtraccion, type ResultadoCombinacion } from './transacciones'

/** Lo que el usuario edita de un documento y se persiste en el backend. */
export type DocumentoEditable = {
  estado: EstadoExtraccion
  resumen: Resumen | null
  transacciones: Transaccion[]
  formato_numerico: FormatoNumerico | null
  modelo: string | null
  prompt_version: string | null
  /** Columnas adicionales de la tabla (botón "+ Campo"). */
  campos_extra: CampoExtra[]
  /** Campos que propuso la IA en la última extracción; se guardan para que el menú siga disponible al recargar. */
  sugerencias_campos: SugerenciaCampo[]
}

export const documentoVacio = (): DocumentoEditable => ({ estado: 'borrador', resumen: null, transacciones: [], formato_numerico: null, modelo: null, prompt_version: null, campos_extra: [], sugerencias_campos: [] })

/** Documentos y borradores anteriores a las columnas adicionales no traen esos datos: se leen como vacíos. */
export const conColumnasExtra = (documento: Omit<DocumentoEditable, 'campos_extra' | 'sugerencias_campos'> & Partial<Pick<DocumentoEditable, 'campos_extra' | 'sugerencias_campos'>>): DocumentoEditable => ({
  ...documento,
  campos_extra: Array.isArray(documento.campos_extra) ? documento.campos_extra : [],
  sugerencias_campos: Array.isArray(documento.sugerencias_campos) ? documento.sugerencias_campos : [],
})

/**
 * Resultado de Gemini → documento editable, combinado con las filas vigentes (se conservan las manuales y las
 * editadas). Queda como borrador. Lo usan la pestaña al aplicar una extracción y el contenedor al escribir el
 * borrador local de una pestaña que nunca se abrió. Las columnas adicionales vigentes se conservan; las celdas
 * vacías de las columnas de la IA se rellenan y las sugerencias se reemplazan por las de esta extracción.
 */
export function documentoDesdeExtraccion(result: GeminiExtractionResponse, actuales: Transaccion[], lote: string, campos: CampoExtra[] = []): { documento: DocumentoEditable; combinacion: ResultadoCombinacion } {
  const combinacion = combinarExtraccion(actuales, result.transacciones, lote)
  const sugerencias = Array.isArray(result.sugerencias_campos) ? result.sugerencias_campos : []
  const transacciones = rellenarColumnasIa(combinacion.transacciones, campos, sugerencias)
  return {
    documento: { estado: 'borrador', resumen: result.resumen, transacciones, formato_numerico: result.formato_numerico, modelo: result.model, prompt_version: result.prompt_version, campos_extra: campos, sugerencias_campos: sugerencias },
    combinacion: { ...combinacion, transacciones },
  }
}

export const documentoDesdeGuardado = (guardado: ExtraccionGuardada): DocumentoEditable => ({
  estado: guardado.estado,
  resumen: guardado.resumen,
  transacciones: guardado.transacciones,
  formato_numerico: guardado.formato_numerico,
  modelo: guardado.modelo,
  prompt_version: guardado.prompt_version,
  campos_extra: Array.isArray(guardado.campos_extra) ? guardado.campos_extra : [],
  sugerencias_campos: Array.isArray(guardado.sugerencias_campos) ? guardado.sugerencias_campos : [],
})

/** JSON con claves ordenadas y sin `undefined`: la misma información da siempre la misma firma. */
function canonico(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonico)
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.keys(valor).sort().filter((clave) => (valor as Record<string, unknown>)[clave] !== undefined).map((clave) => [clave, canonico((valor as Record<string, unknown>)[clave])]))
  }
  return valor
}

export const firmaContenido = (documento: DocumentoEditable) => JSON.stringify(canonico(documento))

/** ¿Hay cambios sin guardar? Sin versión guardada, cualquier contenido cuenta como cambio. */
export function hayCambios(documento: DocumentoEditable, firmaGuardada: string | null): boolean {
  if (firmaGuardada === null) return documento.resumen !== null || documento.transacciones.length > 0 || documento.campos_extra.length > 0
  return firmaContenido(documento) !== firmaGuardada
}

/** Mismo cálculo que contar_problemas() del backend: lo que exige confirmación para marcar como revisado. */
export function contarProblemas(validacion: ValidacionContable, resumen: Resumen | null, transacciones: Transaccion[]): ProblemasRevision {
  const diferencias = validacion.comprobaciones.filter((item) => item.estado === 'diferencia').length
  const dudososPorFila = new Set(transacciones.flatMap((transaccion) => transaccion.dudosos.map((campo) => `${transaccion.id}|${campo}`)))
  const dudosos = (resumen?.dudosos.length ?? 0) + dudososPorFila.size
  const invalidos = validacion.importes_invalidos.filter((item) => !dudososPorFila.has(`${item.id}|${item.campo}`)).length
  const enRevision = transacciones.filter((transaccion) => transaccion.revision).length
  const incompleta = validacion.cuadra === null
  return { cuadra: validacion.cuadra, diferencias, dudosos, invalidos, en_revision: enRevision, validacion_incompleta: incompleta, total: diferencias + dudosos + invalidos + enRevision + (incompleta ? 1 : 0) }
}

export type ResultadoGuardado =
  | { ok: true; extraccion: ExtraccionGuardada }
  | { ok: false; tipo: 'conflicto' | 'revision_con_problemas' | 'error'; mensaje: string; problemas?: ProblemasRevision }

/**
 * Ejecuta el guardado y solo informa éxito si el backend respondió OK con una extracción válida.
 * Cualquier otro caso devuelve el mensaje real del error para mostrarlo en la interfaz.
 */
export async function ejecutarGuardado(guardar: () => Promise<ExtraccionGuardada>): Promise<ResultadoGuardado> {
  try {
    const extraccion = await guardar()
    if (!extraccion || typeof extraccion.version !== 'number') return { ok: false, tipo: 'error', mensaje: 'El backend respondió sin confirmar el guardado.' }
    return { ok: true, extraccion }
  } catch (error) {
    if (error instanceof ErrorApi) {
      if (error.status === 409) return { ok: false, tipo: 'conflicto', mensaje: error.message }
      if (error.code === 'revision_con_problemas') {
        const detalle = error.detalle as { problemas?: ProblemasRevision } | null
        return { ok: false, tipo: 'revision_con_problemas', mensaje: error.message, problemas: detalle?.problemas }
      }
      return { ok: false, tipo: 'error', mensaje: error.message }
    }
    return { ok: false, tipo: 'error', mensaje: error instanceof Error ? error.message : 'No se pudo guardar la extracción.' }
  }
}

// --- Borrador local (solo cambios aún no guardados en el backend) ---------------------------------

export type BorradorLocal = { version_base: number | null; guardadoEn: string; documento: DocumentoEditable }
type AlmacenLocal = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PREFIJO_BORRADOR = 'nexora.borrador.'
export const claveBorrador = (cuentaId: string, messageId: string, partId: string) => `${PREFIJO_BORRADOR}${cuentaId}.${messageId}__${partId}`

function almacenNavegador(): AlmacenLocal | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Acceso tolerante a fallos: en modo privado o sin almacenamiento, el borrador local simplemente no existe. */
export function borradoresLocales(almacen: AlmacenLocal | null = almacenNavegador()) {
  return {
    leer(clave: string): BorradorLocal | null {
      try {
        const crudo = almacen?.getItem(clave)
        if (!crudo) return null
        const valor = JSON.parse(crudo) as BorradorLocal
        // Un borrador escrito antes de las columnas adicionales abre igual, sin columnas.
        return valor && Array.isArray(valor.documento?.transacciones) ? { ...valor, documento: conColumnasExtra(valor.documento) } : null
      } catch {
        return null
      }
    },
    guardar(clave: string, borrador: BorradorLocal) {
      try { almacen?.setItem(clave, JSON.stringify(borrador)) } catch { /* sin espacio o sin almacenamiento */ }
    },
    borrar(clave: string) {
      try { almacen?.removeItem(clave) } catch { /* sin almacenamiento */ }
    },
  }
}
