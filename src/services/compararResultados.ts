/**
 * Comparación de dos resultados de extracción (las reglas, «manual», contra la IA), campo por campo.
 * Adaptado de singularity/src/features/comparison/utils/compareResults.ts (compareSnapshots, summarizeComparison).
 *
 * Diferencias con el original: los estados se llaman coincide | diferente | solo_manual | solo_ia | vacio, y dos
 * valores coinciden aunque cambien mayúsculas, acentos o espacios («Cliente  Ficticio» = «cliente ficticio»).
 */
import { request } from './extraccionesApi'

export type EstadoComparacion = 'coincide' | 'diferente' | 'solo_manual' | 'solo_ia' | 'vacio'
export type FiltroComparacion = EstadoComparacion | 'todos'

export type FilaComparacion = { clave: string; campo: string; manual: string; ia: string; estado: EstadoComparacion; configurado: boolean }
export type ResumenComparacion = { coincide: number; diferente: number; solo_manual: number; solo_ia: number; vacio: number; total: number }

const comparable = (valor: string) => valor.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** compareSnapshots: una fila por campo (los de las dos extracciones), en el orden de los campos configurados. */
export function compararResultados(manual: Record<string, string>, ia: Record<string, string>, configurados: string[] = []): FilaComparacion[] {
  const nombres = [...new Set([...configurados, ...Object.keys(manual), ...Object.keys(ia)])]
  return nombres.map((campo) => {
    const valorManual = (manual[campo] ?? '').trim()
    const valorIa = (ia[campo] ?? '').trim()
    let estado: EstadoComparacion
    if (!valorManual && !valorIa) estado = 'vacio'
    else if (valorManual && !valorIa) estado = 'solo_manual'
    else if (!valorManual && valorIa) estado = 'solo_ia'
    else if (comparable(valorManual) === comparable(valorIa)) estado = 'coincide'
    else estado = 'diferente'
    return { clave: comparable(campo), campo, manual: valorManual, ia: valorIa, estado, configurado: configurados.includes(campo) }
  })
}

/** summarizeComparison. */
export function resumirComparacion(filas: FilaComparacion[]): ResumenComparacion {
  return filas.reduce<ResumenComparacion>((resumen, fila) => ({ ...resumen, [fila.estado]: resumen[fila.estado] + 1, total: resumen.total + 1 }),
    { coincide: 0, diferente: 0, solo_manual: 0, solo_ia: 0, vacio: 0, total: 0 })
}

export const filtrarComparacion = (filas: FilaComparacion[], filtro: FiltroComparacion) => (filtro === 'todos' ? filas : filas.filter((fila) => fila.estado === filtro))

export const ESTADO_COMPARACION: Record<EstadoComparacion, { texto: string; clase: string }> = {
  coincide: { texto: 'Coincide', clase: 'bg-emerald-50 text-emerald-700' },
  diferente: { texto: 'Diferente', clase: 'bg-rose-50 text-rose-700' },
  solo_manual: { texto: 'Solo manual', clase: 'bg-amber-50 text-amber-700' },
  solo_ia: { texto: 'Solo IA', clase: 'bg-sky-50 text-sky-700' },
  vacio: { texto: 'Vacío', clase: 'bg-slate-100 text-slate-500' },
}

/** «Tienes 5 campos, la IA encontró 10. ¿Agregar?» */
export const textoOferta = (configurados: number, encontrados: number) => `Tienes ${configurados} campo${configurados === 1 ? '' : 's'}, la IA encontró ${encontrados}. ¿Agregar?`

export type SugerenciaIa = { nombre: string; alcance: 'documento' | 'movimiento'; ejemplo: string }
export type ResultadoComparacion = {
  tipo: { id: string; nombre: string; codigo: string; contable: boolean }
  estructura: { id: string; nombre: string; version_activa: number; versiones: number[] } | null
  version_usada: number | null
  campos: { nombre: string; alcance: string }[]
  manual: Record<string, string>
  ia: Record<string, string>
  sugerencias: SugerenciaIa[]
  campos_configurados: number
  ia_encontrados: number
  modelo: string | null
}

const ruta = (messageId: string, partId: string) => `${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`
const json = (valor: unknown) => JSON.stringify(valor)

export const comparacionApi = {
  comparar: (messageId: string, partId: string, attachmentId: string | null) =>
    request<ResultadoComparacion>(`/extracciones/${ruta(messageId, partId)}/comparar`, { method: 'POST', body: json({ attachmentId }) }),
  crearVersion: (tipoId: string, estructuraId: string | null, campos: { nombre: string; alcance: string }[]) =>
    request<{ version: number; agregados: string[] }>(`/tipos/${encodeURIComponent(tipoId)}/versiones`, { method: 'POST', body: json({ estructura_id: estructuraId, campos }) }),
  reprocesarVersion: (messageId: string, partId: string, version: number, attachmentId: string | null) =>
    request<{ version: number; encontrados: number | null; total_campos: number | null }>(`/extracciones/${ruta(messageId, partId)}/reprocesar-version`, { method: 'POST', body: json({ version, attachmentId }) }),
}
