// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { listarMock, probarMock, agregarMock, quitarMock, automaticoMock, revisarMock } = vi.hoisted(() => ({
  listarMock: vi.fn(), probarMock: vi.fn(), agregarMock: vi.fn(), quitarMock: vi.fn(), automaticoMock: vi.fn(), revisarMock: vi.fn(),
}))
vi.mock('./services/imapApi', async (original) => ({
  ...(await original<typeof import('./services/imapApi')>()),
  imapApi: { listar: listarMock, probar: probarMock, agregar: agregarMock, quitar: quitarMock, automatico: automaticoMock, revisar: revisarMock },
}))

const { CuentasImapPage } = await import('./CuentasImap')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const cuenta = { id: '1', correo: 'polizas@empresa-ficticia.test', servidor: 'imap.empresa-ficticia.test', puerto: 993, seguridad: 'ssl', usuario: 'polizas', activo: true, creado: null,
  automatico: { activo: false, en_curso: false, ultima_revision: null, ultimo_resultado: null, ultimo_error: null } }

const llenar = () => {
  fireEvent.change(screen.getByLabelText('Correo'), { target: { value: 'polizas@empresa-ficticia.test' } })
  fireEvent.change(screen.getByLabelText('Servidor'), { target: { value: 'imap.empresa-ficticia.test' } })
  fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'polizas' } })
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'Contrasena-Ficticia-123' } })
}

describe('Cuentas IMAP', () => {
  it('prueba la conexión, guarda y no deja la contraseña en pantalla', async () => {
    listarMock.mockResolvedValueOnce({ cuentas: [] }).mockResolvedValue({ cuentas: [cuenta] })
    probarMock.mockResolvedValue({ ok: true, mensajes: 3, carpeta: 'INBOX' })
    agregarMock.mockResolvedValue({ cuenta })
    render(<CuentasImapPage />)
    expect(await screen.findByText('Todavía no hay cuentas IMAP.')).toBeTruthy()
    llenar()
    fireEvent.change(screen.getByLabelText('Seguridad'), { target: { value: 'starttls' } })
    expect((screen.getByLabelText('Puerto') as HTMLInputElement).value).toBe('143')
    fireEvent.click(screen.getByRole('button', { name: /Probar conexión/ }))
    expect((await screen.findByRole('status')).textContent).toContain('3 mensajes en INBOX')
    expect(probarMock).toHaveBeenCalledWith(expect.objectContaining({ seguridad: 'starttls', puerto: 143, contrasena: 'Contrasena-Ficticia-123' }))
    fireEvent.click(screen.getByRole('button', { name: /Guardar cuenta/ }))
    await waitFor(() => expect(agregarMock).toHaveBeenCalled())
    expect(await screen.findByText('polizas@empresa-ficticia.test')).toBeTruthy()
    expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('Contrasena-Ficticia-123')
  })

  it('error de conexión claro', async () => {
    listarMock.mockResolvedValue({ cuentas: [] })
    probarMock.mockRejectedValue(new Error('El servidor IMAP rechazo el usuario o la contrasena.'))
    render(<CuentasImapPage />)
    await screen.findByText('Todavía no hay cuentas IMAP.')
    llenar()
    fireEvent.click(screen.getByRole('button', { name: /Probar conexión/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('rechazo el usuario o la contrasena')
  })

  it('activa la extracción automática, revisa ahora y quita la cuenta', async () => {
    listarMock.mockResolvedValue({ cuentas: [{ ...cuenta, automatico: { ...cuenta.automatico, activo: true } }] })
    automaticoMock.mockResolvedValue({})
    revisarMock.mockResolvedValue({})
    quitarMock.mockResolvedValue({ ok: true })
    render(<CuentasImapPage />)
    fireEvent.click(await screen.findByRole('switch', { name: /Extracción automática de polizas/ }))
    await waitFor(() => expect(automaticoMock).toHaveBeenCalledWith('1', false))
    fireEvent.click(screen.getByRole('button', { name: /Revisar ahora/ }))
    await waitFor(() => expect(revisarMock).toHaveBeenCalledWith('1'))
    fireEvent.click(screen.getByRole('button', { name: /Quitar polizas/ }))
    await waitFor(() => expect(quitarMock).toHaveBeenCalledWith('1'))
  })
})
