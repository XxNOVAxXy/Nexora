import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, PenLine, RefreshCw, Trash2 } from 'lucide-react'
import { bandejaApi, type CodigoBandeja, type DocumentoBandeja, type EstadoBandeja, type EventoProceso } from './services/bandejaApi'
import { gmailApi } from './services/gmailApi'
import { urlAbrirEnvio } from './HistorialEnvios'

export const MOTIVO_BANDEJA: Record<CodigoBandeja, { texto: string; ayuda: string; clase: string }> = {
  pdf_protegido: { texto: 'PDF con contraseña', ayuda: 'Pide el documento sin contraseña o captúralo a mano.', clase: 'bg-red-50 text-red-700' },
  pdf_danado: { texto: 'PDF dañado', ayuda: 'El archivo está incompleto o corrupto. Pide que lo reenvíen o captúralo a mano.', clase: 'bg-red-50 text-red-700' },
  pdf_escaneado: { texto: 'PDF escaneado', ayuda: 'No tiene texto. «Reprocesar» lo lee con la IA como imagen.', clase: 'bg-amber-100 text-amber-800' },
  formato_no_soportado: { texto: 'Formato no soportado', ayuda: 'No es PDF ni imagen. Revisa el archivo y captúralo a mano si hace falta.', clase: 'bg-slate-200 text-slate-700' },
  error_extraccion: { texto: 'No se pudo extraer', ayuda: 'La extracción automática agotó sus intentos. «Reprocesar» lo intenta de nuevo.', clase: 'bg-red-50 text-red-700' },
}

const ETAPA: Record<EventoProceso['etapa'], string> = { lectura: 'Lectura', diagnostico: 'Diagnóstico', extraccion: 'Extracción', envio: 'Envío' }
const ESTADOS: { valor: EstadoBandeja; texto: string }[] = [{ valor: 'pendiente', texto: 'Pendientes' }, { valor: 'resuelto', texto: 'Resueltos' }, { valor: 'descartado', texto: 'Descartados' }]

const fechaHora = (valor: string | null | undefined) => (valor ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(valor)) : '—')
const clave = (documento: DocumentoBandeja) => `${documento.message_id}__${documento.part_id}`
type Aviso = { id: string; ok: boolean; mensaje: string }

/** Documentos que no se pudieron procesar solos: por qué, su historial y qué hacer (reprocesar o capturar a mano). */
export function BandejaCapturaPage() {
  const navigate = useNavigate()
  const [estado, setEstado] = useState<EstadoBandeja>('pendiente')
  const [documentos, setDocumentos] = useState<DocumentoBandeja[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [eventos, setEventos] = useState<Record<string, EventoProceso[] | 'error'>>({})

  const cargar = (filtro: EstadoBandeja = estado) => {
    setError(null)
    setDocumentos(null)
    bandejaApi.listar(filtro).then((valor) => setDocumentos(valor.documentos)).catch((motivo: unknown) => setError(motivo instanceof Error ? motivo.message : 'No se pudo cargar la bandeja.'))
  }
  useEffect(() => cargar(estado), [estado]) // eslint-disable-line react-hooks/exhaustive-deps

  const verEventos = (documento: DocumentoBandeja) => {
    const id = clave(documento)
    if (abierto === id) { setAbierto(null); return }
    setAbierto(id)
    bandejaApi.eventos(documento.message_id, documento.part_id)
      .then((valor) => setEventos((previo) => ({ ...previo, [id]: valor.eventos })))
      .catch(() => setEventos((previo) => ({ ...previo, [id]: 'error' })))
  }

  const reprocesar = async (documento: DocumentoBandeja) => {
    const id = clave(documento)
    setOcupado(id)
    setAviso(null)
    try {
      const resultado = await bandejaApi.reprocesar(documento.message_id, documento.part_id)
      const ok = resultado.estado !== 'sigue_en_bandeja'
      setAviso({ id, ok, mensaje: ok ? (resultado.mensaje ?? 'Listo.') : `Sigue sin poder procesarse: ${resultado.mensaje ?? ''}`.trim() })
      if (ok) setDocumentos((previo) => previo?.filter((item) => clave(item) !== id) ?? previo)
    } catch (motivo) {
      setAviso({ id, ok: false, mensaje: motivo instanceof Error ? motivo.message : 'No se pudo reprocesar.' })
    } finally {
      setOcupado(null)
      // El historial cambió: se vuelve a pedir la próxima vez que se abra.
      setEventos((previo) => Object.fromEntries(Object.entries(previo).filter(([otro]) => otro !== id)))
    }
  }

  const descartar = async (documento: DocumentoBandeja) => {
    const id = clave(documento)
    setOcupado(id)
    setAviso(null)
    try {
      await bandejaApi.descartar(documento.message_id, documento.part_id)
      setDocumentos((previo) => previo?.filter((item) => clave(item) !== id) ?? previo)
    } catch (motivo) {
      setAviso({ id, ok: false, mensaje: motivo instanceof Error ? motivo.message : 'No se pudo quitar de la bandeja.' })
    } finally {
      setOcupado(null)
    }
  }

  // El id del adjunto de Gmail cambia entre consultas: se busca el vigente por partId antes de abrir Extracción.
  const capturar = async (documento: DocumentoBandeja) => {
    const id = clave(documento)
    setOcupado(id)
    setAviso(null)
    try {
      const mensaje = await gmailApi.message(documento.message_id)
      const adjunto = mensaje.attachments.find((item) => item.partId === documento.part_id)
      if (!adjunto) throw new Error('El correo ya no tiene este adjunto.')
      navigate(urlAbrirEnvio({ messageId: documento.message_id, partId: documento.part_id, filename: documento.nombre ?? '' }, adjunto.id))
    } catch (motivo) {
      setAviso({ id, ok: false, mensaje: motivo instanceof Error ? motivo.message : 'No se pudo abrir el documento.' })
    } finally {
      setOcupado(null)
    }
  }

  return <div className="space-y-5">
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div><div className="eyebrow mb-2">Operación</div><h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">Bandeja de captura manual</h1><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Documentos que no se pudieron procesar solos: PDF con contraseña, dañado, escaneado, formato no soportado o extracción fallida. Reprocésalos o captúralos a mano.</p></div>
        <button type="button" onClick={() => cargar()} className="btn-soft shrink-0"><RefreshCw size={15} />Actualizar</button>
      </div>
      <div role="tablist" aria-label="Estado en la bandeja" className="mt-4 flex gap-1 rounded-lg bg-slate-100 p-1 sm:inline-flex">{ESTADOS.map((item) => <button key={item.valor} role="tab" type="button" aria-selected={estado === item.valor} onClick={() => setEstado(item.valor)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-bold sm:flex-none ${estado === item.valor ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>{item.texto}</button>)}</div>
    </section>

    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {!error && documentos === null && <div className="panel flex items-center justify-center gap-2 p-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" />Cargando bandeja…</div>}
    {documentos?.length === 0 && <div className="panel p-10 text-center text-sm text-slate-400">{estado === 'pendiente' ? 'No hay documentos pendientes de captura manual.' : 'No hay documentos en esta lista.'}</div>}

    {documentos && documentos.length > 0 && <ul className="space-y-3">{documentos.map((documento) => {
      const id = clave(documento)
      const bandeja = documento.bandeja
      const motivo = bandeja ? MOTIVO_BANDEJA[bandeja.codigo] : undefined
      const expandido = abierto === id
      const lista = eventos[id]
      return <li key={id} className="panel overflow-hidden">
        <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <button type="button" aria-label={expandido ? 'Ocultar historial' : 'Ver historial'} aria-expanded={expandido} onClick={() => verEventos(documento)} className="self-start rounded-md p-1 text-slate-400 hover:bg-slate-100 lg:self-auto">{expandido ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><FileText size={16} className="shrink-0 text-slate-400" /><span className="truncate font-semibold text-ink">{documento.nombre || 'Documento'}</span>{motivo && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${motivo.clase}`}>{motivo.texto}</span>}</div>
            <div className="mt-1 text-xs text-slate-500">{documento.asunto || 'Sin asunto'}{documento.remitente ? ` · ${documento.remitente}` : ''} · Recibido {fechaHora(documento.recibido_en)} · En la bandeja desde {fechaHora(bandeja?.entrada_en)}</div>
            {bandeja?.mensaje && <div className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-700"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" /><span>{bandeja.mensaje}{motivo ? ` ${motivo.ayuda}` : ''}</span></div>}
            {bandeja && bandeja.estado !== 'pendiente' && <div className="mt-1 text-xs text-slate-500">{bandeja.estado === 'resuelto' ? 'Resuelto' : 'Descartado'} {fechaHora(bandeja.resuelto_en)}{bandeja.resolucion ? ` (${bandeja.resolucion.replace(/_/g, ' ')})` : ''}</div>}
          </div>
          <div className="flex flex-wrap gap-2 lg:shrink-0">
            {documento.tiene_original && <a href={bandejaApi.urlOriginal(documento.message_id, documento.part_id)} target="_blank" rel="noreferrer" className="btn-soft justify-center"><ExternalLink size={15} />Ver original</a>}
            {bandeja?.estado === 'pendiente' && <>
              <button type="button" onClick={() => void reprocesar(documento)} disabled={ocupado !== null} className="btn-primary justify-center">{ocupado === id ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Reprocesar</button>
              <button type="button" onClick={() => void capturar(documento)} disabled={ocupado !== null} className="btn-soft justify-center"><PenLine size={15} />Capturar a mano</button>
              <button type="button" onClick={() => void descartar(documento)} disabled={ocupado !== null} aria-label="Quitar de la bandeja" title="Quitar de la bandeja" className="flex items-center justify-center rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"><Trash2 size={15} /></button>
            </>}
          </div>
        </div>
        {aviso?.id === id && <div role={aviso.ok ? 'status' : 'alert'} className={`mx-4 mb-3 rounded-lg border px-3 py-2 text-xs ${aviso.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{aviso.mensaje}</div>}
        {expandido && <div className="border-t border-slate-100 bg-slate-50/50 p-4 text-xs">
          {lista === undefined && <div className="flex items-center gap-2 text-slate-400"><Loader2 size={14} className="animate-spin" />Cargando historial…</div>}
          {lista === 'error' && <div className="text-red-700">No se pudo cargar el historial.</div>}
          {Array.isArray(lista) && lista.length === 0 && <div className="text-slate-400">Sin eventos registrados.</div>}
          {Array.isArray(lista) && lista.length > 0 && <ol className="space-y-1.5">{lista.map((evento) => <li key={evento.id} className="flex flex-wrap gap-x-2"><span className="font-semibold text-slate-700">{fechaHora(evento.fecha)}</span><span className="text-slate-500">{ETAPA[evento.etapa]} · {evento.codigo}{evento.origen ? ` · ${evento.origen}` : ''}</span><span className="text-slate-700">{evento.mensaje}</span></li>)}</ol>}
        </div>}
      </li>
    })}</ul>}
  </div>
}
