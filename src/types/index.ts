/** Origen de un movimiento: extraído por la IA, capturado a mano o extraído por la IA y corregido a mano. */
export type OrigenTransaccion = 'ia' | 'manual' | 'ia_editada'

export type CampoMonto = 'cargo' | 'abono' | 'saldo'
export type CampoMontoResumen = 'saldo_inicial' | 'total_cargos' | 'total_abonos' | 'saldo_final'

/**
 * Modelo único de movimiento para la captura manual y la extracción con Gemini.
 * Los montos normalizados usan el formato "1234.56"; cargo y abono son magnitudes positivas.
 * Los campos *_original guardan el texto impreso en el documento (solo para auditoría).
 */
export type Transaccion = {
  id: string
  fecha: string
  concepto: string
  referencia: string
  cargo: string
  abono: string
  saldo: string
  cargo_original?: string
  abono_original?: string
  saldo_original?: string
  origen: OrigenTransaccion
  /** Montos que el backend no pudo interpretar sin adivinar y requieren revisión. */
  dudosos: CampoMonto[]
  /** Identifica la fila de la IA entre extracciones; se calcula antes de cualquier edición y no cambia al editar. */
  huella?: string
  /** Motivo por el que la fila requiere revisión además de sus montos dudosos. */
  revision?: RevisionTransaccion
}

export type RevisionTransaccion = 'no_aparece_en_extraccion' | 'fila_de_saldo_con_importe'

export type Resumen = {
  banco: string
  titular: string
  cuenta: string
  periodo: string
  moneda: string
  saldo_inicial: string
  total_cargos: string
  total_abonos: string
  saldo_final: string
  saldo_inicial_original?: string
  total_cargos_original?: string
  total_abonos_original?: string
  saldo_final_original?: string
  dudosos: CampoMontoResumen[]
}
