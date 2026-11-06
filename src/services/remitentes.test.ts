import { describe, expect, it } from 'vitest'
import { agregarRemitente, normalizarRemitente } from './remitentes'

describe('validación local de remitentes (igual que el backend)', () => {
  it('normaliza mayúsculas y recorta espacios de los extremos', () => {
    expect(normalizarRemitente('  Estados@Banco.COM ')).toEqual({ ok: true, valor: 'estados@banco.com' })
    expect(normalizarRemitente('@Banco.com.MX')).toEqual({ ok: true, valor: '@banco.com.mx' })
  })

  it('rechaza formatos inválidos, espacios internos y sintaxis de búsqueda', () => {
    for (const valor of ['', 'banco', 'banco.com', '@banco', 'a@@b.com', 'a@b..com', '.a@b.com', 'a@-b.com', 'a@b.c', '@ banco.com', 'a@b.com OR x', 'a@b.com" OR from:"x', '(a@b.com)']) {
      expect(normalizarRemitente(valor).ok, valor).toBe(false)
    }
  })

  it('rechaza duplicados después de normalizar', () => {
    const primera = agregarRemitente([], 'estados@banco.com')
    expect(primera.ok).toBe(true)
    const repetida = agregarRemitente(primera.ok ? primera.lista : [], 'ESTADOS@banco.com ')
    expect(repetida).toEqual({ ok: false, motivo: 'Duplicado: estados@banco.com ya está en la lista.' })
  })
})
