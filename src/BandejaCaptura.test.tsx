// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentoBandeja } from './services/bandejaApi'

const { listarMock, reprocesarMock, descartarMock, eventosMock, mensajeMock } = vi.hoisted(() => ({
  listarMock: vi.fn(), reprocesarMock: vi.fn(), descartarMock: vi.fn(), eventosMock: vi.fn(), mensajeMock: vi.fn(),
}))
vi.mock('./services/bandejaApi', () => ({
  bandejaApi: { listar: listarMock, reprocesar: reprocesarMock, descartar: descartarMock, eventos: eventosMock, urlOriginal: (m: string, p: string) => `/api/documentos/${m}/${p}/original` },
}))
vi.mock('./services/gmailApi', () => ({ gmailApi: { message: mensajeMock } }))

const { BandejaCapturaPage } = await import('./BandejaCaptura')

const documento = (cambios: Partial<DocumentoBandeja> = {}, codigo: NonNullable<DocumentoBandeja['bandeja']>['codigo'] = 'pdf_protegido'): DocumentoBandeja => ({
  message_id: 'm1', part_id: '1', attachment_id: 'att-viejo', nombre: 'poliza.pdf', mime: 'application/pdf', tamano: 1000, recibido_en: '2026-11-20T10:00:00Z',
  asunto: 'Póliza ficticia', remitente: 'polizas@ficticia.test', guardado_en: '2026-11-20T10:01:00Z', actualizado: '2026-11-20T10:01:00Z', tiene_original: true,
  diagnostico: { codigo: codigo === 'error_extraccion' ? 'ok' : codigo, mensaje: 'x', formato: 'pdf' },
  bandeja: { estado: 'pendiente', codigo, motivo: 'x', mensaje: 'El PDF esta protegido con contrasena: no se puede abrir sin ella.', entrada_en: '2026-11-20T10:01:00Z', resuelto_en: null, resolucion: null },
  ...cambios,
})

function Ubicacion() {
  const location = useLocation()
  return <div data-testid="ubicacion">{location.pathname}{location.search}</div>
}

const pintar = () => render(<MemoryRouter initialEntries={['/bandeja']}><Routes><Route path="/bandeja" element={<BandejaCapturaPage />} /><Route path="/extraction" element={<Ubicacion />} /></Routes></MemoryRouter>)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Bandeja de captura manual', () => {
  it('muestra el motivo, el mensaje y el enlace al original', async () => {
    listarMock.mockResolvedValue({ documentos: [documento()], motivos: {} })
    pintar()
    expect(await screen.findByText('poliza.pdf')).toBeTruthy()
    expect(screen.getByText('PDF con contraseña')).toBeTruthy()
    expect(screen.getByText(/protegido con contrasena/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Ver original/ }).getAttribute('href')).toBe('/api/documentos/m1/1/original')
    expect(listarMock).toHaveBeenCalledWith('pendiente')
  })

  it('Reprocesar: si se extrae, sale de la lista; si no, avisa por qué', async () => {
    listarMock.mockResolvedValue({ documentos: [documento({}, 'pdf_escaneado'), documento({ message_id: 'm2', nombre: 'otro.pdf' })], motivos: {} })
    reprocesarMock.mockImplementation(async (messageId: string) => messageId === 'm1'
      ? { estado: 'extraido', mensaje: 'Extraido: revisalo en Extraccion antes de enviarlo.', documento: null }
      : { estado: 'sigue_en_bandeja', mensaje: 'El PDF esta protegido con contrasena.', documento: null })
    pintar()
    await screen.findByText('poliza.pdf')
    const [primero] = screen.getAllByRole('button', { name: /Reprocesar/ })
    fireEvent.click(primero)
    await waitFor(() => expect(screen.queryByText('poliza.pdf')).toBeNull())
    expect(reprocesarMock).toHaveBeenCalledWith('m1', '1')

    fireEvent.click(screen.getByRole('button', { name: /Reprocesar/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Sigue sin poder procesarse')
    expect(screen.getByText('otro.pdf')).toBeTruthy()
  })

  it('Capturar a mano abre Extracción con el adjunto vigente del correo', async () => {
    listarMock.mockResolvedValue({ documentos: [documento()], motivos: {} })
    mensajeMock.mockResolvedValue({ attachments: [{ id: 'att-nuevo', partId: '1' }] })
    pintar()
    fireEvent.click(await screen.findByRole('button', { name: /Capturar a mano/ }))
    const ubicacion = await screen.findByTestId('ubicacion')
    expect(ubicacion.textContent).toContain('/extraction?')
    expect(ubicacion.textContent).toContain('attachment=att-nuevo')
    expect(ubicacion.textContent).toContain('part=1')
  })

  it('Quitar de la bandeja y ver el historial de eventos', async () => {
    listarMock.mockResolvedValue({ documentos: [documento()], motivos: {} })
    eventosMock.mockResolvedValue({ eventos: [
      { id: 'e2', fecha: '2026-11-20T10:01:00Z', etapa: 'diagnostico', codigo: 'pdf_protegido', mensaje: 'Protegido.', message_id: 'm1', part_id: '1', origen: 'automatico' },
      { id: 'e1', fecha: '2026-11-20T10:01:00Z', etapa: 'lectura', codigo: 'ok', mensaje: 'Archivo recibido y original guardado.', message_id: 'm1', part_id: '1', origen: 'automatico' },
    ] })
    descartarMock.mockResolvedValue({ documento: documento() })
    pintar()
    await screen.findByText('poliza.pdf')
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }))
    const evento = await screen.findByText('Protegido.')
    expect(within(evento.closest('li')!).getByText(/Diagnóstico · pdf_protegido · automatico/)).toBeTruthy()
    const lectura = screen.getByText('Archivo recibido y original guardado.')
    expect(within(lectura.closest('li')!).getByText(/Lectura · ok · automatico/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Quitar de la bandeja' }))
    await waitFor(() => expect(screen.queryByText('poliza.pdf')).toBeNull())
    expect(descartarMock).toHaveBeenCalledWith('m1', '1')
  })

  it('cambia entre pendientes, resueltos y descartados', async () => {
    listarMock.mockResolvedValue({ documentos: [], motivos: {} })
    pintar()
    expect(await screen.findByText(/No hay documentos pendientes/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Resueltos' }))
    await waitFor(() => expect(listarMock).toHaveBeenLastCalledWith('resuelto'))
  })
})
