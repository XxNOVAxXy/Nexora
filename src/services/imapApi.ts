/** Cuentas IMAP corporativas (la contraseña solo viaja al probar o guardar; el backend nunca la devuelve). */
import { request } from './extraccionesApi'

export type SeguridadImap = 'ssl' | 'starttls' | 'ninguna'
export type CuentaImap = {
  id: string
  correo: string
  servidor: string
  puerto: number
  seguridad: SeguridadImap | null
  usuario: string | null
  activo: boolean
  creado: string | null
  automatico: { activo: boolean; en_curso: boolean; ultima_revision: string | null; ultimo_resultado: string | null; ultimo_error: string | null } | null
}
export type SolicitudCuentaImap = { correo: string; servidor: string; puerto: number; seguridad: SeguridadImap; usuario: string; contrasena: string }

/** Puerto habitual de cada seguridad: 993 con SSL, 143 con STARTTLS. */
export const puertoPara = (seguridad: SeguridadImap) => (seguridad === 'ssl' ? 993 : 143)

const json = (valor: unknown) => JSON.stringify(valor)

export const imapApi = {
  listar: () => request<{ cuentas: CuentaImap[] }>('/imap/cuentas'),
  probar: (cuenta: SolicitudCuentaImap) => request<{ ok: boolean; mensajes: number; carpeta: string }>('/imap/probar', { method: 'POST', body: json(cuenta) }),
  agregar: (cuenta: SolicitudCuentaImap) => request<{ cuenta: CuentaImap }>('/imap/cuentas', { method: 'POST', body: json(cuenta) }),
  quitar: (id: string) => request<{ ok: boolean }>(`/imap/cuentas/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  automatico: (id: string, activo: boolean) => request<unknown>(`/imap/cuentas/${encodeURIComponent(id)}/automatico`, { method: 'PUT', body: json({ activo }) }),
  revisar: (id: string) => request<unknown>(`/imap/cuentas/${encodeURIComponent(id)}/revisar`, { method: 'POST' }),
}
