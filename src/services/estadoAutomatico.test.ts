import { describe, expect, it } from 'vitest'
import type { AdjuntoAutomatico, EstadoAutomatico } from './automaticoApi'
import type { EntradaListado } from './extraccionesApi'
import { confirmacionExtraer, envioAutomaticoEncendido, envioAutomaticoSinEnviar, estadoDocumento, fechaHoraEnvio, grupoEnvioAutomatico, pendienteEnvioAutomatico, respuestaSaveData, textoAvisoEnviadoAuto, textoAvisoEnvioAutomatico, textoCamposAutomaticos, textoIndicador, ultimoEnvioAutomatico, type AdjuntoAExtraer } from './estadoAutomatico'

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

describe('estado del envío automático en la bandeja', () => {
  const envio = (estado: NonNullable<AdjuntoAutomatico['envio']>['estado'], version: number | null) => ({ estado, intentos: 1, error: null, motivos: null, problemas: null, version, actualizado: null })
  it('distingue enviado, requiere revisión, error e incierto mientras nadie lo toque', () => {
    expect(estadoDocumento(guardado({ estado: 'enviado', version: 2 }), auto({ envio: envio('enviado', 2) }))).toBe('enviado_auto')
    expect(estadoDocumento(guardado(), auto({ envio: envio('requiere_revision', null) }))).toBe('requiere_revision')
    expect(estadoDocumento(guardado({ estado: 'revisado', version: 2 }), auto({ envio: envio('error', 2) }))).toBe('error_envio')
    expect(estadoDocumento(guardado({ estado: 'revisado', version: 2 }), auto({ envio: envio('incierto', 2) }))).toBe('incierto_envio')
  })
  it('si el usuario lo editó después, manda su estado normal', () => {
    expect(estadoDocumento(guardado({ estado: 'enviado', version: 3 }), auto({ envio: envio('enviado', 2) }))).toBe('enviado')
    expect(estadoDocumento(guardado({ version: 2 }), auto({ envio: envio('requiere_revision', null) }))).toBe('borrador')
  })
  it('pendiente, omitido o sin SaveData no tienen etiqueta propia', () => {
    expect(estadoDocumento(guardado(), auto({ envio: envio('omitido', null) }))).toBe('automatico')
    expect(estadoDocumento(guardado({ estado: 'revisado', version: 2 }), auto({ envio: envio('pendiente', 2) }))).toBe('revisado')
  })
})

describe('avisos del envío automático', () => {
  const encendido = (cambios: Partial<EstadoAutomatico> = {}) => proceso({ envio_activo: true, ...cambios })
  const nuevo = '2026-11-13T09:30:00Z'

  it('solo cuenta como encendido con la extracción activa y el envío activo', () => {
    expect(envioAutomaticoEncendido(encendido())).toBe(true)
    expect(envioAutomaticoEncendido(encendido({ activo: false }))).toBe(false)
    expect(envioAutomaticoEncendido(proceso())).toBe(false)
    expect(envioAutomaticoEncendido(null)).toBe(false)
  })

  it('el aviso de la bandeja lleva la hora de la próxima revisión y desaparece con el envío apagado', () => {
    expect(textoAvisoEnvioAutomatico(encendido())).toMatch(/^Envío automático activo · los estados de cuenta nuevos se envían solos en la próxima revisión \([^)]+\)\. No es necesario pulsar Extraer\.$/)
    expect(textoAvisoEnvioAutomatico(encendido({ proxima_revision: null }))).toBe('Envío automático activo · los estados de cuenta nuevos se envían solos en la próxima revisión. No es necesario pulsar Extraer.')
    expect(textoAvisoEnvioAutomatico(proceso())).toBeNull()
  })

  it('pendiente: correo posterior a la activación, sin guardar, sin descartar y sin resultado del proceso', () => {
    expect(pendienteEnvioAutomatico(encendido(), undefined, 'm1', '1', nuevo)).toBe(true)
    expect(pendienteEnvioAutomatico(encendido({ adjuntos: { m1__1: auto({ estado: 'pendiente', version: null }) } }), undefined, 'm1', '1', nuevo)).toBe(true)
    expect(pendienteEnvioAutomatico(encendido({ adjuntos: { m1__1: auto({ estado: 'en_curso', version: null }) } }), undefined, 'm1', '1', nuevo)).toBe(true)
  })

  it('no pendiente: envío apagado, ya guardado, ya revisado, descartado o anterior a la activación', () => {
    expect(pendienteEnvioAutomatico(proceso(), undefined, 'm1', '1', nuevo)).toBe(false)
    expect(pendienteEnvioAutomatico(encendido({ activo: false }), undefined, 'm1', '1', nuevo)).toBe(false)
    expect(pendienteEnvioAutomatico(encendido(), guardado(), 'm1', '1', nuevo)).toBe(false)
    expect(pendienteEnvioAutomatico(encendido({ adjuntos: { m1__1: auto() } }), undefined, 'm1', '1', nuevo)).toBe(false)
    expect(pendienteEnvioAutomatico(encendido({ adjuntos: { m1__1: auto({ estado: 'error', version: null }) } }), undefined, 'm1', '1', nuevo)).toBe(false)
    const descartado = { clave: 'm1', message_id: 'm1', part_id: null, motivo: 'sin_adjunto_valido', detalle: null, asunto: null, recibido: null, primera_vez: null, ultima_vez: null, veces: 1 }
    expect(pendienteEnvioAutomatico(encendido({ descartados: [descartado] }), undefined, 'm1', '1', nuevo)).toBe(false)
    expect(pendienteEnvioAutomatico(encendido(), undefined, 'm1', '1', '2026-11-13T08:59:00Z')).toBe(false)
    expect(pendienteEnvioAutomatico(encendido(), undefined, 'm1', '1', null)).toBe(false)
  })

  it('extraído automáticamente sin enviar: solo mientras siga en la versión del proceso y el envío no haya terminado', () => {
    const conEnvio = (envio: AdjuntoAutomatico['envio']) => encendido({ adjuntos: { m1__1: auto({ enviar_auto: true, envio }) } })
    expect(envioAutomaticoSinEnviar(conEnvio(null), 'm1', '1', 1)).toBe(true)
    expect(envioAutomaticoSinEnviar(conEnvio({ estado: 'pendiente', intentos: 1, error: null, motivos: null, problemas: null, version: null, actualizado: null }), 'm1', '1', 1)).toBe(true)
    expect(envioAutomaticoSinEnviar(conEnvio(null), 'm1', '1', 2)).toBe(false)
    expect(envioAutomaticoSinEnviar(conEnvio({ estado: 'enviado', intentos: 1, error: null, motivos: null, problemas: null, version: 2, actualizado: null }), 'm1', '1', 2)).toBe(false)
    expect(envioAutomaticoSinEnviar(encendido({ adjuntos: { m1__1: auto({ enviar_auto: false }) } }), 'm1', '1', 1)).toBe(false)
    expect(envioAutomaticoSinEnviar(proceso({ adjuntos: { m1__1: auto({ enviar_auto: true }) } }), 'm1', '1', 1)).toBe(false)
  })
})

describe('confirmación al extraer a mano con el envío automático encendido', () => {
  const encendido = (cambios: Partial<EstadoAutomatico> = {}) => proceso({ envio_activo: true, ...cambios })
  const enviado = auto({ enviar_auto: true, envio: { estado: 'enviado', intentos: 1, error: null, motivos: null, problemas: null, version: 2, actualizado: '2026-11-13T09:50:00Z' } })
  const p: AdjuntoAExtraer = { grupo: 'pendiente', enviadoEn: null }
  const e = (enviadoEn = '2026-11-13T09:50:00Z'): AdjuntoAExtraer => ({ grupo: 'enviado_auto', enviadoEn })
  const m: AdjuntoAExtraer = { grupo: 'manual', enviadoEn: null }

  it('clasifica cada adjunto: ya enviado, pendiente o manual', () => {
    expect(grupoEnvioAutomatico(encendido({ adjuntos: { m1__1: enviado } }), guardado(), 'm1', '1', '2026-11-13T09:30:00Z')).toEqual({ grupo: 'enviado_auto', enviadoEn: '2026-11-13T09:50:00Z' })
    expect(grupoEnvioAutomatico(encendido(), undefined, 'm1', '1', '2026-11-13T09:30:00Z').grupo).toBe('pendiente')
    expect(grupoEnvioAutomatico(encendido(), undefined, 'm1', '1', '2026-11-13T08:00:00Z').grupo).toBe('manual')
    expect(grupoEnvioAutomatico(encendido(), guardado(), 'm1', '1', '2026-11-13T09:30:00Z').grupo).toBe('manual')
    expect(grupoEnvioAutomatico(encendido({ adjuntos: { m1__1: auto({ estado: 'error', version: null }) } }), undefined, 'm1', '1', '2026-11-13T09:30:00Z').grupo).toBe('manual')
    const requiere = auto({ enviar_auto: true, envio: { estado: 'requiere_revision', intentos: 1, error: null, motivos: [], problemas: [], version: 1, actualizado: null } })
    expect(grupoEnvioAutomatico(encendido({ adjuntos: { m1__1: requiere } }), guardado(), 'm1', '1', '2026-11-13T09:30:00Z').grupo).toBe('manual')
  })

  it('un solo grupo: texto propio, en singular o plural', () => {
    expect(confirmacionExtraer([p])).toMatchObject({ tipo: 'pendiente', texto: expect.stringContaining('Estos documentos se enviarán solos') })
    expect(confirmacionExtraer([e()]).texto).toBe(`Este documento ya se envió automáticamente a SaveData el ${fechaHoraEnvio('2026-11-13T09:50:00Z')}. Vas a abrirlo en modo manual: si cambias algo, tendrás que reenviarlo a mano como actualización. ¿Continuar?`)
    expect(confirmacionExtraer([e('2026-11-13T09:10:00Z'), e()]).texto).toContain(`Estos 2 documentos ya se enviaron automáticamente a SaveData (el último el ${fechaHoraEnvio('2026-11-13T09:50:00Z')})`)
    expect(confirmacionExtraer([m])).toEqual({ tipo: 'manual', texto: 'Vas a trabajar este documento en modo manual. Recuerda enviarlo a SaveData a mano cuando termines. ¿Continuar?', lineas: [] })
    expect(confirmacionExtraer([m, m]).texto).toBe('Vas a trabajar estos 2 documentos en modo manual. Recuerda enviarlos a SaveData a mano cuando termines. ¿Continuar?')
  })

  it('mixto: una línea resumen y una por grupo; con pendientes cambia de botones', () => {
    const conPendientes = confirmacionExtraer([p, e(), m, m])
    expect(conPendientes.tipo).toBe('mixto_con_pendientes')
    expect(conPendientes.texto).toBe('1 se enviará solo · 1 ya se envió automáticamente · 2 son manuales')
    expect(conPendientes.lineas).toHaveLength(4)
    const sinPendientes = confirmacionExtraer([e(), e(), m])
    expect(sinPendientes.tipo).toBe('mixto')
    expect(sinPendientes.texto).toBe('2 ya se enviaron automáticamente · 1 es manual')
    expect(confirmacionExtraer([p, p, m]).texto).toBe('2 se enviarán solos · 1 es manual')
  })

  it('lee message y code de la respuesta de SaveData', () => {
    expect(respuestaSaveData('{"code":200,"message":"Exito"}')).toEqual({ message: 'Exito', code: '200' })
    expect(respuestaSaveData('{"code":200}')).toEqual({ message: null, code: '200' })
    expect(respuestaSaveData('no es json')).toBeNull()
    expect(respuestaSaveData('[1]')).toBeNull()
    expect(respuestaSaveData(null)).toBeNull()
  })

  it('aviso fijo: último envío automático exitoso con su respuesta', () => {
    const base = { iniciado_en: '2026-11-13T09:49:00Z', terminado_en: '2026-11-13T09:50:00Z', respuesta: '{"code":200,"message":"Exito"}' }
    const envios = [{ ...base, resultado: 'exito', automatico: true }, { ...base, resultado: 'exito', automatico: false }, { ...base, resultado: 'error', automatico: true }]
    expect(ultimoEnvioAutomatico(envios)).toBe(envios[0])
    expect(ultimoEnvioAutomatico([envios[1]])).toBeNull()
    expect(textoAvisoEnviadoAuto(envios[0])).toBe(`Enviado automáticamente a SaveData el ${fechaHoraEnvio('2026-11-13T09:50:00Z')} · respuesta: Exito (code 200). Si lo modificas, reenvíalo a mano como actualización.`)
    expect(textoAvisoEnviadoAuto({ ...base, resultado: 'exito', respuesta: 'texto' })).toContain('respuesta: sin mensaje (code —)')
  })
})
