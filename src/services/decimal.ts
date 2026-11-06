/**
 * Decimal exacto mínimo (valor = n / 10^e) para cálculos contables sin float.
 * Replica la semántica de decimal.Decimal de Python que usa el backend para sumar, comparar y redondear.
 */
export type Decimal = { readonly n: bigint; readonly e: number }

export const CERO: Decimal = { n: 0n, e: 0 }

/** Construye un Decimal desde texto canónico: "-1234.567", "12", "0.50". */
export function decimal(texto: string): Decimal {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(texto)
  if (!match) throw new Error(`Decimal inválido: ${texto}`)
  const fraccion = match[3] ?? ''
  const n = BigInt(match[2] + fraccion)
  return { n: match[1] ? -n : n, e: fraccion.length }
}

const escalar = (valor: Decimal, e: number) => valor.n * 10n ** BigInt(e - valor.e)

export function sumar(a: Decimal, b: Decimal): Decimal {
  const e = Math.max(a.e, b.e)
  return { n: escalar(a, e) + escalar(b, e), e }
}

export const negar = (a: Decimal): Decimal => ({ n: -a.n, e: a.e })
export const restar = (a: Decimal, b: Decimal): Decimal => sumar(a, negar(b))
export const abs = (a: Decimal): Decimal => (a.n < 0n ? negar(a) : a)
export const esCero = (a: Decimal) => a.n === 0n

export function comparar(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const e = Math.max(a.e, b.e)
  const x = escalar(a, e)
  const y = escalar(b, e)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Redondea a 2 decimales con redondeo bancario (ROUND_HALF_EVEN, igual que Decimal.quantize en Python). */
export function redondear2(a: Decimal): Decimal {
  if (a.e <= 2) return { n: escalar(a, 2), e: 2 }
  const divisor = 10n ** BigInt(a.e - 2)
  const signo = a.n < 0n ? -1n : 1n
  const magnitud = a.n * signo
  let cociente = magnitud / divisor
  const resto = magnitud % divisor
  if (resto * 2n > divisor || (resto * 2n === divisor && cociente % 2n === 1n)) cociente += 1n
  return { n: cociente * signo, e: 2 }
}

/** Texto con exactamente `a.e` decimales (mínimo 0), sin separadores de miles. */
function textoExacto(a: Decimal): string {
  const negativo = a.n < 0n
  const digitos = (negativo ? -a.n : a.n).toString().padStart(a.e + 1, '0')
  const entero = a.e > 0 ? digitos.slice(0, -a.e) : digitos
  const fraccion = a.e > 0 ? `.${digitos.slice(-a.e)}` : ''
  return `${negativo ? '-' : ''}${entero}${fraccion}`
}

/** Formato canónico "1234.56": al menos dos decimales, conserva más si los hay, sin cero negativo. */
export function formatear(a: Decimal): string {
  const valor = esCero(a) ? { n: 0n, e: a.e } : a
  return textoExacto(valor.e < 2 ? { n: escalar(valor, 2), e: 2 } : valor)
}

/** Formato con exactamente dos decimales tras redondear (para diferencias). */
export function formatear2(a: Decimal): string {
  const redondeado = redondear2(a)
  return textoExacto(esCero(redondeado) ? { n: 0n, e: 2 } : redondeado)
}
