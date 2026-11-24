import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, CheckCircle2, X } from 'lucide-react'
import { automaticoApi, type AvisoAutomatico, type Descartado, type EstadoAutomatico } from './services/automaticoApi'
import { EVENTO_ESTADO_AUTOMATICO, publicarEstadoAutomatico } from './services/eventosAutomatico'
import { avisosSinLeer, motivosAgrupados, resumenCiclo, textoMotivo, textoResultadoCiclo } from './services/estadoAutomatico'
import { formatoMexico } from './services/fechas'

const fechaHora = (valor: string | null | undefined) => (valor ? formatoMexico({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(valor)) : '—')

const ESTILO_AVISO: Record<string, string> = {
  enviado: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  requiere_revision: 'border-amber-200 bg-amber-50 text-amber-900',
  incierto: 'border-amber-200 bg-amber-50 text-amber-900',
  error: 'border-red-200 bg-red-50 text-red-800',
  error_ciclo: 'border-red-200 bg-red-50 text-red-800',
}
const estiloAviso = (tipo: string) => ESTILO_AVISO[tipo] ?? 'border-slate-200 bg-slate-50 text-slate-700'

function IconoAviso({ tipo }: { tipo: string }) {
  return tipo === 'enviado' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />
}

/** Resumen del último ciclo; mientras hay uno en curso, solo "Revisando ahora". */
export function ResumenUltimoCiclo({ estado }: { estado: EstadoAutomatico }) {
  if (estado.en_curso) {
    return <p role="status" className="mt-3 text-xs font-semibold text-blue-700">Revisando ahora{estado.ciclo_en_curso_desde ? ` (desde ${fechaHora(estado.ciclo_en_curso_desde)})` : ''}…</p>
  }
  const ciclo = estado.ultimo_ciclo
  if (!ciclo) return <p className="mt-3 text-xs text-slate-500">{estado.revision_pendiente ? 'Revisión solicitada; empezará en unos segundos.' : 'Todavía no hay ciclos registrados.'}</p>
  const problema = ['error', 'interrumpido', 'interrumpido_reinicio', 'sin_gmail', 'limite_gmail', 'sin_gemini'].includes(ciclo.resultado)
  return (
    <div role="region" aria-label="Último ciclo" className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs text-slate-600">
      <div className="font-semibold text-ink">
        Último ciclo: <span className={problema ? 'text-red-700' : 'text-emerald-700'}>{textoResultadoCiclo(ciclo.resultado)}</span>
        <span className="font-normal text-slate-400"> · {ciclo.origen === 'manual' ? 'manual' : 'programado'} · {fechaHora(ciclo.fin ?? ciclo.detectado_en ?? ciclo.inicio)}</span>
      </div>
      <div className={`mt-1 ${ciclo.errores > 0 ? 'font-semibold text-red-700' : ''}`}>{resumenCiclo(ciclo)}</div>
      {ciclo.texto_envios && <div className="mt-1 font-semibold text-ink" data-testid="envios-por-tipo">{ciclo.texto_envios}</div>}
      {ciclo.descartes.length > 0 && <div className="mt-1 text-slate-500">Omitidos: {motivosAgrupados(ciclo)}{ciclo.descartes_total > ciclo.descartes.length ? ` y ${ciclo.descartes_total - ciclo.descartes.length} más` : ''}</div>}
      {ciclo.error && <div className="mt-1 text-red-700">{ciclo.error}</div>}
      {estado.revision_pendiente && <div className="mt-1 text-blue-700">Revisión solicitada; empezará en unos segundos.</div>}
    </div>
  )
}

/** Correos y adjuntos que el proceso descartó, con su motivo (los más recientes primero). */
export function ListaDescartes({ descartados }: { descartados: Descartado[] }) {
  if (descartados.length === 0) return null
  return (
    <details className="mt-3 text-xs text-slate-600">
      <summary className="cursor-pointer font-semibold text-slate-500">Correos y adjuntos descartados ({descartados.length})</summary>
      <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {descartados.slice(0, 100).map((item) => (
          <li key={item.clave} className="rounded-md border border-slate-100 bg-white px-2.5 py-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-semibold text-ink">{item.asunto || `Correo ${item.message_id}`}{item.part_id ? ` · adjunto ${item.part_id}` : ''}</span>
              <span className="text-[10px] text-slate-400">{fechaHora(item.ultima_vez)}{item.veces && item.veces > 1 ? ` · visto ${item.veces} veces` : ''}</span>
            </div>
            <div><span className="font-semibold text-amber-800">{textoMotivo(item.motivo)}</span>{item.detalle ? <span className="text-slate-500"> — {item.detalle}</span> : null}</div>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Avisos sin leer, visibles en la tarjeta. */
export function AvisosAutomatico({ estado, onActualizado }: { estado: EstadoAutomatico; onActualizado: (estado: EstadoAutomatico) => void }) {
  const avisos = avisosSinLeer(estado)
  if (avisos.length === 0) return null
  const marcar = async () => {
    try { onActualizado(publicarEstadoAutomatico(await automaticoApi.marcarAvisosLeidos())) } catch { /* se reintenta en la siguiente consulta */ }
  }
  return (
    <div role="alert" aria-label="Avisos de la extracción automática" className="mt-3 space-y-1.5">
      {avisos.slice(0, 5).map((aviso) => <FilaAviso key={aviso.id} aviso={aviso} />)}
      <button type="button" onClick={() => void marcar()} className="text-[11px] font-semibold text-slate-500 underline">Marcar avisos como leídos</button>
    </div>
  )
}

function FilaAviso({ aviso }: { aviso: AvisoAutomatico }) {
  return (
    <div className={`flex gap-2 rounded-lg border px-3 py-2 text-xs ${estiloAviso(aviso.tipo)} ${aviso.leido ? 'opacity-60' : ''}`}>
      <IconoAviso tipo={aviso.tipo} />
      <div><div>{aviso.texto}</div><div className="text-[10px] opacity-70">{fechaHora(aviso.fecha)}</div></div>
    </div>
  )
}

/** Campanita del encabezado: avisos de la extracción automática, con un aviso emergente cuando llega uno nuevo. */
export function CampanaAvisos() {
  const [estado, setEstado] = useState<EstadoAutomatico | null>(null)
  const [abierta, setAbierta] = useState(false)
  const [emergente, setEmergente] = useState<AvisoAutomatico | null>(null)
  const vistos = useRef<Set<string> | null>(null)

  useEffect(() => {
    let vivo = true
    const recibir = (valor: EstadoAutomatico | null) => {
      if (!vivo) return
      setEstado(valor)
      const ids = new Set((valor?.avisos ?? []).map((aviso) => aviso.id))
      // El primer estado solo fija lo ya conocido; después, un aviso sin leer que no se había visto aparece emergente.
      if (vistos.current !== null) {
        const nuevo = (valor?.avisos ?? []).find((aviso) => !aviso.leido && !vistos.current?.has(aviso.id))
        if (nuevo) setEmergente(nuevo)
      }
      vistos.current = ids
    }
    const consultar = () => { automaticoApi.estado().then(recibir).catch(() => { if (vivo) setEstado(null) }) }
    const alPublicar = (evento: Event) => recibir((evento as CustomEvent<EstadoAutomatico>).detail)
    consultar()
    const temporizador = window.setInterval(consultar, 60_000)
    window.addEventListener(EVENTO_ESTADO_AUTOMATICO, alPublicar)
    return () => { vivo = false; window.clearInterval(temporizador); window.removeEventListener(EVENTO_ESTADO_AUTOMATICO, alPublicar) }
  }, [])

  useEffect(() => {
    if (!emergente) return
    const temporizador = window.setTimeout(() => setEmergente(null), 10_000)
    return () => window.clearTimeout(temporizador)
  }, [emergente])

  const sinLeer = avisosSinLeer(estado).length
  const marcarTodos = async () => {
    try { setEstado(publicarEstadoAutomatico(await automaticoApi.marcarAvisosLeidos())) } catch { /* se reintenta en la siguiente consulta */ }
  }
  return (
    <div className="relative">
      <button type="button" aria-label={sinLeer > 0 ? `Avisos (${sinLeer} sin leer)` : 'Avisos'} aria-expanded={abierta} onClick={() => setAbierta((valor) => !valor)} className="relative rounded-lg p-2 text-slate-500 hover:bg-white">
        <Bell size={19} />
        {sinLeer > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[9px] font-bold text-white">{sinLeer > 99 ? '99+' : sinLeer}</span>}
      </button>
      {abierta && (
        <div role="dialog" aria-label="Avisos de la extracción automática" className="absolute right-0 top-11 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold text-ink">Avisos</span><button type="button" aria-label="Cerrar avisos" onClick={() => setAbierta(false)} className="text-slate-400"><X size={14} /></button></div>
          {(estado?.avisos ?? []).length === 0 ? <p className="text-xs text-slate-500">Sin avisos.</p> : <div className="max-h-80 space-y-1.5 overflow-y-auto">{(estado?.avisos ?? []).slice(0, 20).map((aviso) => <FilaAviso key={aviso.id} aviso={aviso} />)}</div>}
          {sinLeer > 0 && <button type="button" onClick={() => void marcarTodos()} className="mt-2 text-[11px] font-semibold text-slate-500 underline">Marcar todos como leídos</button>}
        </div>
      )}
      {emergente && !abierta && (
        <div role="status" aria-label="Nuevo aviso" className={`absolute right-0 top-11 z-40 flex w-80 max-w-[calc(100vw-2rem)] gap-2 rounded-xl border px-3 py-2.5 text-xs shadow-lg ${estiloAviso(emergente.tipo)}`}>
          <IconoAviso tipo={emergente.tipo} />
          <div className="flex-1">{emergente.texto}</div>
          <button type="button" aria-label="Cerrar aviso" onClick={() => setEmergente(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  )
}
