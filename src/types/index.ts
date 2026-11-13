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
  /** Valores de las columnas adicionales ({id del campo: valor}); no entran en la validación contable ni en SaveData. */
  extras?: Record<string, string>
  /** Ids de las columnas cuyas celdas en esta fila llenó la IA (se distinguen de lo escrito a mano). */
  extras_ia?: string[]
}

/** Columna adicional de la tabla de Movimientos (botón "+ Campo"). */
export type CampoExtra = {
  id: string
  nombre: string
  /** 'ia' si se creó desde una sugerencia de la IA; 'manual' si el usuario escribió el nombre. */
  origen: 'ia' | 'manual'
  /** Clave de la sugerencia que la creó: enlaza la columna con la misma sugerencia al re-extraer. */
  clave?: string
  /**
   * 'documento': dato que aparece una sola vez en el estado de cuenta (RFC, número de crédito…); se guarda una vez
   * en `valor` y nunca se repite en cada movimiento. 'movimiento' (o ausente): un valor por movimiento en `extras`.
   */
  alcance?: AlcanceCampo
  /** Valor de un campo del documento. */
  valor?: string
  /** El valor del documento lo llenó la IA y el usuario no lo ha editado. */
  valor_ia?: boolean
}

export type AlcanceCampo = 'movimiento' | 'documento'

/** Campo que la IA encontró en el documento y no está capturado. Nunca inventa campos ni valores. */
export type SugerenciaCampo = {
  clave: string
  nombre: string
  /** Valores por fila, asociados a la huella del movimiento (en orden, por si dos filas comparten huella). */
  valores: { huella: string; valor: string }[]
  /** Valor único del documento: al elegirlo se repite en cada fila. */
  valor_documento?: string
}

/** Lo que encontró la IA al buscar una columna manual en el documento. Si no está, `encontrado` es false. */
export type ResultadoCampo = {
  nombre: string
  clave: string
  encontrado: boolean
  valores: { huella: string; valor: string }[]
  valor_documento?: string
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
