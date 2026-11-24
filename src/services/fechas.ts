/**
 * Fechas en la interfaz: el backend y la base guardan todo en UTC; aquí siempre se muestran en hora de México
 * (America/Mexico_City), sin importar la zona horaria configurada en la computadora.
 */
export const ZONA_MEXICO = 'America/Mexico_City'

/** Intl.DateTimeFormat en español de México y hora de México. */
export const formatoMexico = (opciones: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-MX', { ...opciones, timeZone: ZONA_MEXICO })
