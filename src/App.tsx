import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react'
import { Link, NavLink, Route, Routes, useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { CampoMonto, CampoMontoResumen, Resumen, Transaccion } from './types'
import { combinarExtraccion, contarCorrecciones, editarCampo, etiquetaOrigen, nuevaTransaccion, type CampoEditable } from './services/transacciones'
import { validarContabilidad, type ValidacionContable } from './services/contabilidad'
import { crearControladorExtraccion, ejecutarExtraccion } from './services/extraccion'
import { gmailApi, type FiltroCorreo, type GmailAttachment, type GmailMessage, type GmailStatus } from './services/gmailApi'
import { geminiApi, type GeminiExtractionResponse, type GeminiStatus } from './services/geminiApi'
import { ejecutarEnvio, savedataApi, type ConfigSaveData, type VistaPreviaEnvio } from './services/savedataApi'
import { claveEstado, inboxStore, type ClassificationOverride, type EstadosExtraccion, type Listado, type MailFolder } from './services/inboxStore'
import { erroresDeRemitentes, preferenciasApi, type ErrorRemitente } from './services/preferenciasApi'
import { agregarRemitente } from './services/remitentes'
import { extraccionesApi, type EstadoExtraccion, type ExtraccionGuardada, type IntentoEnvio, type ProblemasRevision } from './services/extraccionesApi'
import { borradoresLocales, claveBorrador, contarProblemas, documentoDesdeGuardado, documentoVacio, ejecutarGuardado, firmaContenido, hayCambios, type BorradorLocal, type DocumentoEditable } from './services/guardado'
import { classifyEmailPreliminarily, classifyMessagesWithCache, classificationLabel, detectStatementEmail, emailClassificationFingerprint, FINGERPRINT_LEGADO, type ClassificationCache, type EmailClassification, type PreliminaryClassificationResult } from './services/emailClassification'
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
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
  Filter,
  Gem,
  Globe2,
  Inbox,
  Landmark,
  Mail,
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

function StatCard({ icon: StatIcon, label, value, change, tone = 'blue' }: { icon: Icon; label: string; value: string; change: string; tone?: string }) {
  const toneClasses: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', coral: 'bg-orange-50 text-coral', green: 'bg-emerald-50 text-emerald-600', purple: 'bg-violet-50 text-violet-600' }
  return <div className="panel p-4 sm:p-5"><div className="flex items-start justify-between"><div className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneClasses[tone]}`}><StatIcon size={17} /></div><span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-600">{change}</span></div><div className="mt-4 text-2xl font-bold tracking-tight text-ink">{value}</div><div className="mt-1 text-xs text-slate-500">{label}</div></div>
}

type EmailFilter = 'all' | 'statements' | 'pending' | 'other'
type LocalClassificationOverride = ClassificationOverride

function FilteredGmailInboxPage() {
  const navigate = useNavigate()
  const [folder, setFolderState] = useState<MailFolder>(inboxStore.lastFolder)
  const [filtroCorreo, setFiltroCorreoState] = useState<FiltroCorreo>(inboxStore.lastFiltro)
  const [listado, setListado] = useState<Listado | null>(() => inboxStore.cachedListado(inboxStore.lastFolder(), inboxStore.lastFiltro()))
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [status, setStatus] = useState<GmailStatus | null>(inboxStore.cachedStatus)
  const [filter, setFilter] = useState<EmailFilter>('all')
  const [classificationCache, setClassificationCache] = useState<ClassificationCache>(inboxStore.classificationCache)
  // Clasificaciones manuales: viven en el backend, por cuenta de Gmail.
  const [clasificacionesManuales, setClasificacionesManuales] = useState<Record<string, LocalClassificationOverride>>(inboxStore.cachedClasificaciones)
  const [estadosExtraccion, setEstadosExtraccion] = useState<EstadosExtraccion>({})
  const [clasificacionesMigradas, setClasificacionesMigradas] = useState(0)
  const [loading, setLoading] = useState(() => listado === null)
  const [cargandoMas, setCargandoMas] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestRequest = useRef(0)
  const messages = listado?.messages ?? []

  const setFolder = (nextFolder: MailFolder) => {
    inboxStore.setLastFolder(nextFolder)
    setFolderState(nextFolder)
  }
  const setFiltroCorreo = (nextFiltro: FiltroCorreo) => {
    inboxStore.setLastFiltro(nextFiltro)
    setFiltroCorreoState(nextFiltro)
  }

  const aplicarListado = (nuevo: Listado) => {
    const nextCache = classifyMessagesWithCache(nuevo.messages, inboxStore.classificationCache())
    inboxStore.setClassificationCache(nextCache)
    setClassificationCache(nextCache)
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
        setClasificacionesManuales({})
        return
      }
      const [nuevo, estadoClasificaciones] = await Promise.all([inboxStore.loadListado(folder, filtroCorreo, { force }), inboxStore.loadClasificaciones({ force })])
      if (!isCurrent()) return
      aplicarListado(nuevo)
      setClasificacionesManuales(estadoClasificaciones.mapa)
      void inboxStore.loadEstados({ force }).then((mapa) => { if (isCurrent()) setEstadosExtraccion(mapa) }).catch(() => undefined)
      // Migración única de las clasificaciones que este navegador guardaba antes (la copia local se conserva).
      const cuenta = nextStatus.cuentaId ?? null
      if (cuenta && !estadoClasificaciones.migradoEn) {
        void inboxStore.migrarClasificaciones(cuenta, nuevo.messages, emailClassificationFingerprint)
          .then((resultado) => {
            if (!isCurrent()) return
            if (resultado.migradas > 0) setClasificacionesMigradas(resultado.migradas)
            setClasificacionesManuales(inboxStore.cachedClasificaciones())
          })
          .catch((migrationError: unknown) => { if (isCurrent()) setError(`No se pudieron migrar las clasificaciones de este navegador (la copia local se conserva): ${migrationError instanceof Error ? migrationError.message : 'error desconocido'}`) })
      }
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

  useEffect(() => { void loadEmails() }, [folder, filtroCorreo])

  // Clasificaciones migradas sin huella moderna: se adopta la huella actual del correo la primera vez que se ve.
  useEffect(() => {
    for (const message of messages) {
      const override = clasificacionesManuales[message.id]
      if (override?.fingerprint !== FINGERPRINT_LEGADO) continue
      void inboxStore.ponerClasificacion(message.id, { classification: override.classification, fingerprint: emailClassificationFingerprint(message) })
        .then(() => setClasificacionesManuales(inboxStore.cachedClasificaciones()))
        .catch(() => undefined)
    }
  }, [messages, clasificacionesManuales])

  const estadoAdjunto = (message: GmailMessage, attachment: GmailAttachment): EstadoDocumento => (attachment.partId && estadosExtraccion[claveEstado(message.id, attachment.partId)]?.estado) || 'sin_extraer'
  const estadoCorreo = (message: GmailMessage) => resumirEstados(message.attachments.filter(esAdjuntoDocumental).map((attachment) => estadoAdjunto(message, attachment)))

  const resultFor = (message: GmailMessage): PreliminaryClassificationResult => classificationCache[message.id] ?? classifyEmailPreliminarily(message)
  const overrideVigente = (message: GmailMessage) => {
    const override = clasificacionesManuales[message.id]
    return override && (override.fingerprint === resultFor(message).fingerprint || override.fingerprint === FINGERPRINT_LEGADO) ? override : null
  }
  const classificationFor = (message: GmailMessage) => overrideVigente(message)?.classification ?? resultFor(message).classification
  const filteredMessages = messages.filter((message) => matchesEmailFilter(classificationFor(message), filter))
  const visibleSelected = selected && filteredMessages.some((message) => message.id === selected.id) ? selected : filteredMessages[0] ?? null
  const unreadCount = messages.filter((message) => message.unread).length
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)
  const pendingCount = messages.filter((message) => classificationFor(message) === 'REQUIERE_REVISION').length
  const statementCount = messages.filter((message) => classificationFor(message) === 'ESTADO_DE_CUENTA').length
  const isManual = (message: GmailMessage) => overrideVigente(message) !== null
  const setClassification = (message: GmailMessage, valor: EmailClassification | 'AUTOMATICA') => {
    const previas = clasificacionesManuales
    const revertir = (requestError: unknown) => {
      setClasificacionesManuales(previas)
      setError(`No se guardó la clasificación: ${requestError instanceof Error ? requestError.message : 'error desconocido'}`)
    }
    if (valor === 'AUTOMATICA') {
      setClasificacionesManuales(Object.fromEntries(Object.entries(previas).filter(([id]) => id !== message.id)))
      void inboxStore.quitarClasificacion(message.id).catch(revertir)
      return
    }
    const override = { classification: valor, fingerprint: resultFor(message).fingerprint }
    setClasificacionesManuales({ ...previas, [message.id]: override })
    void inboxStore.ponerClasificacion(message.id, override).catch(revertir)
  }
  const conectado = Boolean(status?.connected)
  const sinRemitentes = filtroCorreo === 'remitentes' && listado?.sinRemitentes === true

  return (
    <>
      <PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Estados de cuenta de los remitentes configurados, sin modificar los mensajes ni las etiquetas de Gmail.">
        <button className="btn-primary" onClick={() => void loadEmails(true)} disabled={loading || !conectado}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button>
      </PageHeading>
      {error && <ErrorNotice text={error} onClose={() => setError(null)} />}
      {clasificacionesMigradas > 0 && <Notice text={`Se migraron ${clasificacionesMigradas} clasificación(es) manual(es) de este navegador al backend. La copia local se conserva como respaldo.`} onClose={() => setClasificacionesMigradas(0)} />}
      {status && !conectado && !error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail no está conectado. La conexión se administra únicamente desde Configuración.</span></div></div>}
      {conectado && <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="text-xs text-slate-500">{filtroCorreo === 'remitentes' ? (listado && !listado.sinRemitentes ? `Filtrado en Gmail: ${listado.remitentes} remitente${listado.remitentes === 1 ? '' : 's'} configurado${listado.remitentes === 1 ? '' : 's'}, solo correos con adjunto.` : 'Filtro por remitentes de estados de cuenta.') : 'Todos los correos de la carpeta, sin filtro de remitente.'}</div><div role="group" aria-label="Filtro de correos" className="flex shrink-0 rounded-lg bg-slate-100 p-1">{([['remitentes', 'Estados de cuenta'], ['todos', 'Todos los correos (sin filtro)']] as const).map(([valor, etiqueta]) => <button key={valor} type="button" aria-pressed={filtroCorreo === valor} onClick={() => setFiltroCorreo(valor)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[11px] font-bold transition ${filtroCorreo === valor ? valor === 'todos' ? 'bg-amber-100 text-amber-900 shadow-sm' : 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'}`}>{etiqueta}</button>)}</div></div>}
      {conectado && filtroCorreo === 'todos' && <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><strong>Vista sin filtro.</strong> Incluye correos que no vienen de remitentes configurados. Solo los de remitentes configurados con PDF se consideran estados de cuenta automáticamente.</div>}
      {conectado && sinRemitentes && <div className="mb-4 flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 sm:flex-row sm:items-center sm:justify-between"><span>No hay remitentes de estados de cuenta configurados, así que no se muestra ningún correo como estado de cuenta.</span><span className="flex shrink-0 flex-wrap gap-2"><Link to="/settings" className="btn-primary px-3 py-2 text-xs">Configurar remitentes</Link><button type="button" onClick={() => setFiltroCorreo('todos')} className="btn-soft px-3 py-2 text-xs">Ver todos los correos (sin filtro)</button></span></div>}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Inbox} label="Mensajes por revisar" value={`${unreadCount}`} change={conectado ? 'Cuenta real' : 'Sin conectar'} tone="blue" />
        <StatCard icon={Paperclip} label="Adjuntos recibidos" value={`${attachmentCount}`} change="Cargados" tone="coral" />
        <StatCard icon={FileCheck2} label="Estados de cuenta" value={`${statementCount}`} change="Remitente + PDF" tone="green" />
        <StatCard icon={CircleHelp} label="Pendientes de verificar" value={`${pendingCount}`} change="Revisión manual" tone="purple" />
      </div>
      <div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(390px,1.1fr)]">
        <GmailFoldersReadOnly folder={folder} setFolder={setFolder} status={status} />
        <EmailMessageList messages={messages} filteredMessages={filteredMessages} selected={visibleSelected} loading={loading} folder={folder} filter={filter} onFilterChange={setFilter} classificationFor={classificationFor} isManual={isManual} estadoCorreo={estadoCorreo} onSelect={setSelected} puedeCargarMas={Boolean(listado?.nextPageToken)} cargandoMas={cargandoMas} onCargarMas={() => void cargarMas()} descartados={listado?.descartados ?? 0} />
        {visibleSelected ? <ClassifiedGmailMessageDetail mail={visibleSelected} classification={classificationFor(visibleSelected)} detection={resultFor(visibleSelected)} manual={isManual(visibleSelected)} estadoAdjunto={(attachment) => estadoAdjunto(visibleSelected, attachment)} onClassificationChange={(classification) => setClassification(visibleSelected, classification)} onExtract={(attachment, mode) => navigate(`/extraction?message=${encodeURIComponent(visibleSelected.id)}&attachment=${encodeURIComponent(attachment.id)}&part=${encodeURIComponent(attachment.partId)}&filename=${encodeURIComponent(attachment.filename)}${mode === 'gemini' ? '&mode=gemini' : ''}`)} /> : <EmptyMailDetail />}
      </div>
    </>
  )
}

/** Remitentes de estados de cuenta de la cuenta conectada (se guardan en el backend). */
function TarjetaRemitentes({ conectado }: { conectado: boolean }) {
  const [lista, setLista] = useState<string[]>([])
  const [guardada, setGuardada] = useState<string[] | null>(null)
  const [entrada, setEntrada] = useState('')
  const [errorEntrada, setErrorEntrada] = useState<string | null>(null)
  const [errores, setErrores] = useState<ErrorRemitente[]>([])
  const [mensaje, setMensaje] = useState<{ tipo: 'exito' | 'error'; texto: string } | null>(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!conectado) return
    void inboxStore.loadStatus().then(() => inboxStore.loadRemitentes({ force: true }))
      .then((config) => { setLista(config.remitentes); setGuardada(config.remitentes) })
      .catch((requestError: unknown) => setMensaje({ tipo: 'error', texto: requestError instanceof Error ? requestError.message : 'No se pudieron cargar los remitentes.' }))
  }, [conectado])

  const agregar = () => {
    const resultado = agregarRemitente(lista, entrada)
    if (!resultado.ok) { setErrorEntrada(resultado.motivo); return }
    setLista(resultado.lista)
    setEntrada('')
    setErrorEntrada(null)
  }
  const hayCambiosRemitentes = guardada !== null && JSON.stringify(lista) !== JSON.stringify(guardada)
  const guardar = async () => {
    setGuardando(true)
    setErrores([])
    setMensaje(null)
    try {
      const config = await preferenciasApi.guardarRemitentes(lista)
      inboxStore.setRemitentes(config)
      setLista(config.remitentes)
      setGuardada(config.remitentes)
      setMensaje({ tipo: 'exito', texto: 'Remitentes guardados. La bandeja usará el nuevo filtro.' })
    } catch (requestError) {
      setErrores(erroresDeRemitentes(requestError))
      setMensaje({ tipo: 'error', texto: requestError instanceof Error ? requestError.message : 'No se pudieron guardar los remitentes.' })
    } finally {
      setGuardando(false)
    }
  }

  return <section className="panel p-5 sm:p-6" aria-labelledby="titulo-remitentes">
    <div className="mb-5 flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Mail size={19} /></div><div><h3 id="titulo-remitentes" className="font-display text-base font-bold text-ink">Remitentes de estados de cuenta</h3><p className="mt-1 text-xs leading-5 text-slate-500">La bandeja busca en Gmail solo correos con adjunto de estos remitentes. Escribe un correo completo (<code>estados@banco.com</code>) o un dominio (<code>@banco.com</code>, incluye subdominios como <code>notificaciones.banco.com</code>). Se compara solo la dirección, nunca el nombre visible, y sin distinguir mayúsculas.</p></div></div>
    {!conectado ? <div className="text-xs text-slate-500">Conecta Gmail para configurar los remitentes de esta cuenta.</div> : <>
      <div className="flex flex-col gap-2 sm:flex-row"><label className="flex-1"><span className="sr-only">Nuevo remitente</span><input type="text" value={entrada} onChange={(event) => { setEntrada(event.target.value); setErrorEntrada(null) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); agregar() } }} className="input" placeholder="estados@banco.com o @banco.com" aria-invalid={Boolean(errorEntrada)} aria-describedby={errorEntrada ? 'error-remitente' : undefined} /></label><button type="button" onClick={agregar} disabled={!entrada.trim()} className="btn-soft"><Plus size={14} />Agregar</button></div>
      {errorEntrada && <div id="error-remitente" role="alert" className="mt-2 text-xs text-red-700">{errorEntrada}</div>}
      <ul className="mt-4 space-y-2">{lista.map((remitente) => <li key={remitente} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><span className="min-w-0 truncate font-mono text-xs text-ink">{remitente}</span><span className="flex shrink-0 items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{remitente.startsWith('@') ? 'Dominio' : 'Correo'}</span><button type="button" onClick={() => setLista(lista.filter((item) => item !== remitente))} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Quitar ${remitente}`}><Trash2 size={14} /></button></span></li>)}{guardada !== null && lista.length === 0 && <li className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400">Sin remitentes: la bandeja no mostrará correos como estados de cuenta hasta que agregues al menos uno.</li>}</ul>
      {errores.length > 0 && <ul role="alert" className="mt-3 space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">{errores.map((item) => <li key={`${item.valor}-${item.motivo}`}><strong>{item.valor || 'Lista'}</strong>: {item.motivo}</li>)}</ul>}
      {mensaje && <div role={mensaje.tipo === 'error' ? 'alert' : 'status'} className={`mt-3 rounded-lg px-3 py-2.5 text-xs ${mensaje.tipo === 'exito' ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-red-200 bg-red-50 text-red-700'}`}>{mensaje.texto}</div>}
      <div className="mt-4 flex items-center gap-3"><button type="button" onClick={() => void guardar()} disabled={!hayCambiosRemitentes || guardando} className="btn-primary"><Check size={14} />{guardando ? 'Guardando…' : 'Guardar remitentes'}</button>{hayCambiosRemitentes && <span className="text-xs font-semibold text-amber-700">Cambios sin guardar</span>}</div>
      <p className="mt-3 text-[11px] leading-5 text-slate-400">Pendiente de mejora: el encabezado From puede falsificarse y todavía no se verifican SPF/DKIM.</p>
    </>}
  </section>
}

function matchesEmailFilter(classification: EmailClassification, filter: EmailFilter) {
  return filter === 'all' || (filter === 'statements' && classification === 'ESTADO_DE_CUENTA') || (filter === 'pending' && classification === 'REQUIERE_REVISION') || (filter === 'other' && classification === 'NO_ES_ESTADO_DE_CUENTA')
}

function EmailMessageList({ messages, filteredMessages, selected, loading, folder, filter, onFilterChange, classificationFor, isManual, estadoCorreo, onSelect, puedeCargarMas, cargandoMas, onCargarMas, descartados }: { messages: GmailMessage[]; filteredMessages: GmailMessage[]; selected: GmailMessage | null; loading: boolean; folder: MailFolder; filter: EmailFilter; onFilterChange: (filter: EmailFilter) => void; classificationFor: (message: GmailMessage) => EmailClassification; isManual: (message: GmailMessage) => boolean; estadoCorreo: (message: GmailMessage) => ResumenEstados | null; onSelect: (message: GmailMessage) => void; puedeCargarMas: boolean; cargandoMas: boolean; onCargarMas: () => void; descartados: number }) {
  const filters: { value: EmailFilter; label: string }[] = [{ value: 'all', label: 'Todos' }, { value: 'statements', label: 'Estados de cuenta' }, { value: 'pending', label: 'Pendientes' }, { value: 'other', label: 'Otros' }]
  return <div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="border-b border-slate-200 px-4 py-4"><div className="flex items-center justify-between gap-3"><div><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${filteredMessages.length} de ${messages.length} mensajes cargados${puedeCargarMas ? ' · hay más' : ''}`}</div></div><Filter size={16} className="text-slate-400" /></div><div className="mt-3 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">{filters.map((item) => <button key={item.value} type="button" onClick={() => onFilterChange(item.value)} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-bold transition ${filter === item.value ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'}`}>{item.label}</button>)}</div></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && filteredMessages.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">No hay correos en este filtro.</div>}{!loading && filteredMessages.map((mail) => { const detection = detectStatementEmail(mail); const classification = classificationFor(mail); return <button key={mail.id} onClick={() => onSelect(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject || '(Sin asunto)'}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div><div className="mt-2 flex flex-wrap items-center gap-1.5"><ClassificationBadge classification={classification} manual={isManual(mail)} /><EstadoCorreoBadge resumen={estadoCorreo(mail)} />{detection.hasDocumentAttachment && <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-500">Adjunto documental</span>}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button> })}{!loading && puedeCargarMas && <button type="button" onClick={onCargarMas} disabled={cargandoMas} className="btn-soft mt-2 w-full justify-center text-xs"><RefreshCw size={13} className={cargandoMas ? 'animate-spin' : ''} />{cargandoMas ? 'Cargando…' : 'Cargar más'}</button>}{!loading && descartados > 0 && <div className="mt-2 px-2 text-center text-[10px] text-slate-400">{descartados} correo{descartados === 1 ? '' : 's'} de Gmail descartado{descartados === 1 ? '' : 's'}: la dirección del remitente no coincide exactamente.</div>}</div></div>
}

type EstadoDocumento = EstadoExtraccion | 'sin_extraer'
type ResumenEstados = { estado: EstadoDocumento; revisados: number; total: number }
const estiloEstadoDocumento: Record<EstadoDocumento, { etiqueta: string; clase: string }> = {
  sin_extraer: { etiqueta: 'Sin extraer', clase: 'bg-slate-100 text-slate-500' },
  borrador: { etiqueta: 'Borrador', clase: 'bg-blue-50 text-blue-700' },
  revisado: { etiqueta: 'Revisado', clase: 'bg-emerald-50 text-emerald-700' },
  enviado: { etiqueta: 'Enviado', clase: 'bg-violet-50 text-violet-700' },
}
const esAdjuntoDocumental = (attachment: GmailAttachment) => attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/')

/** Estado de un correo a partir de sus documentos: borrador si alguno lo es; revisado solo si todos lo están. */
function resumirEstados(estados: EstadoDocumento[]): ResumenEstados | null {
  if (estados.length === 0) return null
  const revisados = estados.filter((estado) => estado === 'revisado' || estado === 'enviado').length
  const estado: EstadoDocumento = estados.includes('borrador') ? 'borrador' : revisados === estados.length ? (estados.every((e) => e === 'enviado') ? 'enviado' : 'revisado') : revisados > 0 ? 'borrador' : 'sin_extraer'
  return { estado, revisados, total: estados.length }
}

function EstadoDocumentoBadge({ estado }: { estado: EstadoDocumento }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-[9px] font-bold ${estiloEstadoDocumento[estado].clase}`}>{estiloEstadoDocumento[estado].etiqueta}</span>
}

function EstadoCorreoBadge({ resumen }: { resumen: ResumenEstados | null }) {
  if (!resumen) return null
  const parcial = resumen.total > 1 && resumen.revisados > 0 && resumen.revisados < resumen.total
  return <span title="Estado de la extracción de los documentos de este correo" className={`inline-flex rounded-full px-2 py-1 text-[9px] font-bold ${estiloEstadoDocumento[resumen.estado].clase}`}>{estiloEstadoDocumento[resumen.estado].etiqueta}{parcial && ` · ${resumen.revisados}/${resumen.total} revisados`}</span>
}

function ClassificationBadge({ classification, manual = false }: { classification: EmailClassification; manual?: boolean }) {
  const tone: Record<EmailClassification, string> = { ESTADO_DE_CUENTA: 'bg-emerald-50 text-emerald-700', NO_ES_ESTADO_DE_CUENTA: 'bg-slate-100 text-slate-600', REQUIERE_REVISION: 'bg-amber-50 text-amber-700' }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold ${tone[classification]}`}><span className={`h-1.5 w-1.5 rounded-full ${classification === 'ESTADO_DE_CUENTA' ? 'bg-emerald-500' : classification === 'REQUIERE_REVISION' ? 'bg-amber-500' : 'bg-slate-400'}`} />{classificationLabel(classification)}{manual && ' · Manual'}</span>
}

function ClassifiedGmailMessageDetail({ mail, classification, detection, manual, estadoAdjunto, onClassificationChange, onExtract }: { mail: GmailMessage; classification: EmailClassification; detection: PreliminaryClassificationResult; manual: boolean; estadoAdjunto: (attachment: GmailAttachment) => EstadoDocumento; onClassificationChange: (classification: EmailClassification | 'AUTOMATICA') => void; onExtract: (attachment: GmailAttachment, mode?: ExtractionMode) => void }) {
  const [preview, setPreview] = useState<GmailAttachment | null>(null)
  const documentAttachment = mail.attachments.find((attachment) => attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/'))
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><span className="ml-2">Gmail · Clasificación</span></div><ClassificationBadge classification={classification} manual={manual} /></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject || '(Sin asunto)'}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]"><div className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Clasificación</div><select value={manual ? classification : 'AUTOMATICA'} onChange={(event) => onClassificationChange(event.target.value as EmailClassification | 'AUTOMATICA')} className="input" aria-label="Clasificación del correo"><option value="AUTOMATICA">Automática · {classificationLabel(detection.classification)}</option><option value="ESTADO_DE_CUENTA">Manual · Estado de cuenta</option><option value="NO_ES_ESTADO_DE_CUENTA">Manual · Otro correo</option><option value="REQUIERE_REVISION">Manual · Pendiente de verificar</option></select><div className="mt-2 text-[11px] text-slate-500">Las correcciones se guardan en Nexora para esta cuenta; no cambian las etiquetas de Gmail.</div></div><div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3"><div className="flex items-center gap-2 text-xs font-bold text-violet-800"><Sparkles size={14} />Gemini documental</div><div className="mt-1.5 text-[11px] leading-5 text-violet-700">{documentAttachment ? `Analiza ${documentAttachment.filename} en el workspace de extracción.` : 'Este correo no tiene un PDF o imagen para analizar.'}</div><button type="button" disabled={!documentAttachment} onClick={() => { if (documentAttachment) onExtract(documentAttachment, 'gemini') }} className="btn-soft mt-2 w-full justify-center px-2 py-2 text-[11px]"><Sparkles size={13} />Verificar con Gemini</button></div></div><div className={`mb-3 rounded-lg border px-3 py-2.5 text-[11px] leading-5 ${mail.remitenteCoincide ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>{mail.remitenteCoincide ? <>Remitente configurado: <strong>{mail.reglaRemitente}</strong>{detection.hasPdfAttachment ? ' · con PDF: estado de cuenta por defecto.' : ' · sin PDF: pendiente de verificar.'}</> : 'El remitente no coincide con los remitentes de estados de cuenta configurados.'}</div>{detection.matched && <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-5 text-amber-800"><strong>Palabras clave (apoyo):</strong> coincidencias en {detection.matchedTerms.join(', ')}. Esto no confirma que sea un estado de cuenta.</div>}{!detection.matched && <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500">No se encontraron términos preliminares de estado de cuenta. Puedes confirmarlo analizando el adjunto con Gemini.</div>}<div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <GmailAttachmentCard key={attachment.id} attachment={attachment} estado={esAdjuntoDocumental(attachment) ? estadoAdjunto(attachment) : null} onPreview={() => setPreview(attachment)} onExtract={() => onExtract(attachment)} />)}</div></div>}</div>{preview && <AttachmentPreview messageId={mail.id} attachment={preview} onClose={() => setPreview(null)} />}</div>
}

function GmailFoldersReadOnly({ folder, setFolder, status }: { folder: MailFolder; setFolder: (value: MailFolder) => void; status: GmailStatus | null }) {
  const folders: { value: MailFolder; label: string; icon: Icon }[] = [{ value: 'inbox', label: 'Bandeja de entrada', icon: Inbox }, { value: 'sent', label: 'Enviados', icon: Send }, { value: 'archive', label: 'Archivados', icon: Archive }, { value: 'trash', label: 'Papelera', icon: Trash2 }]
  return <div className="p-4"><div className="mb-4 px-2"><span className="eyebrow">Cuenta conectada</span><div className="mt-3 flex items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2.5 text-xs font-semibold text-ink"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600"><Globe2 size={13} /></span><span className="min-w-0 truncate">{status?.email ?? 'Gmail no conectado'}</span><span className={`ml-auto h-1.5 w-1.5 rounded-full ${status?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} /></div></div><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Carpetas Gmail</div><div className="space-y-1">{folders.map(({ value, label, icon: FolderIcon }) => <button key={value} onClick={() => setFolder(value)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${folder === value ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-500 hover:bg-slate-50'}`}><FolderIcon size={16} />{label}</button>)}</div><div className="mt-8 border-t border-slate-100 pt-5"><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Estado</div><div className="px-2 text-[11px] leading-5 text-slate-500">{status?.connected ? 'OAuth activo. Los mensajes se consultan desde Gmail.' : 'Configura la conexión desde la sección Configuración.'}</div></div></div>
}

function GmailAttachmentCard({ attachment, estado, onPreview, onExtract }: { attachment: GmailAttachment; estado: EstadoDocumento | null; onPreview: () => void; onExtract: () => void }) {
  const previewable = attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/')
  return <div className="flex max-w-md flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500">{attachmentMime(attachment).startsWith('image/') ? <FileImage size={20} /> : <FileText size={20} />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{attachment.filename}</div><div className="mt-0.5 text-[11px] text-slate-400">{attachmentMime(attachment)} · {formatBytes(attachment.size)}</div>{estado && <div className="mt-1.5"><EstadoDocumentoBadge estado={estado} /></div>}</div>{previewable && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview() }} className="btn-soft px-2.5 py-2 text-[11px]"><FileSearch size={13} />Visualizar</button>}<button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onExtract() }} className="btn-primary px-2.5 py-2 text-[11px]"><Sparkles size={13} />Extraer</button></div>
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
  return <div className="space-y-5"><ExtractionReviewWorkspace mode={mode} onModeChange={setMode} /></div>
}

type AvisoCombinacion = { conservadas: number; noAparecen: number }
/** Una sola lista por documento: los modos manual y Gemini muestran y editan el mismo documento. */
type ListaDocumento = { documentKey: string | null; documento: DocumentoEditable; aviso: AvisoCombinacion | null; warnings: string[] }
/** Última versión confirmada por el backend para este documento. */
type VersionGuardada = { documentKey: string; version: number; estado: EstadoExtraccion; actualizado: string; firma: string; envios: IntentoEnvio[]; enviado_en: string | null }
type OfertaBorrador = { documentKey: string; borrador: BorradorLocal; versionGuardada: number | null }
let loteExtraccion = 0
const borradores = borradoresLocales()
const listaVacia = (documentKey: string | null): ListaDocumento => ({ documentKey, documento: documentoVacio(), aviso: null, warnings: [] })
const etiquetaEstado: Record<EstadoExtraccion, string> = { borrador: 'Borrador', revisado: 'Revisado', enviado: 'Enviado' }

function ExtractionReviewWorkspace({ mode, onModeChange }: { mode: ExtractionMode; onModeChange: (mode: ExtractionMode) => void }) {
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
  const [guardando, setGuardando] = useState(false)
  const [resultadoGuardado, setResultadoGuardado] = useState<{ documentKey: string; tipo: 'exito' | 'error' | 'conflicto'; mensaje: string } | null>(null)
  const [confirmandoRevision, setConfirmandoRevision] = useState<ProblemasRevision | null>(null)
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [confirmandoReextraccion, setConfirmandoReextraccion] = useState(false)
  // Asocia cada extracción a su documento y descarta respuestas tardías de documentos anteriores.
  const [controlador] = useState(crearControladorExtraccion)
  const [params] = useSearchParams()
  const messageId = params.get('message')
  const attachmentId = params.get('attachment')
  const partId = params.get('part')
  const filename = params.get('filename') ?? 'Documento recibido'
  const fileType = filename.split('.').pop()?.toUpperCase() ?? 'PDF'
  const documentKey = messageId && attachmentId ? `${messageId}:${partId ?? attachmentId}` : null
  const documentKeyActual = useRef(documentKey)
  useEffect(() => { documentKeyActual.current = documentKey }, [documentKey])

  const deEsteDocumento = lista.documentKey === documentKey
  const documento = deEsteDocumento ? lista.documento : documentoVacio()
  const transactions = documento.transacciones
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
          setLista({ documentKey, documento: documentoGuardado, aviso: null, warnings: [] })
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

  // Aviso del navegador al recargar o cerrar con cambios pendientes.
  useEffect(() => {
    if (!sinGuardar) return
    const alSalir = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', alSalir)
    return () => window.removeEventListener('beforeunload', alSalir)
  }, [sinGuardar])

  // Aviso al navegar dentro de la app (otra sección u otro documento) con cambios pendientes.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => sinGuardar && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  const salirSinGuardar = () => {
    // El borrador local se escribe ya (sin esperar el debounce) para no perder los últimos cambios.
    if (claveLocal && !oferta) borradores.guardar(claveLocal, { version_base: versionGuardada?.version ?? null, guardadoEn: new Date().toISOString(), documento })
    blocker.proceed?.()
  }

  const cambiarCampo = (id: string, campo: CampoEditable, valor: string) => setTransactions((items) => items.map((item) => item.id === id ? editarCampo(item, campo, valor) : item))
  const eliminarTransaccion = (id: string) => setTransactions((items) => items.filter((item) => item.id !== id))
  const agregarTransaccion = () => setTransactions((items) => [...items, nuevaTransaccion()])
  const selectMode = (nextMode: ExtractionMode) => onModeChange(nextMode)

  const restaurarBorrador = () => {
    if (!oferta) return
    setLista({ documentKey, documento: oferta.borrador.documento, aviso: null, warnings: [] })
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
    }))
    if (documentKeyActual.current !== clave) return
    setGuardando(false)
    if (resultado.ok) {
      const { extraccion } = resultado
      setGuardado({ documentKey: clave, version: extraccion.version, estado: extraccion.estado, actualizado: extraccion.actualizado, firma: firmaContenido({ ...enviado, estado: extraccion.estado }), envios: extraccion.envios ?? [], enviado_en: extraccion.enviado_en })
      // Las ediciones hechas mientras se guardaba siguen pendientes; solo se refleja el estado si no hubo cambios.
      setLista((prev) => (prev.documentKey === clave && prev.documento.transacciones === transaccionesEnviadas ? { ...prev, documento: { ...prev.documento, estado: extraccion.estado } } : prev))
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

  const solicitarExtraccion = () => {
    if (extracting || !documentKey) return
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
      return geminiApi.extract(messageId, attachmentId, { forzar, signal })
    }, {
      exito: (result) => {
        loteExtraccion += 1
        const lote = `${Date.now().toString(36)}${loteExtraccion}`
        // Updater puro: combina con lo vigente (lo guardado y las ediciones hechas mientras Gemini procesaba).
        // El resultado queda como borrador con cambios sin guardar hasta que el usuario pulse Guardar.
        setLista((prev) => {
          const base = prev.documentKey === documentKey ? prev : listaVacia(documentKey)
          const combinacion = combinarExtraccion(base.documento.transacciones, result.transacciones, lote)
          const mostrarAviso = forzar || combinacion.conservadas > 0
          return {
            documentKey,
            documento: { estado: 'borrador', resumen: result.resumen, transacciones: combinacion.transacciones, formato_numerico: result.formato_numerico, modelo: result.model, prompt_version: result.prompt_version },
            aviso: mostrarAviso ? { conservadas: combinacion.conservadas, noAparecen: combinacion.noAparecen } : null,
            warnings: result.warnings,
          }
        })
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
  const puedeExtraer = cargaLista && !extracting && !confirmandoReextraccion && geminiStatus?.enabled === true
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
          {mode === 'gemini' && <button type="button" onClick={solicitarExtraccion} disabled={!puedeExtraer} className="btn-primary px-3 py-2"><Sparkles size={14} className={extracting ? 'animate-pulse' : ''} />{extracting ? `Extrayendo ${progress}%` : geminiStatus?.enabled !== true ? 'Extracción IA no disponible' : huboExtraccion ? 'Re-extraer con Gemini' : 'Extraer con Gemini'}</button>}
          <button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver</button>
          <button type="button" onClick={() => void guardar(documento.estado === 'revisado' ? 'revisado' : 'borrador', documento.estado === 'revisado')} disabled={!puedeGuardar || !sinGuardar} className="btn-soft px-3 py-2"><Check size={14} />{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" onClick={marcarRevisado} disabled={!puedeGuardar || transactions.length === 0 || (versionGuardada !== null && versionGuardada.estado !== 'borrador' && !sinGuardar)} className="btn-primary px-3 py-2"><FileCheck2 size={14} />Marcar como revisado</button>
        </div>
      </div>
      {!partId && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">Este enlace no identifica el adjunto de forma estable, así que no se puede guardar. Vuelve a abrir el documento desde Correos.</div>}
      {mode === 'gemini' && !geminiStatus?.enabled && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">{geminiError ?? 'Consultando disponibilidad de Gemini en FastAPI. La extracción no generará datos hasta que esté habilitado.'}</div>}
      {geminiError && geminiStatus?.enabled === true && <div className="mt-3"><ErrorNotice text={geminiError} onClose={() => setGeminiError(null)} /></div>}
      {extracting && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} /></div>}
      {errorCarga && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><span>No se pudo cargar la extracción guardada: {errorCarga}</span><button type="button" onClick={() => setRecargas((valor) => valor + 1)} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Reintentar</button></div>}
      {oferta && <div role="alertdialog" aria-labelledby="titulo-borrador-local" className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-900"><div id="titulo-borrador-local" className="font-bold">Borrador local sin guardar · {new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(oferta.borrador.guardadoEn))}</div><div className="mt-1 leading-5">Este navegador conserva cambios que nunca llegaron al backend ({oferta.borrador.documento.transacciones.length} movimientos).{oferta.borrador.version_base !== oferta.versionGuardada && ` Se basan en ${oferta.borrador.version_base ? `la versión ${oferta.borrador.version_base}` : 'un documento sin guardar'} y lo guardado ahora es ${oferta.versionGuardada ? `la versión ${oferta.versionGuardada}` : 'nada'}.`}</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={restaurarBorrador} className="btn-primary px-3 py-1.5 text-xs">Restaurar borrador local</button><button type="button" onClick={descartarBorrador} className="btn-soft px-3 py-1.5 text-xs">Descartar</button></div></div>}
      {confirmandoReextraccion && <div role="alertdialog" aria-labelledby="confirmar-reextraccion" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900"><div id="confirmar-reextraccion" className="font-bold">Este documento tiene {correcciones} corrección{correcciones === 1 ? '' : 'es'} manual{correcciones === 1 ? '' : 'es'}.</div><div className="mt-1 leading-5">Volver a extraer reemplaza solo las filas de la IA sin editar. Las filas manuales y las editadas se conservan; si una fila editada ya no aparece en la nueva extracción, se conserva marcada para revisión. El resultado queda como borrador hasta que lo guardes.</div><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void extraerConGemini()} className="btn-primary px-3 py-1.5 text-xs"><Sparkles size={13} />Re-extraer conservando correcciones</button><button type="button" onClick={() => setConfirmandoReextraccion(false)} className="btn-soft px-3 py-1.5 text-xs">Cancelar</button></div></div>}
      {confirmandoRevision && <div role="alertdialog" aria-labelledby="confirmar-revision" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-900"><div id="confirmar-revision" className="font-bold">Quedan {confirmandoRevision.total} problema{confirmandoRevision.total === 1 ? '' : 's'} sin resolver.</div><ul className="mt-1.5 list-disc space-y-0.5 pl-5">{confirmandoRevision.diferencias > 0 && <li>{confirmandoRevision.diferencias} comprobación{confirmandoRevision.diferencias === 1 ? '' : 'es'} contable{confirmandoRevision.diferencias === 1 ? '' : 's'} con diferencia.</li>}{confirmandoRevision.dudosos > 0 && <li>{confirmandoRevision.dudosos} importe{confirmandoRevision.dudosos === 1 ? '' : 's'} dudoso{confirmandoRevision.dudosos === 1 ? '' : 's'}.</li>}{confirmandoRevision.invalidos > 0 && <li>{confirmandoRevision.invalidos} importe{confirmandoRevision.invalidos === 1 ? '' : 's'} inválido{confirmandoRevision.invalidos === 1 ? '' : 's'}.</li>}{confirmandoRevision.en_revision > 0 && <li>{confirmandoRevision.en_revision} fila{confirmandoRevision.en_revision === 1 ? '' : 's'} marcada{confirmandoRevision.en_revision === 1 ? '' : 's'} para revisión.</li>}{confirmandoRevision.validacion_incompleta && <li>La validación contable no pudo completarse.</li>}</ul><div className="mt-2.5 flex flex-wrap gap-2"><button type="button" onClick={() => void guardar('revisado', true)} className="btn-primary px-3 py-1.5 text-xs">Marcar como revisado de todos modos</button><button type="button" onClick={() => setConfirmandoRevision(null)} className="btn-soft px-3 py-1.5 text-xs">Seguir revisando</button></div></div>}
      {aviso && <div className="mt-3"><AvisoReextraccion aviso={aviso} onClose={() => setLista((prev) => ({ ...prev, aviso: null }))} /></div>}
      {avisoGuardado?.tipo === 'exito' && <div className="mt-3"><Notice text={avisoGuardado.mensaje} onClose={() => setResultadoGuardado(null)} /></div>}
      {avisoGuardado && avisoGuardado.tipo !== 'exito' && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{avisoGuardado.mensaje}{avisoGuardado.tipo === 'conflicto' && ' Tus cambios se conservan como borrador local en este navegador.'}</span><span className="flex gap-2">{avisoGuardado.tipo === 'conflicto' && <button type="button" onClick={recargarGuardado} className="btn-soft px-3 py-1.5 text-xs"><RefreshCw size={13} />Cargar la versión guardada</button>}<button type="button" onClick={() => setResultadoGuardado(null)} aria-label="Cerrar error"><X size={16} /></button></span></div>}
    </section>
    {blocker.state === 'blocked' && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"><div role="alertdialog" aria-modal="true" aria-labelledby="titulo-salir" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><div id="titulo-salir" className="font-display text-lg font-bold text-ink">Hay cambios sin guardar</div><p className="mt-2 text-sm leading-6 text-slate-600">Los cambios de este documento no están guardados en el backend.{claveLocal ? ' Se conservarán como borrador local en este navegador y podrás restaurarlos al volver.' : ''}</p><div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => blocker.reset?.()} className="btn-primary px-3 py-2 text-sm">Seguir editando</button><button type="button" onClick={salirSinGuardar} className="btn-soft px-3 py-2 text-sm">Salir sin guardar</button></div></div></div>}
    <div className="grid min-h-0 gap-4 xl:h-[calc(100vh-226px)] xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]">
      <section className="min-h-[560px] min-w-0 overflow-hidden rounded-2xl"><div className="h-full overflow-y-auto scrollbar-thin"><DocumentViewer page={page} setPage={setPage} /></div></section>
      <section className="panel flex min-h-[560px] min-w-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5"><div><div className="text-sm font-bold text-ink">Movimientos</div><div className="mt-0.5 text-[11px] text-slate-400">{versionGuardada ? `Guardado ${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(versionGuardada.actualizado))}` : mode === 'gemini' ? 'Resultado del backend Gemini' : 'Captura manual'}</div></div><button type="button" onClick={agregarTransaccion} disabled={!cargaLista} className="btn-soft px-2.5 py-1.5 text-xs"><Plus size={14} />Agregar</button></div>
        {cargando && <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-slate-400"><RefreshCw size={15} className="animate-spin" />Cargando la extracción guardada…</div>}
        {cargaLista && !versionGuardada && transactions.length === 0 && !extracting && <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">Este documento no tiene una extracción guardada. {mode === 'gemini' ? <>Pulsa <strong>Extraer con Gemini</strong> para obtenerla.</> : <>Captura los movimientos con <strong>Agregar</strong> o cambia al modo Gemini para extraerlos.</>}</div>}
        {!cargando && <div className="min-h-0 flex-1 overflow-auto scrollbar-thin"><TablaTransacciones transacciones={transactions} alertas={alertas} onCambiar={cambiarCampo} onEliminar={eliminarTransaccion} /></div>}
        <div className="shrink-0 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-400"><div className="flex flex-wrap items-center gap-1.5"><CircleHelp size={13} />{`${transactions.length} movimiento${transactions.length === 1 ? '' : 's'}.`}{dudososCount > 0 && <span className="font-semibold text-amber-700">{dudososCount} importe{dudososCount === 1 ? '' : 's'} dudoso{dudososCount === 1 ? '' : 's'}: revísalo{dudososCount === 1 ? '' : 's'} contra el documento.</span>}</div></div>
      </section>
    </div>
    <PanelValidacion validacion={validacion} transacciones={transactions} conResumen={documento.resumen !== null} />
    <PanelEnvioSaveData key={documentKey ?? 'sin-documento'} messageId={messageId} partId={partId} guardado={versionGuardada} sinGuardar={sinGuardar} modificadoTrasEnvio={modificadoTrasEnvio} onActualizado={alActualizarEnvio} />
    {mode === 'gemini' && documento.resumen && <GeminiStatementSummary datos={{ filename, modelo: documento.modelo, resumen: documento.resumen, movimientos: transactions.length, warnings: deEsteDocumento ? lista.warnings : [] }} />}
  </div>
}

function AvisoReextraccion({ aviso, onClose }: { aviso: AvisoCombinacion; onClose: () => void }) {
  const tono = aviso.noAparecen > 0 ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
  return <div role="status" className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tono}`}><div className="flex items-start gap-2"><CheckCircle2 size={17} className="mt-0.5 shrink-0" /><div><div className="font-semibold">Extracción combinada con tus correcciones.</div><div className="mt-0.5 text-xs">Se conservaron {aviso.conservadas} corrección{aviso.conservadas === 1 ? '' : 'es'}. {aviso.noAparecen} fila{aviso.noAparecen === 1 ? '' : 's'} quedaron marcadas como «no aparece en extracción».</div></div></div><button type="button" onClick={onClose} aria-label="Cerrar aviso"><X size={16} /></button></div>
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

function GeminiStatementSummary({ datos }: { datos: { filename: string; modelo: string | null; resumen: Resumen; movimientos: number; warnings: string[] } }) {
  const resumen = datos.resumen
  const fields: { label: string; value: string; campo?: CampoMontoResumen }[] = [
    { label: 'Banco', value: resumen.banco },
    { label: 'Titular', value: resumen.titular },
    { label: 'Cuenta', value: resumen.cuenta },
    { label: 'Periodo', value: resumen.periodo },
    { label: 'Moneda', value: resumen.moneda },
    { label: 'Saldo inicial', value: resumen.saldo_inicial, campo: 'saldo_inicial' },
    { label: 'Total abonos', value: resumen.total_abonos, campo: 'total_abonos' },
    { label: 'Total cargos', value: resumen.total_cargos, campo: 'total_cargos' },
    { label: 'Saldo final', value: resumen.saldo_final, campo: 'saldo_final' },
  ]
  return <section className="panel overflow-hidden"><div className="border-b border-slate-200 bg-violet-50/50 p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div className="eyebrow mb-2 text-violet-700">Resumen del estado de cuenta</div><h2 className="font-display text-xl font-extrabold tracking-tight text-ink">Datos documentales extraídos</h2><p className="mt-1.5 text-sm text-slate-500">Gemini · {datos.modelo ?? 'modelo no registrado'} · {datos.movimientos} movimientos</p></div><span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-violet-700">{datos.filename}</span></div></div><div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.7fr)]"><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(({ label, value, campo }) => { const dudoso = campo !== undefined && resumen.dudosos.includes(campo); return <div key={label} className={`rounded-lg border p-3 ${dudoso ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50/60'}`}><dt className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}{dudoso && <span className="text-amber-700">Dudoso</span>}</dt><dd className={`mt-1 break-words text-sm font-semibold ${dudoso ? 'text-amber-900' : 'text-ink'} ${campo ? 'tabular-nums' : ''}`}>{value || 'No identificado'}</dd></div> })}</dl><div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-600"><div className="text-[10px] font-bold uppercase tracking-wider">Advertencias de la extracción</div>{datos.warnings.length > 0 ? <ul className="mt-2 space-y-1 text-xs">{datos.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <div className="mt-2 text-xs">Sin advertencias.</div>}</div></div></section>
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
      <div><div className="eyebrow mb-2">Integración empresarial</div><h2 id="titulo-envio-savedata" className="font-display text-xl font-extrabold tracking-tight text-ink">Envío a SaveData</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Se envían dos renglones: <strong>H</strong> con el total de abonos y <strong>S</strong> con el total de cargos, calculados por el backend a partir de las transacciones guardadas. El navegador nunca contacta SaveData directamente.</p></div>
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
  { campo: 'fecha', etiqueta: 'Fecha', monto: false, ancho: 'w-24' },
  { campo: 'concepto', etiqueta: 'Concepto', monto: false, ancho: 'min-w-[180px]' },
  { campo: 'referencia', etiqueta: 'Referencia', monto: false, ancho: 'w-28' },
  { campo: 'cargo', etiqueta: 'Cargo', monto: true, ancho: 'w-28' },
  { campo: 'abono', etiqueta: 'Abono', monto: true, ancho: 'w-28' },
  { campo: 'saldo', etiqueta: 'Saldo', monto: true, ancho: 'w-28' },
]
const tonoOrigen: Record<Transaccion['origen'], string> = { ia: 'bg-violet-50 text-violet-700', ia_editada: 'bg-blue-50 text-blue-700', manual: 'bg-slate-100 text-slate-600' }

const etiquetaRevision: Record<NonNullable<Transaccion['revision']>, string> = { no_aparece_en_extraccion: 'No aparece en extracción', fila_de_saldo_con_importe: 'Fila de saldo: no se suma' }

function TablaTransacciones({ transacciones, alertas, onCambiar, onEliminar }: { transacciones: Transaccion[]; alertas: Record<string, string[]>; onCambiar: (id: string, campo: CampoEditable, valor: string) => void; onEliminar: (id: string) => void }) {
  if (transacciones.length === 0) return <div className="px-5 py-14 text-center text-xs text-slate-400">Sin movimientos. Usa <strong>Agregar</strong> para capturar uno.</div>
  return <table className="w-full min-w-[760px] border-collapse text-xs"><thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400"><tr>{columnasTabla.map((columna) => <th key={columna.campo} scope="col" className={`${columna.ancho} border-b border-slate-200 px-2 py-2 font-bold ${columna.monto ? 'text-right' : 'text-left'}`}>{columna.etiqueta}</th>)}<th scope="col" className="w-28 border-b border-slate-200 px-2 py-2 text-left font-bold">Origen</th><th scope="col" className="w-8 border-b border-slate-200"><span className="sr-only">Acciones</span></th></tr></thead><tbody>{transacciones.map((transaccion, index) => <tr key={transaccion.id} className={`border-b border-slate-100 align-top ${alertas[transaccion.id] ? 'bg-red-50/40' : transaccion.revision ? 'bg-amber-50/40' : 'hover:bg-slate-50/50'}`}>{columnasTabla.map((columna) => { const dudoso = columna.monto && transaccion.dudosos.includes(columna.campo as CampoMonto); return <td key={columna.campo} className="px-1 py-1"><input aria-label={`${columna.etiqueta} del movimiento ${index + 1}`} value={transaccion[columna.campo]} inputMode={columna.monto ? 'decimal' : undefined} title={dudoso ? 'Importe dudoso: no se pudo interpretar sin adivinar. Revísalo contra el documento.' : undefined} onChange={(event) => onCambiar(transaccion.id, columna.campo, event.target.value)} className={`w-full rounded-md border px-2 py-1.5 text-xs text-ink outline-none transition focus:border-coral focus:bg-white focus:ring-2 focus:ring-coral/10 ${columna.monto ? 'text-right tabular-nums' : ''} ${dudoso ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-transparent bg-transparent hover:border-slate-200'}`} /></td> })}<td className="px-2 py-2"><div className="flex flex-col items-start gap-1"><span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${tonoOrigen[transaccion.origen]}`}>{etiquetaOrigen(transaccion.origen)}</span>{transaccion.revision && <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">{etiquetaRevision[transaccion.revision]}</span>}{alertas[transaccion.id] && <span title={alertas[transaccion.id].join(' ')} className="inline-flex cursor-help rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">{alertas[transaccion.id].length} alerta{alertas[transaccion.id].length === 1 ? '' : 's'}</span>}</div></td><td className="px-1 py-1"><button type="button" onClick={() => onEliminar(transaccion.id)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Eliminar movimiento ${index + 1}`}><Trash2 size={13} /></button></td></tr>)}</tbody></table>
}

function DocumentViewer({ page, setPage }: { page: number; setPage: (page: number) => void }) {
  const [params] = useSearchParams()
  const messageId = params.get('message')
  const attachmentId = params.get('attachment')
  const filename = params.get('filename') ?? 'Documento recibido'
  if (messageId && attachmentId) return <GmailDocumentPreview messageId={messageId} attachmentId={attachmentId} filename={filename} page={page} setPage={setPage} />
  return <EmptyDocumentViewer />
}

function EmptyDocumentViewer() {
  return <div className="panel flex min-h-[560px] items-center justify-center overflow-hidden"><div className="max-w-xs px-6 text-center"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileSearch size={24} /></div><div className="mt-4 text-sm font-bold text-ink">No hay documento seleccionado</div><div className="mt-1.5 text-xs leading-5 text-slate-400">Abre un PDF o imagen desde Correos y pulsa Extraer para visualizarlo aquí.</div></div></div>
}

function GmailDocumentPreview({ messageId, attachmentId, filename, page, setPage }: { messageId: string; attachmentId: string; filename: string; page: number; setPage: (page: number) => void }) {
  const url = gmailApi.attachmentUrl(messageId, attachmentId)
  const isPdf = filename.toLowerCase().endsWith('.pdf')
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(filename)
  const previewMime = isPdf ? 'application/pdf' : isImage ? attachmentMime({ id: attachmentId, filename, mimeType: '', size: 0, partId: '' }) : 'application/octet-stream'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    const controller = new AbortController()
    setPreviewUrl(null)
    setLoading(true)
    setError(null)
    void fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar el documento (${response.status}).`)
      const buffer = await response.arrayBuffer()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: previewMime }))
      setPreviewUrl(objectUrl)
    }).catch((requestError: unknown) => {
      if (controller.signal.aborted) return
      setError(requestError instanceof Error ? requestError.message : 'No se pudo visualizar el documento.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, previewMime])
  return <div className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink"><FileText size={16} className="shrink-0 text-coral" /><span className="truncate">{filename}</span></div><span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">Documento para extracción</span></div><div className="flex h-[560px] items-center justify-center overflow-auto bg-slate-100/80 p-5 sm:p-8">{loading && <div className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw size={16} className="animate-spin" />Cargando documento...</div>}{error && <div className="text-sm text-red-600">{error}</div>}{previewUrl && isPdf && <iframe src={previewUrl} title={filename} className="h-full min-h-[500px] w-full rounded-lg bg-white" />}{previewUrl && isImage && <img src={previewUrl} alt={filename} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />}{!loading && !error && !isPdf && !isImage && <div className="text-center text-sm text-slate-500">Este formato no tiene visor integrado.</div>}</div><div className="flex items-center justify-between border-t border-slate-200 px-4 py-3"><span className="text-[11px] text-slate-400">Página {page} · Documento original de Gmail</span><div className="flex items-center gap-2"><button disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronLeft size={14} /></button><span className="rounded bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">100%</span><button disabled className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronRight size={14} /></button></div></div></div>
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
  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Administra Gmail y Gemini desde Nexora sin editar el archivo .env."><span className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700"><ShieldCheck size={14} />Configuración en backend</span></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}{notice && <Notice text={notice} onClose={() => setNotice(null)} />}<div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>Las claves se guardan en FastAPI y nunca se muestran completas ni se almacenan en el navegador.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conexión real mediante OAuth 2.0." connected={Boolean(gmailStatus?.connected)} onToggle={() => void handleGmail()}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value={gmailStatus?.email ?? 'No conectada'} /><SettingField label="Estado" value={gmailStatus?.connected ? 'OAuth activo · Gmail API' : 'Esperando autorización'} /></div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="Guarda tu API key y activa la extracción desde esta pantalla." connected={Boolean(geminiStatus?.enabled)} onToggle={() => void (geminiStatus?.enabled ? disableGemini() : saveGemini())}><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">API key de Gemini</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="input" placeholder={geminiStatus?.maskedKey ?? 'Pega aquí tu API key'} autoComplete="new-password" /></label><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo</span><select value={model} onChange={(event) => setModel(event.target.value)} className="input"><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option><option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite · respaldo</option><option value="gemini-3.8-flash">Gemini 3.8 Flash · documentos complejos</option></select></label></div><div className="mt-4 flex flex-wrap items-center gap-2"><button onClick={() => void saveGemini()} className="btn-primary"><Check size={14} />Guardar y activar</button><button onClick={() => void disableGemini()} className="btn-soft" disabled={!geminiStatus?.configured}><X size={14} />Desactivar</button>{geminiStatus?.configured && <span className="text-xs text-slate-500">Key guardada: {geminiStatus.maskedKey}</span>}</div></IntegrationCard><TarjetaRemitentes conectado={Boolean(gmailStatus?.connected)} /><section className="panel p-5 sm:p-6" aria-labelledby="titulo-config-savedata"><div className="mb-5 flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Send size={19} /></div><div><h3 id="titulo-config-savedata" className="font-display text-base font-bold text-ink">SaveData</h3><p className="mt-1 text-xs text-slate-500">Envío de extracciones revisadas. La URL se define en el backend con SAVEDATA_URL; el navegador nunca la llama directamente.</p></div></div><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Sucursal predeterminada</span><input type="text" inputMode="numeric" value={sucursalPredeterminada} onChange={(event) => setSucursalPredeterminada(event.target.value)} className="input" placeholder="Ej. 3102" /></label><SettingField label="URL de SaveData" value={savedata ? savedata.url ?? 'Sin configurar (SAVEDATA_URL)' : 'Consultando…'} /></div><div className="mt-4"><button type="button" onClick={() => void guardarSucursal()} className="btn-primary"><Check size={14} />Guardar sucursal</button></div></section></div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={ShieldCheck} title="Privacidad" description="Key protegida en el servidor" /><SmallSetting icon={Sparkles} title="Modelo activo" description={geminiStatus?.model ?? model} /><SmallSetting icon={Code2} title="API FastAPI" description="Configuración persistente" /></div></>
}

function IntegrationCard({ icon: CardIcon, iconClass, title, description, connected, onToggle, children }: { icon: Icon; iconClass: string; title: string; description: string; connected: boolean; onToggle: () => void; children: React.ReactNode }) { return <section className="panel p-5 sm:p-6"><div className="mb-6 flex items-start justify-between gap-4"><div className="flex gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}><CardIcon size={19} /></div><div><h3 className="font-display text-base font-bold text-ink">{title}</h3><p className="mt-1 text-xs text-slate-500">{description}</p></div></div>{title === 'Gmail' ? <button onClick={onToggle} className={connected ? 'btn-soft' : 'btn-primary'}>{connected ? 'Desconectar Gmail' : 'Conectar Gmail'}</button> : <button onClick={onToggle} className="flex items-center gap-2 text-xs font-semibold text-slate-500"><span className={`relative h-5 w-9 rounded-full transition ${connected ? 'bg-emerald-500' : 'bg-slate-200'}`}><span className={`absolute top-1 h-3 w-3 rounded-full bg-white shadow transition ${connected ? 'left-5' : 'left-1'}`} /></span>{connected ? 'Conectado' : 'Desconectado'}</button>}</div>{children}</section> }
function SettingField({ label, value, placeholder = false }: { label: string; value: string; placeholder?: boolean }) { return <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">{label}</span><div className={`input flex items-center justify-between ${placeholder ? 'text-slate-400' : ''}`}>{value}{placeholder && <span className="text-[10px] text-slate-400">No guardar</span>}</div></label> }
function SmallSetting({ icon: SmallIcon, title, description }: { icon: Icon; title: string; description: string }) { return <div className="panel flex items-center gap-3 p-4"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><SmallIcon size={16} /></div><div><div className="text-xs font-bold text-ink">{title}</div><div className="mt-0.5 text-[11px] text-slate-400">{description}</div></div><ChevronRight size={15} className="ml-auto text-slate-300" /></div> }

function avatarTone(tone: string) { const tones: Record<string, string> = { blue: 'bg-blue-100 text-blue-700', purple: 'bg-violet-100 text-violet-700', coral: 'bg-orange-100 text-orange-700', amber: 'bg-amber-100 text-amber-700' }; return tones[tone] ?? tones.blue }

export default App
