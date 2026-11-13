import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import { Link, NavLink, Route, Routes, useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { AlcanceCampo, CampoExtra, CampoMonto, CampoMontoResumen, Resumen, SugerenciaCampo, Transaccion } from './types'
import { agregarCampoManual, aplicarSugerencia, cambiarAlcance, camposParaSolicitar, editarExtra, editarValorDocumento, eliminarCampo, errorNombreCampo, esBuscable, esCeldaDeIa, esDelDocumento, filasConValor, fuenteDeLlenado, llenarColumnaManual, MAX_CAMPOS_EXTRA, mensajeLlenado, nombreComparable, puedeSerDelDocumento, renombrarCampo, sugerenciasDisponibles, type ColumnasDocumento, type ResultadoLlenado } from './services/camposExtra'
import { contarCorrecciones, editarCampo, etiquetaOrigen, moverTransaccion, nuevaTransaccion, type CampoEditable } from './services/transacciones'
import { validarContabilidad, type ValidacionContable } from './services/contabilidad'
import { crearControladorExtraccion, ejecutarExtraccion } from './services/extraccion'
import { gmailApi, type FiltroCorreo, type GmailAttachment, type GmailMessage, type GmailStatus } from './services/gmailApi'
import { geminiApi, type GeminiExtractionResponse, type GeminiStatus } from './services/geminiApi'
import { ejecutarEnvio, savedataApi, type ConfigSaveData, type VistaPreviaEnvio } from './services/savedataApi'
import { claveEstado, inboxStore, type EstadosExtraccion, type Listado, type MailFolder } from './services/inboxStore'
import { automaticoApi, type EstadoAutomatico } from './services/automaticoApi'
import { plantillaCamposApi, plantillaVigente } from './services/plantillaCamposApi'
import { agregarAPlantilla, aplicarPlantilla, CAMPOS_FIJOS, cambiarTipoEnPlantilla, errorNombrePlantilla, etiquetaAlcance, nuevoIdPlantilla, quitarDePlantilla, renombrarEnPlantilla, sugerenciasNuevas, type CampoPlantilla, type SugerenciaPlantilla } from './services/plantillaCampos'
import { estadoDocumento, textoCamposAutomaticos, textoIndicador, type EstadoDocumento } from './services/estadoAutomatico'
import { extraccionesApi, type EstadoExtraccion, type ExtraccionGuardada, type IntentoEnvio, type ProblemasRevision } from './services/extraccionesApi'
import { crearColaExtraccion, type ColaExtraccion } from './services/colaExtraccion'
import { estadoPestana, leerArchivos, urlExtraccionLote, type ArchivoExtraccion, type EstadoCola, type EstadoPestana } from './services/pestanasExtraccion'
import { esSeleccionable, LIMITE_LOTE, seleccionAdjuntos } from './services/seleccionAdjuntos'
import { borradoresLocales, claveBorrador, contarProblemas, documentoDesdeExtraccion, documentoDesdeGuardado, documentoVacio, ejecutarGuardado, firmaContenido, hayCambios, type BorradorLocal, type DocumentoEditable } from './services/guardado'
import { detectarDatos } from './services/deteccionDocumento'
import { tieneCapaDeTexto, type PaginaTexto } from './services/textoPdf'
import { compatibles, ETIQUETA_CAMPO, movimientoDesdeFila, posicionParaInsertar, valorParaCaptura, verificar, type MarcaVerificacion } from './services/verificacion'
import { PanelVerificacion, VisorPdf, type EstadoTextoDocumento, type Resaltado } from './VisorPdf'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightLeft,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  FileCheck2,
  FileImage,
  FileSearch,
  FileText,
  Gem,
  Globe2,
  Inbox,
  Landmark,
  Mail,
  Pencil,
  Menu,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
  Zap,
} from 'lucide-react'

type Icon = typeof Inbox
type ExtractionMode = 'manual' | 'gemini'

const navSections: { label: string; items: { to: string; label: string; icon: Icon }[] }[] = [
  { label: 'Operación', items: [{ to: '/emails', label: 'Correos', icon: Mail }, { to: '/extraction', label: 'Extracción', icon: FileSearch }] },
  { label: 'Sistema', items: [{ to: '/settings', label: 'Configuración', icon: SettingsIcon }] },
]

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="lg:pl-[250px]">
        <Topbar onMenu={() => setSidebarOpen(true)} />
        <main className="mx-auto max-w-[1440px] px-5 pb-10 pt-6 sm:px-8 lg:px-10">
          <Routes>
            <Route path="/" element={<FilteredGmailInboxPage />} />
            <Route path="/emails" element={<FilteredGmailInboxPage />} />
            <Route path="/extraction" element={<ExtractionWorkspace />} />
            <Route path="/settings" element={<SettingsPageV3 />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  useSyncExternalStore(inboxStore.subscribe, inboxStore.version)
  useEffect(() => { void inboxStore.loadStatus().catch(() => undefined) }, [])
  const gmailStatus = inboxStore.cachedStatus()
  const connected = Boolean(gmailStatus?.connected)
  const unreadCount = connected ? (inboxStore.cachedListado('inbox', inboxStore.lastFiltro())?.messages ?? []).filter((message) => message.unread).length : 0
  const accountEmail = connected ? gmailStatus?.email ?? 'Cuenta de Gmail' : 'Gmail sin conectar'
  const initials = connected && gmailStatus?.email ? gmailStatus.email.slice(0, 2).toUpperCase() : '—'
  return (
    <>
      {open && <button aria-label="Cerrar menú" className="fixed inset-0 z-30 bg-ink/50 lg:hidden" onClick={onClose} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[250px] flex-col bg-ink px-4 py-5 text-slate-300 transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between px-3">
          <Link to="/emails" className="flex items-center gap-2.5" onClick={onClose}>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-coral text-white shadow-lg shadow-coral/20"><Zap size={19} fill="currentColor" /></div>
            <div><div className="font-display text-[19px] font-extrabold tracking-tight text-white">nexora</div><div className="text-[9px] uppercase tracking-[0.2em] text-slate-500">transaction intelligence</div></div>
          </Link>
          <button className="rounded-md p-1 text-slate-500 hover:bg-white/10 hover:text-white lg:hidden" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="mt-9 rounded-xl border border-white/10 bg-white/[.06] p-2.5">
          <div className="flex items-center gap-2.5"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-400/15 text-blue-300"><Landmark size={16} /></div><div className="min-w-0"><div className="truncate text-xs font-semibold text-white">Nexora</div><div className="text-[10px] text-slate-500">Espacio de trabajo</div></div></div>
        </div>
        <nav className="mt-8 flex-1">
          {navSections.map((section) => <div key={section.label} className="mb-7"><div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.17em] text-slate-600">{section.label}</div>{section.items.map(({ to, label, icon: NavIcon }) => <NavLink key={to} to={to} onClick={onClose} className={({ isActive }) => `group mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition ${isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/[.05] hover:text-slate-200'}`}><NavIcon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'Correos' && unreadCount > 0 && <span className="ml-auto rounded-full bg-coral px-1.5 py-0.5 text-[10px] font-bold text-white" title="Sin leer en la bandeja de entrada">{unreadCount}</span>}</NavLink>)}</div>)}
        </nav>
        <div className="border-t border-white/10 pt-4"><div className="mb-4 flex items-center gap-3 px-2"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-coral text-xs font-bold text-white">{initials}</div><div className="min-w-0"><div className="truncate text-xs font-semibold text-white">{accountEmail}</div><div className="text-[10px] text-slate-500">Cuenta conectada</div></div></div>{connected ? <div className="rounded-lg bg-emerald-400/10 px-3 py-2 text-[10px] text-emerald-300"><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />Gmail conectado</div> : <Link to="/settings" onClick={onClose} className="block rounded-lg bg-amber-400/10 px-3 py-2 text-[10px] text-amber-300 hover:bg-amber-400/15"><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />Conectar Gmail en Configuración</Link>}</div>
      </aside>
    </>
  )
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const location = useLocation()
  const titles: Record<string, string> = { '/': 'Correos', '/emails': 'Correos', '/extraction': 'Extracción', '/settings': 'Configuración' }
  return <header className="flex h-[76px] items-center justify-between border-b border-slate-200/70 bg-paper px-5 sm:px-8 lg:px-10"><div className="flex items-center gap-3"><button onClick={onMenu} className="rounded-lg p-2 text-slate-500 hover:bg-white lg:hidden"><Menu size={21} /></button><div><div className="eyebrow">Workspace / {titles[location.pathname] ?? 'Nexora'}</div><h1 className="font-display text-xl font-extrabold tracking-tight text-ink sm:text-[22px]">{titles[location.pathname] ?? 'Nexora'}</h1></div></div><div className="flex items-center gap-2 sm:gap-4"><div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400 md:flex"><Search size={15} /><span>Buscar en Nexora</span><kbd className="ml-8 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400">⌘ K</kbd></div><button className="relative rounded-lg p-2 text-slate-500 hover:bg-white"><Bell size={19} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-coral" /></button><div className="hidden h-7 w-px bg-slate-200 sm:block" /><button className="flex items-center gap-2 text-sm font-semibold text-slate-600"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-coral/10 text-xs font-bold text-coral">JD</span><ChevronDown size={14} className="hidden sm:block" /></button></div></header>
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="eyebrow mb-2">{eyebrow}</div><h2 className="font-display text-[28px] font-extrabold tracking-[-0.04em] text-ink sm:text-[32px]">{title}</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p></div>{children && <div className="flex shrink-0 gap-2">{children}</div>}</div>
}

/** Carpetas que se muestran: los estados de cuenta llegan a la bandeja de entrada; "Enviados" sirve para reenvíos propios. */
const carpetasCorreo: { value: MailFolder; label: string; icon: Icon }[] = [{ value: 'inbox', label: 'Bandeja de entrada', icon: Inbox }, { value: 'sent', label: 'Enviados', icon: Send }]

function FilteredGmailInboxPage() {
  const navigate = useNavigate()
  const [folder, setFolderState] = useState<MailFolder>(() => (carpetasCorreo.some((carpeta) => carpeta.value === inboxStore.lastFolder()) ? inboxStore.lastFolder() : 'inbox'))
  // Filtro automático y fijo: solo estados de cuenta (asunto + PDF o imagen), sin configuración del usuario.
  const filtroCorreo: FiltroCorreo = 'estados'
  const [listado, setListado] = useState<Listado | null>(() => inboxStore.cachedListado(folder, filtroCorreo))
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [status, setStatus] = useState<GmailStatus | null>(inboxStore.cachedStatus)
  const [estadosExtraccion, setEstadosExtraccion] = useState<EstadosExtraccion>({})
  const [loading, setLoading] = useState(() => listado === null)
  const [cargandoMas, setCargandoMas] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [avisoLimite, setAvisoLimite] = useState(false)
  const [automatico, setAutomatico] = useState<EstadoAutomatico | null>(null)
  const latestRequest = useRef(0)
  const messages = listado?.messages ?? []
  // Adjuntos marcados para extraer: la selección vive fuera del componente y abarca varios correos.
  useSyncExternalStore(seleccionAdjuntos.suscribir, seleccionAdjuntos.version)
  const totalMarcados = seleccionAdjuntos.total()
  const alternarMarcado = (message: GmailMessage, attachment: GmailAttachment) => setAvisoLimite(seleccionAdjuntos.alternar(message.id, attachment) === 'limite')
  const limpiarSeleccion = () => { seleccionAdjuntos.limpiar(); setAvisoLimite(false) }
  const extraerMarcados = () => { if (totalMarcados > 0) navigate(urlExtraccionLote(seleccionAdjuntos.lista())) }

  const setFolder = (nextFolder: MailFolder) => {
    inboxStore.setLastFolder(nextFolder)
    setFolderState(nextFolder)
  }

  const aplicarListado = (nuevo: Listado) => {
    setListado(nuevo)
    setSelected((current) => nuevo.messages.find((message) => message.id === current?.id) ?? nuevo.messages[0] ?? null)
  }

  const loadEmails = async (force = false) => {
    const requestId = ++latestRequest.current
    const isCurrent = () => requestId === latestRequest.current
    const cached = inboxStore.cachedListado(folder, filtroCorreo)
    setListado(cached)
    setLoading(force || cached === null)
    setError(null)
    try {
      const nextStatus = await inboxStore.loadStatus()
      if (!isCurrent()) return
      setStatus(nextStatus)
      if (!nextStatus.connected) {
        setListado(null)
        setSelected(null)
        setEstadosExtraccion({})
        return
      }
      const nuevo = await inboxStore.loadListado(folder, filtroCorreo, { force })
      if (!isCurrent()) return
      aplicarListado(nuevo)
      void inboxStore.loadEstados({ force }).then((mapa) => { if (isCurrent()) setEstadosExtraccion(mapa) }).catch(() => undefined)
    } catch (requestError) {
      if (!isCurrent()) return
      setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  const cargarMas = async () => {
    if (!listado?.nextPageToken || cargandoMas) return
    const requestId = latestRequest.current
    setCargandoMas(true)
    try {
      const nuevo = await inboxStore.loadMore(folder, filtroCorreo)
      if (requestId === latestRequest.current && nuevo) aplicarListado(nuevo)
    } catch (requestError) {
      if (requestId === latestRequest.current) setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar más correos.')
    } finally {
      setCargandoMas(false)
    }
  }

  useEffect(() => { void loadEmails() }, [folder])

  // Extracción automática: estado del proceso cada minuto. Cuando guarda extracciones nuevas, se refresca la bandeja.
  const extraidosAuto = useRef<number | null>(null)
  const recargarBandeja = useRef(loadEmails)
  recargarBandeja.current = loadEmails
  useEffect(() => {
    let vivo = true
    const consultar = async () => {
      try {
        const estado = await automaticoApi.estado()
        if (!vivo) return
        setAutomatico(estado)
        const extraidos = Object.values(estado.adjuntos).filter((adjunto) => adjunto.estado === 'extraido' || adjunto.estado === 'error').length
        if (extraidosAuto.current !== null && extraidos !== extraidosAuto.current) void recargarBandeja.current(true)
        extraidosAuto.current = extraidos
      } catch {
        if (vivo) setAutomatico(null) // Sin Gmail conectado o sin backend: el indicador simplemente no se muestra.
      }
    }
    void consultar()
    const temporizador = window.setInterval(() => void consultar(), 60_000)
    return () => { vivo = false; window.clearInterval(temporizador) }
  }, [])

  const estadoAdjunto = (message: GmailMessage, attachment: GmailAttachment): EstadoDocumento => {
    if (!attachment.partId) return 'sin_extraer'
    const clave = claveEstado(message.id, attachment.partId)
    return estadoDocumento(estadosExtraccion[clave], automatico?.adjuntos[clave])
  }
  const abrirEnExtraccion = (message: GmailMessage, attachment: GmailAttachment) => {
    if (attachment.partId) navigate(urlExtraccionLote([{ messageId: message.id, attachmentId: attachment.id, partId: attachment.partId, filename: attachment.filename, mimeType: attachment.mimeType }]))
  }
  const indicador = conectadoGmail(status) ? textoIndicador(automatico) : null
  const estadoCorreo = (message: GmailMessage) => resumirEstados(message.attachments.filter(esAdjuntoDocumental).map((attachment) => estadoAdjunto(message, attachment)))
  const visibleSelected = selected && messages.some((message) => message.id === selected.id) ? selected : messages[0] ?? null
  const conectado = Boolean(status?.connected)

  return (
    <>
      <PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Solo los estados de cuenta que llegan a tu Gmail, de cualquier banco. Nexora no modifica tus correos." />
      {error && <ErrorNotice text={error} onClose={() => setError(null)} />}
      {status && !conectado && !error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail no está conectado. La conexión se administra únicamente desde Configuración.</span></div></div>}
      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-slate-500" role="status">
          {totalMarcados > 0 ? <><strong className="text-ink">{totalMarcados}</strong> archivo{totalMarcados === 1 ? '' : 's'} marcado{totalMarcados === 1 ? '' : 's'} para extraer.</> : 'Marca los PDF o imágenes que quieras extraer, de uno o varios correos.'}
          {avisoLimite && <span className="ml-1 font-semibold text-red-700">Máximo {LIMITE_LOTE} archivos por lote.</span>}
          {indicador && <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400" title={automatico?.ultimo_error ?? undefined}><span className={`inline-block h-1.5 w-1.5 rounded-full ${automatico?.activo ? (automatico.en_curso ? 'animate-pulse bg-blue-500' : 'bg-emerald-500') : 'bg-slate-300'}`} />{indicador}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {totalMarcados > 0 && <button type="button" onClick={limpiarSeleccion} className="btn-soft px-3 py-2"><X size={14} />Limpiar selección</button>}
          <button type="button" className="btn-soft px-3 py-2" onClick={() => void loadEmails(true)} disabled={loading || !conectado}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button>
          <button type="button" className="btn-primary px-3 py-2" onClick={extraerMarcados} disabled={totalMarcados === 0}><Sparkles size={15} />{totalMarcados > 0 ? `Extraer (${totalMarcados})` : 'Extraer'}</button>
        </div>
      </div>
      <div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(390px,1.1fr)]">
        <GmailFoldersReadOnly folder={folder} setFolder={setFolder} status={status} />
        <EmailMessageList messages={messages} selected={visibleSelected} loading={loading} folder={folder} estadoCorreo={estadoCorreo} marcadosEn={(message) => seleccionAdjuntos.contarEnCorreo(message.id)} onSelect={setSelected} puedeCargarMas={Boolean(listado?.nextPageToken)} cargandoMas={cargandoMas} onCargarMas={() => void cargarMas()} />
        {visibleSelected ? <GmailMessageDetail mail={visibleSelected} resumen={estadoCorreo(visibleSelected)} estadoAdjunto={(attachment) => estadoAdjunto(visibleSelected, attachment)} estaMarcado={(attachment) => seleccionAdjuntos.estaMarcado(visibleSelected.id, attachment.partId)} onAlternar={(attachment) => alternarMarcado(visibleSelected, attachment)} onAbrir={(attachment) => abrirEnExtraccion(visibleSelected, attachment)} /> : <EmptyMailDetail />}
      </div>
    </>
  )
}

function EmailMessageList({ messages, selected, loading, folder, estadoCorreo, marcadosEn, onSelect, puedeCargarMas, cargandoMas, onCargarMas }: { messages: GmailMessage[]; selected: GmailMessage | null; loading: boolean; folder: MailFolder; estadoCorreo: (message: GmailMessage) => ResumenEstados | null; marcadosEn: (message: GmailMessage) => number; onSelect: (message: GmailMessage) => void; puedeCargarMas: boolean; cargandoMas: boolean; onCargarMas: () => void }) {
  return <div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="border-b border-slate-200 px-4 py-4"><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${messages.length} estado${messages.length === 1 ? '' : 's'} de cuenta${puedeCargarMas ? ' · hay más' : ''}`}</div></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && messages.length === 0 && <div className="px-5 py-14 text-center text-xs leading-5 text-slate-400">No hay estados de cuenta en esta carpeta.<br />Se muestran los correos con PDF o imagen cuyo asunto dice “estado de cuenta” o similar.</div>}{!loading && messages.map((mail) => <button key={mail.id} onClick={() => onSelect(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject || '(Sin asunto)'}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div><div className="mt-2 flex flex-wrap items-center gap-1.5"><EstadoCorreoBadge resumen={estadoCorreo(mail)} /><MarcadosBadge cantidad={marcadosEn(mail)} /></div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button>)}{!loading && puedeCargarMas && <button type="button" onClick={onCargarMas} disabled={cargandoMas} className="btn-soft mt-2 w-full justify-center text-xs"><RefreshCw size={13} className={cargandoMas ? 'animate-spin' : ''} />{cargandoMas ? 'Cargando…' : 'Cargar más'}</button>}</div></div>
}

type ResumenEstados = { estado: EstadoDocumento; revisados: number; total: number }
const estiloEstadoDocumento: Record<EstadoDocumento, { etiqueta: string; clase: string }> = {
  sin_extraer: { etiqueta: 'Sin extraer', clase: 'bg-slate-100 text-slate-500' },
  borrador: { etiqueta: 'Borrador', clase: 'bg-blue-50 text-blue-700' },
  revisado: { etiqueta: 'Revisado', clase: 'bg-emerald-50 text-emerald-700' },
  enviado: { etiqueta: 'Enviado', clase: 'bg-violet-50 text-violet-700' },
  automatico: { etiqueta: 'Extraído automáticamente', clase: 'bg-blue-50 text-blue-700' },
  error_auto: { etiqueta: 'Error al extraer', clase: 'bg-red-50 text-red-700' },
}
const esAdjuntoDocumental = (attachment: GmailAttachment) => attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/')

/** Estado de un correo a partir de sus documentos: borrador si alguno lo es; revisado solo si todos lo están. */
function resumirEstados(estados: EstadoDocumento[]): ResumenEstados | null {
  if (estados.length === 0) return null
  const revisados = estados.filter((estado) => estado === 'revisado' || estado === 'enviado').length
  const estado: EstadoDocumento = estados.includes('borrador') ? 'borrador' : estados.includes('automatico') ? 'automatico' : estados.includes('error_auto') ? 'error_auto' : revisados === estados.length ? (estados.every((e) => e === 'enviado') ? 'enviado' : 'revisado') : revisados > 0 ? 'borrador' : 'sin_extraer'
  return { estado, revisados, total: estados.length }
}

/** El adjunto ya tiene una extracción guardada (automática o del usuario) que se puede abrir sin volver a extraer. */
const estadoTieneExtraccion = (estado: EstadoDocumento) => estado !== 'sin_extraer' && estado !== 'error_auto'
const conectadoGmail = (status: GmailStatus | null) => Boolean(status?.connected)

function EstadoDocumentoBadge({ estado }: { estado: EstadoDocumento }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-[9px] font-bold ${estiloEstadoDocumento[estado].clase}`}>{estiloEstadoDocumento[estado].etiqueta}</span>
}

function EstadoCorreoBadge({ resumen }: { resumen: ResumenEstados | null }) {
  if (!resumen) return null
  const parcial = resumen.total > 1 && resumen.revisados > 0 && resumen.revisados < resumen.total
  return <span title="Estado de la extracción de los documentos de este correo" className={`inline-flex rounded-full px-2 py-1 text-[9px] font-bold ${estiloEstadoDocumento[resumen.estado].clase}`}>{estiloEstadoDocumento[resumen.estado].etiqueta}{parcial && ` · ${resumen.revisados}/${resumen.total} revisados`}</span>
}

function MarcadosBadge({ cantidad }: { cantidad: number }) {
  if (cantidad === 0) return null
  return <span title="Adjuntos de este correo marcados para extraer" className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-1 text-[9px] font-bold text-coral"><Check size={10} />{cantidad} marcado{cantidad === 1 ? '' : 's'}</span>
}

function GmailMessageDetail({ mail, resumen, estadoAdjunto, estaMarcado, onAlternar, onAbrir }: { mail: GmailMessage; resumen: ResumenEstados | null; estadoAdjunto: (attachment: GmailAttachment) => EstadoDocumento; estaMarcado: (attachment: GmailAttachment) => boolean; onAlternar: (attachment: GmailAttachment) => void; onAbrir: (attachment: GmailAttachment) => void }) {
  const [preview, setPreview] = useState<GmailAttachment | null>(null)
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><span className="text-xs text-slate-500">Estado de cuenta</span><EstadoCorreoBadge resumen={resumen} /></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject || '(Sin asunto)'}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <GmailAttachmentCard key={attachment.id} attachment={attachment} estado={esAdjuntoDocumental(attachment) ? estadoAdjunto(attachment) : null} onPreview={() => setPreview(attachment)} marcado={estaMarcado(attachment)} onAlternar={esSeleccionable(attachment) ? () => onAlternar(attachment) : null} onAbrir={esSeleccionable(attachment) && estadoTieneExtraccion(estadoAdjunto(attachment)) ? () => onAbrir(attachment) : null} />)}</div></div>}</div>{preview && <AttachmentPreview messageId={mail.id} attachment={preview} onClose={() => setPreview(null)} />}</div>
}

function GmailFoldersReadOnly({ folder, setFolder, status }: { folder: MailFolder; setFolder: (value: MailFolder) => void; status: GmailStatus | null }) {
  return <div className="p-4"><div className="mb-4 px-2"><span className="eyebrow">Cuenta conectada</span><div className="mt-3 flex items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2.5 text-xs font-semibold text-ink"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600"><Globe2 size={13} /></span><span className="min-w-0 truncate">{status?.email ?? 'Gmail no conectado'}</span><span className={`ml-auto h-1.5 w-1.5 rounded-full ${status?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} /></div></div><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Carpetas Gmail</div><div className="space-y-1">{carpetasCorreo.map(({ value, label, icon: FolderIcon }) => <button key={value} onClick={() => setFolder(value)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${folder === value ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-500 hover:bg-slate-50'}`}><FolderIcon size={16} />{label}</button>)}</div></div>
}

function GmailAttachmentCard({ attachment, estado, onPreview, marcado, onAlternar, onAbrir = null }: { attachment: GmailAttachment; estado: EstadoDocumento | null; onPreview: () => void; marcado: boolean; onAlternar: (() => void) | null; onAbrir?: (() => void) | null }) {
  const previewable = attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/')
  // Solo PDF e imágenes se pueden marcar para extraer; los ya extraídos también (al abrirlos se carga lo guardado).
  return <div className={`flex max-w-md flex-wrap items-center gap-3 rounded-xl border bg-white p-3 ${marcado ? 'border-coral ring-1 ring-coral/30' : 'border-slate-200'}`}>{onAlternar ? <input type="checkbox" checked={marcado} onChange={onAlternar} aria-label={`Marcar ${attachment.filename} para extraer`} className="h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-coral focus:ring-coral" /> : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500">{attachmentMime(attachment).startsWith('image/') ? <FileImage size={20} /> : <FileText size={20} />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{attachment.filename}</div><div className="mt-0.5 text-[11px] text-slate-400">{attachmentMime(attachment)} · {formatBytes(attachment.size)}</div>{estado && <div className="mt-1.5"><EstadoDocumentoBadge estado={estado} /></div>}</div>{previewable && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview() }} className="btn-soft px-2.5 py-2 text-[11px]"><FileSearch size={13} />Visualizar</button>}{onAbrir && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onAbrir() }} className="btn-soft px-2.5 py-2 text-[11px]"><Sparkles size={13} />Abrir en Extracción</button>}</div>
}

function AttachmentPreview({ messageId, attachment, onClose }: { messageId: string; attachment: GmailAttachment; onClose: () => void }) {
  const url = gmailApi.attachmentUrl(messageId, attachment.id)
  const previewMime = attachmentMime(attachment)
  const isImage = previewMime.startsWith('image/')
  const isPdf = previewMime === 'application/pdf'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    const controller = new AbortController()
    setPreviewUrl(null)
    setPreviewError(null)
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar el adjunto (${response.status}).`)
      const buffer = await response.arrayBuffer()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: previewMime }))
      setPreviewUrl(objectUrl)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setPreviewError(error instanceof Error ? error.message : 'No se pudo visualizar el adjunto.')
    })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, previewMime])
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" onClick={onClose}><div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex min-w-0 items-center gap-2"><FileText size={17} className="shrink-0 text-coral" /><span className="truncate text-sm font-semibold text-ink">{attachment.filename}</span></div><button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-ink" aria-label="Cerrar visor"><X size={18} /></button></div><div className="flex min-h-[420px] flex-1 items-center justify-center overflow-auto bg-slate-100 p-4 sm:p-8">{!previewUrl && !previewError && <div className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw size={16} className="animate-spin" />Cargando vista previa...</div>}{previewError && <div className="text-center text-sm text-red-600">{previewError}</div>}{previewUrl && isImage && <img src={previewUrl} alt={attachment.filename} className="max-h-[72vh] max-w-full rounded-lg object-contain shadow-lg" />}{previewUrl && isPdf && <iframe src={previewUrl} title={attachment.filename} className="h-[72vh] w-full rounded-lg bg-white" />}{previewUrl && !isImage && !isPdf && <div className="text-center text-sm text-slate-500">Este tipo de archivo no tiene vista previa disponible.</div>}</div><div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-400"><span>Vista previa desde Gmail · {previewMime}</span><button onClick={onClose} className="btn-soft">Cerrar</button></div></div></div>
}

function attachmentMime(attachment: GmailAttachment) {
  if (attachment.mimeType && attachment.mimeType !== 'application/octet-stream') return attachment.mimeType
  const extension = attachment.filename.toLowerCase().split('.').pop()
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}

function EmptyMailDetail() { return <div className="flex min-h-[480px] items-center justify-center border-t border-slate-200 bg-slate-50/30 p-8 text-center lg:border-l lg:border-t-0"><div><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><Mail size={22} /></div><div className="mt-4 text-sm font-semibold text-ink">Selecciona un mensaje</div><div className="mt-1 text-xs text-slate-400">El contenido del correo aparecerá aquí.</div></div></div> }

function ErrorNotice({ text, onClose }: { text: string; onClose: () => void }) { return <div className="mb-5 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><div className="flex items-center gap-2"><CircleHelp size={17} />{text}</div><button onClick={onClose}><X size={16} /></button></div> }
function folderLabel(folder: MailFolder) { return { inbox: 'Bandeja de entrada', sent: 'Enviados', archive: 'Archivados', trash: 'Papelera' }[folder] }
function timeLabel(value: string | null) { return value ? new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Sin fecha' }
function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB` }

function Notice({ text, onClose }: { text: string; onClose: () => void }) { return <div className="mb-5 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><div className="flex items-center gap-2"><CheckCircle2 size={17} />{text}</div><button onClick={onClose}><X size={16} /></button></div> }

function ExtractionWorkspace() {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<ExtractionMode>(() => params.get('mode') === 'gemini' ? 'gemini' : 'manual')
  const { archivos, lote } = useMemo(() => leerArchivos(params), [params])
  // Otra lista de archivos es otro lote: se reinicia todo (el aviso de salida protege los cambios sin guardar).
  const firmaLote = `${lote ? 'lote' : 'enlace'}|${archivos.map((archivo) => archivo.clave).join('|')}`
  return <div className="space-y-5"><ExtractionTabsWorkspace key={firmaLote} archivos={archivos} lote={lote} mode={mode} onModeChange={setMode} /></div>
}

/** Lo que cada pestaña informa a su contenedor: estado guardado (tras cargar) y si tiene cambios sin guardar. */
type ReportePestana = { guardado: EstadoExtraccion | null; sinGuardar: boolean }
type ColaPestana = { estado: EstadoCola; guardado: EstadoExtraccion | null; error: string | null }
/** Resultado de Gemini obtenido por la cola para un archivo; `id` evita aplicarlo dos veces. */
type ResultadoCola = { id: number; datos: GeminiExtractionResponse }
let idResultadoCola = 0

const estiloPestana: Record<EstadoPestana, { etiqueta: string; clase: string }> = {
  en_cola: { etiqueta: 'En cola', clase: 'bg-slate-100 text-slate-600' },
  extrayendo: { etiqueta: 'Extrayendo', clase: 'bg-violet-50 text-violet-700' },
  extraido: { etiqueta: 'Extraído', clase: 'bg-sky-50 text-sky-700' },
  error: { etiqueta: 'Error', clase: 'bg-red-50 text-red-700' },
  borrador: { etiqueta: 'Borrador', clase: 'bg-blue-50 text-blue-700' },
  revisado: { etiqueta: 'Revisado', clase: 'bg-emerald-50 text-emerald-700' },
  enviado: { etiqueta: 'Enviado', clase: 'bg-violet-50 text-violet-700' },
  borrador_local: { etiqueta: 'Borrador local', clase: 'bg-amber-50 text-amber-800' },
  sin_extraer: { etiqueta: 'Sin extraer', clase: 'bg-slate-100 text-slate-500' },
}

/**
 * Extracción con pestañas: una por archivo. Cada pestaña es un ExtractionReviewWorkspace independiente que se monta
 * la primera vez que se abre y después se conserva oculto, así sus ediciones no se pierden ni se mezclan.
 * Aquí viven la cola (extracción en secuencia) y el único aviso de salida, que considera todas las pestañas.
 */
export function ExtractionTabsWorkspace({ archivos, lote, mode, onModeChange }: { archivos: ArchivoExtraccion[]; lote: boolean; mode: ExtractionMode; onModeChange: (mode: ExtractionMode) => void }) {
  const [activa, setActiva] = useState<string | null>(archivos[0]?.clave ?? null)
  const [visitadas, setVisitadas] = useState<string[]>(() => (archivos[0] ? [archivos[0].clave] : []))
  const [cola, setCola] = useState<Record<string, ColaPestana>>({})
  const [resultados, setResultados] = useState<Record<string, ResultadoCola>>({})
  const [reportes, setReportes] = useState<Record<string, ReportePestana>>({})
  const salidas = useRef(new Map<string, () => void>())
  const colaRef = useRef<ColaExtraccion<ArchivoExtraccion, GeminiExtractionResponse> | null>(null)
  const archivosIniciales = useRef(archivos)
  const cuentaRef = useRef<string | null>(inboxStore.cachedStatus()?.cuentaId ?? null)

  useEffect(() => {
    if (!lote) return
    const nueva = crearColaExtraccion<ArchivoExtraccion, GeminiExtractionResponse>({
      consultarGuardado: async (archivo) => (archivo.partId ? (await extraccionesApi.obtener(archivo.messageId, archivo.partId))?.estado ?? null : null),
      tieneBorradorLocal: async (archivo) => {
        if (!archivo.partId) return false
        const status = await inboxStore.loadStatus().catch(() => inboxStore.cachedStatus())
        // Cuenta con que se escribirán, al salir, los borradores locales de las pestañas que nunca se abrieron.
        if (status?.cuentaId) cuentaRef.current = status.cuentaId
        return Boolean(status?.cuentaId && borradores.leer(claveBorrador(status.cuentaId, archivo.messageId, archivo.partId)))
      },
      extraer: async (archivo, signal) => {
        const status = await geminiApi.status()
        if (!status.enabled) throw new Error('Gemini no está conectado o habilitado en FastAPI.')
        // Se piden los campos de la configuración (Configuración → Campos que se capturan).
        const plantilla = await plantillaVigente.cargar()
        return geminiApi.extract(archivo.messageId, archivo.attachmentId, { signal, campos: camposParaSolicitar(aplicarPlantilla([], plantilla)) })
      },
      alCambiar: (clave, evento) => {
        if (evento.estado !== 'terminado') {
          setCola((prev) => ({ ...prev, [clave]: { estado: evento.estado, guardado: null, error: null } }))
          return
        }
        const resultado = evento.resultado
        if (resultado.tipo === 'extraido') {
          idResultadoCola += 1
          const id = idResultadoCola
          setResultados((prev) => ({ ...prev, [clave]: { id, datos: resultado.resultado } }))
        }
        const siguiente: ColaPestana = resultado.tipo === 'guardado' ? { estado: 'guardado', guardado: resultado.estado, error: null }
          : resultado.tipo === 'error' ? { estado: 'error', guardado: null, error: resultado.mensaje }
            : { estado: resultado.tipo, guardado: null, error: null }
        setCola((prev) => ({ ...prev, [clave]: siguiente }))
      },
    })
    colaRef.current = nueva
    void nueva.agregar(archivosIniciales.current)
    return () => { nueva.cancelar(); colaRef.current = null }
  }, [lote])

  const activar = (clave: string) => {
    setActiva(clave)
    setVisitadas((prev) => (prev.includes(clave) ? prev : [...prev, clave]))
  }
  const reintentar = (clave: string) => {
    const archivo = archivos.find((item) => item.clave === clave)
    if (archivo) void colaRef.current?.agregar([archivo])
  }
  const reportar = useCallback((clave: string, reporte: ReportePestana) => setReportes((prev) => (prev[clave]?.guardado === reporte.guardado && prev[clave]?.sinGuardar === reporte.sinGuardar ? prev : { ...prev, [clave]: reporte })), [])
  const registrarSalida = useCallback((clave: string, alSalir: (() => void) | null) => {
    if (alSalir) salidas.current.set(clave, alSalir)
    else salidas.current.delete(clave)
  }, [])

  // Resultado de Gemini que aún no aplicó ninguna pestaña: la pestaña nunca se abrió (o no terminó de cargar), así que
  // no informa nada; el resultado solo vive aquí y también cuenta como cambio sin guardar.
  const sinAbrirConResultado = (clave: string) => Boolean(resultados[clave]) && !reportes[clave]
  const tieneCambios = (clave: string) => Boolean(reportes[clave]?.sinGuardar) || sinAbrirConResultado(clave)
  const conCambios = archivos.filter((archivo) => tieneCambios(archivo.clave))
  const haySinGuardar = conCambios.length > 0
  const porExtraer = archivos.filter((archivo) => cola[archivo.clave]?.estado === 'en_cola' || cola[archivo.clave]?.estado === 'extrayendo')
  const hayQueAvisar = haySinGuardar || porExtraer.length > 0
  const estadoDe = (clave: string) => estadoPestana(cola[clave]?.estado, reportes[clave] ? reportes[clave].guardado : undefined, cola[clave]?.guardado ?? null)

  /** Escribe ya el borrador local de cada archivo con cambios: las pestañas abiertas el suyo; aquí, los no abiertos. */
  const escribirBorradores = useRef<() => void>(() => undefined)
  escribirBorradores.current = () => {
    salidas.current.forEach((alSalir) => alSalir())
    const cuenta = cuentaRef.current ?? inboxStore.cachedStatus()?.cuentaId ?? null
    if (!cuenta) return
    for (const archivo of archivos) {
      const resultado = resultados[archivo.clave]
      if (!resultado || !archivo.partId || !sinAbrirConResultado(archivo.clave)) continue
      // Sin nada guardado en el backend (la cola no extrae lo guardado): el borrador parte de un documento vacío.
      const { documento } = documentoDesdeExtraccion(resultado.datos, [], nuevoLoteExtraccion(), aplicarPlantilla([], plantillaVigente.actual()))
      borradores.guardar(claveBorrador(cuenta, archivo.messageId, archivo.partId), { version_base: null, guardadoEn: new Date().toISOString(), documento })
    }
  }

  // Al recargar o cerrar: el navegador muestra su aviso genérico (no permite texto propio) y, si de verdad se sale
  // (pagehide), se escriben los borradores locales para no perder lo extraído.
  useEffect(() => {
    if (!hayQueAvisar) return
    const alSalir = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const alOcultar = () => escribirBorradores.current()
    window.addEventListener('beforeunload', alSalir)
    window.addEventListener('pagehide', alOcultar)
    return () => { window.removeEventListener('beforeunload', alSalir); window.removeEventListener('pagehide', alOcultar) }
  }, [hayQueAvisar])

  // Aviso al navegar dentro de la app (otra sección u otro lote). Cambiar de pestaña no cambia la URL.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hayQueAvisar && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  const salirSinGuardar = () => {
    // Borradores locales ya (sin esperar el debounce); al desmontar, la cola se cancela.
    escribirBorradores.current()
    blocker.proceed?.()
  }

  if (archivos.length === 0) return <ExtractionReviewWorkspace archivo={null} mode={mode} onModeChange={onModeChange} />

  const barra = <BarraPestanas archivos={archivos} activa={activa} onActivar={activar} estadoDe={estadoDe} sinGuardar={tieneCambios} />
  return <>
    {archivos.map((archivo, indice) => visitadas.includes(archivo.clave) && <div key={archivo.clave} role="tabpanel" id={`panel-extraccion-${indice}`} aria-labelledby={`pestana-extraccion-${indice}`} hidden={archivo.clave !== activa}>
      <ExtractionReviewWorkspace archivo={archivo} mode={mode} onModeChange={onModeChange} barraPestanas={archivo.clave === activa ? barra : null} cola={cola[archivo.clave]} resultadoCola={resultados[archivo.clave] ?? null} onReintentar={() => reintentar(archivo.clave)} onReporte={reportar} registrarSalida={registrarSalida} />
    </div>)}
    {blocker.state === 'blocked' && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"><div role="alertdialog" aria-modal="true" aria-labelledby="titulo-salir" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
      <div id="titulo-salir" className="font-display text-lg font-bold text-ink">{haySinGuardar ? 'Hay cambios sin guardar' : 'La extracción sigue en curso'}</div>
      {haySinGuardar && <p className="mt-2 text-sm leading-6 text-slate-600">{conCambios.length === 1 ? <>Los cambios de <strong>{conCambios[0].filename}</strong> no están guardados en el backend.</> : <>{conCambios.length} archivos tienen cambios que no están guardados en el backend: {conCambios.map((archivo) => archivo.filename).join(', ')}.</>} Se conservarán como borrador local en este navegador y podrás restaurarlos al volver.</p>}
      {porExtraer.length > 0 && <p className="mt-2 text-sm font-semibold leading-6 text-amber-800">Quedan {porExtraer.length} archivo{porExtraer.length === 1 ? '' : 's'} por extraer; se cancelarán.</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => blocker.reset?.()} className="btn-primary px-3 py-2 text-sm">{haySinGuardar ? 'Seguir editando' : 'Quedarme'}</button><button type="button" onClick={salirSinGuardar} className="btn-soft px-3 py-2 text-sm">{haySinGuardar ? 'Salir sin guardar' : 'Salir y cancelar'}</button></div>
    </div></div>}
  </>
}

function BarraPestanas({ archivos, activa, onActivar, estadoDe, sinGuardar }: { archivos: ArchivoExtraccion[]; activa: string | null; onActivar: (clave: string) => void; estadoDe: (clave: string) => EstadoPestana; sinGuardar: (clave: string) => boolean }) {
  return <nav aria-label="Archivos de este lote" className="panel overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5"><div className="text-sm font-bold text-ink">Archivos</div><div className="text-[11px] text-slate-400">{archivos.length} archivo{archivos.length === 1 ? '' : 's'} · cada pestaña tiene su documento, sus movimientos y su validación</div></div>
    <div role="tablist" className="flex gap-1.5 overflow-x-auto p-2 scrollbar-thin">{archivos.map((archivo, indice) => {
      const estado = estiloPestana[estadoDe(archivo.clave)]
      const seleccionada = archivo.clave === activa
      const pendiente = sinGuardar(archivo.clave)
      return <button key={archivo.clave} type="button" role="tab" id={`pestana-extraccion-${indice}`} aria-selected={seleccionada} aria-controls={`panel-extraccion-${indice}`} onClick={() => onActivar(archivo.clave)} className={`flex min-w-0 max-w-[280px] shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${seleccionada ? 'border-coral bg-orange-50/60 text-ink' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
        {/\.(png|jpe?g|webp|gif)$/i.test(archivo.filename) ? <FileImage size={14} className="shrink-0 text-coral" /> : <FileText size={14} className="shrink-0 text-coral" />}
        <span className="min-w-0 truncate font-semibold" title={archivo.filename}>{archivo.filename}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${estado.clase}`}>{estado.etiqueta}</span>
        {pendiente && <span title="Cambios sin guardar" aria-label="Cambios sin guardar" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
      </button>
    })}</div>
  </nav>
}

type AvisoCombinacion = { conservadas: number; noAparecen: number; campos: string[] }
/** Una sola lista por documento: los modos manual y Gemini muestran y editan el mismo documento. */
type CampoResumenEditable = 'banco' | 'titular' | 'cuenta' | 'periodo' | 'moneda' | CampoMontoResumen
/** Celda a la que se copia el dato del documento al hacer clic en su recuadro. */
type DestinoCaptura = { tipo: 'movimiento'; id: string; campo: CampoEditable } | { tipo: 'resumen'; campo: Exclude<CampoResumenEditable, 'banco'> } | { tipo: 'documento'; campoId: string }
/** «RFC: XAXX…» → «XAXX…» cuando el texto del documento trae delante el nombre del dato. */
const sinNombreDelante = (texto: string, nombre: string) => {
  const limpio = texto.replace(/\s+/g, ' ').trim()
  const comparable = (valor: string) => valor.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const prefijo = comparable(nombre).replace(/\s+/g, ' ').trim()
  if (!prefijo || !comparable(limpio).startsWith(prefijo)) return limpio
  const resto = limpio.slice(prefijo.length).replace(/^[\s:.#-]+/, '').trim()
  return resto || limpio
}
const resumenVacio = (): Resumen => ({ banco: '', titular: '', cuenta: '', periodo: '', moneda: '', saldo_inicial: '', total_cargos: '', total_abonos: '', saldo_final: '', dudosos: [] })
const etiquetaResumen: Record<CampoResumenEditable, string> = { banco: 'Banco', titular: 'Titular', cuenta: 'Cuenta', periodo: 'Periodo', moneda: 'Moneda', saldo_inicial: 'Saldo inicial', total_abonos: 'Total abonos', total_cargos: 'Total cargos', saldo_final: 'Saldo final' }
const camposResumen: CampoResumenEditable[] = ['banco', 'titular', 'cuenta', 'periodo', 'moneda', 'saldo_inicial', 'total_abonos', 'total_cargos', 'saldo_final']
type VerificacionVisor = { estado: EstadoTextoDocumento; onTexto: (paginas: PaginaTexto[] | null) => void; marcas: MarcaVerificacion[]; disponible: boolean; visible: boolean; onAlternar: () => void; resaltado: Resaltado | null; onClicMarca: (marca: MarcaVerificacion) => void; panel: React.ReactNode }

type ListaDocumento = { documentKey: string | null; documento: DocumentoEditable; aviso: AvisoCombinacion | null; warnings: string[]; avisosCampos: Record<string, AvisoCampo> }
/** Mensaje junto a una columna manual tras buscarla con la IA. */
type AvisoCampo = { tipo: 'exito' | 'info' | 'error'; texto: string }
const avisoDeLlenado = (resultado: ResultadoLlenado): AvisoCampo => ({ tipo: resultado.estado === 'llenado' || resultado.estado === 'dato_del_documento' ? 'exito' : 'info', texto: mensajeLlenado(resultado) })
/** Última versión confirmada por el backend para este documento. */
type VersionGuardada = { documentKey: string; version: number; estado: EstadoExtraccion; actualizado: string; firma: string; envios: IntentoEnvio[]; enviado_en: string | null }
type OfertaBorrador = { documentKey: string; borrador: BorradorLocal; versionGuardada: number | null }
let loteExtraccion = 0
/** Identificador del lote con que se marcan las filas de una extracción (lo usa combinarExtraccion). */
function nuevoLoteExtraccion() {
  loteExtraccion += 1
  return `${Date.now().toString(36)}${loteExtraccion}`
}
const borradores = borradoresLocales()
const listaVacia = (documentKey: string | null): ListaDocumento => ({ documentKey, documento: documentoVacio(), aviso: null, warnings: [], avisosCampos: {} })
const etiquetaEstado: Record<EstadoExtraccion, string> = { borrador: 'Borrador', revisado: 'Revisado', enviado: 'Enviado' }

type PropsRevision = {
  archivo: ArchivoExtraccion | null
  mode: ExtractionMode
  onModeChange: (mode: ExtractionMode) => void
  /** Barra de pestañas: se muestra entre el área documento/movimientos y la validación. */
  barraPestanas?: React.ReactNode
  /** Estado de este archivo en la cola de extracción en lote (undefined fuera de un lote). */
  cola?: ColaPestana
  resultadoCola?: ResultadoCola | null
  onReintentar?: () => void
  onReporte?: (clave: string, reporte: ReportePestana) => void
  registrarSalida?: (clave: string, alSalir: (() => void) | null) => void
}

function ExtractionReviewWorkspace({ archivo, mode, onModeChange, barraPestanas = null, cola, resultadoCola = null, onReintentar, onReporte, registrarSalida }: PropsRevision) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [lista, setLista] = useState<ListaDocumento>(() => listaVacia(null))
  const [guardado, setGuardado] = useState<VersionGuardada | null>(null)
  const [carga, setCarga] = useState<{ documentKey: string | null; estado: 'cargando' | 'listo' | 'error'; error: string | null }>({ documentKey: null, estado: 'listo', error: null })
  const [recargas, setRecargas] = useState(0)
  const [cuentaId, setCuentaId] = useState<string | null>(() => inboxStore.cachedStatus()?.cuentaId ?? null)
  const [ofertaBorrador, setOfertaBorrador] = useState<OfertaBorrador | null>(null)
  const [abrirMenuCampo, setAbrirMenuCampo] = useState(0)
  const [sugerenciasCerradas, setSugerenciasCerradas] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [resultadoGuardado, setResultadoGuardado] = useState<{ documentKey: string; tipo: 'exito' | 'error' | 'conflicto'; mensaje: string } | null>(null)
  const [confirmandoRevision, setConfirmandoRevision] = useState<ProblemasRevision | null>(null)
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [confirmandoReextraccion, setConfirmandoReextraccion] = useState(false)
  // Verificación visual (solo de esta pestaña): texto del PDF, celda destino del clic, fila resaltada.
  const [textoDocumento, setTextoDocumento] = useState<{ documentKey: string | null; estado: 'listo' | 'sin_texto' | 'error'; paginas: PaginaTexto[] } | null>(null)
  const [verificacionVisible, setVerificacionVisible] = useState(true)
  const [destino, setDestino] = useState<DestinoCaptura | null>(null)
  const [resaltado, setResaltado] = useState<Resaltado | null>(null)
  const [mensajeCaptura, setMensajeCaptura] = useState<{ tipo: 'info' | 'error'; texto: string } | null>(null)
  const [filaPorAgregar, setFilaPorAgregar] = useState<number | null>(null)
  const [llenandoCampos, setLlenandoCampos] = useState<{ documentKey: string | null; campos: string[] }>({ documentKey: null, campos: [] })
  // Asocia cada extracción a su documento y descarta respuestas tardías de documentos anteriores.
  const [controlador] = useState(crearControladorExtraccion)
  const messageId = archivo?.messageId ?? null
  const attachmentId = archivo?.attachmentId ?? null
  const partId = archivo?.partId ?? null
  const filename = archivo?.filename ?? 'Documento recibido'
  const fileType = filename.split('.').pop()?.toUpperCase() ?? 'PDF'
  const documentKey = messageId && attachmentId ? `${messageId}:${partId ?? attachmentId}` : null
  const documentKeyActual = useRef(documentKey)
  useEffect(() => { documentKeyActual.current = documentKey }, [documentKey])

  const deEsteDocumento = lista.documentKey === documentKey
  const documento = deEsteDocumento ? lista.documento : documentoVacio()
  const transactions = documento.transacciones
  // Sugerencias de la IA que aún no son columna (p. ej. de una extracción automática): el aviso abre el menú "+ Campo".
  const sugerenciasPendientes = sugerenciasDisponibles(documento.sugerencias_campos, documento.campos_extra).length
  const aviso = deEsteDocumento ? lista.aviso : null
  const versionGuardada = guardado?.documentKey === documentKey ? guardado : null
  const cargaLista = carga.documentKey === documentKey && carga.estado === 'listo'
  const sinGuardar = Boolean(documentKey) && cargaLista && hayCambios(documento, versionGuardada?.firma ?? null)
  const claveLocal = cuentaId && messageId && partId ? claveBorrador(cuentaId, messageId, partId) : null
  const oferta = ofertaBorrador?.documentKey === documentKey ? ofertaBorrador : null
  const avisoGuardado = resultadoGuardado?.documentKey === documentKey ? resultadoGuardado : null
  /** Cualquier cambio de contenido vuelve el documento a borrador hasta que se guarde o se marque como revisado. */
  const setTransactions = (actualizar: (items: Transaccion[]) => Transaccion[]) => setLista((prev) => {
    const base = prev.documentKey === documentKey ? prev : listaVacia(documentKey)
    return { ...base, documento: { ...base.documento, estado: 'borrador', transacciones: actualizar(base.documento.transacciones) } }
  })
  const dudososCount = transactions.reduce((total, transaccion) => total + transaccion.dudosos.length, 0)
  const correcciones = contarCorrecciones(transactions)
  const huboExtraccion = documento.resumen !== null || transactions.some((transaccion) => transaccion.origen !== 'manual')
  // La misma validación del backend, recalculada sobre la lista editada.
  const validacion = useMemo(() => validarContabilidad(documento.resumen ?? {}, transactions, documento.formato_numerico), [documento.resumen, transactions, documento.formato_numerico])
  const alertas = useMemo(() => alertasPorFila(validacion), [validacion])
  const problemas = useMemo(() => contarProblemas(validacion, documento.resumen, transactions), [validacion, documento.resumen, transactions])

  // Verificación visual: se recalcula con cada edición; nada de esto se guarda.
  const esPdf = filename.toLowerCase().endsWith('.pdf')
  const esImagen = /\.(png|jpe?g|webp|gif)$/i.test(filename)
  const textoActual = textoDocumento?.documentKey === documentKey ? textoDocumento : null
  const estadoTexto: EstadoTextoDocumento = esImagen ? 'imagen' : !esPdf ? 'otro' : textoActual?.estado ?? 'cargando'
  const datosDocumento = useMemo(() => (textoActual?.estado === 'listo' ? detectarDatos(textoActual.paginas) : null), [textoActual])
  const verificacion = useMemo(() => (datosDocumento ? verificar(datosDocumento, { resumen: documento.resumen, transacciones: transactions, formato_numerico: documento.formato_numerico }) : null), [datosDocumento, documento.resumen, transactions, documento.formato_numerico])
  const verificando = verificacionVisible && verificacion !== null
  // Copiar a un dato del documento (RFC…): todo el texto del documento se vuelve clicable, no solo lo reconocido.
  const destinoDocumento = destino?.tipo === 'documento' ? destino.campoId : null
  const marcasTexto = useMemo<MarcaVerificacion[] | null>(() => {
    if (!destinoDocumento || textoActual?.estado !== 'listo') return null
    return textoActual.paginas.flatMap((pagina) => pagina.fragmentos.map((fragmento, indice) => ({
      id: `texto-${pagina.numero}-${indice}`, grupo: 'texto' as const, campo: 'concepto' as const, etiqueta: 'Texto', textoDocumento: fragmento.texto.trim(), valorCapturado: '', estado: 'no_se_captura' as const,
      recuadro: { pagina: pagina.numero, x: fragmento.x, y: fragmento.y, ancho: fragmento.ancho, alto: fragmento.alto }, filaDocumento: null, transaccionId: null,
    })).filter((marca) => marca.textoDocumento))
  }, [destinoDocumento, textoActual])
  const sinRespaldo = useMemo(() => new Set(verificando ? verificacion!.sinRespaldo : []), [verificando, verificacion])

  const aplicadoCola = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    // Cambiar de documento cancela la extracción en curso: su respuesta tardía se descartará.
    controlador.cancelar()
    setLista(listaVacia(documentKey))
    setGuardado(null)
    setOfertaBorrador(null)
    setResultadoGuardado(null)
    setConfirmandoRevision(null)
    setGeminiError(null)
    setConfirmandoReextraccion(false)
    setExtracting(false)
    setProgress(0)
    aplicadoCola.current = null
    setDestino(null)
    setResaltado(null)
    setMensajeCaptura(null)
    setFilaPorAgregar(null)
    if (!documentKey) {
      setGeminiStatus(null)
      setCarga({ documentKey, estado: 'listo', error: null })
      return () => { active = false; controlador.cancelar() }
    }
    void geminiApi.status().then((status) => {
      if (active) setGeminiStatus(status)
    }).catch((error: unknown) => {
      if (active) setGeminiError(error instanceof Error ? `Extracción IA no disponible: ${error.message}` : 'Extracción IA no disponible.')
    })
    if (!messageId || !partId) {
      // Enlace antiguo sin partId: se puede revisar, pero no hay clave estable para guardar.
      setCarga({ documentKey, estado: 'listo', error: null })
      return () => { active = false; controlador.cancelar() }
    }
    // Primero lo guardado en el backend (fuente de verdad); solo si no existe se ofrece extraer.
    setCarga({ documentKey, estado: 'cargando', error: null })
    void Promise.all([extraccionesApi.obtener(messageId, partId), inboxStore.loadStatus().catch(() => inboxStore.cachedStatus())])
      .then(([guardadoBackend, status]) => {
        if (!active) return
        const cuenta = status?.cuentaId ?? null
        setCuentaId(cuenta)
        let firmaServidor: string | null = null
        if (guardadoBackend) {
          const documentoGuardado = documentoDesdeGuardado(guardadoBackend)
          firmaServidor = firmaContenido(documentoGuardado)
          setLista({ documentKey, documento: documentoGuardado, aviso: null, warnings: [], avisosCampos: {} })
          setGuardado({ documentKey, version: guardadoBackend.version, estado: guardadoBackend.estado, actualizado: guardadoBackend.actualizado, firma: firmaServidor, envios: guardadoBackend.envios ?? [], enviado_en: guardadoBackend.enviado_en })
        }
        const clave = cuenta ? claveBorrador(cuenta, messageId, partId) : null
        const borrador = clave ? borradores.leer(clave) : null
        if (clave && borrador) {
          // Un borrador idéntico a lo guardado no aporta nada: se descarta sin preguntar.
          if (firmaServidor !== null && firmaContenido(borrador.documento) === firmaServidor) borradores.borrar(clave)
          else setOfertaBorrador({ documentKey, borrador, versionGuardada: guardadoBackend?.version ?? null })
        }
        setCarga({ documentKey, estado: 'listo', error: null })
      })
      .catch((error: unknown) => {
        if (active) setCarga({ documentKey, estado: 'error', error: error instanceof Error ? error.message : 'No se pudo cargar la extracción guardada.' })
      })
    return () => { active = false; controlador.cancelar() }
  }, [documentKey, messageId, partId, controlador, recargas])

  // Borrador local: copia de los cambios aún no guardados, escrita ~2 s después de la última edición.
  useEffect(() => {
    if (!claveLocal || !sinGuardar || oferta) return
    const temporizador = window.setTimeout(() => borradores.guardar(claveLocal, { version_base: versionGuardada?.version ?? null, guardadoEn: new Date().toISOString(), documento }), 2000)
    return () => window.clearTimeout(temporizador)
  }, [claveLocal, sinGuardar, oferta, documento, versionGuardada])

  // El aviso al salir vive en el contenedor de pestañas (React Router admite un solo bloqueador): esta pestaña le
  // informa si tiene cambios sin guardar y le deja cómo escribir su borrador local al salir.
  const alSalirRef = useRef<() => void>(() => undefined)
  alSalirRef.current = () => {
    // El borrador local se escribe ya (sin esperar el debounce) para no perder los últimos cambios.
    if (claveLocal && !oferta && sinGuardar) borradores.guardar(claveLocal, { version_base: versionGuardada?.version ?? null, guardadoEn: new Date().toISOString(), documento })
  }
  useEffect(() => {
    if (!documentKey || !registrarSalida) return
    registrarSalida(documentKey, () => alSalirRef.current())
    return () => registrarSalida(documentKey, null)
  }, [documentKey, registrarSalida])
  const estadoGuardado = versionGuardada?.estado ?? null
  useEffect(() => {
    if (documentKey && cargaLista && onReporte) onReporte(documentKey, { guardado: estadoGuardado, sinGuardar })
  }, [documentKey, cargaLista, estadoGuardado, sinGuardar, onReporte])

  const cambiarCampo = (id: string, campo: CampoEditable, valor: string) => setTransactions((items) => items.map((item) => item.id === id ? editarCampo(item, campo, valor) : item))
  const eliminarTransaccion = (id: string) => setTransactions((items) => items.filter((item) => item.id !== id))
  const agregarTransaccion = () => setTransactions((items) => [...items, nuevaTransaccion()])
  /** Número del movimiento: escribir otro número lo mueve a esa posición (el orden por fecha se aplica al extraer). */
  const moverMovimiento = (id: string, numero: number) => setTransactions((items) => moverTransaccion(items, id, numero))
  /** Columnas adicionales ("+ Campo"): como cualquier cambio de contenido, vuelven el documento a borrador. */
  const setColumnas = (actualizar: (columnas: ColumnasDocumento) => ColumnasDocumento) => setLista((prev) => {
    const base = prev.documentKey === documentKey ? prev : listaVacia(documentKey)
    const { transacciones, campos_extra } = actualizar({ transacciones: base.documento.transacciones, campos_extra: base.documento.campos_extra })
    return { ...base, documento: { ...base.documento, estado: 'borrador', transacciones, campos_extra } }
  })
  const cambiarExtra = (id: string, campoId: string, valor: string) => setTransactions((items) => items.map((item) => item.id === id ? editarExtra(item, campoId, valor) : item))
  /**
   * "Agregar también a la configuración": el campo nuevo del documento queda vinculado (plantilla_id) a un campo nuevo
   * de la configuración. Si ya hay un campo configurado con ese nombre, se vincula a él; si no se puede guardar, el
   * campo queda solo en el documento y se avisa junto a él.
   */
  const vincularConfiguracion = (plantillaId: string, configurado: Omit<CampoPlantilla, 'id'>) => {
    const clave = documentKey
    const fijarVinculo = (nuevoId: string | null, aviso?: AvisoCampo) => setLista((prev) => {
      if (prev.documentKey !== clave) return prev
      const campo = prev.documento.campos_extra.find((item) => item.plantilla_id === plantillaId)
      if (!campo) return prev
      const { plantilla_id: _vinculo, ...resto } = campo
      const actualizado: CampoExtra = nuevoId ? { ...resto, plantilla_id: nuevoId } : resto
      return {
        ...prev,
        documento: { ...prev.documento, campos_extra: prev.documento.campos_extra.map((item) => (item === campo ? actualizado : item)) },
        avisosCampos: aviso ? { ...prev.avisosCampos, [campo.id]: aviso } : prev.avisosCampos,
      }
    })
    void (async () => {
      try {
        const actual = await plantillaCamposApi.obtener()
        const existente = actual.campos.find((campo) => nombreComparable(campo.nombre) === nombreComparable(configurado.nombre))
        if (existente) { fijarVinculo(existente.id); return }
        const guardada = await plantillaCamposApi.guardar(agregarAPlantilla(actual.campos, { ...configurado, id: plantillaId }))
        plantillaVigente.fijar(guardada.campos)
      } catch (error) {
        fijarVinculo(null, { tipo: 'error', texto: `No se pudo agregar «${configurado.nombre}» a la configuración: ${error instanceof Error ? error.message : 'error desconocido'}` })
      }
    })()
  }
  /** Agrega el campo al documento y, si se pidió, lo vincula a la configuración con un id nuevo. */
  const agregarYVincular = (actualizar: (columnas: ColumnasDocumento) => ColumnasDocumento, configurado: Omit<CampoPlantilla, 'id'> | null) => {
    if (!configurado) { setColumnas(actualizar); return }
    const plantillaId = nuevoIdPlantilla()
    setColumnas((columnas) => {
      const resultado = actualizar(columnas)
      return { ...resultado, campos_extra: resultado.campos_extra.map((campo) => (columnas.campos_extra.some((previo) => previo.id === campo.id) ? campo : { ...campo, plantilla_id: plantillaId })) }
    })
    vincularConfiguracion(plantillaId, configurado)
  }
  const elegirSugerencia = (sugerencia: SugerenciaCampo, tambienConfiguracion = false) => agregarYVincular(
    (columnas) => aplicarSugerencia(columnas, sugerencia),
    tambienConfiguracion ? { nombre: sugerencia.nombre, origen: 'ia', alcance: sugerencia.valores.length > 0 ? 'movimiento' : 'documento', clave: sugerencia.clave } : null,
  )
  const agregarCampo = (nombre: string, alcance: AlcanceCampo, tambienConfiguracion = false) => agregarYVincular(
    (columnas) => ({ ...columnas, campos_extra: agregarCampoManual(columnas.campos_extra, nombre, alcance) }),
    tambienConfiguracion ? { nombre: nombre.replace(/\s+/g, ' ').trim(), origen: 'manual', alcance } : null,
  )
  const cambiarValorDocumento = (id: string, valor: string) => setColumnas((columnas) => ({ ...columnas, campos_extra: editarValorDocumento(columnas.campos_extra, id, valor) }))
  /** El usuario corrige el tipo que eligió la IA (una vez para todos ↔ en cada movimiento). */
  const cambiarTipoCampo = (id: string, alcance: AlcanceCampo) => setColumnas((columnas) => cambiarAlcance(columnas, id, alcance))
  const renombrarColumna = (id: string, nombre: string) => setColumnas((columnas) => ({ ...columnas, campos_extra: renombrarCampo(columnas.campos_extra, id, nombre) }))
  const eliminarColumna = (id: string) => setColumnas((columnas) => eliminarCampo(columnas, id))
  const cerrarAvisoCampo = (id: string) => setLista((prev) => (prev.documentKey === documentKey ? { ...prev, avisosCampos: Object.fromEntries(Object.entries(prev.avisosCampos).filter(([clave]) => clave !== id)) } : prev))
  /** "Llenar con IA": busca solo esta columna manual con las filas actuales y llena únicamente las celdas vacías. */
  const llenarConIa = async (campoId: string) => {
    const campo = documento.campos_extra.find((item) => item.id === campoId)
    if (!campo || !messageId || !attachmentId || !documentKey || llenandoCampos.campos.includes(campoId)) return
    const clave = documentKey
    const filas = transactions
    const ids = filas.map((fila) => fila.id)
    setLlenandoCampos((prev) => ({ documentKey: clave, campos: [...(prev.documentKey === clave ? prev.campos : []), campoId] }))
    let aviso: AvisoCampo | null = null
    let respuesta: Awaited<ReturnType<typeof geminiApi.llenarCampo>> | null = null
    try {
      respuesta = await geminiApi.llenarCampo(messageId, attachmentId, campo.nombre, filas.map(({ fecha, concepto, referencia, cargo, abono }) => ({ fecha, concepto, referencia, cargo, abono })))
    } catch (error) {
      aviso = { tipo: 'error', texto: `No se pudo buscar «${campo.nombre}»: ${error instanceof Error ? error.message : 'error desconocido'}` }
    }
    // Una respuesta tardía de otro documento se descarta.
    if (documentKeyActual.current !== clave) return
    setLlenandoCampos((prev) => (prev.documentKey === clave ? { ...prev, campos: prev.campos.filter((id) => id !== campoId) } : prev))
    setLista((prev) => {
      if (prev.documentKey !== clave) return prev
      const actual = prev.documento.campos_extra.find((item) => item.id === campoId)
      if (!actual) return prev
      if (!respuesta) return { ...prev, avisosCampos: { ...prev.avisosCampos, [campoId]: aviso! } }
      // Las filas borradas mientras se buscaba se ignoran; solo se llenan las celdas que siguen vacías.
      const { transacciones, campo: campoNuevo, resultado } = llenarColumnaManual(prev.documento.transacciones, actual, respuesta.encontrado, fuenteDeLlenado(respuesta, ids))
      // Un dato del documento se llena una sola vez en el campo, nunca en cada movimiento.
      const campos_extra = campoNuevo === actual ? prev.documento.campos_extra : prev.documento.campos_extra.map((item) => (item.id === campoId ? campoNuevo : item))
      const documentoNuevo = resultado.llenadas > 0 ? { ...prev.documento, estado: 'borrador' as const, transacciones, campos_extra } : prev.documento
      return { ...prev, documento: documentoNuevo, avisosCampos: { ...prev.avisosCampos, [campoId]: avisoDeLlenado(resultado) } }
    })
  }
  /** Edición del resumen: como cualquier cambio de contenido, vuelve el documento a borrador; el campo deja de ser dudoso. */
  const cambiarResumen = (campo: CampoResumenEditable, valor: string) => setLista((prev) => {
    const base = prev.documentKey === documentKey ? prev : listaVacia(documentKey)
    const actual = base.documento.resumen ?? resumenVacio()
    if (actual[campo] === valor) return base
    return { ...base, documento: { ...base.documento, estado: 'borrador', resumen: { ...actual, [campo]: valor, dudosos: actual.dudosos.filter((dudoso) => dudoso !== campo) } } }
  })

  const textoRecibido = useCallback((paginas: PaginaTexto[] | null) => {
    setTextoDocumento({ documentKey, estado: paginas === null ? 'error' : tieneCapaDeTexto(paginas) ? 'listo' : 'sin_texto', paginas: paginas ?? [] })
  }, [documentKey])
  const nombreDestino = (valor: DestinoCaptura) => {
    if (valor.tipo === 'documento') return `${documento.campos_extra.find((campo) => campo.id === valor.campoId)?.nombre ?? 'Dato'} del documento`
    if (valor.tipo === 'resumen') return `${etiquetaResumen[valor.campo]} del resumen`
    const posicion = transactions.findIndex((transaccion) => transaccion.id === valor.id)
    return `${ETIQUETA_CAMPO[valor.campo]} del movimiento ${posicion + 1}`
  }
  const enfocarCeldaMovimiento = (id: string, campo: CampoEditable) => {
    setDestino({ tipo: 'movimiento', id, campo })
    setResaltado({ transaccionId: id, filaDocumento: null, origen: 'tabla' })
    setFilaPorAgregar(null)
  }
  /** Dato del documento (RFC…): con el texto del documento listo, cualquier texto del documento se puede copiar a él. */
  const enfocarValorDocumento = (campoId: string) => {
    setFilaPorAgregar(null)
    if (estadoTexto !== 'listo') { setDestino(null); return }
    setDestino({ tipo: 'documento', campoId })
    setVerificacionVisible(true)
  }
  const enfocarCampoResumen = (campo: CampoResumenEditable) => {
    // El banco no se verifica en el documento: no tiene recuadro del que copiar.
    setDestino(campo === 'banco' ? null : { tipo: 'resumen', campo })
    setFilaPorAgregar(null)
  }
  /** Clic en un recuadro: copia a la celda destino, ofrece agregar un movimiento faltante o resalta su fila. */
  const clicMarca = (marca: MarcaVerificacion) => {
    setMensajeCaptura(null)
    if (destino?.tipo === 'documento') {
      const campo = documento.campos_extra.find((item) => item.id === destino.campoId)
      if (!campo) { setDestino(null); return }
      const texto = sinNombreDelante(marca.textoDocumento, campo.nombre).slice(0, 500)
      cambiarValorDocumento(campo.id, texto)
      setMensajeCaptura({ tipo: 'info', texto: `Copiado a ${campo.nombre} del documento: ${texto}` })
      setDestino(null)
      return
    }
    if (destino && verificacion) {
      if (!compatibles(destino.campo, marca.campo)) {
        setMensajeCaptura({ tipo: 'error', texto: `No se copió: ${marca.etiqueta.toLowerCase()} no corresponde a ${nombreDestino(destino).toLowerCase()}. Haz clic en ${destino.campo === 'fecha' ? 'una fecha' : ['cargo', 'abono', 'saldo', 'saldo_inicial', 'total_cargos', 'total_abonos', 'saldo_final'].includes(destino.campo) ? 'un importe' : 'un texto'} del documento.` })
        return
      }
      const valor = valorParaCaptura(destino.campo, marca.textoDocumento, verificacion.formato)
      if (!valor.ok) {
        setMensajeCaptura({ tipo: 'error', texto: `No se copió: ${valor.mensaje}` })
        return
      }
      if (destino.tipo === 'movimiento') cambiarCampo(destino.id, destino.campo, valor.valor)
      else cambiarResumen(destino.campo, valor.valor)
      setMensajeCaptura({ tipo: 'info', texto: `Copiado a ${nombreDestino(destino).toLowerCase()}: ${valor.valor}` })
      setDestino(null)
      return
    }
    if (marca.grupo === 'movimientos' && marca.filaDocumento !== null && marca.transaccionId === null && marca.estado === 'falta') {
      setFilaPorAgregar(marca.filaDocumento)
      setResaltado({ transaccionId: null, filaDocumento: marca.filaDocumento, origen: 'documento' })
      return
    }
    if (marca.grupo === 'movimientos') setResaltado({ transaccionId: marca.transaccionId, filaDocumento: marca.filaDocumento, origen: 'documento' })
  }
  const agregarDesdeDocumento = () => {
    const fila = filaPorAgregar === null ? null : datosDocumento?.filas[filaPorAgregar] ?? null
    if (!fila || !verificacion) return
    const nuevo = movimientoDesdeFila(fila, verificacion.formato)
    const emparejamiento = verificacion.emparejamiento
    setTransactions((items) => {
      const posicion = posicionParaInsertar(fila.indice, emparejamiento, items)
      return [...items.slice(0, posicion), nuevo, ...items.slice(posicion)]
    })
    setFilaPorAgregar(null)
    setResaltado({ transaccionId: nuevo.id, filaDocumento: fila.indice, origen: 'documento' })
    setMensajeCaptura({ tipo: 'info', texto: 'Movimiento agregado desde el documento.' })
  }
  const selectMode = (nextMode: ExtractionMode) => onModeChange(nextMode)

  const restaurarBorrador = () => {
    if (!oferta) return
    setLista({ documentKey, documento: oferta.borrador.documento, aviso: null, warnings: [], avisosCampos: {} })
    setOfertaBorrador(null)
  }
  const descartarBorrador = () => {
    if (claveLocal) borradores.borrar(claveLocal)
    setOfertaBorrador(null)
  }

  const guardar = async (estado: 'borrador' | 'revisado', confirmarProblemas = false) => {
    if (!messageId || !partId || !documentKey || guardando) return
    const clave = documentKey
    const enviado: DocumentoEditable = { ...documento, estado }
    const transaccionesEnviadas = documento.transacciones
    const camposEnviados = documento.campos_extra
    setConfirmandoRevision(null)
    setGuardando(true)
    setResultadoGuardado(null)
    const resultado = await ejecutarGuardado(() => extraccionesApi.guardar(messageId, partId, {
      version_base: versionGuardada?.version ?? null,
      estado,
      confirmar_problemas: confirmarProblemas,
      resumen: enviado.resumen ?? undefined,
      transacciones: enviado.transacciones,
      formato_numerico: enviado.formato_numerico,
      modelo: enviado.modelo,
      prompt_version: enviado.prompt_version,
      filename,
      attachmentId,
      campos_extra: enviado.campos_extra,
      sugerencias_campos: enviado.sugerencias_campos,
    }))
    if (documentKeyActual.current !== clave) return
    setGuardando(false)
    if (resultado.ok) {
      const { extraccion } = resultado
      setGuardado({ documentKey: clave, version: extraccion.version, estado: extraccion.estado, actualizado: extraccion.actualizado, firma: firmaContenido({ ...enviado, estado: extraccion.estado }), envios: extraccion.envios ?? [], enviado_en: extraccion.enviado_en })
      // Las ediciones hechas mientras se guardaba siguen pendientes; solo se refleja el estado si no hubo cambios.
      setLista((prev) => (prev.documentKey === clave && prev.documento.transacciones === transaccionesEnviadas && prev.documento.campos_extra === camposEnviados ? { ...prev, documento: { ...prev.documento, estado: extraccion.estado } } : prev))
      if (claveLocal) borradores.borrar(claveLocal)
      setOfertaBorrador(null)
      inboxStore.invalidarEstados()
      setResultadoGuardado({ documentKey: clave, tipo: 'exito', mensaje: `Guardado en el backend como ${etiquetaEstado[extraccion.estado].toLowerCase()} · versión ${extraccion.version}.` })
    } else if (resultado.tipo === 'revision_con_problemas' && resultado.problemas) {
      setConfirmandoRevision(resultado.problemas)
    } else {
      setResultadoGuardado({ documentKey: clave, tipo: resultado.tipo === 'conflicto' ? 'conflicto' : 'error', mensaje: `No se guardó: ${resultado.mensaje}` })
    }
  }
  /** Un envío (exitoso o no) devuelve la extracción auditada: se actualiza estado e historial sin tocar el contenido. */
  const alActualizarEnvio = (extraccion: ExtraccionGuardada) => {
    if (!documentKey || documentKeyActual.current !== documentKey) return
    const clave = documentKey
    const firma = firmaContenido(documentoDesdeGuardado(extraccion))
    setGuardado((prev) => (prev && prev.documentKey === clave ? { ...prev, version: extraccion.version, estado: extraccion.estado, actualizado: extraccion.actualizado, firma, envios: extraccion.envios ?? [], enviado_en: extraccion.enviado_en } : prev))
    setLista((prev) => (prev.documentKey === clave && firmaContenido({ ...prev.documento, estado: extraccion.estado }) === firma ? { ...prev, documento: { ...prev.documento, estado: extraccion.estado } } : prev))
    inboxStore.invalidarEstados()
  }
  const marcarRevisado = () => {
    if (problemas.total > 0) setConfirmandoRevision(problemas)
    else void guardar('revisado')
  }
  const recargarGuardado = () => {
    if (claveLocal) borradores.guardar(claveLocal, { version_base: versionGuardada?.version ?? null, guardadoEn: new Date().toISOString(), documento })
    setRecargas((valor) => valor + 1)
  }

  /** Combina un resultado de Gemini con lo vigente de ESTE documento (lo guardado y las ediciones hechas mientras procesaba). */
  const aplicarResultadoGemini = (result: GeminiExtractionResponse, forzar: boolean) => {
    if (!documentKey) return
    const clave = documentKey
    const lote = nuevoLoteExtraccion()
    // Updater puro. El resultado queda como borrador con cambios sin guardar hasta que el usuario pulse Guardar.
    setLista((prev) => {
      const base = prev.documentKey === clave ? prev : listaVacia(clave)
      // Los campos de la configuración que el documento no tiene se agregan vacíos (nunca se borra nada).
      const campos = aplicarPlantilla(base.documento.campos_extra, plantillaVigente.actual())
      const { documento: combinado, combinacion, llenado } = documentoDesdeExtraccion(result, base.documento.transacciones, lote, campos)
      const mostrarAviso = forzar || combinacion.conservadas > 0 || llenado.length > 0
      return {
        documentKey: clave,
        documento: combinado,
        aviso: mostrarAviso ? { conservadas: combinacion.conservadas, noAparecen: combinacion.noAparecen, campos: llenado.map(mensajeLlenado) } : null,
        warnings: result.warnings,
        avisosCampos: Object.fromEntries(llenado.map((resultado) => [resultado.campoId, avisoDeLlenado(resultado)])),
      }
    })
  }

  // Resultado de la extracción en lote: solo llega el de este archivo (la cola lo entrega con su clave) y se aplica
  // una vez, cuando lo guardado ya cargó y no existe (la cola no extrae lo que ya está guardado).
  useEffect(() => {
    if (!resultadoCola || !documentKey || !cargaLista || versionGuardada || aplicadoCola.current === resultadoCola.id) return
    aplicadoCola.current = resultadoCola.id
    onModeChange('gemini')
    aplicarResultadoGemini(resultadoCola.datos, false)
  })

  const colaActiva = cola?.estado === 'en_cola' || cola?.estado === 'extrayendo'
  const solicitarExtraccion = () => {
    if (extracting || colaActiva || !documentKey) return
    if (huboExtraccion && correcciones > 0) {
      setConfirmandoReextraccion(true)
      return
    }
    void extraerConGemini()
  }
  const extraerConGemini = async () => {
    if (!messageId || !attachmentId || !documentKey) return
    const forzar = huboExtraccion
    setConfirmandoReextraccion(false)
    onModeChange('gemini')
    setGeminiError(null)
    setLista((prev) => (prev.documentKey === documentKey ? { ...prev, aviso: null } : prev))
    setExtracting(true)
    setProgress(25)
    await ejecutarExtraccion(controlador, documentKey, async (signal) => {
      const status = geminiStatus ?? await geminiApi.status()
      if (!status.enabled) throw new Error('Gemini no está conectado o habilitado en FastAPI.')
      const plantilla = await plantillaVigente.cargar()
      return geminiApi.extract(messageId, attachmentId, { forzar, signal, campos: camposParaSolicitar(aplicarPlantilla(documento.campos_extra, plantilla)) })
    }, {
      exito: (result) => {
        aplicarResultadoGemini(result, forzar)
        setProgress(100)
      },
      error: (error) => {
        setProgress(0)
        setGeminiError(error instanceof Error ? `Extracción IA no disponible: ${error.message}` : 'Extracción IA no disponible.')
      },
      fin: () => setExtracting(false),
    })
  }

  if (!messageId || !attachmentId) return <div className="space-y-4"><section className="sticky top-2 z-20 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur"><div><div className="eyebrow">Workspace de extracción</div><div className="text-sm font-bold text-ink">Sin documento seleccionado</div></div><button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver a correos</button></section><div className="grid gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]"><EmptyDocumentViewer /><section className="panel flex min-h-[560px] items-center justify-center p-8 text-center"><div><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileSearch size={22} /></div><div className="mt-4 text-sm font-bold text-ink">Sin transacciones para revisar</div><div className="mt-1.5 max-w-xs text-xs leading-5 text-slate-400">Selecciona un PDF o imagen desde Correos y pulsa Extraer para comenzar.</div></div></section></div></div>

  const cargando = carga.documentKey === documentKey && carga.estado === 'cargando'
  const errorCarga = carga.documentKey === documentKey && carga.estado === 'error' ? carga.error : null
  const puedeGuardar = Boolean(partId) && cargaLista && !guardando
  const puedeExtraer = cargaLista && !extracting && !colaActiva && !confirmandoReextraccion && geminiStatus?.enabled === true
  const estadoVisible = versionGuardada ? etiquetaEstado[versionGuardada.estado] : 'Sin guardar'
  const ultimoEnvioExitoso = versionGuardada?.envios.filter((intento) => intento.resultado === 'exito').slice(-1)[0]
  const modificadoTrasEnvio = Boolean(ultimoEnvioExitoso) && (sinGuardar || (versionGuardada?.version ?? 0) > (ultimoEnvioExitoso?.version_extraccion ?? 0))

  return <div className="space-y-4">
    <section className="sticky top-2 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur sm:p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral"><FileText size={18} /></div>
          <div className="min-w-0"><div className="eyebrow">Revisión de estado de cuenta · {fileType}</div><div className="truncate text-sm font-bold text-ink sm:text-base">{filename}</div></div>
          <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold sm:inline-flex ${versionGuardada?.estado === 'revisado' ? 'bg-emerald-50 text-emerald-700' : versionGuardada ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{estadoVisible}{versionGuardada && ` · v${versionGuardada.version}`}</span>
          {sinGuardar && <span role="status" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold text-amber-800"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Cambios sin guardar</span>}{modificadoTrasEnvio && <span className="inline-flex shrink-0 rounded-full bg-orange-100 px-2.5 py-1 text-[10px] font-bold text-orange-800">Modificado después del último envío</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-100 p-1"><button type="button" onClick={() => selectMode('manual')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'manual' ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}><UserRound size={13} />Manual</button><button type="button" onClick={() => selectMode('gemini')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'gemini' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sparkles size={13} />Gemini</button></div>
          {mode === 'gemini' && <button type="button" onClick={solicitarExtraccion} disabled={!puedeExtraer} className="btn-primary px-3 py-2"><Sparkles size={14} className={extracting ? 'animate-pulse' : ''} />{extracting ? `Extrayendo ${progress}%` : cola?.estado === 'extrayendo' ? 'Extrayendo…' : cola?.estado === 'en_cola' ? 'En cola…' : geminiStatus?.enabled !== true ? 'Extracción IA no disponible' : huboExtraccion ? 'Re-extraer con Gemini' : 'Extraer con Gemini'}</button>}
          <button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver</button>
          <button type="button" onClick={() => void guardar(documento.estado === 'revisado' ? 'revisado' : 'borrador', documento.estado === 'revisado')} disabled={!puedeGuardar || !sinGuardar} className="btn-soft px-3 py-2"><Check size={14} />{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" onClick={marcarRevisado} disabled={!puedeGuardar || transactions.length === 0 || (versionGuardada !== null && versionGuardada.estado !== 'borrador' && !sinGuardar)} className="btn-primary px-3 py-2"><FileCheck2 size={14} />Marcar como revisado</button>
        </div>
      </div>
      {!partId && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">Este enlace no identifica el adjunto de forma estable, así que no se puede guardar. Vuelve a abrir el documento desde Correos.</div>}
      {mode === 'gemini' && !geminiStatus?.enabled && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">{geminiError ?? 'Consultando disponibilidad de Gemini en FastAPI. La extracción no generará datos hasta que esté habilitado.'}</div>}
      {geminiError && geminiStatus?.enabled === true && <div className="mt-3"><ErrorNotice text={geminiError} onClose={() => setGeminiError(null)} /></div>}
      {extracting && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} /></div>}
      {!extracting && cola?.estado === 'extrayendo' && <div role="status" className="mt-3"><div className="mb-1 text-[11px] text-violet-700">Extrayendo con Gemini (un archivo a la vez)…</div><div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-1/2 animate-pulse rounded-full bg-violet-500" /></div></div>}
      {cola?.estado === 'error' && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><span>No se pudo extraer este archivo: {cola.error}</span>{onReintentar && <button type="button" onClick={onReintentar} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Reintentar este archivo</button>}</div>}
      {errorCarga && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><span>No se pudo cargar la extracción guardada: {errorCarga}</span><button type="button" onClick={() => setRecargas((valor) => valor + 1)} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Reintentar</button></div>}
      {oferta && <div role="alertdialog" aria-labelledby="titulo-borrador-local" className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-900"><div id="titulo-borrador-local" className="font-bold">Borrador local sin guardar · {new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(oferta.borrador.guardadoEn))}</div><div className="mt-1 leading-5">Este navegador conserva cambios que nunca llegaron al backend ({oferta.borrador.documento.transacciones.length} movimientos).{oferta.borrador.version_base !== oferta.versionGuardada && ` Se basan en ${oferta.borrador.version_base ? `la versión ${oferta.borrador.version_base}` : 'un documento sin guardar'} y lo guardado ahora es ${oferta.versionGuardada ? `la versión ${oferta.versionGuardada}` : 'nada'}.`}</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={restaurarBorrador} className="btn-primary px-3 py-1.5 text-xs">Restaurar borrador local</button><button type="button" onClick={descartarBorrador} className="btn-soft px-3 py-1.5 text-xs">Descartar</button></div></div>}
      {confirmandoReextraccion && <div role="alertdialog" aria-labelledby="confirmar-reextraccion" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900"><div id="confirmar-reextraccion" className="font-bold">Este documento tiene {correcciones} corrección{correcciones === 1 ? '' : 'es'} manual{correcciones === 1 ? '' : 'es'}.</div><div className="mt-1 leading-5">Volver a extraer reemplaza solo las filas de la IA sin editar. Las filas manuales y las editadas se conservan; si una fila editada ya no aparece en la nueva extracción, se conserva marcada para revisión. El resultado queda como borrador hasta que lo guardes.</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void extraerConGemini()} className="btn-primary px-3 py-1.5 text-xs"><Sparkles size={13} />Re-extraer conservando correcciones</button><button type="button" onClick={() => setConfirmandoReextraccion(false)} className="btn-soft px-3 py-1.5 text-xs">Cancelar</button></div></div>}
      {confirmandoRevision && <div role="alertdialog" aria-labelledby="confirmar-revision" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-900"><div id="confirmar-revision" className="font-bold">Quedan {confirmandoRevision.total} problema{confirmandoRevision.total === 1 ? '' : 's'} sin resolver.</div><ul className="mt-1.5 list-disc space-y-0.5 pl-5">{confirmandoRevision.diferencias > 0 && <li>{confirmandoRevision.diferencias} comprobación{confirmandoRevision.diferencias === 1 ? '' : 'es'} contable{confirmandoRevision.diferencias === 1 ? '' : 's'} con diferencia.</li>}{confirmandoRevision.dudosos > 0 && <li>{confirmandoRevision.dudosos} importe{confirmandoRevision.dudosos === 1 ? '' : 's'} dudoso{confirmandoRevision.dudosos === 1 ? '' : 's'}.</li>}{confirmandoRevision.invalidos > 0 && <li>{confirmandoRevision.invalidos} importe{confirmandoRevision.invalidos === 1 ? '' : 's'} inválido{confirmandoRevision.invalidos === 1 ? '' : 's'}.</li>}{confirmandoRevision.en_revision > 0 && <li>{confirmandoRevision.en_revision} fila{confirmandoRevision.en_revision === 1 ? '' : 's'} marcada{confirmandoRevision.en_revision === 1 ? '' : 's'} para revisión.</li>}{confirmandoRevision.validacion_incompleta && <li>La validación contable no pudo completarse.</li>}</ul><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void guardar('revisado', true)} className="btn-primary px-3 py-1.5 text-xs">Marcar como revisado de todos modos</button><button type="button" onClick={() => setConfirmandoRevision(null)} className="btn-soft px-3 py-1.5 text-xs">Seguir revisando</button></div></div>}
      {aviso && <div className="mt-3"><AvisoReextraccion aviso={aviso} onClose={() => setLista((prev) => ({ ...prev, aviso: null }))} /></div>}
      {sugerenciasPendientes > 0 && transactions.length > 0 && sugerenciasCerradas !== documentKey && <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5 text-xs text-violet-800"><span className="flex items-center gap-1.5"><Sparkles size={13} />La IA detectó {sugerenciasPendientes} campo{sugerenciasPendientes === 1 ? '' : 's'} que no está{sugerenciasPendientes === 1 ? '' : 'n'} en la tabla. Revisa las sugerencias y decide si agregarlos.</span><span className="flex gap-2"><button type="button" onClick={() => setAbrirMenuCampo((valor) => valor + 1)} className="btn-soft px-3 py-1.5 text-xs"><Plus size={13} />Ver sugerencias</button><button type="button" aria-label="Cerrar aviso de sugerencias" onClick={() => setSugerenciasCerradas(documentKey)} className="px-1 text-violet-500 hover:text-violet-800"><X size={14} /></button></span></div>}
      {avisoGuardado?.tipo === 'exito' && <div className="mt-3"><Notice text={avisoGuardado.mensaje} onClose={() => setResultadoGuardado(null)} /></div>}
      {avisoGuardado && avisoGuardado.tipo !== 'exito' && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{avisoGuardado.mensaje}{avisoGuardado.tipo === 'conflicto' && ' Tus cambios se conservan como borrador local en este navegador.'}</span><span className="flex gap-2">{avisoGuardado.tipo === 'conflicto' && <button type="button" onClick={recargarGuardado} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Cargar la versión guardada</button>}<button type="button" onClick={() => setResultadoGuardado(null)} aria-label="Cerrar error"><X size={16} /></button></span></div>}
    </section>
    <div className="grid min-h-0 gap-4 2xl:h-[calc(100vh-226px)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section className="h-[75vh] min-h-[520px] min-w-0 overflow-hidden rounded-2xl 2xl:h-full"><DocumentViewer messageId={messageId} attachmentId={attachmentId} filename={filename} page={page} setPage={setPage} verificacion={{
        estado: estadoTexto,
        onTexto: textoRecibido,
        marcas: marcasTexto ?? (verificando ? verificacion!.marcas : []),
        disponible: estadoTexto === 'listo',
        visible: verificacionVisible,
        onAlternar: () => { setVerificacionVisible((valor) => !valor); setDestino(null); setFilaPorAgregar(null) },
        resaltado,
        onClicMarca: clicMarca,
        panel: <PanelVerificacion estado={estadoTexto} visible={verificacionVisible} resultado={verificacion} destino={destino ? nombreDestino(destino) : null} onCancelarDestino={() => setDestino(null)} mensaje={mensajeCaptura} onCerrarMensaje={() => setMensajeCaptura(null)} filaPorAgregar={filaPorAgregar === null ? null : datosDocumento?.filas[filaPorAgregar] ?? null} onAgregar={agregarDesdeDocumento} onCancelarAgregar={() => { setFilaPorAgregar(null); setResaltado(null) }} />,
      }} /></section>
      <section className="panel flex min-h-[520px] min-w-0 flex-col overflow-hidden 2xl:min-h-0">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5"><div><div className="text-sm font-bold text-ink">Movimientos</div><div className="mt-0.5 text-[11px] text-slate-400">{versionGuardada ? `Guardado ${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(versionGuardada.actualizado))}` : mode === 'gemini' ? 'Resultado del backend Gemini' : 'Captura manual'}</div></div><button type="button" onClick={agregarTransaccion} disabled={!cargaLista} className="btn-soft px-2.5 py-1.5 text-xs"><Plus size={14} />Agregar</button></div>
        {cargando && <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-slate-400"><RefreshCw size={15} className="animate-spin" />Cargando la extracción guardada…</div>}
        {cargaLista && !versionGuardada && transactions.length === 0 && !extracting && !colaActiva && cola?.estado !== 'error' && <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">Este documento no tiene una extracción guardada. {mode === 'gemini' ? <>Pulsa <strong>Extraer con Gemini</strong> para obtenerla.</> : <>Captura los movimientos con <strong>Agregar</strong> o cambia al modo Gemini para extraerlos.</>}</div>}
        {!cargando && <div className="min-h-0 flex-1 overflow-auto scrollbar-thin"><TablaTransacciones transacciones={transactions} columnas={{
          campos: documento.campos_extra,
          onCambiar: cambiarExtra,
          onCambiarValorDocumento: cambiarValorDocumento,
          onEnfocarDocumento: enfocarValorDocumento,
          destinoDocumento: destino?.tipo === 'documento' ? destino.campoId : null,
          onCambiarAlcance: cambiarTipoCampo,
          onRenombrar: renombrarColumna,
          onEliminar: eliminarColumna,
          onLlenar: (id) => void llenarConIa(id),
          llenando: llenandoCampos.documentKey === documentKey ? llenandoCampos.campos : [],
          motivoNoLlenar: geminiStatus?.enabled !== true ? 'Gemini no está conectado o habilitado.' : null,
          avisos: deEsteDocumento ? lista.avisosCampos : {},
          onCerrarAviso: cerrarAvisoCampo,
          menu: <MenuCampo campos={documento.campos_extra} sugerencias={documento.sugerencias_campos} huboExtraccionIa={huboExtraccion} onAplicar={elegirSugerencia} onAgregar={agregarCampo} solicitudAbrir={abrirMenuCampo} />,
        }} alertas={alertas} onCambiar={cambiarCampo} onEliminar={eliminarTransaccion} onMover={moverMovimiento} sinRespaldo={sinRespaldo} resaltado={resaltado} destino={verificando && destino?.tipo === 'movimiento' ? destino : null} onEnfocar={enfocarCeldaMovimiento} /></div>}
        <div className="shrink-0 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-400"><div className="flex flex-wrap items-center gap-1.5"><CircleHelp size={13} />{`${transactions.length} movimiento${transactions.length === 1 ? '' : 's'}.`}{dudososCount > 0 && <span className="font-semibold text-amber-700">{dudososCount} importe{dudososCount === 1 ? '' : 's'} dudoso{dudososCount === 1 ? '' : 's'}: revísalo{dudososCount === 1 ? '' : 's'} contra el documento.</span>}</div></div>
      </section>
    </div>
    {barraPestanas}
    <PanelValidacion validacion={validacion} transacciones={transactions} conResumen={documento.resumen !== null} />
    <PanelEnvioSaveData key={documentKey ?? 'sin-documento'} messageId={messageId} partId={partId} guardado={versionGuardada} sinGuardar={sinGuardar} modificadoTrasEnvio={modificadoTrasEnvio} onActualizado={alActualizarEnvio} />
    <ResumenEditable filename={filename} modelo={documento.modelo} resumen={documento.resumen} movimientos={transactions.length} warnings={deEsteDocumento ? lista.warnings : []} habilitado={cargaLista} destino={verificando && destino?.tipo === 'resumen' ? destino.campo : null} onCambiar={cambiarResumen} onEnfocar={enfocarCampoResumen} />
  </div>
}

function AvisoReextraccion({ aviso, onClose }: { aviso: AvisoCombinacion; onClose: () => void }) {
  const tono = aviso.noAparecen > 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return <div role="status" className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tono}`}><div className="flex items-start gap-2"><CheckCircle2 size={17} className="mt-0.5 shrink-0" /><div><div className="font-semibold">Extracción combinada con tus correcciones.</div><div className="mt-0.5 text-xs">Se conservaron {aviso.conservadas} corrección{aviso.conservadas === 1 ? '' : 'es'}. {aviso.noAparecen} fila{aviso.noAparecen === 1 ? '' : 's'} quedaron marcadas como «no aparece en extracción».</div>{aviso.campos.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{aviso.campos.map((texto) => <li key={texto}>{texto}</li>)}</ul>}</div></div><button type="button" onClick={onClose} aria-label="Cerrar aviso"><X size={16} /></button></div>
}

const etiquetaCampoInvalido = { cargo: 'Cargo dudoso o inválido.', abono: 'Abono dudoso o inválido.', saldo: 'Saldo dudoso o inválido.', cargo_y_abono: 'Tiene cargo y abono a la vez.' } as const

function alertasPorFila(validacion: ValidacionContable): Record<string, string[]> {
  const alertas: Record<string, string[]> = {}
  const agregar = (id: string, texto: string) => { alertas[id] = [...(alertas[id] ?? []), texto] }
  validacion.filas_discontinuas.forEach((fila) => agregar(fila.id, `Saldo esperado ${fila.saldo_esperado}, reportado ${fila.saldo_reportado} (diferencia ${fila.diferencia}).`))
  validacion.importes_invalidos.forEach((importe) => agregar(importe.id, etiquetaCampoInvalido[importe.campo]))
  return alertas
}

const estiloComprobacion = { ok: { etiqueta: 'Cuadra', clase: 'bg-emerald-50 text-emerald-700' }, diferencia: { etiqueta: 'Diferencia', clase: 'bg-red-50 text-red-700' }, no_verificable: { etiqueta: 'Sin verificar', clase: 'bg-slate-100 text-slate-600' } } as const
const tituloComprobacion = { total_cargos: 'Total de cargos', total_abonos: 'Total de abonos', saldo_final: 'Saldo inicial + abonos − cargos = saldo final', continuidad: 'Continuidad de saldos por fila' } as const

function PanelValidacion({ validacion, transacciones, conResumen }: { validacion: ValidacionContable; transacciones: Transaccion[]; conResumen: boolean }) {
  if (transacciones.length === 0 && !conResumen) return null
  const numero = (id: string) => transacciones.findIndex((transaccion) => transaccion.id === id) + 1
  const general = validacion.cuadra === true ? { texto: 'Cuadra', clase: 'border-emerald-200 bg-emerald-50 text-emerald-800' } : validacion.cuadra === false ? { texto: 'No cuadra', clase: 'border-red-200 bg-red-50 text-red-800' } : { texto: 'Sin verificar', clase: 'border-slate-200 bg-slate-50 text-slate-700' }
  return <section className="panel overflow-hidden" aria-labelledby="titulo-validacion"><div className="flex flex-col justify-between gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:p-6"><div><div className="eyebrow mb-2">Validación contable · tolerancia {validacion.tolerancia}</div><h2 id="titulo-validacion" className="font-display text-xl font-extrabold tracking-tight text-ink">¿Cuadra la lista revisada?</h2><p className="mt-1.5 text-sm text-slate-500">Se recalcula al editar. {conResumen ? 'Compara los movimientos contra el resumen extraído del documento.' : 'Sin resumen del documento: solo se verifica la continuidad de saldos.'}</p></div><span className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${general.clase}`}>{general.texto}</span></div><div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.8fr)]"><div><dl className="mb-4 grid grid-cols-2 gap-3"><div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Suma de cargos</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-ink">{validacion.suma_cargos ?? '—'}</dd></div><div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Suma de abonos</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-ink">{validacion.suma_abonos ?? '—'}</dd></div></dl><ul className="space-y-2">{validacion.comprobaciones.map((item) => <li key={item.id} className="rounded-lg border border-slate-100 p-3"><div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-ink">{tituloComprobacion[item.id]}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${estiloComprobacion[item.estado].clase}`}>{estiloComprobacion[item.estado].etiqueta}</span></div>{(item.esperado !== null || item.calculado !== null) && <div className="mt-1 text-[11px] tabular-nums text-slate-500">Documento: {item.esperado ?? '—'} · Calculado: {item.calculado ?? '—'}{item.diferencia !== null && ` · Diferencia: ${item.diferencia}`}</div>}{item.mensaje && item.estado !== 'ok' && <div className="mt-1 text-[11px] text-slate-500">{item.mensaje}</div>}</li>)}</ul></div><div className="space-y-3 text-xs">{validacion.filas_discontinuas.length > 0 && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800"><div className="font-bold">Continuidad rota</div><ul className="mt-1.5 space-y-1">{validacion.filas_discontinuas.map((fila) => <li key={fila.id} className="tabular-nums">Fila {numero(fila.id)}: esperado {fila.saldo_esperado}, reportado {fila.saldo_reportado} (diferencia {fila.diferencia})</li>)}</ul></div>}{validacion.importes_invalidos.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900"><div className="font-bold">Importes que impiden sumar</div><ul className="mt-1.5 space-y-1">{validacion.importes_invalidos.map((importe) => <li key={`${importe.id}-${importe.campo}`}>Fila {numero(importe.id)}: {etiquetaCampoInvalido[importe.campo]}</li>)}</ul></div>}{validacion.filas_excluidas.length > 0 && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-600">{validacion.filas_excluidas.length} fila{validacion.filas_excluidas.length === 1 ? '' : 's'} de saldo (inicial, anterior o final) excluida{validacion.filas_excluidas.length === 1 ? '' : 's'} de las sumas: fila{validacion.filas_excluidas.length === 1 ? '' : 's'} {validacion.filas_excluidas.map(numero).join(', ')}.</div>}{validacion.filas_discontinuas.length === 0 && validacion.importes_invalidos.length === 0 && validacion.filas_excluidas.length === 0 && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-500">Sin observaciones por fila.</div>}</div></div></section>
}

const CAMPOS_MONTO_DEL_RESUMEN: string[] = ['saldo_inicial', 'total_cargos', 'total_abonos', 'saldo_final']

/** Resumen del estado de cuenta, editable en ambos modos. Sin origen por campo: el tipo Resumen no lo tiene. */
function ResumenEditable({ filename, modelo, resumen, movimientos, warnings, habilitado, destino, onCambiar, onEnfocar }: { filename: string; modelo: string | null; resumen: Resumen | null; movimientos: number; warnings: string[]; habilitado: boolean; destino: CampoResumenEditable | null; onCambiar: (campo: CampoResumenEditable, valor: string) => void; onEnfocar: (campo: CampoResumenEditable) => void }) {
  const valores = resumen ?? resumenVacio()
  return <section className="panel overflow-hidden" aria-labelledby="titulo-resumen"><div className="border-b border-slate-200 bg-violet-50/50 p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div className="eyebrow mb-2 text-violet-700">Resumen del estado de cuenta</div><h2 id="titulo-resumen" className="font-display text-xl font-extrabold tracking-tight text-ink">Datos documentales</h2><p className="mt-1.5 text-sm text-slate-500">{modelo ? `Gemini · ${modelo}` : 'Captura manual'} · {movimientos} movimientos</p></div><span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-violet-700">{filename}</span></div></div><div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.7fr)]"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{camposResumen.map((campo) => { const monto = CAMPOS_MONTO_DEL_RESUMEN.includes(campo); const dudoso = monto && valores.dudosos.includes(campo as CampoMontoResumen); return <label key={campo} className={`rounded-lg border p-3 ${destino === campo ? 'border-blue-300 ring-2 ring-blue-400' : dudoso ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50/60'}`}><span className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">{etiquetaResumen[campo]}{dudoso && <span className="text-amber-700">Dudoso</span>}</span><input aria-label={`${etiquetaResumen[campo]} del resumen`} value={valores[campo]} disabled={!habilitado} placeholder="No identificado" inputMode={monto ? 'decimal' : undefined} onFocus={() => onEnfocar(campo)} onChange={(event) => onCambiar(campo, event.target.value)} className={`mt-1 w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold outline-none placeholder:font-normal placeholder:text-slate-300 hover:border-slate-200 focus:border-coral focus:bg-white ${dudoso ? 'text-amber-900' : 'text-ink'} ${monto ? 'tabular-nums' : ''}`} /></label> })}</div><div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-600"><div className="text-[10px] font-bold uppercase tracking-wider">Advertencias de la extracción</div>{warnings.length > 0 ? <ul className="mt-2 space-y-1 text-xs">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <div className="mt-2 text-xs">Sin advertencias.</div>}</div></div></section>
}

const etiquetaResultadoEnvio: Record<IntentoEnvio['resultado'], { texto: string; clase: string }> = {
  exito: { texto: 'Éxito', clase: 'bg-emerald-50 text-emerald-700' },
  error: { texto: 'Error', clase: 'bg-red-50 text-red-700' },
  incierto: { texto: 'Resultado incierto', clase: 'bg-amber-100 text-amber-800' },
  en_curso: { texto: 'Interrumpido / desconocido', clase: 'bg-amber-100 text-amber-800' },
}
const fechaHora = (valor: string | null) => (valor ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(valor)) : '—')

/** Envío del documento revisado a SaveData. La vista previa y el envío los construye el backend. */
function PanelEnvioSaveData({ messageId, partId, guardado, sinGuardar, modificadoTrasEnvio, onActualizado }: { messageId: string; partId: string | null; guardado: VersionGuardada | null; sinGuardar: boolean; modificadoTrasEnvio: boolean; onActualizado: (extraccion: ExtraccionGuardada) => void }) {
  const [sucursal, setSucursal] = useState('')
  const [articulo, setArticulo] = useState('')
  const [cargaInicial, setCargaInicial] = useState(false)
  const [config, setConfig] = useState<ConfigSaveData | null>(null)
  const [vista, setVista] = useState<VistaPreviaEnvio | null>(null)
  const [errorVista, setErrorVista] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [confirmandoReenvio, setConfirmandoReenvio] = useState(false)
  const [resultado, setResultado] = useState<{ tipo: 'exito' | 'error' | 'incierto'; mensaje: string; intento?: IntentoEnvio } | null>(null)
  const vivo = useRef(true)
  useEffect(() => { vivo.current = true; return () => { vivo.current = false } }, [])

  useEffect(() => {
    void savedataApi.config().then((valor) => {
      if (!vivo.current) return
      setConfig(valor)
      if (valor.sucursal_predeterminada !== null) setSucursal((actual) => actual || String(valor.sucursal_predeterminada))
    }).catch(() => undefined)
  }, [])

  const sucursalNumero = /^\d{1,9}$/.test(sucursal.trim()) && Number(sucursal) > 0 ? Number(sucursal) : null
  const articuloLimpio = articulo.trim()
  const datosCompletos = sucursalNumero !== null && articuloLimpio.length > 0 && articuloLimpio.length <= 50
  const version = guardado?.version ?? null
  const estado = guardado?.estado ?? null

  // Vista previa del cuerpo exacto, generada por el backend (~0.4 s después del último cambio).
  useEffect(() => {
    setVista(null)
    setErrorVista(null)
    if (!partId || version === null || !datosCompletos) return
    const controller = new AbortController()
    const temporizador = window.setTimeout(() => {
      void savedataApi.vistaPrevia(messageId, partId, { sucursal: sucursalNumero!, articulo: articuloLimpio, carga_inicial: cargaInicial }, controller.signal)
        .then((valor) => { if (!controller.signal.aborted) setVista(valor) })
        .catch((error: unknown) => { if (!controller.signal.aborted) setErrorVista(error instanceof Error ? error.message : 'No se pudo generar la vista previa.') })
    }, 400)
    return () => { window.clearTimeout(temporizador); controller.abort() }
  }, [messageId, partId, version, estado, sucursalNumero, articuloLimpio, cargaInicial, datosCompletos])

  const motivosLocales = [
    !partId && 'El documento no tiene un identificador estable; ábrelo de nuevo desde Correos.',
    !guardado && 'Guarda la extracción antes de enviarla.',
    sinGuardar && 'Hay cambios sin guardar: guárdalos y marca el documento como revisado antes de enviar.',
    guardado && guardado.estado === 'borrador' && 'Solo se pueden enviar extracciones revisadas: marca el documento como revisado.',
    sucursalNumero === null && 'Indica una sucursal numérica.',
    !articuloLimpio && 'Captura el artículo (obligatorio).',
  ].filter((motivo): motivo is string => Boolean(motivo))
  const motivos = [...motivosLocales, ...(vista?.motivos ?? []).filter((motivo) => !motivo.startsWith('Solo se pueden enviar'))]
  const puedeEnviar = motivos.length === 0 && vista !== null && vista.version === version && !enviando

  const enviar = async (confirmarReenvio: boolean) => {
    if (!partId || version === null || sucursalNumero === null) return
    setConfirmandoReenvio(false)
    setEnviando(true)
    setResultado(null)
    const respuesta = await ejecutarEnvio(() => savedataApi.enviar(messageId, partId, { version_base: version, sucursal: sucursalNumero, articulo: articuloLimpio, carga_inicial: cargaInicial, confirmar_reenvio: confirmarReenvio }))
    if (!vivo.current) return
    setEnviando(false)
    if (respuesta.extraccion) onActualizado(respuesta.extraccion)
    if (respuesta.ok) setResultado({ tipo: 'exito', mensaje: respuesta.mensaje, intento: respuesta.intento })
    else if (respuesta.tipo === 'requiere_confirmar_reenvio') setConfirmandoReenvio(true)
    else setResultado({ tipo: respuesta.tipo === 'incierto' ? 'incierto' : 'error', mensaje: respuesta.mensaje, intento: respuesta.intento })
  }
  const solicitarEnvio = () => {
    if (vista?.requiere_confirmar_reenvio) setConfirmandoReenvio(true)
    else void enviar(false)
  }

  const envios = [...(guardado?.envios ?? [])].reverse()
  const previo = vista?.envio_previo ?? envios.find((intento) => intento.resultado !== 'error') ?? null

  return <section className="panel overflow-hidden" aria-labelledby="titulo-envio-savedata">
    <div className="flex flex-col justify-between gap-3 border-b border-slate-200 bg-slate-50/60 p-5 sm:flex-row sm:items-start sm:p-6">
      <div><div className="eyebrow mb-2">Integración empresarial</div><h2 id="titulo-envio-savedata" className="font-display text-xl font-extrabold tracking-tight text-ink">Envío a SaveData</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Se envía nuestra extracción revisada: archivo, resumen, transacciones (sin filas vacías) y totales validados por el backend. El navegador nunca contacta SaveData directamente.</p></div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">{guardado?.estado === 'enviado' && <span className="rounded-full bg-violet-50 px-3 py-1.5 text-xs font-bold text-violet-700">Enviado · {fechaHora(guardado.enviado_en)}</span>}{modificadoTrasEnvio && <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-bold text-amber-800">Modificado después del último envío</span>}{config && !config.url_configurada && <span className="rounded-full bg-red-50 px-3 py-1.5 text-xs font-bold text-red-700">SAVEDATA_URL sin configurar</span>}</div>
    </div>
    <div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[minmax(0,.9fr)_minmax(360px,1.1fr)]">
      <div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Sucursal</span><input type="text" inputMode="numeric" value={sucursal} onChange={(event) => setSucursal(event.target.value)} className="input" placeholder={config?.sucursal_predeterminada ? String(config.sucursal_predeterminada) : 'Ej. 3102'} aria-invalid={sucursal !== '' && sucursalNumero === null} /><span className="mt-1 block text-[10px] text-slate-400">Predeterminada en Configuración: {config?.sucursal_predeterminada ?? 'sin definir'}</span></label>
          <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Artículo (obligatorio)</span><input type="text" value={articulo} maxLength={50} onChange={(event) => setArticulo(event.target.value)} className="input" placeholder="Ej. 10000453" aria-required="true" /></label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={cargaInicial} onChange={(event) => setCargaInicial(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-coral focus:ring-coral" />CargaInicial</label>
        {vista && <dl className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">H · Total de abonos</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-ink">{vista.totales.abonos}</dd></div><div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">S · Total de cargos</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-ink">{vista.totales.cargos}</dd></div></dl>}
        {motivos.length > 0 && <ul className="mt-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">{motivos.map((motivo) => <li key={motivo}>{motivo}</li>)}</ul>}
        {errorVista && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">{errorVista}</div>}
        {confirmandoReenvio && <div role="alertdialog" aria-labelledby="confirmar-reenvio" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-900"><div id="confirmar-reenvio" className="font-bold">Este documento ya se envió a SaveData.</div><div className="mt-1 leading-5">{previo ? <>Último intento: {etiquetaResultadoEnvio[previo.resultado].texto.toLowerCase()} el {fechaHora(previo.terminado_en ?? previo.iniciado_en)} (sucursal {previo.sucursal}, artículo {previo.articulo}).</> : 'Hay un envío previo registrado.'} {previo && previo.resultado !== 'exito' && 'No se sabe si SaveData lo recibió: verifícalo antes de reenviar para no duplicar los saldos.'} Reenviarlo puede duplicar los registros.</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void enviar(true)} className="btn-primary px-3 py-1.5 text-xs"><Send size={13} />Reenviar de todos modos</button><button type="button" onClick={() => setConfirmandoReenvio(false)} className="btn-soft px-3 py-1.5 text-xs">Cancelar</button></div></div>}
        {resultado?.tipo === 'exito' && <div role="status" className="mt-4"><Notice text={`${resultado.mensaje} (HTTP ${resultado.intento?.http_status ?? 200}).`} onClose={() => setResultado(null)} /></div>}
        {resultado && resultado.tipo !== 'exito' && <div role="alert" className={`mt-4 rounded-xl border px-4 py-3 text-sm ${resultado.tipo === 'incierto' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-700'}`}><div className="flex items-start justify-between gap-3"><div><div className="font-semibold">{resultado.tipo === 'incierto' ? 'Resultado incierto: no se sabe si SaveData recibió el envío.' : 'El envío no se completó.'}</div><div className="mt-0.5 text-xs">{resultado.mensaje}{resultado.intento?.http_status ? ` · HTTP ${resultado.intento.http_status}` : ''}</div>{resultado.intento?.respuesta && <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 text-[10px]">{resultado.intento.respuesta}</pre>}</div><button type="button" onClick={() => setResultado(null)} aria-label="Cerrar resultado"><X size={16} /></button></div></div>}
        <button type="button" onClick={solicitarEnvio} disabled={!puedeEnviar} className="btn-primary mt-4 w-full justify-center"><Send size={15} />{enviando ? 'Enviando a SaveData…' : vista?.requiere_confirmar_reenvio ? 'Reenviar a SaveData' : 'Enviar a SaveData'}</button>
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold text-ink">Vista previa del cuerpo exacto</h3><Code2 size={17} className="text-slate-400" /></div>
        <pre aria-label="Cuerpo exacto que se enviará a SaveData" className="scrollbar-thin min-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-ink p-4 text-[11px] leading-5 text-slate-200">{vista ? vista.cuerpo : datosCompletos ? (errorVista ? '—' : 'Generando vista previa…') : 'Completa sucursal y artículo para ver el cuerpo que se enviará.'}</pre>
        {vista && <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer font-semibold">Ver el JSON interno con formato (solo lectura)</summary><pre className="scrollbar-thin mt-2 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-700">{JSON.stringify(vista.interno, null, 2)}</pre></details>}
        <div className="mt-5"><h3 className="mb-2 text-sm font-bold text-ink">Historial de envíos</h3>{envios.length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">Este documento aún no se ha enviado.</div> : <ul className="space-y-2">{envios.map((intento) => <li key={intento.id} className="rounded-lg border border-slate-100 p-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-slate-700">{fechaHora(intento.terminado_en ?? intento.iniciado_en)}{intento.reenvio && ' · reenvío'}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${etiquetaResultadoEnvio[intento.resultado].clase}`}>{etiquetaResultadoEnvio[intento.resultado].texto}</span></div><div className="mt-1 text-slate-500">Sucursal {intento.sucursal} · Artículo {intento.articulo} · H {intento.totales.abonos} · S {intento.totales.cargos}{intento.http_status ? ` · HTTP ${intento.http_status}` : ''}</div>{intento.error && <div className="mt-1 text-red-700">{intento.error}</div>}<details className="mt-1"><summary className="cursor-pointer text-slate-400">Cuerpo enviado y respuesta</summary><pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-[10px]">{intento.cuerpo}</pre>{intento.respuesta && <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-[10px]">{intento.respuesta}</pre>}</details></li>)}</ul>}</div>
      </div>
    </div>
  </section>
}

const columnasTabla: { campo: CampoEditable; etiqueta: string; monto: boolean; ancho: string }[] = [
  { campo: 'fecha', etiqueta: 'Fecha', monto: false, ancho: 'w-[92px]' },
  { campo: 'concepto', etiqueta: 'Concepto', monto: false, ancho: '' },
  { campo: 'referencia', etiqueta: 'Referencia', monto: false, ancho: 'w-[96px]' },
  { campo: 'cargo', etiqueta: 'Cargo', monto: true, ancho: 'w-[96px]' },
  { campo: 'abono', etiqueta: 'Abono', monto: true, ancho: 'w-[96px]' },
  { campo: 'saldo', etiqueta: 'Saldo', monto: true, ancho: 'w-[104px]' },
]
const tonoOrigen: Record<Transaccion['origen'], string> = { ia: 'bg-violet-50 text-violet-700', ia_editada: 'bg-blue-50 text-blue-700', manual: 'bg-slate-100 text-slate-600' }

const etiquetaRevision: Record<NonNullable<Transaccion['revision']>, string> = { no_aparece_en_extraccion: 'No aparece en extracción', fila_de_saldo_con_importe: 'Fila de saldo: no se suma' }

function NumeroMovimiento({ numero, total, onMover }: { numero: number; total: number; onMover: (numero: number) => void }) {
  const [texto, setTexto] = useState(String(numero))
  useEffect(() => { setTexto(String(numero)) }, [numero])
  const aplicar = () => {
    const valor = Number(texto.trim())
    if (!/^\d+$/.test(texto.trim()) || valor < 1) { setTexto(String(numero)); return }
    if (valor !== numero) onMover(Math.min(valor, total))
    else setTexto(String(numero))
  }
  return <input aria-label={`Número del movimiento ${numero}`} title={`Movimiento ${numero} de ${total}. Escribe otro número para moverlo a esa posición.`} value={texto} inputMode="numeric"
    onChange={(event) => setTexto(event.target.value.replace(/\D/g, ''))} onBlur={aplicar}
    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); aplicar(); (event.target as HTMLInputElement).blur() } else if (event.key === 'Escape') { setTexto(String(numero)); (event.target as HTMLInputElement).blur() } }}
    className="w-full rounded-md border border-transparent bg-transparent px-1 py-1.5 text-center text-xs font-bold tabular-nums text-slate-500 outline-none transition hover:border-slate-200 focus:border-coral focus:bg-white focus:text-ink focus:ring-2 focus:ring-coral/10" />
}

type ColumnasTabla = {
  campos: CampoExtra[]
  onCambiar: (id: string, campoId: string, valor: string) => void
  /** Valor de un campo del documento (se guarda una sola vez). */
  onCambiarValorDocumento: (id: string, valor: string) => void
  /** Al enfocar un dato del documento: se puede copiar a él cualquier texto del documento. */
  onEnfocarDocumento: (id: string) => void
  /** Dato del documento que recibirá el texto pulsado en el documento. */
  destinoDocumento: string | null
  onRenombrar: (id: string, nombre: string) => void
  onEliminar: (id: string) => void
  /** "Llenar con IA" de una columna manual. */
  onLlenar: (id: string) => void
  llenando: string[]
  /** Por qué no se puede llenar con IA ahora (null si se puede). */
  motivoNoLlenar: string | null
  avisos: Record<string, AvisoCampo>
  onCerrarAviso: (id: string) => void
  /** Corrige el tipo del campo: una vez para todos ↔ en cada movimiento. */
  onCambiarAlcance: (id: string, alcance: AlcanceCampo) => void
  menu: React.ReactNode
}

function TablaTransacciones({ transacciones, columnas, alertas, onCambiar, onEliminar, onMover, sinRespaldo, resaltado, destino, onEnfocar }: { transacciones: Transaccion[]; columnas: ColumnasTabla; alertas: Record<string, string[]>; onCambiar: (id: string, campo: CampoEditable, valor: string) => void; onEliminar: (id: string) => void; onMover: (id: string, numero: number) => void; sinRespaldo: Set<string>; resaltado: Resaltado | null; destino: { id: string; campo: CampoEditable } | null; onEnfocar: (id: string, campo: CampoEditable) => void }) {
  const tabla = useRef<HTMLDivElement>(null)
  const filaResaltada = resaltado?.transaccionId ?? null
  // Desde el documento: lleva la lista al movimiento del recuadro pulsado.
  useEffect(() => {
    if (!filaResaltada || resaltado?.origen !== "documento") return
    const fila = [...(tabla.current?.querySelectorAll<HTMLElement>("[data-movimiento]") ?? [])].find((elemento) => elemento.dataset.movimiento === filaResaltada)
    fila?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [filaResaltada, resaltado?.origen])
  const delDocumento = columnas.campos.filter(esDelDocumento)
  const porMovimiento = columnas.campos.filter((campo) => !esDelDocumento(campo))
  const encabezado = (campo: CampoExtra) => <EncabezadoCampo campo={campo} campos={columnas.campos} onRenombrar={columnas.onRenombrar} onEliminar={columnas.onEliminar} onLlenar={() => columnas.onLlenar(campo.id)} llenando={columnas.llenando.includes(campo.id)} motivoNoLlenar={columnas.motivoNoLlenar} aviso={columnas.avisos[campo.id] ?? null} onCerrarAviso={() => columnas.onCerrarAviso(campo.id)} onCambiarAlcance={(alcance) => columnas.onCambiarAlcance(campo.id, alcance)} puedeSerDelDocumento={puedeSerDelDocumento(transacciones, campo)} />
  const claseEntrada = (resaltada: boolean, extra = '') => `w-full rounded-md border px-2 py-1.5 text-xs text-ink outline-none transition focus:border-coral focus:bg-white focus:ring-2 focus:ring-coral/10 ${resaltada ? 'border-violet-100 bg-violet-50 text-violet-900' : 'border-transparent bg-slate-50/70 hover:border-slate-200'} ${extra}`
  return <div ref={tabla} className="text-xs">
    <table aria-label="Movimientos del estado de cuenta" style={{ width: 112 + transacciones.length * 188 }} className="table-fixed border-collapse text-xs">
        <colgroup><col className="w-28" />{transacciones.map((transaccion) => <col key={transaccion.id} className="w-[188px]" />)}</colgroup>
        <thead><tr>
          <th scope="col" className="sticky left-0 top-0 z-20 border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-left align-top text-[10px] font-bold uppercase tracking-wider text-slate-400"><div title="Número del movimiento. Escribe otro número para moverlo.">#</div><div className="mt-1 normal-case tracking-normal">{columnas.menu}</div></th>
          {transacciones.map((transaccion, index) => {
            const activa = filaResaltada === transaccion.id
            return <th key={transaccion.id} scope="col" data-movimiento={transaccion.id} data-activo={activa || undefined} aria-label={`Movimiento ${index + 1}`} className={`sticky top-0 z-10 border-b border-r border-slate-200 px-1.5 py-1.5 text-left align-top font-normal ${activa ? 'bg-blue-50' : alertas[transaccion.id] ? 'bg-red-50' : transaccion.revision ? 'bg-amber-50' : 'bg-slate-50'}`}>
              <div className="flex items-center gap-1"><div className="w-10"><NumeroMovimiento numero={index + 1} total={transacciones.length} onMover={(numero) => onMover(transaccion.id, numero)} /></div><span className="flex-1" /><button type="button" onClick={() => onEliminar(transaccion.id)} className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Eliminar movimiento ${index + 1}`}><Trash2 size={13} /></button></div>
              <div className="mt-0.5 flex flex-wrap gap-1"><span className={`inline-flex whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${tonoOrigen[transaccion.origen]}`}>{etiquetaOrigen(transaccion.origen)}</span>{transaccion.revision && <span className="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">{etiquetaRevision[transaccion.revision]}</span>}{sinRespaldo.has(transaccion.id) && <span title="La verificación visual no encontró este movimiento en el texto del documento." className="inline-flex rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold text-rose-700">No aparece en el documento</span>}{alertas[transaccion.id] && <span title={alertas[transaccion.id].join(' ')} className="inline-flex cursor-help rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700">{alertas[transaccion.id].length} alerta{alertas[transaccion.id].length === 1 ? '' : 's'}</span>}</div>
            </th>
          })}
        </tr></thead>
        <tbody>
          {transacciones.length > 0 && columnasTabla.map((columna) => <tr key={columna.campo} className="border-b border-slate-100 align-top">
            <th scope="row" className="sticky left-0 z-[5] border-r border-slate-200 bg-white px-2 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400">{columna.etiqueta}</th>
            {transacciones.map((transaccion, index) => {
              const dudoso = columna.monto && transaccion.dudosos.includes(columna.campo as CampoMonto)
              const esDestino = destino?.id === transaccion.id && destino.campo === columna.campo
              const clases = `w-full rounded-md border px-1.5 py-1.5 text-xs text-ink outline-none transition focus:border-coral focus:bg-white focus:ring-2 focus:ring-coral/10 ${esDestino ? 'ring-2 ring-blue-400' : ''} ${columna.monto ? 'text-right tabular-nums' : ''} ${dudoso ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-transparent bg-transparent hover:border-slate-200'}`
              const comunes = { 'aria-label': `${columna.etiqueta} del movimiento ${index + 1}`, value: transaccion[columna.campo], onFocus: () => onEnfocar(transaccion.id, columna.campo), title: dudoso ? 'Importe dudoso: no se pudo interpretar sin adivinar. Revísalo contra el documento.' : transaccion[columna.campo] || undefined }
              return <td key={transaccion.id} className={`border-r border-slate-100 px-1 py-1 ${filaResaltada === transaccion.id ? 'bg-blue-50/70' : ''}`}>{columna.campo === 'concepto'
                ? <textarea {...comunes} rows={1} style={{ fieldSizing: 'content' } as React.CSSProperties} onChange={(event) => onCambiar(transaccion.id, columna.campo, event.target.value)} className={`${clases} block min-h-[30px] resize-none overflow-hidden leading-snug`} />
                : <input {...comunes} inputMode={columna.monto ? 'decimal' : undefined} onChange={(event) => onCambiar(transaccion.id, columna.campo, event.target.value)} className={clases} />}</td>
            })}
          </tr>)}
          {transacciones.length > 0 && porMovimiento.map((campo) => <tr key={campo.id} className="border-b border-slate-100 align-top">
            <th scope="row" data-campo={campo.id} className="sticky left-0 z-[5] border-r border-slate-200 bg-white px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">{encabezado(campo)}</th>
            {transacciones.map((transaccion, index) => {
              const valor = transaccion.extras?.[campo.id] ?? ''
              const deIa = esCeldaDeIa(transaccion, campo.id)
              return <td key={transaccion.id} className={`relative border-r border-slate-100 px-1 py-1 ${filaResaltada === transaccion.id ? 'bg-blue-50/70' : ''}`}><input aria-label={`${campo.nombre} del movimiento ${index + 1}`} data-ia={deIa || undefined} value={valor} title={deIa ? `Llenado por la IA: ${valor}` : valor || undefined} maxLength={500} onChange={(event) => columnas.onCambiar(transaccion.id, campo.id, event.target.value)} className={`w-full rounded-md border px-1.5 py-1.5 text-xs text-ink outline-none transition focus:border-coral focus:bg-white focus:ring-2 focus:ring-coral/10 ${deIa ? 'border-violet-100 bg-violet-50 pr-5 text-violet-900' : 'border-transparent bg-transparent hover:border-slate-200'}`} />{deIa && <Sparkles size={10} aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-violet-400" />}</td>
            })}
          </tr>)}
          {delDocumento.map((campo) => <tr key={campo.id} className="border-b border-slate-100 align-top">
            <th scope="row" data-campo={campo.id} className="sticky left-0 z-[5] border-r border-slate-200 bg-white px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">{encabezado(campo)}</th>
            {/* Dato que aparece una sola vez en el estado de cuenta: una sola casilla para todos los movimientos. */}
            <td colSpan={Math.max(1, transacciones.length)} className="px-1 py-1"><div className="sticky left-[7.25rem] w-[min(100%,22rem)]" title="Aparece una sola vez en el estado de cuenta: vale para todos los movimientos."><div className="relative"><input aria-label={`${campo.nombre} del documento`} data-ia={campo.valor_ia || undefined} value={campo.valor ?? ''} title={campo.valor_ia ? `Llenado por la IA: ${campo.valor}` : campo.valor || undefined} maxLength={500} placeholder="Sin capturar" onFocus={() => columnas.onEnfocarDocumento(campo.id)} onChange={(event) => columnas.onCambiarValorDocumento(campo.id, event.target.value)} className={claseEntrada(Boolean(campo.valor_ia), `bg-white ${campo.valor_ia ? 'pr-6' : ''} ${columnas.destinoDocumento === campo.id ? 'ring-2 ring-blue-400' : ''}`)} />{campo.valor_ia && <Sparkles size={10} aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-violet-400" />}</div></div></td>
          </tr>)}
        </tbody>
      </table>
    {transacciones.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">Sin movimientos. Usa <strong>Agregar</strong> para capturar uno.</div>}
  </div>
}

/** Encabezado de una columna adicional: nombre, renombrar y eliminar (con confirmación, porque borra sus valores). */
function EncabezadoCampo({ campo, campos, onRenombrar, onEliminar, onLlenar, llenando, motivoNoLlenar, aviso, onCerrarAviso, onCambiarAlcance = () => undefined, puedeSerDelDocumento = true }: { campo: CampoExtra; campos: CampoExtra[]; onRenombrar: (id: string, nombre: string) => void; onEliminar: (id: string) => void; onLlenar: () => void; llenando: boolean; motivoNoLlenar: string | null; aviso: AvisoCampo | null; onCerrarAviso: () => void; onCambiarAlcance?: (alcance: AlcanceCampo) => void; puedeSerDelDocumento?: boolean }) {
  const [modo, setModo] = useState<'normal' | 'renombrar' | 'confirmar'>('normal')
  const [nombre, setNombre] = useState(campo.nombre)
  const error = modo === 'renombrar' ? errorNombreCampo(nombre, campos, campo.id) : null
  const confirmar = () => {
    if (error) return
    onRenombrar(campo.id, nombre)
    setModo('normal')
  }
  if (modo === 'renombrar') return <div className="normal-case tracking-normal">
    <input autoFocus aria-label={`Nuevo nombre del campo ${campo.nombre}`} value={nombre} maxLength={60} onChange={(event) => setNombre(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') confirmar(); if (event.key === 'Escape') setModo('normal') }} className={`w-full rounded-md border bg-white px-1.5 py-1 text-[11px] font-semibold text-ink outline-none focus:ring-2 ${error ? 'border-red-300 focus:ring-red-100' : 'border-slate-300 focus:ring-coral/10'}`} />
    {error && <div role="alert" className="mt-0.5 text-[10px] font-normal text-red-600">{error}</div>}
    <div className="mt-1 flex gap-1"><button type="button" onClick={confirmar} disabled={Boolean(error)} aria-label="Guardar el nuevo nombre" className="rounded bg-ink px-1.5 py-0.5 text-[10px] font-bold text-white disabled:opacity-40">Guardar</button><button type="button" onClick={() => setModo('normal')} className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">Cancelar</button></div>
  </div>
  if (modo === 'confirmar') return <div role="alertdialog" aria-label={`Eliminar el campo ${campo.nombre}`} className="normal-case tracking-normal">
    <div className="text-[10px] font-semibold leading-tight text-red-700">¿Eliminar «{campo.nombre}» y sus valores?</div>
    <div className="mt-1 flex gap-1"><button type="button" onClick={() => onEliminar(campo.id)} className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">Eliminar</button><button type="button" onClick={() => setModo('normal')} className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-100">Cancelar</button></div>
  </div>
  const tonoAviso = aviso?.tipo === 'error' ? 'bg-red-50 text-red-700' : aviso?.tipo === 'exito' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
  return <div>
  <div className="flex items-center gap-1">
    <span className="min-w-0 flex-1 truncate" title={campo.origen === 'ia' ? `${campo.nombre} · sugerido por la IA` : campo.nombre}>{campo.origen === 'ia' && <Sparkles size={10} className="mr-1 inline text-violet-500" aria-hidden />}{campo.nombre}</span>
    {esBuscable(campo) && <button type="button" onClick={onLlenar} disabled={llenando || motivoNoLlenar !== null} aria-label={`Llenar con IA el campo ${campo.nombre}`} title={motivoNoLlenar ?? (llenando ? 'Buscando en el documento…' : esDelDocumento(campo) ? 'Llenar con IA: busca este dato en el documento y llena su único valor' : 'Llenar con IA: busca este dato en el documento y llena solo las celdas vacías')} className="rounded p-0.5 text-violet-500 hover:bg-violet-100 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40">{llenando ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}</button>}
    {esDelDocumento(campo)
      ? <button type="button" onClick={() => onCambiarAlcance('movimiento')} aria-label={`Cambiar ${campo.nombre} a un valor en cada movimiento`} title="Es un dato del documento (una vez para todos). Cambiar a un valor en cada movimiento: el valor se copia a cada movimiento." className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-ink"><ArrowRightLeft size={11} /></button>
      : <button type="button" onClick={() => onCambiarAlcance('documento')} disabled={!puedeSerDelDocumento} aria-label={`Cambiar ${campo.nombre} a dato del documento`} title={puedeSerDelDocumento ? 'Es un valor por movimiento. Cambiar a dato del documento (una vez para todos).' : 'Los movimientos tienen valores distintos: no puede ser un dato único del documento sin perder datos.'} className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"><ArrowRightLeft size={11} /></button>}
    <button type="button" onClick={() => { setNombre(campo.nombre); setModo('renombrar') }} aria-label={`Renombrar el campo ${campo.nombre}`} className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-ink"><Pencil size={11} /></button>
    <button type="button" onClick={() => setModo('confirmar')} aria-label={`Eliminar el campo ${campo.nombre}`} className="rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={11} /></button>
  </div>
  {aviso && <div role="status" className={`mt-1 flex items-start gap-1 rounded-md px-1.5 py-1 text-[10px] font-normal normal-case leading-tight tracking-normal ${tonoAviso}`}><span className="min-w-0 flex-1">{aviso.texto}</span><button type="button" onClick={onCerrarAviso} aria-label={`Cerrar el mensaje de ${campo.nombre}`} className="shrink-0 opacity-70 hover:opacity-100"><X size={10} /></button></div>}
  </div>
}

/** Botón "+ Campo": agrega una columna desde las sugerencias de la IA o con un nombre escrito a mano. */
function MenuCampo({ campos, sugerencias, huboExtraccionIa, onAplicar, onAgregar, solicitudAbrir = 0 }: { campos: CampoExtra[]; sugerencias: SugerenciaCampo[]; huboExtraccionIa: boolean; onAplicar: (sugerencia: SugerenciaCampo, tambienConfiguracion: boolean) => void; onAgregar: (nombre: string, alcance: AlcanceCampo, tambienConfiguracion: boolean) => void; solicitudAbrir?: number }) {
  const [abierto, setAbierto] = useState(false)
  const [tambienConfiguracion, setTambienConfiguracion] = useState(false)
  const [alcance, setAlcance] = useState<AlcanceCampo>('documento')
  const [posicion, setPosicion] = useState<{ top: number; right: number } | null>(null)
  const [nombre, setNombre] = useState('')
  const [intentado, setIntentado] = useState(false)
  const boton = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const disponibles = sugerenciasDisponibles(sugerencias, campos)
  const lleno = campos.length >= MAX_CAMPOS_EXTRA
  const error = errorNombreCampo(nombre, campos)
  const cerrar = () => { setAbierto(false); setNombre(''); setIntentado(false) }
  useEffect(() => {
    if (!abierto) return
    // El menú es fijo en pantalla: se cierra al hacer clic fuera, al desplazar la tabla o con Escape.
    const fuera = (event: Event) => {
      const objetivo = event.target as Node | null
      if (objetivo && (menu.current?.contains(objetivo) || boton.current?.contains(objetivo))) return
      cerrar()
    }
    const tecla = (event: KeyboardEvent) => { if (event.key === 'Escape') cerrar() }
    document.addEventListener('mousedown', fuera)
    document.addEventListener('scroll', fuera, true)
    document.addEventListener('keydown', tecla)
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('scroll', fuera, true); document.removeEventListener('keydown', tecla) }
  }, [abierto])
  const abrir = () => {
    const caja = boton.current?.getBoundingClientRect()
    setPosicion(caja ? { top: caja.bottom + 4, right: Math.max(8, window.innerWidth - caja.right) } : null)
    setAbierto(true)
  }
  const alternar = () => (abierto ? cerrar() : abrir())
  // El aviso de sugerencias pendientes pide abrir el menú: primero se lleva el botón a la vista (el menú se cierra al
  // desplazar, así que se abre cuando el desplazamiento ya terminó).
  useEffect(() => {
    if (solicitudAbrir === 0) return
    boton.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    const temporizador = window.setTimeout(abrir, 80)
    return () => window.clearTimeout(temporizador)
  }, [solicitudAbrir])
  const agregarManual = () => {
    setIntentado(true)
    if (error || lleno) return
    onAgregar(nombre, alcance, tambienConfiguracion)
    cerrar()
  }
  const vacio = sugerencias.length === 0 ? (huboExtraccionIa ? 'La IA no encontró campos adicionales en este documento.' : 'Extrae con Gemini para ver los campos que la IA encuentre en el documento.') : 'Ya agregaste todos los campos que sugirió la IA.'
  return <>
    <button ref={boton} type="button" onClick={alternar} aria-expanded={abierto} aria-haspopup="dialog" className="btn-soft whitespace-nowrap px-2 py-1 text-[11px]"><Plus size={12} />Campo</button>
    {abierto && <div ref={menu} role="dialog" aria-label="Agregar campo" style={posicion ?? undefined} className="fixed z-50 w-72 rounded-xl border border-slate-200 bg-white p-3 text-left text-xs font-normal normal-case tracking-normal text-slate-600 shadow-xl">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-violet-700"><Sparkles size={12} />Sugerencias de la IA</div>
      <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Campos que aparecen en el documento y no están capturados. La IA no inventa campos ni valores.</p>
      <label className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600"><input type="checkbox" checked={tambienConfiguracion} onChange={(event) => setTambienConfiguracion(event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-coral focus:ring-coral" />Agregar también a la configuración</label>
      {disponibles.length === 0 ? <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">{vacio}</div> : <ul className="scrollbar-thin mt-2 max-h-56 space-y-1 overflow-auto">{disponibles.map((sugerencia) => {
        const filas = filasConValor(sugerencia)
        const ejemplo = sugerencia.valores[0]?.valor ?? sugerencia.valor_documento ?? ''
        return <li key={sugerencia.clave}><button type="button" disabled={lleno} onClick={() => { onAplicar(sugerencia, tambienConfiguracion); cerrar() }} className="w-full rounded-lg border border-slate-100 px-2.5 py-2 text-left hover:border-violet-200 hover:bg-violet-50/60 disabled:opacity-50">
          <div className="flex items-center justify-between gap-2"><span className="truncate font-bold text-ink">{sugerencia.nombre}</span>{filas === null ? <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800">Valor único del documento</span> : <span className="shrink-0 text-[10px] text-slate-400">{filas} fila{filas === 1 ? '' : 's'} con dato</span>}</div>
          <div className="mt-0.5 truncate text-[10px] text-slate-500" title={ejemplo}>Ej.: {ejemplo}</div>
          {filas === null && <div className="mt-0.5 text-[10px] text-amber-700">Va una sola vez para todos los movimientos.</div>}
        </button></li>
      })}</ul>}
      <div className="mt-3 border-t border-slate-100 pt-2.5">
        <label htmlFor="nombre-campo-manual" className="flex items-center gap-1.5 text-[11px] font-bold text-ink"><UserRound size={12} />Manual</label>
        <div className="mt-1.5 flex gap-1.5"><input id="nombre-campo-manual" value={nombre} maxLength={60} placeholder="Nombre del campo" onChange={(event) => setNombre(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') agregarManual() }} className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs text-ink outline-none focus:border-coral focus:ring-2 focus:ring-coral/10" /><button type="button" onClick={agregarManual} className="btn-primary px-2.5 py-1.5 text-xs">Agregar</button></div>
        {intentado && (error || lleno) && <div role="alert" className="mt-1 text-[10px] text-red-600">{lleno ? `La tabla admite hasta ${MAX_CAMPOS_EXTRA} campos adicionales.` : error}</div>}
        <fieldset className="mt-2"><legend className="text-[10px] font-semibold text-slate-500">¿Dónde aparece este dato?</legend>
          <div className="mt-1 grid grid-cols-2 gap-1">{([['documento', 'Una vez para todos', 'Ej.: RFC, número de crédito'], ['movimiento', 'En cada movimiento', 'Ej.: sucursal, folio']] as const).map(([valor, titulo, ejemplo]) => <label key={valor} className={`cursor-pointer rounded-lg border px-2 py-1.5 ${alcance === valor ? 'border-coral bg-coral/5 text-ink' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}><input type="radio" name="alcance-campo" value={valor} checked={alcance === valor} onChange={() => setAlcance(valor)} className="sr-only" /><span className="block text-[11px] font-bold">{titulo}</span><span className="block text-[10px] text-slate-400">{ejemplo}</span></label>)}</div>
        </fieldset>
      </div>
    </div>}
  </>
}

function DocumentViewer({ messageId, attachmentId, filename, page, setPage, verificacion = null }: { messageId: string | null; attachmentId: string | null; filename: string; page: number; setPage: (page: number) => void; verificacion?: VerificacionVisor | null }) {
  if (messageId && attachmentId) return <GmailDocumentPreview messageId={messageId} attachmentId={attachmentId} filename={filename} page={page} setPage={setPage} verificacion={verificacion} />
  return <EmptyDocumentViewer />
}

function EmptyDocumentViewer() {
  return <div className="panel flex h-full min-h-[520px] items-center justify-center overflow-hidden"><div className="max-w-xs px-6 text-center"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileSearch size={24} /></div><div className="mt-4 text-sm font-bold text-ink">No hay documento seleccionado</div><div className="mt-1.5 text-xs leading-5 text-slate-400">Abre un PDF o imagen desde Correos y pulsa Extraer para visualizarlo aquí.</div></div></div>
}

function GmailDocumentPreview({ messageId, attachmentId, filename, page, setPage, verificacion }: { messageId: string; attachmentId: string; filename: string; page: number; setPage: (page: number) => void; verificacion: VerificacionVisor | null }) {
  const url = gmailApi.attachmentUrl(messageId, attachmentId)
  const isPdf = filename.toLowerCase().endsWith('.pdf')
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(filename)
  const previewMime = isPdf ? 'application/pdf' : isImage ? attachmentMime({ id: attachmentId, filename, mimeType: '', size: 0, partId: '' }) : 'application/octet-stream'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [datosPdf, setDatosPdf] = useState<Uint8Array | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    const controller = new AbortController()
    setPreviewUrl(null)
    setDatosPdf(null)
    setLoading(true)
    setError(null)
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar el documento (${response.status}).`)
      const buffer = await response.arrayBuffer()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: previewMime }))
      setPreviewUrl(objectUrl)
      if (isPdf) setDatosPdf(new Uint8Array(buffer))
    }).catch((requestError: unknown) => {
      if (controller.signal.aborted) return
      setError(requestError instanceof Error ? requestError.message : 'No se pudo visualizar el documento.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, previewMime, isPdf])
  // PDF con capa de texto: visor propio con la verificación. Escaneados, o si pdf.js no pudo abrirlo: visor del navegador.
  if (isPdf && datosPdf && verificacion && verificacion.estado !== 'sin_texto' && verificacion.estado !== 'error') {
    return <VisorPdf datos={datosPdf} filename={filename} urlExterna={previewUrl} pagina={page} onPagina={setPage} onTexto={verificacion.onTexto} marcas={verificacion.marcas} verificacionDisponible={verificacion.disponible} verificacionVisible={verificacion.visible} onAlternarVerificacion={verificacion.onAlternar} resaltado={verificacion.resaltado} onClicMarca={verificacion.onClicMarca} panel={verificacion.panel} />
  }
  return <div className="panel flex h-full flex-col overflow-hidden"><div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink"><FileText size={16} className="shrink-0 text-coral" /><span className="truncate">{filename}</span></div><a href={previewUrl ?? undefined} target="_blank" rel="noreferrer" className={`shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-bold text-blue-700 hover:bg-blue-100 ${previewUrl ? '' : 'pointer-events-none opacity-50'}`}>Abrir en otra pestaña</a></div>{previewUrl && verificacion?.panel}{previewUrl && verificacion?.estado === 'error' && <div role="note" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">No se pudo preparar la verificación visual de este PDF; se muestra con el visor del navegador.</div>}<div className={`flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-100/80 ${previewUrl && isPdf ? '' : 'p-5 sm:p-8'}`}>{loading && <div className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw size={16} className="animate-spin" />Cargando documento...</div>}{error && <div className="text-sm text-red-600">{error}</div>}{previewUrl && isPdf && <iframe src={`${previewUrl}#navpanes=0&view=FitH`} title={filename} className="h-full w-full bg-white" />}{previewUrl && isImage && <img src={previewUrl} alt={filename} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />}{!loading && !error && !isPdf && !isImage && <div className="text-center text-sm text-slate-500">Este formato no tiene visor integrado.</div>}</div></div>
}

function SettingsPageV3() {
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash-lite')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [savedata, setSavedata] = useState<ConfigSaveData | null>(null)
  const [sucursalPredeterminada, setSucursalPredeterminada] = useState('')
  useEffect(() => {
    void savedataApi.config().then((valor) => { setSavedata(valor); setSucursalPredeterminada(valor.sucursal_predeterminada === null ? '' : String(valor.sucursal_predeterminada)) }).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar la configuración de SaveData.'))
  }, [])
  const guardarSucursal = async () => {
    const texto = sucursalPredeterminada.trim()
    if (texto && !(/^\d{1,9}$/.test(texto) && Number(texto) > 0)) { setError('La sucursal predeterminada debe ser un número entero positivo.'); return }
    try { const valor = await savedataApi.guardarConfig(texto ? Number(texto) : null); setSavedata(valor); setNotice('Sucursal predeterminada guardada en el backend.'); setError(null) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo guardar la sucursal.') }
  }
  const loadSettings = async () => {
    try {
      const [nextGmail, nextGemini] = await Promise.all([inboxStore.loadStatus(), geminiApi.status()])
      setGmailStatus(nextGmail)
      setGeminiStatus(nextGemini)
      setModel(nextGemini.model)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar la configuración.') }
  }
  useEffect(() => { void loadSettings() }, [])
  const handleGmail = async () => {
    if (gmailStatus?.connected) { await gmailApi.disconnect(); inboxStore.clear(); await loadSettings() } else gmailApi.startAuth()
  }
  const saveGemini = async () => {
    if (!apiKey.trim() && !geminiStatus?.configured) { setError('Escribe una API key de Gemini para activar la integración.'); return }
    try { setGeminiStatus(await geminiApi.save(apiKey.trim(), model)); setApiKey(''); setNotice('Gemini quedó configurado y activado en FastAPI.'); setError(null) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo guardar Gemini.') }
  }
  const disableGemini = async () => {
    try { setGeminiStatus(await geminiApi.disable()); setNotice('Gemini quedó desactivado.'); setError(null) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo desactivar Gemini.') }
  }
  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Administra Gmail y Gemini desde Nexora sin editar el archivo .env."><span className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700"><ShieldCheck size={14} />Configuración en backend</span></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}{notice && <Notice text={notice} onClose={() => setNotice(null)} />}<div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>Las claves se guardan en FastAPI y nunca se muestran completas ni se almacenan en el navegador.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conexión real mediante OAuth 2.0." connected={Boolean(gmailStatus?.connected)} onToggle={() => void handleGmail()}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value={gmailStatus?.email ?? 'No conectada'} /><SettingField label="Estado" value={gmailStatus?.connected ? 'OAuth activo · Gmail API' : 'Esperando autorización'} /></div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="Guarda tu API key y activa la extracción desde esta pantalla." connected={Boolean(geminiStatus?.enabled)} onToggle={() => void (geminiStatus?.enabled ? disableGemini() : saveGemini())}><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">API key de Gemini</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="input" placeholder={geminiStatus?.maskedKey ?? 'Pega aquí tu API key'} autoComplete="new-password" /></label><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo</span><select value={model} onChange={(event) => setModel(event.target.value)} className="input"><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option><option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite · respaldo</option><option value="gemini-3.8-flash">Gemini 3.8 Flash · documentos complejos</option></select></label></div><div className="mt-4 flex flex-wrap items-center gap-2"><button onClick={() => void saveGemini()} className="btn-primary"><Check size={14} />Guardar y activar</button><button onClick={() => void disableGemini()} className="btn-soft" disabled={!geminiStatus?.configured}><X size={14} />Desactivar</button>{geminiStatus?.configured && <span className="text-xs text-slate-500">Key guardada: {geminiStatus.maskedKey}</span>}</div></IntegrationCard><section className="panel p-5 sm:p-6" aria-labelledby="titulo-config-savedata"><div className="mb-5 flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Send size={19} /></div><div><h3 id="titulo-config-savedata" className="font-display text-base font-bold text-ink">SaveData</h3><p className="mt-1 text-xs text-slate-500">Envío de extracciones revisadas. La URL se define en el backend con SAVEDATA_URL; el navegador nunca la llama directamente.</p></div></div><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Sucursal predeterminada</span><input type="text" inputMode="numeric" value={sucursalPredeterminada} onChange={(event) => setSucursalPredeterminada(event.target.value)} className="input" placeholder="Ej. 3102" /></label><SettingField label="URL de SaveData" value={savedata ? savedata.url ?? 'Sin configurar (SAVEDATA_URL)' : 'Consultando…'} /></div><div className="mt-4"><button type="button" onClick={() => void guardarSucursal()} className="btn-primary"><Check size={14} />Guardar sucursal</button></div></section>{gmailStatus?.connected && <TarjetaCamposConfigurados onNotice={(texto) => { setNotice(texto); setError(null) }} onError={setError} />}{gmailStatus?.connected && <TarjetaExtraccionAutomatica onNotice={(texto) => { setNotice(texto); setError(null) }} onError={setError} />}</div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={ShieldCheck} title="Privacidad" description="Key protegida en el servidor" /><SmallSetting icon={Sparkles} title="Modelo activo" description={geminiStatus?.model ?? model} /><SmallSetting icon={Code2} title="API FastAPI" description="Configuración persistente" /></div></>
}

/**
 * Configuración de campos: los campos que se capturan de cada estado de cuenta, definidos una vez por cuenta.
 * Paso 1: la IA sugiere campos a partir de un estado de cuenta de ejemplo (no se guarda). Paso 2: la lista final.
 */
export function TarjetaCamposConfigurados({ onNotice, onError }: { onNotice: (texto: string) => void; onError: (texto: string) => void }) {
  const [configurada, setConfigurada] = useState<boolean | null>(null)
  const [campos, setCampos] = useState<CampoPlantilla[]>([])
  const [guardados, setGuardados] = useState<string>('[]')
  const [archivo, setArchivo] = useState<File | null>(null)
  const [sugerencias, setSugerencias] = useState<SugerenciaPlantilla[] | null>(null)
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set())
  const [sugiriendo, setSugiriendo] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [nombre, setNombre] = useState('')
  const [alcance, setAlcance] = useState<AlcanceCampo>('documento')
  const [renombrando, setRenombrando] = useState<{ id: string; nombre: string } | null>(null)
  const mensaje = (requestError: unknown, defecto: string) => (requestError instanceof Error ? requestError.message : defecto)
  useEffect(() => {
    let vivo = true
    void plantillaCamposApi.obtener().then((plantilla) => {
      if (!vivo) return
      setConfigurada(plantilla.configurada)
      setCampos(plantilla.campos)
      setGuardados(plantilla.configurada ? JSON.stringify(plantilla.campos) : '')
    }).catch((requestError: unknown) => { if (vivo) onError(mensaje(requestError, 'No se pudo cargar la configuración de campos.')) })
    return () => { vivo = false }
  }, [])
  const sinGuardar = configurada !== null && JSON.stringify(campos) !== guardados
  const errorNombre = nombre.trim() ? errorNombrePlantilla(nombre, campos) : null
  const nuevas = sugerencias ? sugerenciasNuevas(sugerencias, campos) : []

  const sugerir = async () => {
    if (!archivo) return
    setSugiriendo(true)
    try {
      const lista = await plantillaCamposApi.sugerir(archivo)
      setSugerencias(lista)
      setMarcadas(new Set())
    } catch (requestError) { onError(mensaje(requestError, 'No se pudieron sugerir campos.')) } finally { setSugiriendo(false) }
  }
  const agregarMarcadas = () => {
    let lista = campos
    for (const sugerencia of nuevas.filter((item) => marcadas.has(item.clave))) lista = agregarAPlantilla(lista, { nombre: sugerencia.nombre, origen: 'ia', alcance: sugerencia.alcance, clave: sugerencia.clave })
    setCampos(lista)
    setMarcadas(new Set())
  }
  const agregarManual = () => {
    if (!nombre.trim() || errorNombre) return
    setCampos((lista) => agregarAPlantilla(lista, { nombre, origen: 'manual', alcance }))
    setNombre('')
  }
  const guardar = async () => {
    setGuardando(true)
    try {
      const plantilla = await plantillaCamposApi.guardar(campos)
      setConfigurada(true)
      setCampos(plantilla.campos)
      setGuardados(JSON.stringify(plantilla.campos))
      plantillaVigente.fijar(plantilla.campos)
      onNotice('Configuración de campos guardada. Se usará en la extracción automática, al extraer y en «Llenar con IA».')
    } catch (requestError) { onError(mensaje(requestError, 'No se pudo guardar la configuración de campos.')) } finally { setGuardando(false) }
  }
  const alternarMarcada = (clave: string) => setMarcadas((previas) => { const siguiente = new Set(previas); if (siguiente.has(clave)) siguiente.delete(clave); else siguiente.add(clave); return siguiente })

  return <section className="panel p-5 sm:p-6" aria-labelledby="titulo-config-campos">
    <div className="mb-5 flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-coral"><FileText size={19} /></div><div><h3 id="titulo-config-campos" className="font-display text-base font-bold text-ink">Campos que se capturan de cada estado de cuenta</h3><p className="mt-1 text-xs text-slate-500">Se definen una vez. Los usan la extracción automática, la extracción manual y «Llenar con IA». Un documento ya guardado conserva sus campos y recibe los nuevos vacíos.</p></div></div>
    {configurada === false && <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-[11px] text-blue-800">Lista precargada con los campos de tus extracciones guardadas. Revísala y pulsa «Guardar campos» para confirmarla.</p>}

    <div className="rounded-xl border border-slate-200 p-4">
      <div className="text-xs font-bold text-ink">Paso 1 · Sugerencias con IA</div>
      <p className="mt-1 text-[11px] text-slate-500">Sube un estado de cuenta de ejemplo (PDF o imagen). La IA sugiere los campos que encuentra; nunca inventa campos. El archivo no se guarda ni se envía a SaveData.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2"><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" aria-label="Estado de cuenta de ejemplo" onChange={(event) => { setArchivo(event.target.files?.[0] ?? null); setSugerencias(null) }} className="text-xs" /><button type="button" onClick={() => void sugerir()} disabled={!archivo || sugiriendo} className="btn-soft"><Sparkles size={14} className={sugiriendo ? 'animate-pulse' : ''} />{sugiriendo ? 'Leyendo el documento…' : 'Sugerir campos con IA'}</button></div>
      {sugerencias && (nuevas.length === 0 ? <p className="mt-3 text-[11px] text-slate-500">{sugerencias.length === 0 ? 'La IA no encontró campos adicionales en este documento.' : 'Todos los campos sugeridos ya están en la lista.'}</p> : <div className="mt-3">
        <ul className="space-y-1">{nuevas.map((sugerencia) => <li key={sugerencia.clave}><label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-100 px-2.5 py-2 text-xs hover:bg-slate-50"><input type="checkbox" checked={marcadas.has(sugerencia.clave)} onChange={() => alternarMarcada(sugerencia.clave)} aria-label={`Usar ${sugerencia.nombre}`} className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-coral focus:ring-coral" /><span className="min-w-0 flex-1"><span className="font-bold text-ink">{sugerencia.nombre}</span> <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">{etiquetaAlcance(sugerencia.alcance)}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500" title={sugerencia.ejemplo}>Ej.: {sugerencia.ejemplo}</span></span></label></li>)}</ul>
        <button type="button" onClick={agregarMarcadas} disabled={marcadas.size === 0} className="btn-primary mt-2"><Plus size={14} />Agregar seleccionados</button>
      </div>)}
    </div>

    <div className="mt-4 rounded-xl border border-slate-200 p-4">
      <div className="text-xs font-bold text-ink">Paso 2 · Lista final</div>
      <ul className="mt-3 space-y-1 text-xs" aria-label="Campos que se capturan">
        {CAMPOS_FIJOS.map((fijo) => <li key={fijo} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-slate-500"><span className="flex-1 font-semibold">{fijo}</span><span className="text-[10px]">Fijo · En cada movimiento</span></li>)}
        {campos.map((campo) => <li key={campo.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5">
          {renombrando?.id === campo.id
            ? <span className="flex flex-1 items-center gap-1"><input autoFocus aria-label={`Nuevo nombre de ${campo.nombre}`} value={renombrando.nombre} maxLength={60} onChange={(event) => setRenombrando({ id: campo.id, nombre: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && !errorNombrePlantilla(renombrando.nombre, campos, campo.id)) { setCampos((lista) => renombrarEnPlantilla(lista, campo.id, renombrando.nombre)); setRenombrando(null) } if (event.key === 'Escape') setRenombrando(null) }} className="input py-1 text-xs" /><button type="button" disabled={Boolean(errorNombrePlantilla(renombrando.nombre, campos, campo.id))} onClick={() => { setCampos((lista) => renombrarEnPlantilla(lista, campo.id, renombrando.nombre)); setRenombrando(null) }} className="btn-soft px-2 py-1 text-[11px]">Listo</button></span>
            : <span className="min-w-0 flex-1 truncate font-semibold text-ink">{campo.nombre}</span>}
          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${campo.origen === 'ia' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{campo.origen === 'ia' ? 'IA' : 'Manual'}</span>
          <select aria-label={`Tipo de ${campo.nombre}`} value={campo.alcance} onChange={(event) => setCampos((lista) => cambiarTipoEnPlantilla(lista, campo.id, event.target.value as AlcanceCampo))} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px]"><option value="documento">Una vez</option><option value="movimiento">En cada movimiento</option></select>
          <button type="button" onClick={() => setRenombrando({ id: campo.id, nombre: campo.nombre })} aria-label={`Renombrar ${campo.nombre}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-ink"><Pencil size={12} /></button>
          <button type="button" onClick={() => setCampos((lista) => quitarDePlantilla(lista, campo.id))} aria-label={`Quitar ${campo.nombre}`} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={12} /></button>
        </li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2"><input value={nombre} maxLength={60} onChange={(event) => setNombre(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') agregarManual() }} placeholder="Nombre del campo" aria-label="Nombre del campo nuevo" className="input max-w-[14rem] py-1.5 text-xs" /><select aria-label="Tipo del campo nuevo" value={alcance} onChange={(event) => setAlcance(event.target.value as AlcanceCampo)} className="rounded-md border border-slate-200 bg-white px-1.5 py-1.5 text-[11px]"><option value="documento">Una vez</option><option value="movimiento">En cada movimiento</option></select><button type="button" onClick={agregarManual} disabled={!nombre.trim() || Boolean(errorNombre)} className="btn-soft"><Plus size={14} />Agregar a mano</button></div>
      {errorNombre && <p role="alert" className="mt-1 text-[10px] text-red-600">{errorNombre}</p>}
    </div>
    <div className="mt-4 flex items-center gap-3"><button type="button" onClick={() => void guardar()} disabled={guardando || configurada === null || (!sinGuardar && configurada === true)} className="btn-primary"><Check size={14} />Guardar campos</button>{sinGuardar && configurada && <span className="text-[11px] font-semibold text-amber-700">Cambios sin guardar</span>}</div>
  </section>
}

/** Configuración de la extracción automática: interruptor (activar o pausar), "Revisar ahora" y los campos que se pedirán. */
export function TarjetaExtraccionAutomatica({ onNotice, onError }: { onNotice: (texto: string) => void; onError: (texto: string) => void }) {
  const [estado, setEstado] = useState<EstadoAutomatico | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const mensaje = (requestError: unknown, defecto: string) => (requestError instanceof Error ? requestError.message : defecto)
  useEffect(() => {
    let vivo = true
    void automaticoApi.estado().then((valor) => { if (vivo) setEstado(valor) }).catch((requestError: unknown) => { if (vivo) onError(mensaje(requestError, 'No se pudo consultar la extracción automática.')) })
    return () => { vivo = false }
  }, [])
  const alternar = async () => {
    if (!estado || ocupado) return
    setOcupado(true)
    try {
      const valor = await automaticoApi.configurar(!estado.activo)
      setEstado(valor)
      onNotice(valor.activo ? 'Extracción automática activada: solo se procesarán los correos que lleguen a partir de su activación.' : 'Extracción automática en pausa.')
    } catch (requestError) { onError(mensaje(requestError, 'No se pudo cambiar la extracción automática.')) } finally { setOcupado(false) }
  }
  const revisar = async () => {
    setOcupado(true)
    try { setEstado(await automaticoApi.revisarAhora()); onNotice('Revisión iniciada. Los estados de cuenta nuevos aparecerán en Correos ya extraídos.') } catch (requestError) { onError(mensaje(requestError, 'No se pudo iniciar la revisión.')) } finally { setOcupado(false) }
  }
  const activo = Boolean(estado?.activo)
  return <section className="panel p-5 sm:p-6" aria-labelledby="titulo-config-automatico"><div className="mb-5 flex items-start justify-between gap-4"><div className="flex gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Sparkles size={19} /></div><div><h3 id="titulo-config-automatico" className="font-display text-base font-bold text-ink">Extracción automática</h3><p className="mt-1 text-xs text-slate-500">Cada {estado?.intervalo_minutos ?? 20} minutos revisa Gmail y extrae los estados de cuenta nuevos como borrador. El envío a SaveData sigue siendo manual.</p></div></div><button type="button" role="switch" aria-checked={activo} aria-label="Extracción automática" onClick={() => void alternar()} disabled={!estado || ocupado} className="flex items-center gap-2 text-xs font-semibold text-slate-500"><span className={`relative h-5 w-9 rounded-full transition ${activo ? 'bg-emerald-500' : 'bg-slate-200'}`}><span className={`absolute top-1 h-3 w-3 rounded-full bg-white shadow transition ${activo ? 'left-5' : 'left-1'}`} /></span>{activo ? 'Activa' : 'En pausa'}</button></div><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Estado" value={textoIndicador(estado) ?? 'Consultando…'} /><SettingField label="Activa desde" value={estado?.activado_en ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(estado.activado_en)) : 'Nunca activada'} /></div>{estado?.ultimo_error && <p className="mt-3 text-[11px] text-red-700">Última revisión con problemas: {estado.ultimo_error}</p>}<p className="mt-4 text-xs text-slate-500">{textoCamposAutomaticos(estado?.campos ?? [])}</p><div className="mt-4"><button type="button" onClick={() => void revisar()} disabled={!activo || ocupado || Boolean(estado?.en_curso)} className="btn-primary"><RefreshCw size={14} className={estado?.en_curso ? 'animate-spin' : ''} />Revisar ahora</button></div></section>
}
function IntegrationCard({ icon: CardIcon, iconClass, title, description, connected, onToggle, children }: { icon: Icon; iconClass: string; title: string; description: string; connected: boolean; onToggle: () => void; children: React.ReactNode }) { return <section className="panel p-5 sm:p-6"><div className="mb-6 flex items-start justify-between gap-4"><div className="flex gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}><CardIcon size={19} /></div><div><h3 className="font-display text-base font-bold text-ink">{title}</h3><p className="mt-1 text-xs text-slate-500">{description}</p></div></div>{title === 'Gmail' ? <button onClick={onToggle} className={connected ? 'btn-soft' : 'btn-primary'}>{connected ? 'Desconectar Gmail' : 'Conectar Gmail'}</button> : <button onClick={onToggle} className="flex items-center gap-2 text-xs font-semibold text-slate-500"><span className={`relative h-5 w-9 rounded-full transition ${connected ? 'bg-emerald-500' : 'bg-slate-200'}`}><span className={`absolute top-1 h-3 w-3 rounded-full bg-white shadow transition ${connected ? 'left-5' : 'left-1'}`} /></span>{connected ? 'Conectado' : 'Desconectado'}</button>}</div>{children}</section> }
function SettingField({ label, value, placeholder = false }: { label: string; value: string; placeholder?: boolean }) { return <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">{label}</span><div className={`input flex items-center justify-between ${placeholder ? 'text-slate-400' : ''}`}>{value}{placeholder && <span className="text-[10px] text-slate-400">No guardar</span>}</div></label> }
function SmallSetting({ icon: SmallIcon, title, description }: { icon: Icon; title: string; description: string }) { return <div className="panel flex items-center gap-3 p-4"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><SmallIcon size={16} /></div><div><div className="text-xs font-bold text-ink">{title}</div><div className="mt-0.5 text-[11px] text-slate-400">{description}</div></div><ChevronRight size={15} className="ml-auto text-slate-300" /></div> }

function avatarTone(tone: string) { const tones: Record<string, string> = { blue: 'bg-blue-100 text-blue-700', purple: 'bg-violet-100 text-violet-700', coral: 'bg-orange-100 text-orange-700', amber: 'bg-amber-100 text-amber-700' }; return tones[tone] ?? tones.blue }

export default App
