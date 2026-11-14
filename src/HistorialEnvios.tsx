import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { ejecutarEliminacion, savedataApi, type DocumentoEnviado, type IntentoHistorial } from './services/savedataApi'
import { gmailApi } from './services/gmailApi'
import type { ResultadoIntento } from './services/extraccionesApi'

const etiquetaResultado: Record<ResultadoIntento, { texto: string; clase: string }> = {
  exito: { texto: 'Éxito', clase: 'bg-emerald-50 text-emerald-700' },
  error: { texto: 'Error', clase: 'bg-red-50 text-red-700' },
  incierto: { texto: 'Resultado incierto', clase: 'bg-amber-100 text-amber-800' },
  en_curso: { texto: 'Interrumpido / desconocido', clase: 'bg-amber-100 text-amber-800' },
  no_existe: { texto: 'Borrado en SaveData', clase: 'bg-red-50 text-red-700' },
}

const fechaHora = (valor: string | null) => (valor ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(valor)) : '—')

/** URL de Extracción con el documento original y lo que se extrajo (sin volver a extraer). */
export function urlAbrirEnvio(documento: Pick<DocumentoEnviado, 'messageId' | 'partId' | 'filename'>, attachmentId: string): string {
  const params = new URLSearchParams({ message: documento.messageId, attachment: attachmentId, part: documento.partId, filename: documento.filename || 'Documento recibido' })
  return `/extraction?${params.toString()}`
}

/** Historial de todo lo enviado a SaveData. Al hacer clic se abre la extracción junto al documento para completarla. */
export function HistorialEnviosPage() {
  const navigate = useNavigate()
  const [documentos, setDocumentos] = useState<DocumentoEnviado[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [abriendo, setAbriendo] = useState<string | null>(null)
  const [errorAbrir, setErrorAbrir] = useState<{ id: string; mensaje: string } | null>(null)
  const [confirmarEliminar, setConfirmarEliminar] = useState<string | null>(null)
  const [eliminando, setEliminando] = useState<string | null>(null)
  const [avisoEliminar, setAvisoEliminar] = useState<{ id: string; ok: boolean; mensaje: string } | null>(null)

  const cargar = () => {
    setError(null)
    setDocumentos(null)
    savedataApi.historial().then((valor) => setDocumentos(valor.documentos)).catch((motivo: unknown) => setError(motivo instanceof Error ? motivo.message : 'No se pudo cargar el historial.'))
  }
  useEffect(cargar, [])

  // El id del adjunto de Gmail cambia entre consultas: se busca el vigente por partId antes de abrir.
  const abrir = async (documento: DocumentoEnviado) => {
    const clave = documento.id ?? `${documento.messageId}__${documento.partId}`
    setAbriendo(clave)
    setErrorAbrir(null)
    try {
      const mensaje = await gmailApi.message(documento.messageId)
      const adjunto = mensaje.attachments.find((item) => item.partId === documento.partId)
      if (!adjunto) throw new Error('El correo ya no tiene este adjunto.')
      navigate(urlAbrirEnvio(documento, adjunto.id))
    } catch (motivo) {
      setErrorAbrir({ id: clave, mensaje: motivo instanceof Error ? motivo.message : 'No se pudo abrir el documento.' })
    } finally {
      setAbriendo(null)
    }
  }

  const eliminar = async (documento: DocumentoEnviado, clave: string) => {
    setConfirmarEliminar(null)
    setEliminando(clave)
    setAvisoEliminar(null)
    const respuesta = await ejecutarEliminacion(documento.messageId, documento.partId)
    setEliminando(null)
    setAvisoEliminar({ id: clave, ok: respuesta.ok, mensaje: respuesta.mensaje })
    // El historial cambia aunque falle: el intento queda auditado.
    savedataApi.historial().then((valor) => setDocumentos(valor.documentos)).catch(() => undefined)
  }

  return <div className="space-y-5">
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div><div className="eyebrow mb-2">Integración empresarial</div><h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">Historial de envíos</h1><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Todo lo que se envió a SaveData. Haz clic en un documento para abrir la extracción junto al documento original, completar lo que faltó y enviar la actualización con el mismo Id.</p></div>
        <button type="button" onClick={cargar} className="btn-soft shrink-0"><RefreshCw size={15} />Actualizar</button>
      </div>
    </section>

    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {!error && documentos === null && <div className="panel flex items-center justify-center gap-2 p-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" />Cargando historial…</div>}
    {documentos?.length === 0 && <div className="panel p-10 text-center text-sm text-slate-400">Aún no se ha enviado ningún documento a SaveData.</div>}

    {documentos && documentos.length > 0 && <ul className="space-y-3">{documentos.map((documento) => {
      const clave = documento.id ?? `${documento.messageId}__${documento.partId}`
      const expandido = abierto === clave
      const ultimo = documento.ultimo
      const eliminado = documento.en_savedata === 'eliminado'
      const pendiente = !eliminado && (documento.modificado_tras_envio || ultimo.resultado !== 'exito' || ultimo.faltantes.length > 0)
      return <li key={clave} className={`panel overflow-hidden ${eliminado ? 'opacity-70' : ''}`}>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <button type="button" aria-label={expandido ? 'Ocultar intentos' : 'Ver intentos'} aria-expanded={expandido} onClick={() => setAbierto(expandido ? null : clave)} className="hidden rounded-md p-1 text-slate-400 hover:bg-slate-100 sm:block">{expandido ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
          <button type="button" onClick={() => void abrir(documento)} disabled={abriendo !== null} className="min-w-0 flex-1 text-left" title="Abrir la extracción y el documento">
            <div className="flex flex-wrap items-center gap-2"><FileText size={16} className="shrink-0 text-slate-400" /><span className="truncate font-semibold text-ink hover:text-coral">{documento.filename || 'Documento'}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${etiquetaResultado[ultimo.resultado].clase}`}>{etiquetaResultado[ultimo.resultado].texto}</span>{eliminado && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">Eliminado de SaveData</span>}{documento.en_savedata === 'borrado' && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">Lo borraron en SaveData</span>}{!eliminado && documento.modificado_tras_envio && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Modificado, falta actualizar</span>}</div>
            <div className="mt-1 text-xs text-slate-500">Id {documento.id ?? '—'} · Último intento {fechaHora(ultimo.terminado_en ?? ultimo.iniciado_en)} · Sucursal {ultimo.sucursal ?? '—'} · Artículo {ultimo.articulo ?? '—'} · {documento.intentos.length} {documento.intentos.length === 1 ? 'envío' : 'envíos'}</div>
            {!eliminado && ultimo.faltantes.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-amber-800"><AlertTriangle size={13} />Se envió sin: {ultimo.faltantes.map((campo) => <span key={campo} className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold">{campo}</span>)}</div>}
          </button>
          <button type="button" onClick={() => void abrir(documento)} disabled={abriendo !== null} className={`${pendiente ? 'btn-primary' : 'btn-soft'} shrink-0 justify-center`}>{abriendo === clave ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}{pendiente ? 'Abrir y completar' : 'Abrir'}</button>
          {documento.en_savedata === 'presente' && <button type="button" onClick={() => setConfirmarEliminar(clave)} disabled={eliminando !== null} className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">{eliminando === clave ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}Eliminar de SaveData</button>}
        </div>
        {confirmarEliminar === clave && <div role="alertdialog" aria-labelledby={`eliminar-${clave}`} className="mx-4 mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-3 text-xs text-red-900"><div id={`eliminar-${clave}`} className="font-bold">¿Eliminar «{documento.filename || 'Documento'}» de SaveData?</div><div className="mt-1 leading-5">Se borrará de la base de datos de SaveData el registro con Id {documento.id ?? '—'}. En Nexora el documento y su historial se quedan; puedes corregirlo y enviarlo de nuevo cuando quieras.</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void eliminar(documento, clave)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">Sí, eliminar de SaveData</button><button type="button" onClick={() => setConfirmarEliminar(null)} className="btn-soft px-3 py-1.5 text-xs">Cancelar</button></div></div>}
        {avisoEliminar?.id === clave && <div role={avisoEliminar.ok ? 'status' : 'alert'} className={`mx-4 mb-3 rounded-lg border px-3 py-2 text-xs ${avisoEliminar.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{avisoEliminar.mensaje}</div>}
        {errorAbrir?.id === clave && <div role="alert" className="mx-4 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{errorAbrir.mensaje}</div>}
        {expandido && <ul className="space-y-2 border-t border-slate-100 bg-slate-50/50 p-4">{[...documento.intentos].reverse().map((intento) => <FilaIntento key={intento.id} intento={intento} onAbrir={() => void abrir(documento)} />)}</ul>}
      </li>
    })}</ul>}
  </div>
}

function FilaIntento({ intento, onAbrir }: { intento: IntentoHistorial; onAbrir: () => void }) {
  return <li><button type="button" onClick={onAbrir} className="w-full rounded-lg border border-slate-100 bg-white p-3 text-left text-xs hover:border-coral/40" title="Abrir la extracción y el documento">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-slate-700">{fechaHora(intento.terminado_en ?? intento.iniciado_en)}{intento.accion === 'eliminar' ? ' · eliminación' : intento.agregado_de_nuevo ? ' · agregado de nuevo' : intento.reenvio ? ' · actualización' : ' · primer envío'}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${etiquetaResultado[intento.resultado].clase}`}>{intento.accion === 'eliminar' && (intento.resultado === 'exito' || intento.resultado === 'no_existe') ? 'Eliminado' : etiquetaResultado[intento.resultado].texto}</span></div>
    {intento.accion === 'eliminar' ? <div className="mt-1 text-slate-500">Se pidió a SaveData borrar el registro.</div> : <>
      <div className="mt-1 text-slate-500">Sucursal {intento.sucursal ?? '—'} · Artículo {intento.articulo ?? '—'} · Versión {intento.version_extraccion ?? '—'}</div>
      {intento.faltantes.length > 0 ? <div className="mt-1 text-amber-800">Sin: {intento.faltantes.join(', ')}</div> : <div className="mt-1 text-emerald-700">Todos los campos con valor.</div>}
    </>}
    {intento.error && <div className="mt-1 text-red-700">{intento.error}</div>}
  </button></li>
}
