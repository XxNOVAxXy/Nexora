// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EstadoAutomatico } from './services/automaticoApi'
import type { DocumentoEnviado, IntentoHistorial } from './services/savedataApi'

const { estadoMock, configurarEnvioMock, historialMock } = vi.hoisted(() => ({ estadoMock: vi.fn(), configurarEnvioMock: vi.fn(), historialMock: vi.fn() }))
vi.mock('./services/automaticoApi', () => ({ automaticoApi: { estado: estadoMock, configurar: vi.fn(), configurarEnvio: configurarEnvioMock, revisarAhora: vi.fn() } }))
vi.mock('./services/savedataApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/savedataApi')>()
  return { ...real, savedataApi: { ...real.savedataApi, historial: historialMock }, ejecutarEliminacion: vi.fn() }
})
vi.mock('./services/gmailApi', () => ({ gmailApi: { message: vi.fn() } }))

const { TarjetaExtraccionAutomatica } = await import('./App')
const { HistorialEnviosPage } = await import('./HistorialEnvios')

const estadoBase = (cambios: Partial<EstadoAutomatico> = {}): EstadoAutomatico => ({
  activo: true, activado_en: '2026-11-13T09:00:00Z', ultima_revision: null, proxima_revision: null, en_curso: false, intervalo_minutos: 20, ultimo_resultado: null, ultimo_error: null,
  gemini_configurado: true, campos: [], adjuntos: {}, envio_activo: false, solo_si_cuadra: true, envio_activado_en: null, savedata_configurada: true, ...cambios,
})

const intento = (cambios: Partial<IntentoHistorial> = {}): IntentoHistorial => ({
  id: 'i1', iniciado_en: '2026-11-13T10:00:00Z', terminado_en: '2026-11-13T10:00:01Z', resultado: 'exito', sucursal: null, articulo: null,
  error: null, accion: 'enviar', reenvio: false, agregado_de_nuevo: false, version_extraccion: 2, faltantes: [], automatico: true, ...cambios,
})
const documento = (cambios: Partial<DocumentoEnviado> = {}): DocumentoEnviado => {
  const primero = intento()
  return { id: 'm1__1', messageId: 'm1', partId: '1', filename: 'estado.pdf', estado: 'enviado', version: 2, enviado_en: primero.terminado_en, modificado_tras_envio: false, en_savedata: 'presente', ultimo: primero, intentos: [primero], envio_automatico: null, ...cambios }
}
const auto = (estado: NonNullable<DocumentoEnviado['envio_automatico']>['estado'], cambios: Partial<NonNullable<DocumentoEnviado['envio_automatico']>> = {}) => ({ estado, intentos: 1, error: null, motivos: [], problemas: [], actualizado: '2026-11-13T10:00:01Z', ...cambios })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Configuración: envío automático a SaveData', () => {
  it('apagado por defecto y con "Enviar solo si cuadra" encendido; se enciende por separado', async () => {
    estadoMock.mockResolvedValue(estadoBase())
    configurarEnvioMock.mockImplementation(async (activo: boolean, cuadra: boolean) => estadoBase({ envio_activo: activo, solo_si_cuadra: cuadra }))
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    const envio = await screen.findByRole('switch', { name: 'Envío automático a SaveData' })
    await waitFor(() => expect((envio as HTMLButtonElement).disabled).toBe(false))
    expect(envio.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Enviar solo si cuadra' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Extracción automática' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(envio)
    await waitFor(() => expect(configurarEnvioMock).toHaveBeenCalledWith(true, true))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Envío automático a SaveData' }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getByRole('switch', { name: 'Enviar solo si cuadra' }))
    await waitFor(() => expect(configurarEnvioMock).toHaveBeenLastCalledWith(true, false))
  })

  it('sin SAVEDATA_URL no se puede encender y lo indica', async () => {
    estadoMock.mockResolvedValue(estadoBase({ savedata_configurada: false }))
    render(<TarjetaExtraccionAutomatica onNotice={vi.fn()} onError={vi.fn()} />)
    expect(await screen.findByText(/SAVEDATA_URL no está configurada/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Envío automático a SaveData' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Envíos: estados del envío automático', () => {
  const pintar = () => render(<MemoryRouter><HistorialEnviosPage /></MemoryRouter>)

  it('distingue enviado automáticamente, requiere revisión, error e incierto', async () => {
    historialMock.mockResolvedValue({ documentos: [
      documento({ envio_automatico: auto('enviado') }),
      documento({ id: 'm2__1', messageId: 'm2', filename: 'b.pdf', estado: 'borrador', ultimo: null, intentos: [], enviado_en: null, en_savedata: 'nunca', envio_automatico: auto('requiere_revision', { motivos: ['La validacion contable no cuadra.'] }) }),
      documento({ id: 'm3__1', messageId: 'm3', filename: 'c.pdf', estado: 'revisado', ultimo: intento({ resultado: 'error' }), envio_automatico: auto('error', { intentos: 3, error: 'SaveData respondio HTTP 500.' }) }),
      documento({ id: 'm4__1', messageId: 'm4', filename: 'd.pdf', estado: 'revisado', ultimo: intento({ resultado: 'incierto' }), envio_automatico: auto('incierto') }),
    ] })
    pintar()
    expect(await screen.findByText('Enviado automáticamente')).toBeTruthy()
    expect(screen.getByText('Requiere revisión')).toBeTruthy()
    expect(screen.getByText('Error al enviar')).toBeTruthy()
    expect(screen.getByText('Incierto, verificar')).toBeTruthy()
    expect(screen.getByText('La validacion contable no cuadra.')).toBeTruthy()
    expect(screen.getByText('SaveData respondio HTTP 500.')).toBeTruthy()
    expect(screen.getByText(/No se envió · revisado por el envío automático/)).toBeTruthy()
  })

  it('con la protección apagada muestra los problemas con los que se envió y marca el intento automático', async () => {
    historialMock.mockResolvedValue({ documentos: [documento({ envio_automatico: auto('enviado', { problemas: ['1 importe(s) dudoso(s).'] }) })] })
    pintar()
    expect(await screen.findByText(/Problemas encontrados:/)).toBeTruthy()
    expect(screen.getByText('1 importe(s) dudoso(s).')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ver intentos' }))
    expect(screen.getByText(/· envío automático/)).toBeTruthy()
  })
})
