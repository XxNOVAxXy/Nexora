export type SaveDataRecord = {
  Sucursal: number
  Articulo: string
  Saldo: number
  Clave: string
}

export type SaveDataDocument = {
  CargaInicial: boolean
  Saldos: SaveDataRecord[]
}

export type SaveDataPayload = {
  data: string
}

export type SaveDataMethod = 'manual' | 'gemini'

export type SaveDataAttemptStatus = 'idle' | 'sending' | 'success' | 'error'

export type SaveDataAttempt = {
  status: SaveDataAttemptStatus
  httpStatus: number | null
  message: string
  attemptedAt: string | null
}

export function createInitialSaveDataAttempt(): SaveDataAttempt {
  return {
    status: 'idle',
    httpStatus: null,
    message: 'No se ha realizado ningún intento.',
    attemptedAt: null,
  }
}

export function saveDataAttemptFromResponse(httpStatus: number, message: string, attemptedAt = new Date().toISOString()): SaveDataAttempt {
  return {
    status: httpStatus >= 200 && httpStatus < 300 ? 'success' : 'error',
    httpStatus,
    message: message.trim() || 'El servidor no devolvió un mensaje.',
    attemptedAt,
  }
}

export function saveDataAttemptFromError(errorMessage: string, attemptedAt = new Date().toISOString()): SaveDataAttempt {
  const detail = errorMessage.trim() || 'Error de conectividad no especificado.'
  return {
    status: 'error',
    httpStatus: null,
    message: `El servidor SaveData no está disponible. ${detail}`,
    attemptedAt,
  }
}

export function updateMethodValue<T>(values: Record<SaveDataMethod, T>, method: SaveDataMethod, value: T): Record<SaveDataMethod, T> {
  return { ...values, [method]: value }
}

export function validateSaveDataDocument(document: unknown): string[] {
  if (!document || typeof document !== 'object') return ['El documento debe ser un objeto.']

  const candidate = document as Partial<SaveDataDocument>
  const errors: string[] = []
  if (typeof candidate.CargaInicial !== 'boolean') errors.push('CargaInicial debe ser booleano.')
  if (!Array.isArray(candidate.Saldos)) return [...errors, 'Saldos debe ser un arreglo de registros.']

  candidate.Saldos.forEach((record, index) => {
    if (!record || typeof record !== 'object') {
      errors.push(`Saldos[${index}] debe ser un registro.`)
      return
    }

    const item = record as Partial<SaveDataRecord>
    if (typeof item.Sucursal !== 'number' || !Number.isFinite(item.Sucursal)) errors.push(`Saldos[${index}].Sucursal debe ser un número.`)
    if (typeof item.Articulo !== 'string' || item.Articulo.trim() === '') errors.push(`Saldos[${index}].Articulo debe ser un string no vacío.`)
    if (typeof item.Saldo !== 'number' || !Number.isFinite(item.Saldo)) errors.push(`Saldos[${index}].Saldo debe ser un número.`)
    if (typeof item.Clave !== 'string' || item.Clave.trim() === '') errors.push(`Saldos[${index}].Clave debe ser un string no vacío.`)
  })

  return errors
}

export function buildSaveDataPayload(registrosValidados: SaveDataRecord[], cargaInicial = false): SaveDataPayload {
  const payload = {
    data: JSON.stringify({
      CargaInicial: cargaInicial,
      Saldos: registrosValidados,
    }),
  }

  return payload
}

export function formatSaveDataPayload(payload: SaveDataPayload): string {
  return JSON.stringify(payload, null, 2)
}
