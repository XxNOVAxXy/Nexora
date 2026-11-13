import { describe, expect, it } from 'vitest'
import type { AdjuntoAutomatico, EstadoAutomatico } from './automaticoApi'
import type { EntradaListado } from './extraccionesApi'
import { estadoDocumento, textoCamposAutomaticos, textoIndicador } from './estadoAutomatico'

const guardado = (cambios: Partial<EntradaListado> = {}): EntradaListado => ({ messageId: 'm1', partId: '1', filename: 'e.pdf', estado: 'borrador', version: 1, actualizado: '2026-11-13T10:00:00Z', cuadra: true, problemas: 0, ...cambios })
const auto = (cambios: Partial<AdjuntoAutomatico> = {}): AdjuntoAutomatico => ({ estado: 'extraido', intentos: 1, error: null, version: 1, actualizado: null, ...cambios })
const proceso = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: true, activado_en: '2026-11-13T09:00:00Z', ultima_revision: '2026-11-13T10:20:00Z', proxima_revision: '2026-11-13T10:40:00Z', en_curso: false,
  intervalo_minutos: 20, ultimo_resultado: 'ok', ultimo_error: null, gemini_configurado: true, campos: [], adjuntos: {}, ...cambios,
})

describe('estado del adjunto en la bandeja', () => {
  it('"Extraído automáticamente" mientras sea la versión que guardó el proceso', () => {
    expect(estadoDocumento(guardado(), auto())).toBe('automatico')
  })
  it('en cuanto el usuario guarda o revisa, muestra su estado normal', () => {
    expect(estadoDocumento(guardado({ version: 2 }), auto())).toBe('borrador')
    expect(estadoDocumento(guardado({ version: 2, estado: 'revisado' }), auto())).toBe('revisado')
    expect(estadoDocumento(guardado({ estado: 'enviado' }), auto())).toBe('enviado')
  })
  it('lo guardado por el usuario manda aunque el proceso lo haya omitido', () => {
    expect(estadoDocumento(guardado(), auto({ estado: 'omitido', version: null }))).toBe('borrador')
  })
  it('"Error al extraer" tras agotar los intentos; los reintentos pendientes siguen como sin extraer', () => {
    expect(estadoDocumento(undefined, auto({ estado: 'error', intentos: 3, version: null }))).toBe('error_auto')
    expect(estadoDocumento(undefined, auto({ estado: 'pendiente', version: null }))).toBe('sin_extraer')
    expect(estadoDocumento(undefined, undefined)).toBe('sin_extraer')
  })
})

describe('indicador del proceso automático', () => {
  it('activo con última y próxima revisión', () => {
    expect(textoIndicador(proceso())).toMatch(/^Extracción automática activa · última revisión .+ · próxima .+$/)
  })
  it('en pausa, sin Gemini o revisando', () => {
    expect(textoIndicador(proceso({ activo: false }))).toBe('Extracción automática en pausa')
    expect(textoIndicador(proceso({ gemini_configurado: false }))).toContain('falta configurar Gemini')
    expect(textoIndicador(proceso({ en_curso: true }))).toContain('revisando ahora')
    expect(textoIndicador(null)).toBeNull()
  })
  it('lista de campos que se buscarán', () => {
    expect(textoCamposAutomaticos(['Nombre', 'RFC'])).toBe('Campos que se buscarán automáticamente: Nombre, RFC')
    expect(textoCamposAutomaticos([])).toContain('ninguno')
  })
})
