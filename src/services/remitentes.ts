/**
 * Validación local de remitentes, igual que backend/app/remitentes.py (el backend es quien decide; esto es
 * solo para avisar antes de guardar). Acepta un correo completo o un dominio que empiece con @.
 */
const ETIQUETA = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMINIO = `(?:${ETIQUETA}\\.)+[a-z]{2,63}`
const LOCAL = '[a-z0-9_%+-]+(?:\\.[a-z0-9_%+-]+)*'
const CORREO = new RegExp(`^${LOCAL}@${DOMINIO}$`)
const REGLA_DOMINIO = new RegExp(`^@${DOMINIO}$`)
export const MAX_REMITENTES = 50

export type ResultadoRemitente = { ok: true; valor: string } | { ok: false; motivo: string }

export function normalizarRemitente(valor: string): ResultadoRemitente {
  const normalizado = valor.trim().toLowerCase()
  if (!normalizado) return { ok: false, motivo: 'El remitente está vacío.' }
  if (/\s/.test(normalizado)) return { ok: false, motivo: 'El remitente no puede contener espacios.' }
  if (normalizado.length > 254) return { ok: false, motivo: 'El remitente es demasiado largo.' }
  if (CORREO.test(normalizado) || REGLA_DOMINIO.test(normalizado)) return { ok: true, valor: normalizado }
  return { ok: false, motivo: 'Usa un correo completo (banco@ejemplo.com) o un dominio que empiece con @ (@ejemplo.com).' }
}

/** Valida un remitente nuevo contra la lista actual (formato y duplicados). */
export function agregarRemitente(lista: string[], valor: string): { ok: true; lista: string[] } | { ok: false; motivo: string } {
  const resultado = normalizarRemitente(valor)
  if (!resultado.ok) return resultado
  if (lista.includes(resultado.valor)) return { ok: false, motivo: `Duplicado: ${resultado.valor} ya está en la lista.` }
  if (lista.length >= MAX_REMITENTES) return { ok: false, motivo: `Se admiten como máximo ${MAX_REMITENTES} remitentes.` }
  return { ok: true, lista: [...lista, resultado.valor] }
}
