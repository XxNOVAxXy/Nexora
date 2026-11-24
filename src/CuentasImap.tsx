import { useEffect, useState } from 'react'
import { Loader2, Plug, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { imapApi, puertoPara, type CuentaImap, type SeguridadImap, type SolicitudCuentaImap } from './services/imapApi'
import { formatoMexico } from './services/fechas'

const vacia: SolicitudCuentaImap = { correo: '', servidor: '', puerto: 993, seguridad: 'ssl', usuario: '', contrasena: '' }
const mensaje = (error: unknown, otro: string) => (error instanceof Error ? error.message : otro)
const fechaHora = (valor: string | null | undefined) => (valor ? formatoMexico({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(valor)) : '—')

/** Cuentas IMAP corporativas: agregar (con «Probar conexión»), activar su proceso automático, revisar ahora y quitar. */
export function CuentasImapPage() {
  const [cuentas, setCuentas] = useState<CuentaImap[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null)
  const [forma, setForma] = useState<SolicitudCuentaImap>(vacia)
  const [ocupado, setOcupado] = useState<string | null>(null)

  const cargar = () => {
    setError(null)
    imapApi.listar().then((valor) => setCuentas(valor.cuentas)).catch((motivo: unknown) => setError(mensaje(motivo, 'No se pudieron cargar las cuentas IMAP.')))
  }
  useEffect(cargar, [])

  const completa = forma.correo.includes('@') && forma.servidor.trim() && forma.usuario.trim() && forma.contrasena && forma.puerto >= 1 && forma.puerto <= 65535
  const cambiar = (cambio: Partial<SolicitudCuentaImap>) => setForma((actual) => ({ ...actual, ...cambio }))

  const accion = async (nombre: string, trabajo: () => Promise<string>) => {
    setOcupado(nombre)
    setAviso(null)
    try { setAviso({ ok: true, texto: await trabajo() }) } catch (motivo) { setAviso({ ok: false, texto: mensaje(motivo, 'No se pudo completar.') }) } finally { setOcupado(null) }
  }
  const probar = () => accion('probar', async () => { const r = await imapApi.probar(forma); return `Conexión correcta: ${r.mensajes} mensaje${r.mensajes === 1 ? '' : 's'} en ${r.carpeta}.` })
  const guardar = () => accion('guardar', async () => {
    const r = await imapApi.agregar(forma)
    setForma(vacia) // la contraseña no se queda en pantalla
    cargar()
    return `Cuenta ${r.cuenta.correo} guardada (contraseña cifrada). Activa su extracción automática cuando quieras.`
  })

  return <div className="space-y-5">
    <section className="panel p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div><div className="eyebrow mb-2">Sistema</div><h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">Cuentas IMAP</h1><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Buzones corporativos que no son Gmail. Se revisan igual que Gmail: extracción automática, «Revisar ahora», bandeja y reintentos. La contraseña se guarda cifrada y nunca se vuelve a mostrar.</p></div>
        <button type="button" onClick={cargar} className="btn-soft shrink-0"><RefreshCw size={15} />Actualizar</button>
      </div>
    </section>

    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {aviso && <div role={aviso.ok ? 'status' : 'alert'} className={`rounded-xl border px-4 py-3 text-sm ${aviso.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{aviso.texto}</div>}

    <section className="panel p-5" aria-label="Agregar cuenta IMAP">
      <div className="mb-3 text-sm font-bold text-ink">Agregar cuenta IMAP</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-[11px] font-bold text-slate-500">Correo<input aria-label="Correo" type="email" value={forma.correo} onChange={(e) => cambiar({ correo: e.target.value })} placeholder="polizas@empresa.com" className="input mt-1 py-1.5 text-xs" /></label>
        <label className="text-[11px] font-bold text-slate-500">Servidor<input aria-label="Servidor" value={forma.servidor} onChange={(e) => cambiar({ servidor: e.target.value })} placeholder="imap.empresa.com" className="input mt-1 py-1.5 text-xs" /></label>
        <label className="text-[11px] font-bold text-slate-500">Seguridad<select aria-label="Seguridad" value={forma.seguridad} onChange={(e) => { const seguridad = e.target.value as SeguridadImap; cambiar({ seguridad, puerto: puertoPara(seguridad) }) }} className="input mt-1 py-1.5 text-xs"><option value="ssl">SSL/TLS (993)</option><option value="starttls">STARTTLS (143)</option><option value="ninguna">Sin cifrado (solo este equipo)</option></select></label>
        <label className="text-[11px] font-bold text-slate-500">Puerto<input aria-label="Puerto" type="number" min={1} max={65535} value={forma.puerto} onChange={(e) => cambiar({ puerto: Number(e.target.value) })} className="input mt-1 py-1.5 text-xs" /></label>
        <label className="text-[11px] font-bold text-slate-500">Usuario<input aria-label="Usuario" value={forma.usuario} autoComplete="username" onChange={(e) => cambiar({ usuario: e.target.value })} placeholder="polizas" className="input mt-1 py-1.5 text-xs" /></label>
        <label className="text-[11px] font-bold text-slate-500">Contraseña<input aria-label="Contraseña" type="password" autoComplete="new-password" value={forma.contrasena} onChange={(e) => cambiar({ contrasena: e.target.value })} className="input mt-1 py-1.5 text-xs" /></label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void probar()} disabled={!completa || ocupado !== null} className="btn-soft">{ocupado === 'probar' ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}Probar conexión</button>
        <button type="button" onClick={() => void guardar()} disabled={!completa || ocupado !== null} className="btn-primary">{ocupado === 'guardar' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Guardar cuenta</button>
      </div>
    </section>

    {cuentas === null && !error && <div className="panel flex items-center justify-center gap-2 p-8 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" />Cargando cuentas…</div>}
    {cuentas?.length === 0 && <div className="panel p-8 text-center text-sm text-slate-400">Todavía no hay cuentas IMAP.</div>}
    {cuentas && cuentas.length > 0 && <ul className="space-y-3">{cuentas.map((cuenta) => {
      const activo = Boolean(cuenta.automatico?.activo)
      return <li key={cuenta.id} className="panel flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><Server size={15} className="text-slate-400" /><span className="font-semibold text-ink">{cuenta.correo}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{cuenta.servidor}:{cuenta.puerto} · {cuenta.seguridad?.toUpperCase() ?? '—'}</span></div>
          <div className="mt-1 text-xs text-slate-500">Usuario {cuenta.usuario ?? '—'} · Última revisión {fechaHora(cuenta.automatico?.ultima_revision)}{cuenta.automatico?.ultimo_resultado ? ` (${cuenta.automatico.ultimo_resultado})` : ''}</div>
          {cuenta.automatico?.ultimo_error && <div className="mt-1 text-xs text-red-700">{cuenta.automatico.ultimo_error}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" role="switch" aria-checked={activo} aria-label={`Extracción automática de ${cuenta.correo}`} onClick={() => void accion(`auto-${cuenta.id}`, async () => { await imapApi.automatico(cuenta.id, !activo); cargar(); return activo ? 'Extracción automática en pausa.' : 'Extracción automática activa.' })} className="btn-soft">{activo ? 'Activa' : 'En pausa'}</button>
          <button type="button" onClick={() => void accion(`revisar-${cuenta.id}`, async () => { await imapApi.revisar(cuenta.id); return `Revisando ${cuenta.correo}…` })} disabled={!activo} className="btn-soft"><RefreshCw size={14} />Revisar ahora</button>
          <button type="button" aria-label={`Quitar ${cuenta.correo}`} onClick={() => void accion(`quitar-${cuenta.id}`, async () => { await imapApi.quitar(cuenta.id); cargar(); return `Cuenta ${cuenta.correo} quitada.` })} className="flex items-center justify-center rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"><Trash2 size={15} /></button>
        </div>
      </li>
    })}</ul>}
  </div>
}
