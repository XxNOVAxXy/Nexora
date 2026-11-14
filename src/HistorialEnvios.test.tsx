// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentoEnviado, IntentoHistorial } from './services/savedataApi'

const { historialMock, mensajeMock, eliminarMock } = vi.hoisted(() => ({ historialMock: vi.fn(), mensajeMock: vi.fn(), eliminarMock: vi.fn() }))
vi.mock('./services/savedataApi', () => ({ savedataApi: { historial: historialMock }, ejecutarEliminacion: eliminarMock }))
vi.mock('./services/gmailApi', () => ({ gmailApi: { message: mensajeMock } }))

const { HistorialEnviosPage } = await import('./HistorialEnvios')

const intento = (cambios: Partial<IntentoHistorial>): IntentoHistorial => ({
  id: 'i1', iniciado_en: '2026-11-13T10:00:00Z', terminado_en: '2026-11-13T10:00:01Z', resultado: 'exito', sucursal: 3102, articulo: '10000453',
  error: null, accion: 'enviar', reenvio: false, agregado_de_nuevo: false, version_extraccion: 2, faltantes: [], ...cambios,
})
const documento = (cambios: Partial<DocumentoEnviado> = {}): DocumentoEnviado => {
  const primero = intento({ faltantes: ['RFC'] })
  return { id: 'm1__1', messageId: 'm1', partId: '1', filename: 'estado.pdf', estado: 'enviado', version: 2, enviado_en: primero.terminado_en, modificado_tras_envio: false, en_savedata: 'presente', ultimo: primero, intentos: [primero], ...cambios }
}

function Ubicacion() {
  const location = useLocation()
  return <div data-testid="ubicacion">{location.pathname}{location.search}</div>
}

const pintar = () => render(<MemoryRouter initialEntries={['/envios']}><Routes><Route path="/envios" element={<HistorialEnviosPage />} /><Route path="/extraction" element={<Ubicacion />} /></Routes></MemoryRouter>)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Historial de envíos', () => {
  it('muestra lo que faltó y al hacer clic abre la extracción con el adjunto vigente del correo', async () => {
    historialMock.mockResolvedValue({ documentos: [documento()] })
    // El id del adjunto cambió desde que se guardó: se usa el actual, buscado por partId.
    mensajeMock.mockResolvedValue({ attachments: [{ id: 'otro', partId: '2' }, { id: 'adjunto-nuevo', partId: '1' }] })
    pintar()
    expect(await screen.findByText('estado.pdf')).toBeTruthy()
    expect(screen.getByText('RFC')).toBeTruthy()
    expect(screen.getByText(/Se envió sin:/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Abrir y completar/ }))
    const ubicacion = await screen.findByTestId('ubicacion')
    const params = new URLSearchParams(ubicacion.textContent!.split('?')[1])
    expect(ubicacion.textContent!.startsWith('/extraction?')).toBe(true)
    expect(Object.fromEntries(params)).toEqual({ message: 'm1', attachment: 'adjunto-nuevo', part: '1', filename: 'estado.pdf' })
    expect(mensajeMock).toHaveBeenCalledWith('m1')
  })

  it('muestra los intentos y avisa si el correo ya no tiene el adjunto', async () => {
    const actualizacion = intento({ id: 'i2', reenvio: true, version_extraccion: 3 })
    historialMock.mockResolvedValue({ documentos: [documento({ ultimo: actualizacion, intentos: [intento({ faltantes: ['RFC'] }), actualizacion] })] })
    mensajeMock.mockResolvedValue({ attachments: [] })
    pintar()
    fireEvent.click(await screen.findByRole('button', { name: 'Ver intentos' }))
    expect(screen.getByText(/· actualización/)).toBeTruthy()
    expect(screen.getByText(/· primer envío/)).toBeTruthy()
    expect(screen.getByText('Sin: RFC')).toBeTruthy()
    expect(screen.getByText('Todos los campos con valor.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Abrir$/ }))
    expect(await screen.findByText('El correo ya no tiene este adjunto.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('ubicacion')).toBeNull())
  })

  it('eliminar de SaveData pide confirmación, llama al backend y muestra el documento como eliminado', async () => {
    const eliminado = intento({ id: 'i2', accion: 'eliminar', sucursal: null, articulo: null })
    historialMock.mockResolvedValueOnce({ documentos: [documento()] }).mockResolvedValueOnce({ documentos: [documento({ en_savedata: 'eliminado', ultimo: eliminado, intentos: [intento({ faltantes: ['RFC'] }), eliminado] })] })
    eliminarMock.mockResolvedValue({ ok: true, mensaje: 'SaveData elimino el registro.' })
    pintar()
    fireEvent.click(await screen.findByRole('button', { name: /Eliminar de SaveData/ }))
    expect(eliminarMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain('m1__1')
    fireEvent.click(screen.getByRole('button', { name: 'Sí, eliminar de SaveData' }))
    expect(await screen.findByText('SaveData elimino el registro.')).toBeTruthy()
    expect(eliminarMock).toHaveBeenCalledWith('m1', '1')
    expect(await screen.findByText('Eliminado de SaveData')).toBeTruthy()
    // Ya no se puede eliminar otra vez ni se marca lo que faltó.
    expect(screen.queryByRole('button', { name: /Eliminar de SaveData/ })).toBeNull()
    expect(screen.queryByText(/Se envió sin:/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ver intentos' }))
    expect(screen.getByText(/· eliminación/)).toBeTruthy()
    expect(screen.getByText('Eliminado')).toBeTruthy()
  })

  it('cancelar no elimina nada', async () => {
    historialMock.mockResolvedValue({ documentos: [documento()] })
    pintar()
    fireEvent.click(await screen.findByRole('button', { name: /Eliminar de SaveData/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(eliminarMock).not.toHaveBeenCalled()
  })

  it('sin envíos muestra el aviso vacío', async () => {
    historialMock.mockResolvedValue({ documentos: [] })
    pintar()
    expect(await screen.findByText('Aún no se ha enviado ningún documento a SaveData.')).toBeTruthy()
  })
})
