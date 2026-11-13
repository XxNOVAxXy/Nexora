import type { CampoExtra, Resumen, SugerenciaCampo, Transaccion } from '../types'
import type { FormatoNumerico, ValidacionContable } from './contabilidad'

const API_URL = import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export type EstadoExtraccion = 'borrador' | 'revisado' | 'enviado'

export type ProblemasRevision = {
  cuadra: boolean | null
  diferencias: number
  dudosos: number
  invalidos: number
  en_revision: number
  validacion_incompleta: boolean
  total: number
}

/** Extracción revisada tal como la persiste el backend (fuente de verdad). */
export type ExtraccionGuardada = {
  schema: number
  messageId: string
  partId: string
  attachmentId: string | null
  filename: string
  estado: EstadoExtraccion
  version: number
  creado: string
  actualizado: string
  revisado_en: string | null
  revisado_con_problemas: boolean
  enviado_en: string | null
  /** Historial auditado de envíos a SaveData (se conserva aunque el documento se edite después). */
  envios: IntentoEnvio[]
  modelo: string | null
  prompt_version: string | null
  formato_numerico: FormatoNumerico | null
  resumen: Resumen
  transacciones: Transaccion[]
  /** Ausentes en documentos guardados antes de las columnas adicionales. */
  campos_extra?: CampoExtra[]
  sugerencias_campos?: SugerenciaCampo[]
  validacion: ValidacionContable
  problemas: ProblemasRevision
}

export type ResultadoIntento = 'exito' | 'error' | 'incierto' | 'en_curso'

/** Un intento de envío a SaveData, tal como queda auditado en el backend. */
export type IntentoEnvio = {
  id: string
  iniciado_en: string
  terminado_en: string | null
  resultado: ResultadoIntento
  url: string
  /** Cuerpo exacto enviado: {"data": "<JSON interno>"}. */
  cuerpo: string
  http_status: number | null
  respuesta: string | null
  error: string | null
  sucursal: number
  articulo: string
  carga_inicial: boolean
  totales: { abonos: string; cargos: string }
  version_extraccion: number
  reenvio: boolean
}

export type EntradaListado = {
  messageId: string
  partId: string
  filename: string
  estado: EstadoExtraccion
  version: number
  actualizado: string
  cuadra: boolean | null
  problemas: number
}

export type SolicitudGuardado = {
  /** Versión sobre la que se editó; null para crear. Si no coincide con la guardada, el backend responde 409. */
  version_base: number | null
  estado: 'borrador' | 'revisado'
  confirmar_problemas: boolean
  resumen?: Resumen
  transacciones: Transaccion[]
  formato_numerico: FormatoNumerico | null
  modelo: string | null
  prompt_version: string | null
  filename: string
  attachmentId: string | null
  campos_extra?: CampoExtra[]
  sugerencias_campos?: SugerenciaCampo[]
}

export class ErrorApi extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null, readonly detalle: unknown) {
    super(message)
    this.name = 'ErrorApi'
  }
}

type DetalleError = string | { code?: string; message?: string } | { msg?: string; loc?: unknown[] }[] | undefined

function mensajeDeDetalle(detalle: DetalleError, status: number): string {
  if (typeof detalle === 'string') return detalle
  if (Array.isArray(detalle)) return `Datos inválidos: ${detalle.map((item) => item.msg ?? 'valor inválido').join('; ')}`
  return detalle?.message ?? `La API respondió con ${status}.`
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new ErrorApi('No se pudo contactar el backend FastAPI.', null, 'red', null)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: DetalleError } | null
    const detalle = body?.detail
    const code = detalle && typeof detalle === 'object' && !Array.isArray(detalle) ? detalle.code ?? null : null
    throw new ErrorApi(mensajeDeDetalle(detalle, response.status), response.status, code, detalle)
  }
  return response.json() as Promise<T>
}

const ruta = (messageId: string, partId: string) => `/extracciones/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`

export const extraccionesApi = {
  /** null si el documento no tiene extracción guardada (404). */
  obtener: async (messageId: string, partId: string): Promise<ExtraccionGuardada | null> => {
    try {
      return await request<ExtraccionGuardada>(ruta(messageId, partId))
    } catch (error) {
      if (error instanceof ErrorApi && error.status === 404) return null
      throw error
    }
  },
  guardar: (messageId: string, partId: string, solicitud: SolicitudGuardado) =>
    request<ExtraccionGuardada>(ruta(messageId, partId), { method: 'PUT', body: JSON.stringify(solicitud) }),
  listar: () => request<{ cuentaId: string; extracciones: EntradaListado[] }>('/extracciones'),
}
