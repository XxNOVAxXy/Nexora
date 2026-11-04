import { describe, expect, it } from 'vitest'
import { buildSaveDataPayload, createInitialSaveDataAttempt, saveDataAttemptFromError, saveDataAttemptFromResponse, updateMethodValue, validateSaveDataDocument, type SaveDataRecord } from './saveData'

const records: SaveDataRecord[] = [
  { Sucursal: 3102, Articulo: '001000453', Saldo: 10, Clave: 'H' },
  { Sucursal: 3102, Articulo: '001000453', Saldo: 2, Clave: 'S' },
]

describe('SaveData payload', () => {
  it('serializa solamente el documento empresarial dentro de data', () => {
    const payload = buildSaveDataPayload(records)

    expect(Object.keys(payload)).toEqual(['data'])
    expect(typeof payload.data).toBe('string')
    expect(JSON.parse(payload.data)).toEqual({ CargaInicial: false, Saldos: records })
    expect(payload).not.toHaveProperty('Saldos')
  })

  it('conserva los ceros iniciales del articulo', () => {
    const payload = buildSaveDataPayload(records)

    expect(JSON.parse(payload.data).Saldos[0].Articulo).toBe('001000453')
  })

  it('rechaza tipos faltantes o incorrectos', () => {
    const errors = validateSaveDataDocument({
      CargaInicial: 'false',
      Saldos: [{ Sucursal: '3102', Articulo: 10000453, Saldo: '10', Clave: '' }],
    })

    expect(errors).toEqual([
      'CargaInicial debe ser booleano.',
      'Saldos[0].Sucursal debe ser un número.',
      'Saldos[0].Articulo debe ser un string no vacío.',
      'Saldos[0].Saldo debe ser un número.',
      'Saldos[0].Clave debe ser un string no vacío.',
    ])
  })

  it('mantiene independientes los registros de Manual y Gemini', () => {
    const geminiRecords: SaveDataRecord[] = [{ Sucursal: 3102, Articulo: '90000001', Saldo: 3, Clave: 'H' }]
    const recordsByMethod = { manual: records, gemini: geminiRecords }
    const editedManual = updateMethodValue(recordsByMethod, 'manual', [{ ...records[0], Saldo: 99 }, records[1]])
    const cargaInicialByMethod = updateMethodValue({ manual: true, gemini: true }, 'manual', false)
    const manualPayload = buildSaveDataPayload(editedManual.manual, cargaInicialByMethod.manual)
    const geminiPayload = buildSaveDataPayload(editedManual.gemini, cargaInicialByMethod.gemini)

    expect(editedManual.gemini).toEqual(geminiRecords)
    expect(JSON.parse(manualPayload.data).CargaInicial).toBe(false)
    expect(JSON.parse(manualPayload.data).Saldos).toHaveLength(2)
    expect(JSON.parse(manualPayload.data).Saldos[0].Saldo).toBe(99)
    expect(JSON.parse(geminiPayload.data).CargaInicial).toBe(true)
    expect(JSON.parse(geminiPayload.data).Saldos).toEqual(geminiRecords)
    expect(JSON.parse(geminiPayload.data).Saldos[0].Saldo).toBe(3)
  })

  it('mapea una respuesta HTTP real a éxito solo para códigos 2xx', () => {
    const attempt = saveDataAttemptFromResponse(201, 'Datos guardados.', '2026-10-30T10:00:00.000Z')

    expect(attempt).toEqual({ status: 'success', httpStatus: 201, message: 'Datos guardados.', attemptedAt: '2026-10-30T10:00:00.000Z' })
    expect(saveDataAttemptFromResponse(500, 'Error interno.', '2026-10-30T10:01:00.000Z').status).toBe('error')
  })

  it('representa la falta de servidor sin inventar código HTTP', () => {
    const initial = createInitialSaveDataAttempt()
    const unavailable = saveDataAttemptFromError('No se pudo conectar.', '2026-10-30T10:02:00.000Z')

    expect(initial).toEqual({ status: 'idle', httpStatus: null, message: 'No se ha realizado ningún intento.', attemptedAt: null })
    expect(unavailable.httpStatus).toBeNull()
    expect(unavailable.status).toBe('error')
    expect(unavailable.message).toContain('no está disponible')
    expect(unavailable.attemptedAt).toBe('2026-10-30T10:02:00.000Z')
  })
})
