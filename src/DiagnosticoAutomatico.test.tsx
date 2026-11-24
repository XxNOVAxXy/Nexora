// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvisoAutomatico, EstadoAutomatico, UltimoCiclo } from './services/automaticoApi'
import { intervaloConsulta, motivosAgrupados, resumenCiclo, textoIndicador, textoMotivo } from './services/estadoAutomatico'

let estadoAuto: EstadoAutomatico

const { estadoMock, revisarMock, leidosMock } = vi.hoisted(() => ({ estadoMock: vi.fn(), revisarMock: vi.fn(), leidosMock: vi.fn() }))

vi.mock('./services/automaticoApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/automaticoApi')>()
  return { ...real, automaticoApi: { estado: estadoMock, configurar: vi.fn(), configurarEnvio: vi.fn(), revisarAhora: revisarMock, marcarAvisosLeidos: leidosMock } }
})

const { TarjetaExtraccionAutomatica } = await import('./App')
const { CampanaAvisos, ResumenUltimoCiclo } = await import('./DiagnosticoAutomatico')
const { publicarEstadoAutomatico } = await import('./services/eventosAutomatico')

const ciclo = (cambios: Partial<UltimoCiclo> = {}): UltimoCiclo => ({
  inicio: '2026-11-18T15:30:00Z', fin: '2026-11-18T15:31:00Z', origen: 'programado', resultado: 'ok', error: null,
  correos_encontrados: 3, extraidos: 1, enviados: 1, requieren_revision: 0, inciertos: 0, omitidos: 2, errores: 0, ya_revisados: 0,
  descartes: [
    { clave: 'm15', message_id: 'm15', part_id: null, motivo: 'sin_adjunto_valido', detalle: 'El correo no trae un PDF o imagen extraible.', asunto: 'Estado de cuenta' },
    { clave: 'p1', message_id: 'p1', part_id: null, motivo: 'asunto_no_coincide', detalle: null, asunto: 'Oferta' },
  ],
  descartes_total: 2, ...cambios,
})
const aviso = (cambios: Partial<AvisoAutomatico> = {}): AvisoAutomatico => ({ id: 'a1', fecha: '2026-11-18T15:31:00Z', tipo: 'enviado', texto: 'Se envio 1 documento a SaveData automaticamente.', claves: ['m1__1'], leido: false, ...cambios })
const estadoBase = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: true, activado_en: '2026-11-13T17:05:00Z', ultima_revision: '2026-11-18T15:31:00Z', proxima_revision: '2026-11-18T15:51:00Z', en_curso: false,
  intervalo_minutos: 20, ultimo_resultado: 'ok', ultimo_error: null, gemini_configurado: true, campos: [], adjuntos: {},
  ultimo_ciclo: null, descartados: [], avisos: [], avisos_sin_leer: 0, revision_pendiente: false, ...cambios,
})

beforeEach(() => {
  estadoAuto = estadoBase()
  estadoMock.mockImplementation(async () => estadoAuto)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('textos del diagnóstico', () => {
  it('resumen del ciclo y omitidos por motivo', () => {
    expect(resumenCiclo(ciclo())).toBe('3 correos encontrados · 1 extraído · 1 enviado · 2 omitidos · 0 errores')
    expect(resumenCiclo(ciclo({ requieren_revision: 2, inciertos: 1 }))).toContain('2 requieren revisión · 1 envío incierto')
    expect(resumenCiclo(ciclo({ en_bandeja: 2 }))).toContain('1 enviado · 2 a captura manual · 2 omitidos')
    expect(resumenCiclo(ciclo({ en_espera: 1, errores: 1 }))).toContain('1 en espera de reintento · 2 omitidos · 1 error')
    expect(motivosAgrupados(ciclo())).toBe('Sin adjunto válido (1), El asunto no coincide (1)')
    expect(textoMotivo('ya_tenia_extraccion')).toBe('Ya tenía extracción')
  })
  it('"revisando" solo con un ciclo en curso; una solicitud pendiente se muestra aparte', () => {
    expect(textoIndicador(estadoBase({ en_curso: true }))).toContain('revisando ahora')
    const pendiente = textoIndicador(estadoBase({ revision_pendiente: true }))
    expect(pendiente).toContain('revisión solicitada')
    expect(pendiente).not.toContain('revisando')
    expect(textoIndicador(estadoBase())).not.toContain('revisando')
  })
  it('consulta rápida solo mientras hay un ciclo o una solicitud', () => {
    expect(intervaloConsulta(estadoBase({ en_curso: true }))).toBe(3_000)
    expect(intervaloConsulta(estadoBase({ revision_pendiente: true }))).toBe(3_000)
    expect(intervaloConsulta(estadoBase())).toBe(60_000)
  })
})

describe('Tarjeta: estado real del proceso', () => {
  it('tras "Revisar ahora" consulta hasta que el ciclo termina y muestra su resumen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    revisarMock.mockImplementation(async () => estadoBase({ en_curso: true, ciclo_en_curso_desde: '2026-11-18T15:30:00Z' }))
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    const boton = await screen.findByRole('button', { name: 'Revisar ahora' })
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(boton)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByText(/revisando ahora/)).toBeTruthy()

    estadoAuto = estadoBase({ ultimo_ciclo: ciclo({ origen: 'manual' }), descartados: [{ ...ciclo().descartes[0], recibido: '2026-11-15T10:00:00Z', primera_vez: '2026-11-15T10:20:00Z', ultima_vez: '2026-11-18T15:31:00Z', veces: 4 }] })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
    const resumen = await screen.findByRole('region', { name: 'Último ciclo' })
    expect(resumen.textContent).toContain('Completado')
    expect(resumen.textContent).toContain('manual')
    expect(resumen.textContent).toContain('3 correos encontrados · 1 extraído · 1 enviado · 2 omitidos · 0 errores')
    expect(resumen.textContent).toContain('Sin adjunto válido (1)')
    expect(screen.queryByText(/revisando ahora/)).toBeNull()
    expect(screen.getByText('Correos y adjuntos descartados (1)')).toBeTruthy()
    expect(screen.getByText(/visto 4 veces/)).toBeTruthy()
  })

  it('un ciclo interrumpido por reinicio se muestra como tal, con su aviso', async () => {
    estadoAuto = estadoBase({ ultimo_ciclo: ciclo({ resultado: 'interrumpido_reinicio', fin: null, detectado_en: '2026-11-18T15:40:00Z', error: 'El backend se reinicio o se apago antes de terminar el ciclo.', correos_encontrados: 0, extraidos: 0, enviados: 0, omitidos: 0, descartes: [], descartes_total: 0 }), avisos: [aviso({ tipo: 'error_ciclo', texto: 'Un ciclo se interrumpio por un reinicio del backend.' })], avisos_sin_leer: 1 })
    leidosMock.mockImplementation(async () => ({ ...estadoAuto, avisos: estadoAuto.avisos?.map((item) => ({ ...item, leido: true })), avisos_sin_leer: 0 }))
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    const resumen = await screen.findByRole('region', { name: 'Último ciclo' })
    expect(resumen.textContent).toContain('Interrumpido por reinicio del backend')
    const avisos = screen.getByRole('alert', { name: 'Avisos de la extracción automática' })
    expect(avisos.textContent).toContain('reinicio del backend')
    fireEvent.click(screen.getByRole('button', { name: 'Marcar avisos como leídos' }))
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'Avisos de la extracción automática' })).toBeNull())
    expect(leidosMock).toHaveBeenCalledTimes(1)
  })
})

describe('Campanita de avisos', () => {
  it('muestra los avisos sin leer, los lista y los marca como leídos', async () => {
    estadoAuto = estadoBase({ avisos: [aviso(), aviso({ id: 'a2', tipo: 'requiere_revision', texto: '1 documento requiere revision antes de enviarse a SaveData.' })], avisos_sin_leer: 2 })
    leidosMock.mockImplementation(async () => ({ ...estadoAuto, avisos: estadoAuto.avisos?.map((item) => ({ ...item, leido: true })), avisos_sin_leer: 0 }))
    render(<CampanaAvisos />)
    const campana = await screen.findByRole('button', { name: 'Avisos (2 sin leer)' })
    fireEvent.click(campana)
    const panel = screen.getByRole('dialog', { name: 'Avisos de la extracción automática' })
    expect(panel.textContent).toContain('requiere revision')
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todos como leídos' }))
    expect(await screen.findByRole('button', { name: 'Avisos' })).toBeTruthy()
  })

  it('un aviso nuevo aparece emergente al publicarse un estado', async () => {
    render(<CampanaAvisos />)
    await screen.findByRole('button', { name: 'Avisos' })
    act(() => { publicarEstadoAutomatico(estadoBase({ avisos: [aviso({ id: 'nuevo' })], avisos_sin_leer: 1 })) })
    const emergente = await screen.findByRole('status', { name: 'Nuevo aviso' })
    expect(emergente.textContent).toContain('SaveData')
    expect(screen.getByRole('button', { name: 'Avisos (1 sin leer)' })).toBeTruthy()
  })

  it('los avisos ya conocidos al cargar no aparecen emergentes', async () => {
    estadoAuto = estadoBase({ avisos: [aviso()], avisos_sin_leer: 1 })
    render(<CampanaAvisos />)
    await screen.findByRole('button', { name: 'Avisos (1 sin leer)' })
    expect(screen.queryByRole('status', { name: 'Nuevo aviso' })).toBeNull()
  })
})

describe('Aviso del ciclo por tipo', () => {
  it('Automatización dice cuántos se enviaron y cuántos no, por tipo', () => {
    const texto = 'Se enviaron 2 (1 Fianzas, 1 Autos individuales) · 1 requiere revisión (Gastos médicos mayores)'
    render(<ResumenUltimoCiclo estado={estadoBase({ ultimo_ciclo: ciclo({ texto_envios: texto }) })} />)
    expect(screen.getByTestId('envios-por-tipo').textContent).toBe(texto)
  })

  it('sin envíos en el ciclo no muestra la línea por tipo', () => {
    render(<ResumenUltimoCiclo estado={estadoBase({ ultimo_ciclo: ciclo({ texto_envios: null }) })} />)
    expect(screen.queryByTestId('envios-por-tipo')).toBeNull()
  })
})
