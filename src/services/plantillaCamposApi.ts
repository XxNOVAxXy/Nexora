import { ErrorApi, request } from './extraccionesApi'
import type { CampoPlantilla, Plantilla, SugerenciaPlantilla } from './plantillaCampos'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export const plantillaCamposApi = {
  obtener: () => request<Plantilla>('/configuracion/campos'),
  guardar: (campos: CampoPlantilla[]) => request<Plantilla>('/configuracion/campos', { method: 'PUT', body: JSON.stringify({ campos }) }),
  /** El archivo de ejemplo viaja como cuerpo binario; el backend no lo guarda ni lo envía a SaveData. */
  sugerir: async (archivo: File): Promise<SugerenciaPlantilla[]> => {
    const params = new URLSearchParams({ filename: archivo.name || 'ejemplo', tipo: archivo.type || '' })
    let response: Response
    try {
      response = await fetch(`${API_URL}/configuracion/campos/sugerir?${params.toString()}`, { method: 'POST', body: archivo, headers: { 'Content-Type': archivo.type || 'application/octet-stream' } })
    } catch {
      throw new ErrorApi('No se pudo contactar el backend FastAPI.', null, 'red', null)
    }
    const cuerpo = await response.json().catch(() => null) as { sugerencias?: SugerenciaPlantilla[]; detail?: string | { message?: string } } | null
    if (!response.ok) {
      const detalle = cuerpo?.detail
      throw new ErrorApi(typeof detalle === 'string' ? detalle : detalle?.message ?? `La API respondió con ${response.status}.`, response.status, null, detalle)
    }
    return cuerpo?.sugerencias ?? []
  },
}

/**
 * Configuración vigente en memoria, para aplicarla a los documentos al extraer. `cargar()` comparte la petición en
 * vuelo; `actual()` devuelve lo último cargado (vacío si aún no se cargó o si falló: entonces no se aplica nada).
 */
let vigente: CampoPlantilla[] = []
let enVuelo: Promise<CampoPlantilla[]> | null = null
export const plantillaVigente = {
  actual: () => vigente,
  /** Si el backend tarda más de `esperaMs`, se sigue con lo último cargado: la extracción nunca se queda esperando. */
  cargar: (esperaMs = 8000): Promise<CampoPlantilla[]> => {
    enVuelo ??= plantillaCamposApi.obtener().then((plantilla) => (vigente = plantilla.campos)).catch(() => vigente).finally(() => { enVuelo = null })
    let temporizador: ReturnType<typeof setTimeout> | undefined
    const limite = new Promise<CampoPlantilla[]>((resolver) => { temporizador = setTimeout(() => resolver(vigente), esperaMs) })
    return Promise.race([enVuelo, limite]).finally(() => clearTimeout(temporizador))
  },
  fijar: (campos: CampoPlantilla[]) => { vigente = campos },
}
