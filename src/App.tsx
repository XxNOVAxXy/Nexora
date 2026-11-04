import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { DocumentItem, Transaction, TransactionStatus } from './types'
import { mockApi } from './services/mockApi'
import { gmailApi, type GmailAttachment, type GmailMessage, type GmailStatus } from './services/gmailApi'
import { geminiApi, type GeminiExtractionResponse, type GeminiStatus } from './services/geminiApi'
import { buildSaveDataPayload, createInitialSaveDataAttempt, formatSaveDataPayload, updateMethodValue, validateSaveDataDocument, type SaveDataAttempt, type SaveDataMethod, type SaveDataRecord } from './services/saveData'
import { classifyMessagesWithCache, classificationLabel, detectStatementEmail, preliminaryClassification, type ClassificationCache, type EmailClassification } from './services/emailClassification'
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  CloudUpload,
  Code2,
  Copy,
  Database,
  FileCheck2,
  FileImage,
  FileSearch,
  FileText,
  Filter,
  FolderOpen,
  Gem,
  Globe2,
  Inbox,
  Landmark,
  LayoutGrid,
  Link2,
  Mail,
  Menu,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
  Zap,
} from 'lucide-react'

type Icon = typeof Inbox
type ExtractionMode = SaveDataMethod
const documents = mockApi.documents
const baseTransactions = mockApi.transactions
type MailFolder = 'inbox' | 'sent' | 'archive' | 'trash'

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
          <div className="flex items-center gap-2.5"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-400/15 text-blue-300"><Landmark size={16} /></div><div className="min-w-0"><div className="truncate text-xs font-semibold text-white">ACME Corporation</div><div className="text-[10px] text-slate-500">Espacio de trabajo</div></div><ChevronDown size={14} className="ml-auto text-slate-500" /></div>
        </div>
        <nav className="mt-8 flex-1">
          {navSections.map((section) => <div key={section.label} className="mb-7"><div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.17em] text-slate-600">{section.label}</div>{section.items.map(({ to, label, icon: NavIcon }) => <NavLink key={to} to={to} onClick={onClose} className={({ isActive }) => `group mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition ${isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/[.05] hover:text-slate-200'}`}><NavIcon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'Correos' && <span className="ml-auto rounded-full bg-coral px-1.5 py-0.5 text-[10px] font-bold text-white">2</span>}</NavLink>)}</div>)}
        </nav>
        <div className="border-t border-white/10 pt-4"><div className="mb-4 flex items-center gap-3 px-2"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-coral text-xs font-bold text-white">JD</div><div><div className="text-xs font-semibold text-white">Javier Duarte</div><div className="text-[10px] text-slate-500">Administrador</div></div><MoreHorizontal size={16} className="ml-auto text-slate-500" /></div><div className="rounded-lg bg-emerald-400/10 px-3 py-2 text-[10px] text-emerald-300"><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />Modo demostración activo</div></div>
      </aside>
    </>
  )
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const location = useLocation()
  const titles: Record<string, string> = { '/emails': 'Correos', '/extraction': 'Extracción', '/settings': 'Configuración' }
  return <header className="flex h-[76px] items-center justify-between border-b border-slate-200/70 bg-paper px-5 sm:px-8 lg:px-10"><div className="flex items-center gap-3"><button onClick={onMenu} className="rounded-lg p-2 text-slate-500 hover:bg-white lg:hidden"><Menu size={21} /></button><div><div className="eyebrow">Workspace / {titles[location.pathname] ?? 'Nexora'}</div><h1 className="font-display text-xl font-extrabold tracking-tight text-ink sm:text-[22px]">{titles[location.pathname] ?? 'Nexora'}</h1></div></div><div className="flex items-center gap-2 sm:gap-4"><div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400 md:flex"><Search size={15} /><span>Buscar en Nexora</span><kbd className="ml-8 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400">⌘ K</kbd></div><button className="relative rounded-lg p-2 text-slate-500 hover:bg-white"><Bell size={19} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-coral" /></button><div className="hidden h-7 w-px bg-slate-200 sm:block" /><button className="flex items-center gap-2 text-sm font-semibold text-slate-600"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-coral/10 text-xs font-bold text-coral">JD</span><ChevronDown size={14} className="hidden sm:block" /></button></div></header>
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="eyebrow mb-2">{eyebrow}</div><h2 className="font-display text-[28px] font-extrabold tracking-[-0.04em] text-ink sm:text-[32px]">{title}</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p></div>{children && <div className="flex shrink-0 gap-2">{children}</div>}</div>
}

function StatCard({ icon: StatIcon, label, value, change, tone = 'blue' }: { icon: Icon; label: string; value: string; change: string; tone?: string }) {
  const toneClasses: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', coral: 'bg-orange-50 text-coral', green: 'bg-emerald-50 text-emerald-600', purple: 'bg-violet-50 text-violet-600' }
  return <div className="panel p-4 sm:p-5"><div className="flex items-start justify-between"><div className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneClasses[tone]}`}><StatIcon size={17} /></div><span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-600">{change}</span></div><div className="mt-4 text-2xl font-bold tracking-tight text-ink">{value}</div><div className="mt-1 text-xs text-slate-500">{label}</div></div>
}

function GmailInboxPage() {
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [messages, setMessages] = useState<GmailMessage[]>([])
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadEmails = async () => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await gmailApi.status()
      setStatus(nextStatus)
      if (!nextStatus.connected) {
        setMessages([])
        setSelected(null)
        return
      }
      const nextMessages = await gmailApi.messages(folder)
      setMessages(nextMessages)
      setSelected((current) => nextMessages.find((message) => message.id === current?.id) ?? nextMessages[0] ?? null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadEmails() }, [folder])
  const unreadCount = messages.filter((message) => message.unread).length
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)

  return <><PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Consulta los mensajes reales de la cuenta de Gmail configurada."><button className="btn-primary" onClick={() => void loadEmails()} disabled={loading || !status?.connected}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}{status && !status.connected && !error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail no está conectado. La conexión se administra únicamente desde Configuración.</span></div></div>}<div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={Inbox} label="Mensajes por revisar" value={`${unreadCount}`} change={status?.connected ? 'Cuenta real' : 'Sin conectar'} tone="blue" /><StatCard icon={Paperclip} label="Adjuntos recibidos" value={`${attachmentCount}`} change="En esta bandeja" tone="coral" /><StatCard icon={FileCheck2} label="Mensajes sincronizados" value={`${messages.length}`} change={folderLabel(folder)} tone="green" /><StatCard icon={Archive} label="Cuenta Gmail" value={status?.connected ? '1' : '0'} change={status?.email ?? 'Pendiente'} tone="purple" /></div><div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(360px,1.1fr)]"><GmailFoldersReadOnly folder={folder} setFolder={setFolder} status={status} /><div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${messages.length} mensajes reales`}</div></div><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-50" aria-label="Filtros"><Filter size={16} /></button></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && messages.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">{status?.connected ? 'No hay mensajes en esta carpeta.' : 'Conecta Gmail desde Configuración para ver tus mensajes.'}</div>}{!loading && messages.map((mail) => <button key={mail.id} onClick={() => setSelected(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button>)}</div></div>{selected ? <GmailMessageDetail mail={selected} /> : <EmptyMailDetail />}</div></>
}

type EmailFilter = 'all' | 'statements' | 'pending' | 'other'
type LocalClassificationOverride = { classification: EmailClassification; fingerprint: string }

/*
function FilteredGmailInboxPage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [messages, setMessages] = useState<GmailMessage[]>([])
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [filter, setFilter] = useState<EmailFilter>('all')
  const [classificationCache, setClassificationCache] = useState<ClassificationCache>({})
  const [classificationOverrides, setClassificationOverrides] = useState<Record<string, LocalClassificationOverride>>({})
  const [classificationLoading, setClassificationLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadEmails = async () => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await gmailApi.status()
      setStatus(nextStatus)
      if (!nextStatus.connected) {
        setMessages([])
        setSelected(null)
        return
      }
      const nextMessages = await gmailApi.messages(folder)
      setMessages(nextMessages)
      setSelected((current) => nextMessages.find((message) => message.id === current?.id) ?? nextMessages[0] ?? null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadEmails() }, [folder])

  const resultFor = (message: GmailMessage) => classificationCache[message.id] ?? { ...detectStatementEmail(message), classification: preliminaryClassification(detectStatementEmail(message)), fingerprint: '', analyzedAt: '', source: 'preliminar' as const }
  const classificationFor = (message: GmailMessage) => {
    const result = resultFor(message)
    const override = classificationOverrides[message.id]
    return override?.fingerprint === result.fingerprint ? override.classification : result.classification
  }
  const filteredMessages = messages.filter((message) => {
    const classification = classificationFor(message)
    return filter === 'all' || (filter === 'statements' && classification === 'ESTADO_DE_CUENTA') || (filter === 'pending' && classification === 'REQUIERE_REVISION') || (filter === 'other' && classification === 'NO_ES_ESTADO_DE_CUENTA')
  })
  const visibleSelected = selected && filteredMessages.some((message) => message.id === selected.id) ? selected : filteredMessages[0] ?? null
  const unreadCount = messages.filter((message) => message.unread).length
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)
  const pendingCount = messages.filter((message) => classificationFor(message) === 'REQUIERE_REVISION').length
  const statementCount = messages.filter((message) => classificationFor(message) === 'ESTADO_DE_CUENTA').length

  const setClassification = (messageId: string, classification: EmailClassification) => {
    setClassificationOverrides((current) => ({ ...current, [messageId]: classification }))
  }

  return <><PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Identifica posibles estados de cuenta sin modificar los mensajes ni etiquetas originales."><button className="btn-primary" onClick={() => void loadEmails()} disabled={loading || !status?.connected}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}{status && !status.connected && !error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail no está conectado. La conexión se administra únicamente desde Configuración.</span></div></div>}<div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={Inbox} label="Mensajes por revisar" value={`${unreadCount}`} change={status?.connected ? 'Cuenta real' : 'Sin conectar'} tone="blue" /><StatCard icon={Paperclip} label="Adjuntos recibidos" value={`${attachmentCount}`} change="En esta bandeja" tone="coral" /><StatCard icon={FileCheck2} label="Estados confirmados" value={`${statementCount}`} change="Corrección local" tone="green" /><StatCard icon={CircleHelp} label="Pendientes de verificar" value={`${pendingCount}`} change="Detección preliminar" tone="purple" /></div><div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(390px,1.1fr)]"><GmailFoldersReadOnly folder={folder} setFolder={setFolder} status={status} /><div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="border-b border-slate-200 px-4 py-4"><div className="flex items-center justify-between gap-3"><div><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${filteredMessages.length} de ${messages.length} mensajes`}</div></div><Filter size={16} className="text-slate-400" /></div><div className="mt-3 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">{([{ value: 'all', label: 'Todos' }, { value: 'statements', label: 'Estados de cuenta' }, { value: 'pending', label: 'Pendientes' }, { value: 'other', label: 'Otros' }] as { value: EmailFilter; label: string }[]).map((item) => <button key={item.value} type="button" onClick={() => setFilter(item.value)} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-bold transition ${filter === item.value ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'}`}>{item.label}</button>)}</div></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && filteredMessages.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">No hay correos en este filtro.</div>}{!loading && filteredMessages.map((mail) => { const detection = detectStatementEmail(mail); const classification = classificationFor(mail); return <button key={mail.id} onClick={() => setSelected(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${visibleSelected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject || '(Sin asunto)'}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div><div className="mt-2 flex flex-wrap items-center gap-1.5"><ClassificationBadge classification={classification} manual={Boolean(classificationOverrides[mail.id])} />{detection.hasDocumentAttachment && <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-500">Adjunto documental</span>}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button> })}</div></div>{visibleSelected ? <ClassifiedGmailMessageDetail mail={visibleSelected} classification={classificationFor(visibleSelected)} detection={detectStatementEmail(visibleSelected)} manual={Boolean(classificationOverrides[visibleSelected.id])} onClassificationChange={(classification) => setClassification(visibleSelected.id, classification)} onExtract={(attachment) => navigate(`/extraction?message=${encodeURIComponent(visibleSelected.id)}&attachment=${encodeURIComponent(attachment.id)}&filename=${encodeURIComponent(attachment.filename)}`)} /> : <EmptyMailDetail />}</div></div></>
}

*/
function FilteredGmailInboxPage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [messages, setMessages] = useState<GmailMessage[]>([])
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [filter, setFilter] = useState<EmailFilter>('all')
  const [classificationCache, setClassificationCache] = useState<ClassificationCache>({})
  const [classificationOverrides, setClassificationOverrides] = useState<Record<string, LocalClassificationOverride>>({})
  const [classificationLoading, setClassificationLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadEmails = async () => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await gmailApi.status()
      setStatus(nextStatus)
      if (!nextStatus.connected) {
        setMessages([])
        setSelected(null)
        return
      }
      const nextMessages = await gmailApi.messages(folder)
      setClassificationLoading(true)
      const nextCache = classifyMessagesWithCache(nextMessages, classificationCache)
      setMessages(nextMessages)
      setClassificationCache(nextCache)
      setClassificationOverrides((current) => Object.fromEntries(Object.entries(current).filter(([messageId, override]) => nextCache[messageId]?.fingerprint === override.fingerprint)))
      setSelected((current) => nextMessages.find((message) => message.id === current?.id) ?? nextMessages[0] ?? null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.')
    } finally {
      setClassificationLoading(false)
      setLoading(false)
    }
  }

  useEffect(() => { void loadEmails() }, [folder])

  const resultFor = (message: GmailMessage) => classificationCache[message.id] ?? { ...detectStatementEmail(message), classification: preliminaryClassification(detectStatementEmail(message)), fingerprint: '', analyzedAt: '', source: 'preliminar' as const }
  const classificationFor = (message: GmailMessage) => {
    const result = resultFor(message)
    const override = classificationOverrides[message.id]
    return override?.fingerprint === result.fingerprint ? override.classification : result.classification
  }
  const filteredMessages = messages.filter((message) => matchesEmailFilter(classificationFor(message), filter))
  const visibleSelected = selected && filteredMessages.some((message) => message.id === selected.id) ? selected : filteredMessages[0] ?? null
  const unreadCount = messages.filter((message) => message.unread).length
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)
  const pendingCount = messages.filter((message) => classificationFor(message) === 'REQUIERE_REVISION').length
  const statementCount = messages.filter((message) => classificationFor(message) === 'ESTADO_DE_CUENTA').length
  const setClassification = (message: GmailMessage, classification: EmailClassification) => {
    const result = resultFor(message)
    setClassificationOverrides((current) => ({ ...current, [message.id]: { classification, fingerprint: result.fingerprint } }))
  }

  return (
    <>
      <PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Identifica posibles estados de cuenta sin modificar los mensajes ni etiquetas originales.">
        <button className="btn-primary" onClick={() => void loadEmails()} disabled={loading || !status?.connected}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button>
      </PageHeading>
      {error && <ErrorNotice text={error} onClose={() => setError(null)} />}
      {status && !status.connected && !error && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail no está conectado. La conexión se administra únicamente desde Configuración.</span></div></div>}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Inbox} label="Mensajes por revisar" value={`${unreadCount}`} change={status?.connected ? 'Cuenta real' : 'Sin conectar'} tone="blue" />
        <StatCard icon={Paperclip} label="Adjuntos recibidos" value={`${attachmentCount}`} change="En esta bandeja" tone="coral" />
        <StatCard icon={FileCheck2} label="Estados confirmados" value={`${statementCount}`} change="Corrección local" tone="green" />
        <StatCard icon={CircleHelp} label="Pendientes de verificar" value={`${pendingCount}`} change="Detección preliminar" tone="purple" />
      </div>
      <div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(390px,1.1fr)]">
        <GmailFoldersReadOnly folder={folder} setFolder={setFolder} status={status} />
        <EmailMessageList messages={messages} filteredMessages={filteredMessages} selected={visibleSelected} loading={loading} classificationLoading={classificationLoading} folder={folder} filter={filter} onFilterChange={setFilter} classificationFor={classificationFor} classificationOverrides={classificationOverrides} onSelect={setSelected} />
        {visibleSelected ? <ClassifiedGmailMessageDetail mail={visibleSelected} classification={classificationFor(visibleSelected)} detection={resultFor(visibleSelected)} manual={classificationOverrides[visibleSelected.id]?.fingerprint === resultFor(visibleSelected).fingerprint} onClassificationChange={(classification) => setClassification(visibleSelected, classification)} onExtract={(attachment) => navigate(`/extraction?message=${encodeURIComponent(visibleSelected.id)}&attachment=${encodeURIComponent(attachment.id)}&filename=${encodeURIComponent(attachment.filename)}`)} /> : <EmptyMailDetail />}
      </div>
    </>
  )
}

function matchesEmailFilter(classification: EmailClassification, filter: EmailFilter) {
  return filter === 'all' || (filter === 'statements' && classification === 'ESTADO_DE_CUENTA') || (filter === 'pending' && classification === 'REQUIERE_REVISION') || (filter === 'other' && classification === 'NO_ES_ESTADO_DE_CUENTA')
}

function EmailMessageList({ messages, filteredMessages, selected, loading, classificationLoading, folder, filter, onFilterChange, classificationFor, classificationOverrides, onSelect }: { messages: GmailMessage[]; filteredMessages: GmailMessage[]; selected: GmailMessage | null; loading: boolean; classificationLoading: boolean; folder: MailFolder; filter: EmailFilter; onFilterChange: (filter: EmailFilter) => void; classificationFor: (message: GmailMessage) => EmailClassification; classificationOverrides: Record<string, LocalClassificationOverride>; onSelect: (message: GmailMessage) => void }) {
  const filters: { value: EmailFilter; label: string }[] = [{ value: 'all', label: 'Todos' }, { value: 'statements', label: 'Estados de cuenta' }, { value: 'pending', label: 'Pendientes' }, { value: 'other', label: 'Otros' }]
  return <div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="border-b border-slate-200 px-4 py-4"><div className="flex items-center justify-between gap-3"><div><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${filteredMessages.length} de ${messages.length} mensajes`}</div></div><Filter size={16} className="text-slate-400" /></div><div className="mt-3 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">{filters.map((item) => <button key={item.value} type="button" onClick={() => onFilterChange(item.value)} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] font-bold transition ${filter === item.value ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'}`}>{item.label}</button>)}</div></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && filteredMessages.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">No hay correos en este filtro.</div>}{!loading && filteredMessages.map((mail) => { const detection = detectStatementEmail(mail); const classification = classificationFor(mail); return <button key={mail.id} onClick={() => onSelect(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject || '(Sin asunto)'}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div><div className="mt-2 flex flex-wrap items-center gap-1.5"><ClassificationBadge classification={classification} manual={Boolean(classificationOverrides[mail.id])} />{detection.hasDocumentAttachment && <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-semibold text-slate-500">Adjunto documental</span>}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button> })}</div></div>
}

function ClassificationBadge({ classification, manual = false }: { classification: EmailClassification; manual?: boolean }) {
  const tone: Record<EmailClassification, string> = { ESTADO_DE_CUENTA: 'bg-emerald-50 text-emerald-700', NO_ES_ESTADO_DE_CUENTA: 'bg-slate-100 text-slate-600', REQUIERE_REVISION: 'bg-amber-50 text-amber-700' }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold ${tone[classification]}`}><span className={`h-1.5 w-1.5 rounded-full ${classification === 'ESTADO_DE_CUENTA' ? 'bg-emerald-500' : classification === 'REQUIERE_REVISION' ? 'bg-amber-500' : 'bg-slate-400'}`} />{classificationLabel(classification)}{manual && ' · Manual'}</span>
}

function ClassifiedGmailMessageDetail({ mail, classification, detection, manual, onClassificationChange, onExtract }: { mail: GmailMessage; classification: EmailClassification; detection: ReturnType<typeof detectStatementEmail>; manual: boolean; onClassificationChange: (classification: EmailClassification) => void; onExtract: (attachment: GmailAttachment) => void }) {
  const [preview, setPreview] = useState<GmailAttachment | null>(null)
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><span className="ml-2">Gmail · Clasificación local</span></div><ClassificationBadge classification={classification} manual={manual} /></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject || '(Sin asunto)'}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]"><div className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Clasificación manual</div><select value={classification} onChange={(event) => onClassificationChange(event.target.value as EmailClassification)} className="input"><option value="ESTADO_DE_CUENTA">ESTADO_DE_CUENTA</option><option value="NO_ES_ESTADO_DE_CUENTA">NO_ES_ESTADO_DE_CUENTA</option><option value="REQUIERE_REVISION">REQUIERE_REVISION</option></select><div className="mt-2 text-[11px] text-slate-500">Esta corrección solo se guarda en Nexora; no cambia las etiquetas originales.</div></div><div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3"><div className="flex items-center gap-2 text-xs font-bold text-violet-800"><Sparkles size={14} />Gemini documental</div><div className="mt-1.5 text-[11px] leading-5 text-violet-700">Pendiente de backend para analizar el archivo adjunto.</div><button type="button" disabled className="btn-soft mt-2 w-full justify-center px-2 py-2 text-[11px]"><Sparkles size={13} />Verificar con Gemini</button></div></div>{detection.matched && <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-5 text-amber-800"><strong>Detección preliminar:</strong> coincidencias en {detection.matchedTerms.join(', ')}. Esto no confirma que sea un estado de cuenta.</div>}{!detection.matched && <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500">No se encontraron términos preliminares de estado de cuenta. La clasificación documental por Gemini aún requiere backend.</div>}<div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <GmailAttachmentCard key={attachment.id} attachment={attachment} onPreview={() => setPreview(attachment)} onExtract={() => onExtract(attachment)} />)}</div></div>}</div>{preview && <AttachmentPreview messageId={mail.id} attachment={preview} onClose={() => setPreview(null)} />}</div>
}

function GmailFoldersReadOnly({ folder, setFolder, status }: { folder: MailFolder; setFolder: (value: MailFolder) => void; status: GmailStatus | null }) {
  const folders: { value: MailFolder; label: string; icon: Icon }[] = [{ value: 'inbox', label: 'Bandeja de entrada', icon: Inbox }, { value: 'sent', label: 'Enviados', icon: Send }, { value: 'archive', label: 'Archivados', icon: Archive }, { value: 'trash', label: 'Papelera', icon: Trash2 }]
  return <div className="p-4"><div className="mb-4 px-2"><span className="eyebrow">Cuenta conectada</span><div className="mt-3 flex items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2.5 text-xs font-semibold text-ink"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600"><Globe2 size={13} /></span><span className="min-w-0 truncate">{status?.email ?? 'Gmail no conectado'}</span><span className={`ml-auto h-1.5 w-1.5 rounded-full ${status?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} /></div></div><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Carpetas Gmail</div><div className="space-y-1">{folders.map(({ value, label, icon: FolderIcon }) => <button key={value} onClick={() => setFolder(value)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${folder === value ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-500 hover:bg-slate-50'}`}><FolderIcon size={16} />{label}</button>)}</div><div className="mt-8 border-t border-slate-100 pt-5"><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Estado</div><div className="px-2 text-[11px] leading-5 text-slate-500">{status?.connected ? 'OAuth activo. Los mensajes se consultan desde Gmail.' : 'Configura la conexión desde la sección Configuración.'}</div></div></div>
}

function RealEmailsPage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<GmailMessage | null>(null)
  const [messages, setMessages] = useState<GmailMessage[]>([])
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadEmails = async () => {
    setLoading(true)
    setError(null)
    try {
      const nextStatus = await gmailApi.status()
      setStatus(nextStatus)
      if (!nextStatus.connected) {
        setMessages([])
        setSelected(null)
        return
      }
      const nextMessages = await gmailApi.messages(folder)
      setMessages(nextMessages)
      setSelected((current) => nextMessages.find((message) => message.id === current?.id) ?? nextMessages[0] ?? null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadEmails() }, [folder])

  const connectGmail = () => navigate('/settings')
  const unreadCount = messages.filter((message) => message.unread).length
  const attachmentCount = messages.reduce((total, message) => total + message.attachments.length, 0)

  return <><PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Consulta los mensajes reales de tu cuenta de Gmail conectada."><button className="btn-primary" onClick={() => void loadEmails()} disabled={loading || !status?.connected}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Sincronizar</button><button className="btn-soft" onClick={() => void connectGmail()}><Plus size={15} />{status?.connected ? 'Cambiar cuenta' : 'Conectar Gmail'}</button></PageHeading>
    {error && <ErrorNotice text={error} onClose={() => setError(null)} />}{status && !status.connected && !error && <div className="mb-5 flex flex-col justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center"><div className="flex items-center gap-2"><CircleHelp size={17} /><span>Gmail todavía no está conectado. Autoriza una cuenta para cargar tus mensajes reales.</span></div><button onClick={() => void connectGmail()} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white hover:bg-amber-800">Iniciar conexión</button></div>}
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={Inbox} label="Mensajes por revisar" value={`${unreadCount}`} change={status?.connected ? 'Cuenta real' : 'Sin conectar'} tone="blue" /><StatCard icon={Paperclip} label="Adjuntos recibidos" value={`${attachmentCount}`} change="En esta bandeja" tone="coral" /><StatCard icon={FileCheck2} label="Mensajes sincronizados" value={`${messages.length}`} change={folder === 'inbox' ? 'Bandeja actual' : 'Carpeta actual'} tone="green" /><StatCard icon={Archive} label="Cuenta Gmail" value={status?.connected ? '1' : '0'} change={status?.email ?? 'Pendiente'} tone="purple" /></div>
    <div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(360px,1.1fr)]"><GmailFolders folder={folder} setFolder={setFolder} status={status} onConnect={() => void connectGmail()} /><div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><div className="font-semibold text-ink">{folderLabel(folder)}</div><div className="mt-0.5 text-[11px] text-slate-400">{loading ? 'Consultando Gmail...' : `${messages.length} mensajes reales`}</div></div><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-50"><Filter size={16} /></button></div><div className="p-2">{loading && <div className="flex items-center justify-center gap-2 py-14 text-xs text-slate-400"><RefreshCw size={16} className="animate-spin" />Consultando Gmail</div>}{!loading && messages.length === 0 && <div className="px-5 py-14 text-center text-xs text-slate-400">{status?.connected ? 'No hay mensajes en esta carpeta.' : 'Conecta Gmail para ver tus mensajes.'}</div>}{!loading && messages.map((mail) => <button key={mail.id} onClick={() => setSelected(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected?.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{timeLabel(mail.receivedAt)}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.snippet || 'Sin vista previa'}</span>{mail.attachments.length > 0 && <Paperclip size={12} className="shrink-0" />}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button>)}</div></div>{selected ? <GmailMessageDetail mail={selected} /> : <EmptyMailDetail />}</div>
  </>
}

/* The previous Gmail mock page was removed. RealEmailsPage is the active implementation.
  const [selected, setSelected] = useState(mailItems[0]!)
  const [folder, setFolder] = useState('Bandeja de entrada')
  return <><PageHeading eyebrow="Centro de comunicaciones" title="Correos" description="Consulta los mensajes y comprobantes de tus cuentas conectadas."><button className="btn-primary"><RefreshCw size={15} />Sincronizar</button><button className="btn-soft"><Plus size={15} />Conectar cuenta</button></PageHeading>
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={Inbox} label="Mensajes por revisar" value="12" change="+3 hoy" tone="blue" /><StatCard icon={Paperclip} label="Adjuntos recibidos" value="28" change="+6 esta semana" tone="coral" /><StatCard icon={FileCheck2} label="Documentos procesados" value="86" change="+12%" tone="green" /><StatCard icon={Archive} label="Cuentas conectadas" value="2" change="Activas" tone="purple" /></div>
    <div className="panel grid min-h-[580px] grid-cols-1 overflow-hidden lg:grid-cols-[255px_minmax(350px,1fr)_minmax(360px,1.1fr)]"><MailFolders folder={folder} setFolder={setFolder} /><div className="border-t border-slate-200 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><div className="font-semibold text-ink">{folder}</div><div className="mt-0.5 text-[11px] text-slate-400">{mailItems.length} mensajes recientes</div></div><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-50"><Filter size={16} /></button></div><div className="p-2">{mailItems.map((mail) => <button key={mail.id} onClick={() => setSelected(mail)} className={`w-full rounded-xl border-b border-slate-100 p-3 text-left transition last:border-b-0 hover:bg-slate-50 ${selected.id === mail.id ? 'bg-slate-50 ring-1 ring-slate-200' : ''}`}><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarTone(mail.tone)}`}>{mail.initials}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className={`truncate text-xs ${mail.unread ? 'font-bold text-ink' : 'font-semibold text-slate-600'}`}>{mail.sender}</span><span className="shrink-0 text-[10px] text-slate-400">{mail.time}</span></div><div className={`mt-1 truncate text-xs ${mail.unread ? 'font-semibold text-slate-700' : 'text-slate-500'}`}>{mail.subject}</div><div className="mt-1 flex items-center gap-2 truncate text-[11px] text-slate-400"><span className="truncate">{mail.preview}</span>{mail.attachments > 0 && <Paperclip size={12} className="shrink-0" />}</div></div>{mail.unread && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}</div></button>)}</div></div><MessageDetail mail={selected} /></div>
  </>
}

function MailFolders({ folder, setFolder }: { folder: string; setFolder: (value: string) => void }) {
  const folders = [{ label: 'Bandeja de entrada', icon: Inbox, count: 12 }, { label: 'Enviados', icon: Send }, { label: 'Archivados', icon: Archive }, { label: 'Papelera', icon: Trash2 }]
  return <div className="p-4"><div className="mb-4 flex items-center justify-between px-2"><span className="eyebrow">Mis cuentas</span><button className="text-slate-400 hover:text-ink"><Plus size={15} /></button></div><div className="mb-7 space-y-1"><button className="flex w-full items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2.5 text-left text-xs font-semibold text-ink"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600"><Globe2 size={13} /></span><span className="truncate">Gmail · Finanzas</span><span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-500" /></button><button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs text-slate-500 transition hover:bg-slate-50"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-600"><Mail size={13} /></span><span className="truncate">IMAP · Tesorería</span><span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-500" /></button></div><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Carpetas</div><div className="space-y-1">{folders.map(({ label, icon: FolderIcon, count }) => <button key={label} onClick={() => setFolder(label)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${folder === label ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-500 hover:bg-slate-50'}`}><FolderIcon size={16} />{label}{count && <span className="ml-auto text-[10px] font-bold text-coral">{count}</span>}</button>)}</div><div className="mt-8 border-t border-slate-100 pt-5"><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Almacenamiento</div><div className="px-2"><div className="mb-2 flex justify-between text-[11px] text-slate-500"><span>1.8 GB de 5 GB</span><span>36%</span></div><div className="h-1.5 rounded-full bg-slate-100"><div className="h-1.5 w-[36%] rounded-full bg-coral" /></div></div></div></div>
}

function MessageDetail({ mail }: { mail: typeof mailItems[number] }) {
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><button className="rounded p-1 hover:bg-white"><ArrowLeft size={15} /></button><button className="rounded p-1 hover:bg-white"><ArrowRight size={15} /></button><span className="ml-2">{mail.account}</span></div><div className="flex gap-1"><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Archive size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Trash2 size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><MoreHorizontal size={15} /></button></div></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.tone)}`}>{mail.initials}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;notificaciones@bancocentro.mx&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: Javier Duarte · Hoy, {mail.time}</div></div></div><div className="space-y-4 text-sm leading-6 text-slate-600"><p>Hola Javier,</p><p>{mail.preview} Hemos incluido toda la información de la operación en el documento adjunto para tu revisión.</p><p>Si no reconoces este movimiento, por favor contacta a tu ejecutivo de cuenta.</p><p>Saludos,<br /><span className="font-semibold text-slate-700">Equipo Banco del Centro</span></p></div>{mail.attachments > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments} archivo adjunto</div><Link to="/documents" className="flex max-w-sm items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-coral/40 hover:shadow-sm"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500"><FileText size={20} /></div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{mail.id === 'mail-2' ? 'Estado_cuenta_Banorte_Marzo.pdf' : 'Comprobante_transferencia_1842.pdf'}</div><div className="mt-0.5 text-[11px] text-slate-400">PDF · {mail.id === 'mail-2' ? '1.8 MB' : '248 KB'}</div></div><ArrowUpRight size={16} className="text-slate-400" /></Link></div>}<div className="mt-8 flex gap-2"><button className="btn-soft"><ArrowLeft size={14} />Responder</button><button className="btn-soft"><ArrowRight size={14} />Reenviar</button></div></div></div>
}

*/
function GmailFolders({ folder, setFolder, status, onConnect }: { folder: MailFolder; setFolder: (value: MailFolder) => void; status: GmailStatus | null; onConnect: () => void }) {
  const folders: { value: MailFolder; label: string; icon: Icon }[] = [{ value: 'inbox', label: 'Bandeja de entrada', icon: Inbox }, { value: 'sent', label: 'Enviados', icon: Send }, { value: 'archive', label: 'Archivados', icon: Archive }, { value: 'trash', label: 'Papelera', icon: Trash2 }]
  return <div className="p-4"><div className="mb-4 flex items-center justify-between px-2"><span className="eyebrow">Mis cuentas</span><button onClick={onConnect} className="text-slate-400 hover:text-ink"><Plus size={15} /></button></div><div className="mb-7 space-y-1"><button onClick={onConnect} className="flex w-full items-center gap-2.5 rounded-lg bg-slate-100 px-3 py-2.5 text-left text-xs font-semibold text-ink"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-600"><Globe2 size={13} /></span><span className="min-w-0 truncate">{status?.email ?? 'Conectar Gmail'}</span><span className={`ml-auto h-1.5 w-1.5 rounded-full ${status?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} /></button><div className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs text-slate-400"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-100 text-violet-600"><Mail size={13} /></span><span className="truncate">IMAP · Próximamente</span></div></div><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Carpetas Gmail</div><div className="space-y-1">{folders.map(({ value, label, icon: FolderIcon }) => <button key={value} onClick={() => setFolder(value)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition ${folder === value ? 'bg-slate-100 font-semibold text-ink' : 'text-slate-500 hover:bg-slate-50'}`}><FolderIcon size={16} />{label}</button>)}</div><div className="mt-8 border-t border-slate-100 pt-5"><div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Cuenta conectada</div><div className="px-2 text-[11px] leading-5 text-slate-500">{status?.connected ? 'OAuth activo. Nexora lee Gmail sin guardar tu contraseña.' : 'La bandeja se activará al completar OAuth.'}</div></div></div>
}

function GmailMessageDetail({ mail }: { mail: GmailMessage }) {
  const navigate = useNavigate()
  const [preview, setPreview] = useState<GmailAttachment | null>(null)
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><button className="rounded p-1 hover:bg-white"><ArrowLeft size={15} /></button><button className="rounded p-1 hover:bg-white"><ArrowRight size={15} /></button><span className="ml-2">Gmail · Cuenta conectada</span></div><div className="flex gap-1"><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Archive size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Trash2 size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><MoreHorizontal size={15} /></button></div></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <GmailAttachmentCard key={attachment.id} attachment={attachment} onPreview={() => setPreview(attachment)} onExtract={() => navigate(`/extraction?source=gmail&message=${encodeURIComponent(mail.id)}&attachment=${encodeURIComponent(attachment.id)}&filename=${encodeURIComponent(attachment.filename)}`)} />)}</div></div>}<div className="mt-8 flex gap-2"><button className="btn-soft"><ArrowLeft size={14} />Responder</button><button className="btn-soft"><ArrowRight size={14} />Reenviar</button></div></div>{preview && <AttachmentPreview messageId={mail.id} attachment={preview} onClose={() => setPreview(null)} />}</div>
}

function GmailAttachmentCard({ attachment, onPreview, onExtract }: { attachment: GmailAttachment; onPreview: () => void; onExtract: () => void }) {
  const previewable = attachmentMime(attachment) === 'application/pdf' || attachmentMime(attachment).startsWith('image/')
  return <div className="flex max-w-md flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500">{attachmentMime(attachment).startsWith('image/') ? <FileImage size={20} /> : <FileText size={20} />}</div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{attachment.filename}</div><div className="mt-0.5 text-[11px] text-slate-400">{attachmentMime(attachment)} · {formatBytes(attachment.size)}</div></div>{previewable && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPreview() }} className="btn-soft px-2.5 py-2 text-[11px]"><FileSearch size={13} />Visualizar</button>}<button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onExtract() }} className="btn-primary px-2.5 py-2 text-[11px]"><Sparkles size={13} />Extraer</button></div>
}

function LegacyGmailMessageDetailWithPreview({ mail }: { mail: GmailMessage }) {
  const [preview, setPreview] = useState<GmailAttachment | null>(null)
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><button className="rounded p-1 hover:bg-white"><ArrowLeft size={15} /></button><button className="rounded p-1 hover:bg-white"><ArrowRight size={15} /></button><span className="ml-2">Gmail · Cuenta conectada</span></div><div className="flex gap-1"><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Archive size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Trash2 size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><MoreHorizontal size={15} /></button></div></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <div key={attachment.id} className="flex max-w-sm items-center gap-3 rounded-xl border border-slate-200 bg-white p-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500"><FileText size={20} /></div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{attachment.filename}</div><div className="mt-0.5 text-[11px] text-slate-400">{attachment.mimeType} · {formatBytes(attachment.size)}</div></div><button onClick={() => setPreview(attachment)} className="btn-soft px-2.5 py-2 text-[11px]"><FileSearch size={13} />Visualizar</button></div>)}</div></div>}<div className="mt-8 flex gap-2"><button className="btn-soft"><ArrowLeft size={14} />Responder</button><button className="btn-soft"><ArrowRight size={14} />Reenviar</button></div></div>{preview && <AttachmentPreview messageId={mail.id} attachment={preview} onClose={() => setPreview(null)} />}</div>
}

function LegacyGmailMessageDetail({ mail }: { mail: GmailMessage }) {
  return <div className="border-t border-slate-200 bg-slate-50/30 lg:border-l lg:border-t-0"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2 text-xs text-slate-500"><button className="rounded p-1 hover:bg-white"><ArrowLeft size={15} /></button><button className="rounded p-1 hover:bg-white"><ArrowRight size={15} /></button><span className="ml-2">Gmail · Cuenta conectada</span></div><div className="flex gap-1"><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Archive size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><Trash2 size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-white hover:text-ink"><MoreHorizontal size={15} /></button></div></div><div className="p-5 sm:p-7"><div className="mb-6 flex items-start gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold ${avatarTone(mail.senderEmail)}`}>{mail.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><h3 className="font-display text-base font-bold text-ink">{mail.subject}</h3><div className="mt-1 text-xs text-slate-500"><span className="font-semibold text-slate-700">{mail.sender}</span> &lt;{mail.senderEmail}&gt;</div><div className="mt-1 text-[11px] text-slate-400">Para: {mail.to || 'Tu cuenta de Gmail'} · {timeLabel(mail.receivedAt)}</div></div></div><div className="whitespace-pre-line text-sm leading-6 text-slate-600">{mail.body || mail.snippet || 'Este mensaje no contiene texto visible.'}</div>{mail.attachments.length > 0 && <div className="mt-8"><div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{mail.attachments.length} archivo{mail.attachments.length === 1 ? '' : 's'} adjunto{mail.attachments.length === 1 ? '' : 's'}</div><div className="space-y-2">{mail.attachments.map((attachment) => <a key={attachment.id} href={gmailApi.attachmentUrl(mail.id, attachment.id)} target="_blank" rel="noreferrer" className="flex max-w-sm items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-coral/40 hover:shadow-sm"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-50 text-red-500"><FileText size={20} /></div><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-ink">{attachment.filename}</div><div className="mt-0.5 text-[11px] text-slate-400">{attachment.mimeType} · {formatBytes(attachment.size)}</div></div><ArrowUpRight size={16} className="text-slate-400" /></a>)}</div></div>}<div className="mt-8 flex gap-2"><button className="btn-soft"><ArrowLeft size={14} />Responder</button><button className="btn-soft"><ArrowRight size={14} />Reenviar</button></div></div></div>
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
    setPreviewUrl(null)
    setPreviewError(null)
    void fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar el adjunto (${response.status}).`)
      const buffer = await response.arrayBuffer()
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: previewMime }))
      setPreviewUrl(objectUrl)
    }).catch((error: unknown) => setPreviewError(error instanceof Error ? error.message : 'No se pudo visualizar el adjunto.'))
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
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

function DocumentsPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('Todos')
  const [uploaded, setUploaded] = useState(false)
  const filtered = documents.filter((doc) => (filter === 'Todos' || doc.type === filter) && doc.name.toLowerCase().includes(query.toLowerCase()))
  return <><PageHeading eyebrow="Biblioteca documental" title="Documentos" description="Todos tus comprobantes y estados de cuenta, en un solo espacio."><label className="btn-primary"><Upload size={15} />Cargar documento<input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={() => setUploaded(true)} /></label></PageHeading>{uploaded && <Notice text="Documento agregado a la bandeja de revisión (simulación)." onClose={() => setUploaded(false)} />}
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={FolderOpen} label="Documentos totales" value="126" change="+8 este mes" tone="blue" /><StatCard icon={FileSearch} label="Por revisar" value="14" change="Requieren acción" tone="coral" /><StatCard icon={CheckCircle2} label="Procesados" value="98" change="78% del total" tone="green" /><StatCard icon={CloudUpload} label="Espacio utilizado" value="2.4 GB" change="de 10 GB" tone="purple" /></div>
    <div className="panel overflow-hidden"><div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} className="input pl-9" placeholder="Buscar documentos..." /></div><div className="flex items-center gap-2 overflow-x-auto"><div className="flex rounded-lg bg-slate-100 p-1">{['Todos', 'PDF', 'JPG', 'PNG'].map((item) => <button key={item} onClick={() => setFilter(item)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition ${filter === item ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>{item}</button>)}</div><button className="btn-soft whitespace-nowrap"><Filter size={14} />Más filtros</button></div></div><div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((doc) => <DocumentCard key={doc.id} doc={doc} onOpen={() => navigate(`/extraction?document=${doc.id}`)} />)}{filtered.length === 0 && <div className="col-span-full py-16 text-center text-sm text-slate-400">No encontramos documentos con esos filtros.</div>}</div><div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-400"><span>Mostrando {filtered.length} de 126 documentos</span><div className="flex gap-1"><button className="rounded border border-slate-200 p-1.5"><ChevronLeft size={14} /></button><button className="rounded bg-ink px-2.5 py-1 text-white">1</button><button className="rounded border border-slate-200 px-2.5 py-1">2</button><button className="rounded border border-slate-200 p-1.5"><ChevronRight size={14} /></button></div></div></div>
  </>
}

function DocumentCard({ doc, onOpen }: { doc: DocumentItem; onOpen: () => void }) {
  const iconTone: Record<string, string> = { coral: 'bg-orange-50 text-coral', blue: 'bg-blue-50 text-blue-600', amber: 'bg-amber-50 text-amber-600', violet: 'bg-violet-50 text-violet-600', emerald: 'bg-emerald-50 text-emerald-600' }
  const statusTone: Record<DocumentItem['status'], string> = { 'Pendiente': 'bg-amber-50 text-amber-700', 'Procesado': 'bg-emerald-50 text-emerald-700', 'En revisión': 'bg-blue-50 text-blue-700' }
  return <button onClick={onOpen} className="group rounded-xl border border-slate-200 p-4 text-left transition hover:-translate-y-0.5 hover:border-coral/40 hover:shadow-md"><div className="mb-5 flex items-start justify-between"><div className={`flex h-11 w-11 items-center justify-center rounded-xl ${iconTone[doc.color]}`}>{doc.type === 'PDF' ? <FileText size={22} /> : <FileImage size={22} />}</div><MoreHorizontal size={17} className="text-slate-400" /></div><div className="truncate text-sm font-bold text-ink group-hover:text-coral">{doc.name}</div><div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400"><span>{doc.type}</span><span>·</span><span>{doc.size}</span><span>·</span><span>{doc.pages} {doc.pages === 1 ? 'página' : 'páginas'}</span></div><div className="mt-5 flex items-center justify-between"><span className="flex items-center gap-1.5 text-[11px] text-slate-500"><span className={`h-1.5 w-1.5 rounded-full ${doc.source.includes('Gmail') ? 'bg-blue-500' : doc.source.includes('IMAP') ? 'bg-violet-500' : 'bg-coral'}`} />{doc.source}</span><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusTone[doc.status]}`}>{doc.status}</span></div><div className="mt-2 text-[10px] text-slate-400">{doc.date}</div></button>
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) { return <div className="mb-5 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><div className="flex items-center gap-2"><CheckCircle2 size={17} />{text}</div><button onClick={onClose}><X size={16} /></button></div> }

function ExtractionWorkspace() {
  const [mode, setMode] = useState<ExtractionMode>('manual')
  const [geminiResult, setGeminiResult] = useState<GeminiExtractionResponse | null>(null)
  return <div className="space-y-5"><ExtractionReviewWorkspace mode={mode} onModeChange={setMode} onGeminiResult={setGeminiResult} /><GeminiStatementSummary result={geminiResult} visible={mode === 'gemini'} /><EnterpriseExportSection mode={mode} /></div>
}

/*
 function ExtractionReviewWorkspace({ mode, onModeChange }: { mode: ExtractionMode; onModeChange: (mode: ExtractionMode) => void }) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [savedByMethod, setSavedByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [activeTxn, setActiveTxn] = useState(0)
  const [manualTransactions, setManualTransactions] = useState<Transaction[]>(baseTransactions)
  const [geminiTransactions, setGeminiTransactions] = useState<Transaction[]>(baseTransactions.map((item) => ({ ...item, status: 'Revisar' as TransactionStatus })))
  const transactions = mode === 'manual' ? manualTransactions : geminiTransactions
  const setTransactions: Dispatch<SetStateAction<Transaction[]>> = mode === 'manual' ? setManualTransactions : setGeminiTransactions
  const selectedIndex = Math.min(activeTxn, Math.max(0, transactions.length - 1))
  const current = transactions[selectedIndex]
  const saved = savedByMethod[mode]
  const params = new URLSearchParams(window.location.search)
  const filename = params.get('filename') ?? 'Comprobante_transferencia_1842.pdf'
  const fileType = filename.split('.').pop()?.toUpperCase() ?? 'PDF'

  const setField = (field: keyof Transaction, value: string) => setTransactions((items) => items.map((item, index) => index === selectedIndex ? { ...item, [field]: value } : item))
  const selectMode = (nextMode: ExtractionMode) => {
    onModeChange(nextMode)
    if (nextMode === 'gemini') {
      setGeminiTransactions([])
    }
  }
  const setSaved = (value: boolean) => setSavedByMethod((currentState) => updateMethodValue(currentState, mode, value))
  const runGemini = () => {
    selectMode('gemini')
    if (extracting) return
    setExtracting(true)
    setProgress(8)
    const timer = window.setInterval(() => {
      setProgress((value) => {
        const next = Math.min(value + 17, 100)
        if (next === 100) {
          window.clearInterval(timer)
          window.setTimeout(() => setExtracting(false), 500)
        }
        return next
      })
    }, 220)
  }
  const groups: { title: string; fields: (keyof Transaction)[] }[] = [
    { title: 'Operación', fields: ['date', 'bank', 'operation', 'amount', 'currency', 'status'] },
    { title: 'Participantes y cuentas', fields: ['sender', 'beneficiary', 'origin', 'destination'] },
    { title: 'Trazabilidad', fields: ['reference', 'concept'] },
  ]

  if (!params.get('message') || !params.get('attachment')) return <div className="space-y-4"><section className="sticky top-2 z-20 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur"><div><div className="eyebrow">Workspace de extracción</div><div className="text-sm font-bold text-ink">Sin documento seleccionado</div></div><button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver a correos</button></section><div className="grid gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]"><EmptyDocumentViewer /><section className="panel flex min-h-[560px] items-center justify-center p-8 text-center"><div><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileSearch size={22} /></div><div className="mt-4 text-sm font-bold text-ink">Sin transacciones para revisar</div><div className="mt-1.5 max-w-xs text-xs leading-5 text-slate-400">Selecciona un PDF o imagen desde Correos y pulsa Extraer para comenzar.</div></div></section></div></div>

  return <div className="space-y-4"><section className="sticky top-2 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur sm:p-4"><div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"><div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral"><FileText size={18} /></div><div className="min-w-0"><div className="eyebrow">Revisión de comprobante · {fileType}</div><div className="truncate text-sm font-bold text-ink sm:text-base">{filename}</div></div><span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold sm:inline-flex ${current.status === 'Revisar' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{current.status}</span></div><div className="flex flex-wrap items-center gap-2"><div className="flex rounded-lg bg-slate-100 p-1"><button type="button" onClick={() => selectMode('manual')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'manual' ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}><UserRound size={13} />Manual</button><button type="button" onClick={() => selectMode('gemini')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'gemini' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sparkles size={13} />Gemini</button></div>{mode === 'gemini' && <button type="button" onClick={runGemini} disabled={extracting} className="btn-primary px-3 py-2"><Sparkles size={14} className={extracting ? 'animate-pulse' : ''} />{extracting ? `Extrayendo ${progress}%` : 'Extraer con Gemini'}</button>}<button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver</button><button type="button" onClick={() => setSaved(true)} className="btn-primary px-3 py-2"><Check size={14} />Guardar</button></div></div>{(extracting || saved) && <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3">{extracting ? <><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} /></div><span className="text-[11px] font-semibold text-violet-700">Procesando documento</span></> : <Notice text={`Resultado ${mode === 'gemini' ? 'Gemini' : 'manual'} guardado correctamente.`} onClose={() => setSaved(false)} />}</div>}</section><div className="grid min-h-0 gap-4 xl:h-[calc(100vh-226px)] xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]"><section className="min-h-[560px] min-w-0 overflow-hidden rounded-2xl"> <div className="h-full overflow-y-auto scrollbar-thin"><DocumentViewer page={page} setPage={setPage} /></div></section><section className="panel flex min-h-[560px] min-w-0 flex-col overflow-hidden"><div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5"><div><div className="text-sm font-bold text-ink">Datos de la transacción</div><div className="mt-0.5 text-[11px] text-slate-400">{mode === 'gemini' ? 'Resultado editable de Gemini' : 'Captura manual'}</div></div><div className="flex items-center gap-1"><button type="button" disabled={selectedIndex === 0} onClick={() => setActiveTxn((value) => value - 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronLeft size={14} /></button><span className="px-1 text-[10px] font-bold text-slate-500">{selectedIndex + 1}/{transactions.length}</span><button type="button" disabled={selectedIndex === transactions.length - 1} onClick={() => setActiveTxn((value) => value + 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronRight size={14} /></button><button type="button" onClick={() => setTransactions([...transactions, { ...baseTransactions[0], id: `txn-${transactions.length + 1}`, status: 'Borrador' }])} className="ml-1 rounded border border-slate-200 p-1.5 text-slate-500 hover:text-ink"><Plus size={14} /></button></div></div><div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin sm:p-5">{groups.map((group) => <div key={group.title} className="mb-5 last:mb-0"><div className="mb-3 flex items-center gap-2"><span className="eyebrow">{group.title}</span><div className="h-px flex-1 bg-slate-100" /></div><div className="grid gap-3 sm:grid-cols-2">{group.fields.map((field) => <Field key={field} field={field} value={current[field]} mode={mode} onChange={(value) => setField(field, value)} />)}</div></div>)}</div><div className="shrink-0 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-400"><div className="flex items-center gap-1.5"><CircleHelp size={13} />{mode === 'gemini' ? 'Revisa los campos con confianza antes de guardar.' : 'Completa y corrige los campos antes de guardar.'}</div></div></section></div></div>
}

*/
function ExtractionReviewWorkspace({ mode, onModeChange, onGeminiResult }: { mode: ExtractionMode; onModeChange: (mode: ExtractionMode) => void; onGeminiResult: (result: GeminiExtractionResponse | null) => void }) {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [savedByMethod, setSavedByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [activeTxn, setActiveTxn] = useState(0)
  const [manualTransactions, setManualTransactions] = useState<Transaction[]>(baseTransactions)
  const [geminiTransactions, setGeminiTransactions] = useState<Transaction[]>([])
  const [geminiResultDocumentKey, setGeminiResultDocumentKey] = useState<string | null>(null)
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const params = new URLSearchParams(window.location.search)
  const messageId = params.get('message')
  const attachmentId = params.get('attachment')
  const filename = params.get('filename') ?? 'Comprobante_transferencia_1842.pdf'
  const fileType = filename.split('.').pop()?.toUpperCase() ?? 'PDF'
  const documentKey = messageId && attachmentId ? `${messageId}:${attachmentId}` : null
  const transactions = mode === 'manual' ? manualTransactions : geminiResultDocumentKey === documentKey ? geminiTransactions : []
  const setTransactions: Dispatch<SetStateAction<Transaction[]>> = mode === 'manual' ? setManualTransactions : (value) => {
    if (typeof value !== 'function') return
    setGeminiTransactions(value)
  }
  const selectedIndex = Math.min(activeTxn, Math.max(0, transactions.length - 1))
  const current = transactions[selectedIndex] ?? { id: 'empty', date: '', bank: '', sender: '', beneficiary: '', origin: '', destination: '', reference: '', concept: '', operation: '', amount: '', currency: '', status: 'Borrador' as TransactionStatus }
  const saved = savedByMethod[mode]
  const groups: { title: string; fields: (keyof Transaction)[] }[] = [
    { title: 'Operación', fields: ['date', 'bank', 'operation', 'amount', 'currency', 'status'] },
    { title: 'Participantes y cuentas', fields: ['sender', 'beneficiary', 'origin', 'destination'] },
    { title: 'Trazabilidad', fields: ['reference', 'concept'] },
  ]

  useEffect(() => {
    let active = true
    setGeminiTransactions([])
    setGeminiResultDocumentKey(null)
    setGeminiError(null)
    onGeminiResult(null)
    setExtracting(false)
    setProgress(0)
    setActiveTxn(0)
    if (!documentKey) {
      setGeminiStatus(null)
      return () => { active = false }
    }
    void geminiApi.status().then((status) => {
      if (active) setGeminiStatus(status)
    }).catch((error: unknown) => {
      if (active) setGeminiError(error instanceof Error ? `Extracción IA no disponible: ${error.message}` : 'Extracción IA no disponible.')
    })
    return () => { active = false }
  }, [documentKey, onGeminiResult])

  const setField = (field: keyof Transaction, value: string) => setTransactions((items) => items.map((item, index) => index === selectedIndex ? { ...item, [field]: value } : item))
  const selectMode = (nextMode: ExtractionMode) => onModeChange(nextMode)
  const setSaved = (value: boolean) => setSavedByMethod((currentState) => updateMethodValue(currentState, mode, value))
  const runGemini = async () => {
    if (extracting || !messageId || !attachmentId) return
    onModeChange('gemini')
    setGeminiError(null)
    setGeminiTransactions([])
    setGeminiResultDocumentKey(null)
    onGeminiResult(null)
    setActiveTxn(0)
    setExtracting(true)
    setProgress(10)
    try {
      const status = geminiStatus ?? await geminiApi.status()
      setGeminiStatus(status)
      if (!status.enabled) throw new Error('Gemini no está conectado o habilitado en FastAPI.')
      setProgress(25)
      const result = await geminiApi.extract(messageId, attachmentId)
      setGeminiTransactions(result.transactions)
      setGeminiResultDocumentKey(documentKey)
      onGeminiResult(result)
      setProgress(100)
    } catch (error: unknown) {
      setGeminiTransactions([])
      setProgress(0)
      setGeminiError(error instanceof Error ? `Extracción IA no disponible: ${error.message}` : 'Extracción IA no disponible.')
    } finally {
      setExtracting(false)
    }
  }

  if (!messageId || !attachmentId) return <div className="space-y-4"><section className="sticky top-2 z-20 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur"><div><div className="eyebrow">Workspace de extracción</div><div className="text-sm font-bold text-ink">Sin documento seleccionado</div></div><button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver a correos</button></section><div className="grid gap-4 xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]"><EmptyDocumentViewer /><section className="panel flex min-h-[560px] items-center justify-center p-8 text-center"><div><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><FileSearch size={22} /></div><div className="mt-4 text-sm font-bold text-ink">Sin transacciones para revisar</div><div className="mt-1.5 max-w-xs text-xs leading-5 text-slate-400">Selecciona un PDF o imagen desde Correos y pulsa Extraer para comenzar.</div></div></section></div></div>

  return <div className="space-y-4"><section className="sticky top-2 z-20 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur sm:p-4"><div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"><div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral"><FileText size={18} /></div><div className="min-w-0"><div className="eyebrow">Revisión de comprobante · {fileType}</div><div className="truncate text-sm font-bold text-ink sm:text-base">{filename}</div></div><span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 sm:inline-flex">{transactions.length === 0 ? 'Sin extracción' : current.status}</span></div><div className="flex flex-wrap items-center gap-2"><div className="flex rounded-lg bg-slate-100 p-1"><button type="button" onClick={() => selectMode('manual')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'manual' ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}><UserRound size={13} />Manual</button><button type="button" onClick={() => selectMode('gemini')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'gemini' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sparkles size={13} />Gemini</button></div>{mode === 'gemini' && <button type="button" onClick={() => void runGemini()} disabled={extracting || geminiStatus?.enabled !== true} className="btn-primary px-3 py-2"><Sparkles size={14} className={extracting ? 'animate-pulse' : ''} />{extracting ? `Extrayendo ${progress}%` : geminiStatus?.enabled === true ? 'Extraer con Gemini' : 'Extracción IA no disponible'}</button>}<button type="button" onClick={() => navigate('/emails')} className="btn-soft px-3 py-2"><ArrowLeft size={14} />Volver</button><button type="button" onClick={() => setSaved(true)} className="btn-primary px-3 py-2"><Check size={14} />Guardar</button></div></div>{mode === 'gemini' && !geminiStatus?.enabled && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">{geminiError ?? 'Consultando disponibilidad de Gemini en FastAPI. La extracción no generará datos hasta que esté habilitado.'}</div>}{geminiError && geminiStatus?.enabled === true && <div className="mt-3"><ErrorNotice text={geminiError} onClose={() => setGeminiError(null)} /></div>}{extracting && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${progress}%` }} /></div>}{saved && <div className="mt-3"><Notice text={`Resultado ${mode === 'gemini' ? 'Gemini' : 'manual'} guardado correctamente.`} onClose={() => setSaved(false)} /></div>}</section><div className="grid min-h-0 gap-4 xl:h-[calc(100vh-226px)] xl:grid-cols-[minmax(0,1.22fr)_minmax(390px,1fr)]"><section className="min-h-[560px] min-w-0 overflow-hidden rounded-2xl"><div className="h-full overflow-y-auto scrollbar-thin"><DocumentViewer page={page} setPage={setPage} /></div></section><section className="panel flex min-h-[560px] min-w-0 flex-col overflow-hidden"><div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5"><div><div className="text-sm font-bold text-ink">Datos de la transacción</div><div className="mt-0.5 text-[11px] text-slate-400">{mode === 'gemini' ? 'Resultado real del backend Gemini' : 'Captura manual'}</div></div><div className="flex items-center gap-1"><button type="button" disabled={transactions.length === 0 || selectedIndex === 0} onClick={() => setActiveTxn((value) => value - 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronLeft size={14} /></button><span className="px-1 text-[10px] font-bold text-slate-500">{transactions.length === 0 ? '0/0' : `${selectedIndex + 1}/${transactions.length}`}</span><button type="button" disabled={transactions.length === 0 || selectedIndex === transactions.length - 1} onClick={() => setActiveTxn((value) => value + 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronRight size={14} /></button><button type="button" onClick={() => setTransactions([...transactions, { ...baseTransactions[0], id: `${mode}-${transactions.length + 1}`, status: 'Borrador' }])} className="ml-1 rounded border border-slate-200 p-1.5 text-slate-500 hover:text-ink"><Plus size={14} /></button></div></div>{mode === 'gemini' && transactions.length === 0 && !extracting && <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">Pulsa <strong>Extraer con Gemini</strong> cuando la IA esté disponible. No se muestran datos de ejemplo.</div>}<div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin sm:p-5">{groups.map((group) => <div key={group.title} className="mb-5 last:mb-0"><div className="mb-3 flex items-center gap-2"><span className="eyebrow">{group.title}</span><div className="h-px flex-1 bg-slate-100" /></div><div className="grid gap-3 sm:grid-cols-2">{group.fields.map((field) => <Field key={field} field={field} value={current[field]} mode={mode} onChange={(value) => setField(field, value)} />)}</div></div>)}</div><div className="shrink-0 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11px] text-slate-400"><div className="flex items-center gap-1.5"><CircleHelp size={13} />{mode === 'gemini' ? `${transactions.length} movimiento${transactions.length === 1 ? '' : 's'} devuelto${transactions.length === 1 ? '' : 's'} por el backend.` : 'Completa y corrige los campos antes de guardar.'}</div></div></section></div></div>
}

function GeminiStatementSummary({ result, visible }: { result: GeminiExtractionResponse | null; visible: boolean }) {
  if (!visible || !result) return null
  const statement = result.statement
  const balanceTone = result.balanceValidation.consistent === true ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : result.balanceValidation.consistent === false ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600'
  const fields = [
    ['Banco', statement.bank],
    ['Titular', statement.account_holder],
    ['Cuenta', statement.account_number],
    ['Periodo', statement.statement_period],
    ['Moneda', statement.currency],
    ['Saldo inicial', statement.opening_balance],
    ['Abonos', statement.total_credits],
    ['Cargos', statement.total_debits],
    ['Saldo final', statement.closing_balance],
  ]
  return <section className="panel overflow-hidden"><div className="border-b border-slate-200 bg-violet-50/50 p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div className="eyebrow mb-2 text-violet-700">Resumen del estado de cuenta</div><h2 className="font-display text-xl font-extrabold tracking-tight text-ink">Datos documentales extraídos</h2><p className="mt-1.5 text-sm text-slate-500">Gemini · {result.model} · {result.transactions.length} movimientos visibles</p></div><span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-violet-700">{result.filename}</span></div></div><div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.7fr)]"><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label, value]) => <div key={label} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</dt><dd className="mt-1 break-words text-sm font-semibold text-ink">{value || 'No identificado'}</dd></div>)}</dl><div className={`rounded-xl border p-4 ${balanceTone}`}><div className="text-[10px] font-bold uppercase tracking-wider">Validación de saldos</div><div className="mt-2 text-sm font-bold">{result.balanceValidation.message}</div>{result.balanceValidation.difference && <div className="mt-1 text-xs">Diferencia: {result.balanceValidation.difference}</div>}{result.warnings.length > 0 && <div className="mt-4 border-t border-current/15 pt-3"><div className="text-[10px] font-bold uppercase tracking-wider">Advertencias</div><ul className="mt-2 space-y-1 text-xs">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}</div></div></section>
}

type EnterpriseRecordDraft = {
  Sucursal: string
  Articulo: string
  Saldo: string
  Clave: string
}

const initialEnterpriseRecords: EnterpriseRecordDraft[] = [
  { Sucursal: '3102', Articulo: '10000453', Saldo: '10.0', Clave: 'H' },
  { Sucursal: '3102', Articulo: '10000453', Saldo: '2.0', Clave: 'S' },
  { Sucursal: '3102', Articulo: '10000451', Saldo: '5.0', Clave: 'H' },
  { Sucursal: '3102', Articulo: '10000451', Saldo: '1.0', Clave: 'S' },
]

/*
function EnterpriseExportSection({ mode }: { mode: ExtractionMode }) {
  const [recordsByMethod, setRecordsByMethod] = useState<Record<ExtractionMode, EnterpriseRecordDraft[]>>({
    manual: initialEnterpriseRecords,
    gemini: initialEnterpriseRecords.map((record) => ({ ...record })),
  })
  const [cargaInicialByMethod, setCargaInicialByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const [copiedByMethod, setCopiedByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const records = recordsByMethod[mode]
  const cargaInicial = cargaInicialByMethod[mode]
  const copied = copiedByMethod[mode]
  const parsedRecords: SaveDataRecord[] = records.map((record) => ({
    Sucursal: Number(record.Sucursal),
    Articulo: record.Articulo,
    Saldo: Number(record.Saldo),
    Clave: record.Clave,
  }))
  const validationErrors = validateSaveDataDocument({ CargaInicial: cargaInicial, Saldos: parsedRecords })
  const visibleValidationErrors = records.length === 0 ? ['Agrega al menos un registro en Saldos.'] : validationErrors
  const isValid = visibleValidationErrors.length === 0
  const preview = formatSaveDataPayload(buildSaveDataPayload(parsedRecords, cargaInicial))

  const setRecords = (updater: SetStateAction<EnterpriseRecordDraft[]>) => {
    setRecordsByMethod((current) => {
      const nextRecords = typeof updater === 'function' ? updater(current[mode]) : updater
      return updateMethodValue(current, mode, nextRecords)
    })
  }
  const updateRecord = (index: number, field: keyof EnterpriseRecordDraft, value: string) => {
    setRecords((current) => current.map((record, recordIndex) => recordIndex === index ? { ...record, [field]: value } : record))
    setCopiedByMethod((current) => updateMethodValue(current, mode, false))
  }
  const addRecord = () => setRecords((current) => [...current, { Sucursal: '', Articulo: '', Saldo: '', Clave: '' }])
  const removeRecord = (index: number) => setRecords((current) => current.filter((_, recordIndex) => recordIndex !== index))
  const updateCargaInicial = (value: boolean) => setCargaInicialByMethod((current) => updateMethodValue(current, mode, value))
  const copyJson = async () => {
    if (!isValid) return
    try {
      await navigator.clipboard.writeText(preview)
      setCopiedByMethod((current) => updateMethodValue(current, mode, true))
    } catch {
      setCopiedByMethod((current) => updateMethodValue(current, mode, false))
    }
  }
  const downloadJson = () => {
    if (!isValid) return
    const url = URL.createObjectURL(new Blob([preview], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'nexora-savedata.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <section className="panel overflow-hidden"><div className="border-b border-slate-200 bg-slate-50/60 p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 md:flex-row md:items-start"><div><div className="eyebrow mb-2">Integración empresarial · {mode === 'manual' ? 'Manual' : 'Gemini'}</div><h2 className="font-display text-xl font-extrabold tracking-tight text-ink">Exportación empresarial</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Prepara los registros para SaveData. Estos campos son independientes de los datos bancarios extraídos y requieren revisión explícita.</p></div><div className="flex shrink-0 items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700"><CircleHelp size={14} />Pendiente de conectar</div></div></div><div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]"><div><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-ink">Registros validados · {mode === 'manual' ? 'Manual' : 'Gemini'}</h3><p className="mt-1 text-[11px] text-slate-400">Ejemplo editable. No se deriva automáticamente del estado de cuenta.</p></div><button type="button" onClick={addRecord} className="btn-soft px-3 py-2 text-xs"><Plus size={14} />Agregar registro</button></div><div className="space-y-3">{records.map((record, index) => <div key={index} className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Registro {index + 1}</span><button type="button" onClick={() => removeRecord(index)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Eliminar registro ${index + 1}`}><Trash2 size={14} /></button></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><EnterpriseField label="Sucursal" value={record.Sucursal} type="number" onChange={(value) => updateRecord(index, 'Sucursal', value)} /><EnterpriseField label="Articulo" value={record.Articulo} onChange={(value) => updateRecord(index, 'Articulo', value)} /><EnterpriseField label="Saldo" value={record.Saldo} type="number" step="any" onChange={(value) => updateRecord(index, 'Saldo', value)} /><EnterpriseField label="Clave" value={record.Clave} onChange={(value) => updateRecord(index, 'Clave', value)} /></div></div>)}{records.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-400">Agrega un registro para construir Saldos.</div>}</div><label className="mt-4 flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={cargaInicial} onChange={(event) => updateCargaInicial(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-coral focus:ring-coral" />CargaInicial</label>{visibleValidationErrors.length > 0 && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><div className="mb-1 font-bold">Revisa los campos obligatorios:</div><div className="space-y-1">{visibleValidationErrors.map((error) => <div key={error}>{error}</div>)}</div></div>}</div><div className="min-w-0"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-bold text-ink">Vista previa del JSON · {mode === 'manual' ? 'Manual' : 'Gemini'}</h3><p className="mt-1 text-[11px] text-slate-400">Cuerpo listo para el futuro backend FastAPI.</p></div><Code2 size={17} className="text-slate-400" /></div><pre className="scrollbar-thin min-h-[300px] overflow-auto rounded-xl bg-ink p-4 text-[11px] leading-5 text-slate-200">{preview}</pre><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void copyJson()} disabled={!isValid} className="btn-primary px-3 py-2 text-xs"><Copy size={14} />{copied ? 'JSON copiado' : 'Copiar JSON'}</button><button type="button" onClick={downloadJson} disabled={!isValid} className="btn-soft px-3 py-2 text-xs"><ArrowDownToLine size={14} />Descargar JSON</button></div><div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-600" /><span><strong className="text-slate-700">Integración:</strong> pendiente de conectar. El botón Enviar al sistema permanecerá deshabilitado hasta contar con un backend seguro.</span></div><button type="button" disabled className="btn-soft mt-3 w-full justify-center text-xs"><Send size={14} />Enviar al sistema</button></div></div></section>
}

*/
function EnterpriseExportSection({ mode }: { mode: ExtractionMode }) {
  const [recordsByMethod, setRecordsByMethod] = useState<Record<ExtractionMode, EnterpriseRecordDraft[]>>({
    manual: initialEnterpriseRecords,
    gemini: initialEnterpriseRecords.map((record) => ({ ...record })),
  })
  const [cargaInicialByMethod, setCargaInicialByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const [copiedByMethod, setCopiedByMethod] = useState<Record<ExtractionMode, boolean>>({ manual: false, gemini: false })
  const [attempt, setAttempt] = useState<SaveDataAttempt>(createInitialSaveDataAttempt)
  const records = recordsByMethod[mode]
  const cargaInicial = cargaInicialByMethod[mode]
  const copied = copiedByMethod[mode]
  const parsedRecords: SaveDataRecord[] = records.map((record) => ({ Sucursal: Number(record.Sucursal), Articulo: record.Articulo, Saldo: Number(record.Saldo), Clave: record.Clave }))
  const validationErrors = validateSaveDataDocument({ CargaInicial: cargaInicial, Saldos: parsedRecords })
  const visibleValidationErrors = records.length === 0 ? ['Agrega al menos un registro en Saldos.'] : validationErrors
  const isValid = visibleValidationErrors.length === 0
  const preview = formatSaveDataPayload(buildSaveDataPayload(parsedRecords, cargaInicial))
  const saveDataBackendReady = false
  const canSend = isValid && saveDataBackendReady

  const setRecords = (updater: SetStateAction<EnterpriseRecordDraft[]>) => {
    setRecordsByMethod((current) => {
      const nextRecords = typeof updater === 'function' ? updater(current[mode]) : updater
      return updateMethodValue(current, mode, nextRecords)
    })
  }
  const updateRecord = (index: number, field: keyof EnterpriseRecordDraft, value: string) => {
    setRecords((current) => current.map((record, recordIndex) => recordIndex === index ? { ...record, [field]: value } : record))
    setCopiedByMethod((current) => updateMethodValue(current, mode, false))
  }
  const addRecord = () => setRecords((current) => [...current, { Sucursal: '', Articulo: '', Saldo: '', Clave: '' }])
  const removeRecord = (index: number) => setRecords((current) => current.filter((_, recordIndex) => recordIndex !== index))
  const updateCargaInicial = (value: boolean) => setCargaInicialByMethod((current) => updateMethodValue(current, mode, value))
  const copyJson = async () => {
    if (!isValid) return
    try {
      await navigator.clipboard.writeText(preview)
      setCopiedByMethod((current) => updateMethodValue(current, mode, true))
    } catch {
      setCopiedByMethod((current) => updateMethodValue(current, mode, false))
    }
  }
  const downloadJson = () => {
    if (!isValid) return
    const url = URL.createObjectURL(new Blob([preview], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `nexora-savedata-${mode}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <section className="panel overflow-hidden"><div className="border-b border-slate-200 bg-slate-50/60 p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 md:flex-row md:items-start"><div><div className="eyebrow mb-2">Integración empresarial · {mode === 'manual' ? 'Manual' : 'Gemini'}</div><h2 className="font-display text-xl font-extrabold tracking-tight text-ink">Exportación empresarial</h2><p className="mt-1.5 max-w-2xl text-sm text-slate-500">Prepara los registros para SaveData. Estos campos son independientes de los datos bancarios extraídos y requieren revisión explícita.</p></div><div className="flex shrink-0 items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700"><CircleHelp size={14} />Pendiente de conectar</div></div></div><div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]"><div><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-ink">Registros validados · {mode === 'manual' ? 'Manual' : 'Gemini'}</h3><p className="mt-1 text-[11px] text-slate-400">Ejemplo editable. No se deriva automáticamente del estado de cuenta.</p></div><button type="button" onClick={addRecord} className="btn-soft px-3 py-2 text-xs"><Plus size={14} />Agregar registro</button></div><div className="space-y-3">{records.map((record, index) => <div key={index} className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Registro {index + 1}</span><button type="button" onClick={() => removeRecord(index)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Eliminar registro ${index + 1}`}><Trash2 size={14} /></button></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><EnterpriseField label="Sucursal" value={record.Sucursal} type="number" onChange={(value) => updateRecord(index, 'Sucursal', value)} /><EnterpriseField label="Articulo" value={record.Articulo} onChange={(value) => updateRecord(index, 'Articulo', value)} /><EnterpriseField label="Saldo" value={record.Saldo} type="number" step="any" onChange={(value) => updateRecord(index, 'Saldo', value)} /><EnterpriseField label="Clave" value={record.Clave} onChange={(value) => updateRecord(index, 'Clave', value)} /></div></div>)}{records.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-400">Agrega un registro para construir Saldos.</div>}</div><label className="mt-4 flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={cargaInicial} onChange={(event) => updateCargaInicial(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-coral focus:ring-coral" />CargaInicial</label>{visibleValidationErrors.length > 0 && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><div className="mb-1 font-bold">Revisa los campos obligatorios:</div><div className="space-y-1">{visibleValidationErrors.map((error) => <div key={error}>{error}</div>)}</div></div>}</div><div className="min-w-0"><div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-bold text-ink">Vista previa del JSON · {mode === 'manual' ? 'Manual' : 'Gemini'}</h3><p className="mt-1 text-[11px] text-slate-400">Cuerpo listo para el futuro backend FastAPI.</p></div><Code2 size={17} className="text-slate-400" /></div><pre className="scrollbar-thin min-h-[300px] overflow-auto rounded-xl bg-ink p-4 text-[11px] leading-5 text-slate-200">{preview}</pre><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void copyJson()} disabled={!isValid} className="btn-primary px-3 py-2 text-xs"><Copy size={14} />{copied ? 'JSON copiado' : 'Copiar JSON'}</button><button type="button" onClick={downloadJson} disabled={!isValid} className="btn-soft px-3 py-2 text-xs"><ArrowDownToLine size={14} />Descargar JSON</button></div><SaveDataAttemptPanel attempt={attempt} /><div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-600" /><span><strong className="text-slate-700">Envío real bloqueado:</strong> requiere JSON válido, backend FastAPI disponible y autorización explícita para el entorno de pruebas.</span></div><button type="button" disabled={!canSend} className="btn-soft mt-3 w-full justify-center text-xs"><Send size={14} />Enviar al sistema</button></div></div></section>
}

function EnterpriseField({ label, value, type = 'text', step, onChange }: { label: string; value: string; type?: 'text' | 'number'; step?: string; onChange: (value: string) => void }) {
  return <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">{label}</span><input type={type} step={step} value={value} onChange={(event) => onChange(event.target.value)} className="input" /></label>
}

function SaveDataAttemptPanel({ attempt }: { attempt: SaveDataAttempt }) {
  const statusLabel = { idle: 'Pendiente', sending: 'Enviando', success: 'Éxito', error: 'Error' }[attempt.status]
  const statusClass = { idle: 'bg-slate-100 text-slate-600', sending: 'bg-blue-50 text-blue-700', success: 'bg-emerald-50 text-emerald-700', error: 'bg-red-50 text-red-700' }[attempt.status]
  const attemptedAt = attempt.attemptedAt ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(attempt.attemptedAt)) : '—'
  return <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3"><div className="mb-3 flex items-center justify-between gap-3"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Resultado del intento</div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusClass}`}>{statusLabel}</span></div><dl className="grid gap-2 text-xs sm:grid-cols-3"><div><dt className="text-[10px] font-semibold text-slate-400">Código HTTP</dt><dd className="mt-0.5 font-bold text-ink">{attempt.httpStatus ?? '—'}</dd></div><div><dt className="text-[10px] font-semibold text-slate-400">Fecha y hora</dt><dd className="mt-0.5 font-semibold text-slate-600">{attemptedAt}</dd></div><div className="sm:col-span-3"><dt className="text-[10px] font-semibold text-slate-400">Respuesta del servidor</dt><dd className="mt-0.5 break-words text-slate-600">{attempt.message}</dd></div></dl></div>
}

function ExtractionWithProgress() {
  const [mode, setMode] = useState<ExtractionMode>('manual')
  const [extracting, setExtracting] = useState(false)
  const [progress, setProgress] = useState(0)
  const startExtraction = () => {
    if (extracting) return
    setExtracting(true)
    setProgress(8)
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(current + 17, 100)
        if (next === 100) {
          window.clearInterval(timer)
          window.setTimeout(() => setExtracting(false), 500)
        }
        return next
      })
    }, 240)
  }
  return <><div className="panel mb-5 border-blue-100 bg-blue-50/50 p-4 sm:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-violet-600">{mode === 'gemini' ? <Sparkles size={18} /> : <UserRound size={18} />}</div><div><div className="text-sm font-bold text-ink">{mode === 'gemini' ? (extracting ? 'Extrayendo con Gemini...' : 'Extracción con Gemini') : 'Captura manual'}</div><div className="mt-0.5 text-[11px] text-slate-500">{mode === 'gemini' ? 'Ejecuta o vuelve a ejecutar la extracción automática.' : 'Completa los campos de la transacción en el formulario.'}</div></div></div>{mode === 'gemini' ? <button type="button" onClick={startExtraction} disabled={extracting} className="btn-primary"><RefreshCw size={15} className={extracting ? 'animate-spin' : ''} />{extracting ? `Extrayendo ${progress}%` : 'Extraer con Gemini'}</button> : <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">Formulario manual activo</span>}</div><div className="mt-4 h-2 overflow-hidden rounded-full bg-white/80"><div className={`h-full rounded-full transition-all duration-200 ${extracting ? 'bg-violet-500' : mode === 'gemini' ? 'bg-emerald-500' : 'bg-slate-300'}`} style={{ width: `${extracting ? progress : mode === 'gemini' ? 100 : 0}%` }} /></div><div className="mt-1.5 flex justify-between text-[10px] text-slate-400"><span>{extracting ? 'Procesamiento en curso' : mode === 'gemini' ? 'Gemini listo para extraer' : 'Captura los datos manualmente'}</span><span>{extracting ? `${progress}%` : mode === 'gemini' ? '100%' : '0%'}</span></div></div><ExtractionPage onModeChange={setMode} /></>
}

function ExtractionPage({ onModeChange }: { onModeChange?: (mode: ExtractionMode) => void }) {
  const navigate = useNavigate()
  const [mode, setModeState] = useState<ExtractionMode>('manual')
  const setMode = (nextMode: ExtractionMode) => { setModeState(nextMode); onModeChange?.(nextMode) }
  const [page, setPage] = useState(1)
  const [saved, setSaved] = useState(false)
  const [activeTxn, setActiveTxn] = useState(0)
  const [manualTransactions, setManualTransactions] = useState<Transaction[]>(baseTransactions)
  const [geminiTransactions, setGeminiTransactions] = useState<Transaction[]>([])
  const transactions = mode === 'manual' ? manualTransactions : geminiTransactions
  const setTransactions: Dispatch<SetStateAction<Transaction[]>> = mode === 'manual' ? setManualTransactions : setGeminiTransactions
  const selectedIndex = Math.min(activeTxn, Math.max(0, transactions.length - 1))
  const current = transactions[selectedIndex]
  const setField = (field: keyof Transaction, value: string) => setTransactions((items) => items.map((item, index) => index === selectedIndex ? { ...item, [field]: value } : item))
  const runGemini = () => setMode('gemini')
  return <><PageHeading eyebrow="Revisión de comprobantes" title="Extracción" description="Revisa los datos del documento y guarda una versión independiente por método."><button className="btn-soft" onClick={() => navigate('/emails')}><ArrowLeft size={15} />Volver a correos</button><button className="btn-primary" onClick={() => setSaved(true)}><Check size={15} />Guardar resultado</button></PageHeading>{saved && <Notice text={`Resultado ${mode === 'gemini' ? 'Gemini' : 'manual'} guardado en Historial.`} onClose={() => setSaved(false)} />}<div className="mb-5 flex flex-col gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-blue-600"><FileText size={16} /></div><div><div className="text-xs font-bold text-ink">Comprobante_transferencia_1842.pdf</div><div className="text-[11px] text-slate-500">PDF · 1 página · Última actualización hoy, 09:42</div></div></div><div className="flex items-center gap-2 text-[11px] text-blue-700"><ShieldCheck size={14} />Los métodos se guardan por separado</div></div><div className="grid gap-5 xl:grid-cols-[minmax(440px,1fr)_minmax(480px,1.08fr)]"><DocumentViewer page={page} setPage={setPage} /><div className="panel min-h-[650px] overflow-hidden"><div className="flex flex-col justify-between gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:px-5"><div><div className="font-semibold text-ink">Datos de la transacción</div><div className="mt-1 text-[11px] text-slate-400">{mode === 'gemini' ? 'Extracción asistida por Gemini' : 'Captura manual'}</div></div><div className="flex rounded-lg bg-slate-100 p-1"><button onClick={() => setMode('manual')} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'manual' ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}><UserRound size={13} />Manual</button><button onClick={runGemini} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold ${mode === 'gemini' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500'}`}><Sparkles size={13} />Gemini</button></div></div>{mode === 'gemini' && <div className="mx-5 mt-4 flex items-center justify-between rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2.5"><div className="flex items-center gap-2 text-xs text-violet-800"><Sparkles size={14} /><span>Extracción completada en 2.4s</span></div><span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-violet-700">87% confianza global</span></div>}<div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div className="flex items-center gap-2"><span className="text-xs font-bold text-ink">Movimiento {activeTxn + 1} de {transactions.length}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${current.status === 'Revisar' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{current.status}</span></div><div className="flex gap-1"><button disabled={activeTxn === 0} onClick={() => setActiveTxn((value) => value - 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronLeft size={14} /></button><button disabled={activeTxn === transactions.length - 1} onClick={() => setActiveTxn((value) => value + 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronRight size={14} /></button><button onClick={() => setTransactions([...transactions, { ...baseTransactions[0], id: `txn-${transactions.length + 1}`, status: 'Borrador' }])} className="ml-1 rounded border border-slate-200 p-1.5 text-slate-500 hover:text-ink"><Plus size={14} /></button></div></div><div className="grid max-h-[465px] grid-cols-1 gap-x-4 gap-y-4 overflow-y-auto p-5 scrollbar-thin sm:grid-cols-2">{(['date', 'bank', 'sender', 'beneficiary', 'origin', 'destination', 'reference', 'concept', 'operation', 'amount', 'currency', 'status'] as (keyof Transaction)[]).map((field) => <Field key={field} field={field} value={current[field]} mode={mode} onChange={(value) => setField(field, value)} />)}</div><div className="border-t border-slate-200 bg-slate-50/50 px-5 py-3 text-[11px] text-slate-400"><div className="flex items-center gap-1.5"><CircleHelp size={13} />Puedes editar cualquier dato antes de guardar.</div></div></div></div></>
}

function Field({ field, value, mode, onChange }: { field: keyof Transaction; value: string | undefined; mode: ExtractionMode; onChange: (value: string) => void }) {
  const labels: Record<keyof Transaction, string> = { id: 'ID', date: 'Fecha', bank: 'Banco', sender: 'Emisor u ordenante', beneficiary: 'Beneficiario', origin: 'Cuenta de origen', destination: 'Cuenta de destino', reference: 'Referencia', concept: 'Concepto', operation: 'Tipo de operación', amount: 'Importe', debit: 'Cargo', credit: 'Abono', balance: 'Saldo', currency: 'Moneda', status: 'Estado de la transacción' }
  if (field === 'id') return null
  const selectFields = field === 'operation' || field === 'currency' || field === 'status'
  return <label className={`${field === 'concept' ? 'sm:col-span-2' : ''} block`}><div className="mb-1.5 flex items-center justify-between text-[11px] font-bold text-slate-500"><span>{labels[field]}</span>{mode === 'gemini' && ['date', 'bank', 'amount', 'concept', 'debit', 'credit', 'balance'].includes(field) && <span className="flex items-center gap-1 text-[9px] font-medium text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Documento</span>}</div>{selectFields ? <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="input"><option>{value ?? ''}</option><option>{field === 'status' ? 'Validada' : field === 'currency' ? 'USD' : field === 'operation' ? 'Transferencia interna' : 'Pendiente'}</option></select> : <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={`input ${mode === 'gemini' && ['date', 'bank', 'amount', 'concept', 'debit', 'credit', 'balance'].includes(field) ? 'border-emerald-200 bg-emerald-50/20' : ''}`} />}</label>
}

function DocumentViewer({ page, setPage }: { page: number; setPage: (page: number) => void }) {
  const params = new URLSearchParams(window.location.search)
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
  const previewMime = isPdf ? 'application/pdf' : isImage ? attachmentMime({ id: attachmentId, filename, mimeType: '', size: 0 }) : 'application/octet-stream'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    setLoading(true)
    setError(null)
    void fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar el documento (${response.status}).`)
      const buffer = await response.arrayBuffer()
      objectUrl = URL.createObjectURL(new Blob([buffer], { type: previewMime }))
      setPreviewUrl(objectUrl)
    }).catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'No se pudo visualizar el documento.')).finally(() => setLoading(false))
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url, previewMime])
  return <div className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink"><FileText size={16} className="shrink-0 text-coral" /><span className="truncate">{filename}</span></div><span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">Documento para extracción</span></div><div className="flex h-[560px] items-center justify-center overflow-auto bg-slate-100/80 p-5 sm:p-8">{loading && <div className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw size={16} className="animate-spin" />Cargando documento...</div>}{error && <div className="text-sm text-red-600">{error}</div>}{previewUrl && isPdf && <iframe src={previewUrl} title={filename} className="h-full min-h-[500px] w-full rounded-lg bg-white" />}{previewUrl && isImage && <img src={previewUrl} alt={filename} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />}{!loading && !error && !isPdf && !isImage && <div className="text-center text-sm text-slate-500">Este formato no tiene visor integrado.</div>}</div><div className="flex items-center justify-between border-t border-slate-200 px-4 py-3"><span className="text-[11px] text-slate-400">Página {page} · Documento original de Gmail</span><div className="flex items-center gap-2"><button disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronLeft size={14} /></button><span className="rounded bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">100%</span><button disabled className="rounded border border-slate-200 p-1.5 text-slate-500 disabled:opacity-40"><ChevronRight size={14} /></button></div></div></div>
}

function LegacyDocumentViewer({ page, setPage }: { page: number; setPage: (page: number) => void }) {
  return <div className="panel overflow-hidden"><div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div className="flex items-center gap-2 text-xs font-semibold text-ink"><FileText size={16} className="text-coral" />Vista previa original</div><div className="flex items-center gap-1"><button className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><ArrowDownToLine size={15} /></button><button className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><MoreHorizontal size={15} /></button></div></div><div className="flex h-[560px] items-center justify-center overflow-auto bg-slate-100/80 p-5 sm:p-8"><div className="document-paper min-h-[465px] w-full max-w-[390px] rounded-sm p-6 text-[8px] text-slate-500 sm:p-8"><div className="mb-7 flex items-start justify-between border-b border-slate-200 pb-4"><div><div className="mb-1 text-[13px] font-extrabold tracking-tight text-[#1c467b]">BANCO DEL CENTRO</div><div className="text-[7px] uppercase tracking-wider">Comprobante de transferencia</div></div><div className="h-7 w-7 rounded-full bg-[#ecb534]/80" /></div><div className="mb-5 flex justify-between rounded bg-slate-50 p-3"><div><div className="mb-1 uppercase text-slate-400">Estatus</div><div className="font-bold text-emerald-600">Operación exitosa</div></div><div className="text-right"><div className="mb-1 uppercase text-slate-400">Folio</div><div className="font-bold text-slate-700">SPEI-184293</div></div></div><div className="mb-4 text-[9px] font-bold text-slate-700">Detalle de la operación</div><div className="grid grid-cols-2 gap-x-5 gap-y-3 border-b border-slate-200 pb-4"><MiniDocField label="Fecha y hora" value="24 abril 2024 · 09:38" /><MiniDocField label="Importe" value="$48,250.00 MXN" /><MiniDocField label="Ordenante" value="ACME Servicios, S.A." /><MiniDocField label="Beneficiario" value="Nexora Operaciones" /><MiniDocField label="Cuenta origen" value="0123 4567 8901" /><MiniDocField label="Cuenta destino" value="0987 6543 2109" /></div><div className="mt-5 rounded border border-slate-100 p-3"><div className="mb-2 text-[7px] uppercase text-slate-400">Concepto</div><div className="font-semibold text-slate-700">Pago factura AC-1842</div></div><div className="document-lines mt-7 h-20 rounded opacity-60" /><div className="mt-8 text-center text-[7px] text-slate-400">Este documento es una representación de demostración · Nexora</div></div></div><div className="flex items-center justify-between border-t border-slate-200 px-4 py-3"><span className="text-[11px] text-slate-400">Página {page} de 1</span><div className="flex items-center gap-3"><button className="text-slate-400 disabled:opacity-30" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span className="rounded bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">100%</span><button className="text-slate-400 disabled:opacity-30" disabled={page === 1} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div></div>
}

function MiniDocField({ label, value }: { label: string; value: string }) { return <div><div className="mb-0.5 uppercase text-slate-400">{label}</div><div className="font-semibold text-slate-700">{value}</div></div> }

function HistoryPage() {
  const [query, setQuery] = useState('')
  const [method, setMethod] = useState('Todos')
  const history = [{ document: 'Comprobante_transferencia_1842.pdf', method: 'Gemini', transactions: 1, date: 'Hoy, 10:02', confidence: '87%', status: 'Revisar' }, { document: 'Estado_cuenta_Banorte_Marzo.pdf', method: 'Manual', transactions: 18, date: 'Ayer, 17:04', confidence: '100%', status: 'Validado' }, { document: 'Recibo_SPEI_99120.png', method: 'Gemini', transactions: 1, date: '21 abr, 09:18', confidence: '94%', status: 'Validado' }, { document: 'Movimientos_cuenta_abril.pdf', method: 'Manual', transactions: 12, date: '19 abr, 18:22', confidence: '100%', status: 'Validado' }, { document: 'Pago_proveedores_abril.jpg', method: 'Manual', transactions: 1, date: '22 abr, 11:20', confidence: '100%', status: 'Borrador' }].filter((row) => (method === 'Todos' || row.method === method) && row.document.toLowerCase().includes(query.toLowerCase()))
  return <><PageHeading eyebrow="Trazabilidad de resultados" title="Historial" description="Consulta y revisa todos los documentos procesados y sus transacciones."><button className="btn-soft"><ArrowDownToLine size={15} />Exportar CSV</button></PageHeading><div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard icon={Database} label="Procesamientos totales" value="148" change="+18 este mes" tone="blue" /><StatCard icon={BadgeCheck} label="Resultados validados" value="121" change="81.7%" tone="green" /><StatCard icon={Sparkles} label="Con Gemini" value="64" change="43% del total" tone="purple" /><StatCard icon={BarChart3} label="Transacciones extraídas" value="1,284" change="+146 este mes" tone="coral" /></div><div className="panel overflow-hidden"><div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="relative max-w-sm flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} className="input pl-9" placeholder="Buscar por documento..." /></div><div className="flex rounded-lg bg-slate-100 p-1">{['Todos', 'Manual', 'Gemini'].map((item) => <button key={item} onClick={() => setMethod(item)} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${method === item ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>{item}</button>)}</div></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left"><thead className="bg-slate-50/80 text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3 font-bold">Documento</th><th className="px-4 py-3 font-bold">Método</th><th className="px-4 py-3 font-bold">Transacciones</th><th className="px-4 py-3 font-bold">Confianza</th><th className="px-4 py-3 font-bold">Estado</th><th className="px-5 py-3" /></tr></thead><tbody className="divide-y divide-slate-100">{history.map((row) => <tr key={row.document} className="group hover:bg-slate-50"><td className="px-5 py-4"><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50 text-red-500"><FileText size={16} /></div><div><div className="text-xs font-semibold text-ink">{row.document}</div><div className="mt-0.5 text-[10px] text-slate-400">Procesado {row.date}</div></div></div></td><td className="px-4 py-4"><span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold ${row.method === 'Gemini' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>{row.method === 'Gemini' && <Sparkles size={11} />}{row.method}</span></td><td className="px-4 py-4 text-xs font-semibold text-slate-600">{row.transactions}</td><td className="px-4 py-4"><div className="flex items-center gap-2 text-xs font-semibold text-slate-600"><div className="h-1.5 w-14 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: row.confidence }} /></div>{row.confidence}</div></td><td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.status === 'Validado' ? 'bg-emerald-50 text-emerald-700' : row.status === 'Revisar' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{row.status}</span></td><td className="px-5 py-4 text-right"><button className="rounded-lg p-2 text-slate-400 opacity-0 transition hover:bg-white hover:text-ink group-hover:opacity-100"><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div>{history.length === 0 && <div className="py-16 text-center text-sm text-slate-400">No hay resultados para ese filtro.</div>}<div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-400"><span>5 resultados de 148</span><span>Última sincronización: hace 4 min</span></div></div></>
}

function SettingsPageV3() {
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gemini-3.5-flash-lite')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadSettings = async () => {
    try {
      const [nextGmail, nextGemini] = await Promise.all([gmailApi.status(), geminiApi.status()])
      setGmailStatus(nextGmail)
      setGeminiStatus(nextGemini)
      setModel(nextGemini.model)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar la configuración.') }
  }
  useEffect(() => { void loadSettings() }, [])
  const handleGmail = async () => {
    if (gmailStatus?.connected) { await gmailApi.disconnect(); await loadSettings() } else gmailApi.startAuth()
  }
  const saveGemini = async () => {
    if (!apiKey.trim() && !geminiStatus?.configured) { setError('Escribe una API key de Gemini para activar la integración.'); return }
    try { setGeminiStatus(await geminiApi.save(apiKey.trim(), model)); setApiKey(''); setNotice('Gemini quedó configurado y activado en FastAPI.'); setError(null) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo guardar Gemini.') }
  }
  const disableGemini = async () => {
    try { setGeminiStatus(await geminiApi.disable()); setNotice('Gemini quedó desactivado.'); setError(null) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo desactivar Gemini.') }
  }
  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Administra Gmail y Gemini desde Nexora sin editar el archivo .env."><span className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700"><ShieldCheck size={14} />Configuración en backend</span></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}{notice && <Notice text={notice} onClose={() => setNotice(null)} />}<div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>Las claves se guardan en FastAPI y nunca se muestran completas ni se almacenan en el navegador.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conexión real mediante OAuth 2.0." connected={Boolean(gmailStatus?.connected)} onToggle={() => void handleGmail()}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value={gmailStatus?.email ?? 'No conectada'} /><SettingField label="Estado" value={gmailStatus?.connected ? 'OAuth activo · Gmail API' : 'Esperando autorización'} /></div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="Guarda tu API key y activa la extracción desde esta pantalla." connected={Boolean(geminiStatus?.enabled)} onToggle={() => void (geminiStatus?.enabled ? disableGemini() : saveGemini())}><div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">API key de Gemini</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="input" placeholder={geminiStatus?.maskedKey ?? 'Pega aquí tu API key'} autoComplete="new-password" /></label><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo</span><select value={model} onChange={(event) => setModel(event.target.value)} className="input"><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option><option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite · respaldo</option><option value="gemini-3.8-flash">Gemini 3.8 Flash · documentos complejos</option></select></label></div><div className="mt-4 flex flex-wrap items-center gap-2"><button onClick={() => void saveGemini()} className="btn-primary"><Check size={14} />Guardar y activar</button><button onClick={() => void disableGemini()} className="btn-soft" disabled={!geminiStatus?.configured}><X size={14} />Desactivar</button>{geminiStatus?.configured && <span className="text-xs text-slate-500">Key guardada: {geminiStatus.maskedKey}</span>}</div></IntegrationCard></div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={ShieldCheck} title="Privacidad" description="Key protegida en el servidor" /><SmallSetting icon={Sparkles} title="Modelo activo" description={geminiStatus?.model ?? model} /><SmallSetting icon={Code2} title="API FastAPI" description="Configuración persistente" /></div></>
}

function SettingsPageV2() {
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [geminiConnected, setGeminiConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadStatus = async () => {
    try {
      const nextStatus = await gmailApi.status()
      setGmailStatus(nextStatus)
      if (nextStatus.error) setError(nextStatus.error)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar Gmail.') }
  }
  useEffect(() => { void loadStatus() }, [])
  const handleGmail = async () => {
    if (gmailStatus?.connected) { await gmailApi.disconnect(); await loadStatus() } else gmailApi.startAuth()
  }
  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Conecta Gmail y prepara Gemini para la extracción de documentos."><span className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700"><ShieldCheck size={14} />Integraciones seguras</span></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}<div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>Las credenciales permanecen en FastAPI; el navegador no guarda secrets.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conexión real mediante OAuth 2.0." connected={Boolean(gmailStatus?.connected)} onToggle={() => void handleGmail()}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value={gmailStatus?.email ?? 'No conectada'} /><SettingField label="Estado" value={gmailStatus?.connected ? 'OAuth activo · Gmail API' : 'Esperando autorización'} /></div><div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs ${gmailStatus?.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{gmailStatus?.connected ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}{gmailStatus?.connected ? 'Cuenta conectada. Correos consulta Gmail real.' : 'Pulsa Conectar Gmail para elegir una cuenta.'}</div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="Modelos disponibles para extracción automática." connected={geminiConnected} onToggle={() => setGeminiConnected((value) => !value)}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="API key" value="Configurada en el backend" placeholder /><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo principal</span><select className="input" defaultValue="gemini-3.5-flash-lite"><option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option><option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite · respaldo</option><option value="gemini-3.8-flash">Gemini 3.8 Flash · documentos complejos</option></select></label></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><SettingField label="Modelo de respaldo" value="gemini-3.1-flash-lite" /><SettingField label="Modelo complejo" value="gemini-3.8-flash" /></div></IntegrationCard></div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={ShieldCheck} title="Privacidad" description="Keys solo en el backend" /><SmallSetting icon={Sparkles} title="Extracción IA" description="Tres modelos configurables" /><SmallSetting icon={Code2} title="API FastAPI" description="Lista para Gemini" /></div></>
}

function RealSettingsPage() {
  const location = useLocation()
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [imapConnected, setImapConnected] = useState(false)
  const [geminiConnected, setGeminiConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = async () => {
    try {
      const nextStatus = await gmailApi.status()
      setGmailStatus(nextStatus)
      if (nextStatus.error) setError(nextStatus.error)
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo consultar el estado de Gmail.') }
  }
  useEffect(() => {
    void loadStatus()
    const callbackError = new URLSearchParams(location.search).get('gmailError')
    if (callbackError) setError(callbackError === 'oauth_exchange_failed' ? 'Google no pudo completar OAuth. Revisa la URI de redirección y las credenciales del cliente.' : `Google canceló la conexión (${callbackError}).`)
  }, [location.search])
  const handleGmail = async () => {
    try {
      if (gmailStatus?.connected) { await gmailApi.disconnect(); await loadStatus() } else { await gmailApi.startAuth() }
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'No se pudo actualizar Gmail.') }
  }

  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Gmail usa OAuth real mediante FastAPI. IMAP y Gemini se habilitarán en las siguientes integraciones."><span className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700"><ShieldCheck size={14} />Backend Gmail activo</span></PageHeading>{error && <ErrorNotice text={error} onClose={() => setError(null)} />}<div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>El secreto OAuth se queda en el backend. El navegador solo recibe el estado de conexión y los mensajes autorizados.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conexión real mediante OAuth 2.0. Nexora no solicita ni guarda tu contraseña." connected={Boolean(gmailStatus?.connected)} onToggle={() => void handleGmail()}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value={gmailStatus?.email ?? 'No conectada'} /><SettingField label="Estado" value={gmailStatus?.connected ? 'OAuth activo · Gmail API' : 'Esperando autorización'} /></div><div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs ${gmailStatus?.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{gmailStatus?.connected ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}{gmailStatus?.connected ? 'Cuenta conectada. La pantalla Correos ya consulta datos reales.' : 'Pulsa el control para iniciar la autorización de Google.'}</div></IntegrationCard><IntegrationCard icon={Mail} iconClass="bg-violet-50 text-violet-600" title="IMAP empresarial" description="Pendiente de implementación en FastAPI." connected={imapConnected} onToggle={() => setImapConnected((value) => !value)}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><SettingField label="Servidor" value="Se configurará próximamente" /><SettingField label="Puerto" value="993" /><SettingField label="Usuario y correo" value="Pendiente" /><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Seguridad</span><select className="input"><option>SSL / TLS</option></select></label></div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="La extracción IA se conectará al backend sin exponer la API key." connected={geminiConnected} onToggle={() => setGeminiConnected((value) => !value)}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="API key" value="Configurada en el backend" placeholder /><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo de extracción</span><select className="input"><option>Gemini 1.5 Flash (recomendado)</option><option>Gemini 1.5 Pro</option></select></label></div></IntegrationCard></div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={Bell} title="Notificaciones" description="Alertas de nuevos documentos" /><SmallSetting icon={ShieldCheck} title="Privacidad" description="Token guardado en el servidor" /><SmallSetting icon={Code2} title="API FastAPI" description="Gmail conectado primero" /></div></>
}

function SettingsPage() {
  const [connected, setConnected] = useState({ gmail: true, imap: true, gemini: false })
  const [tested, setTested] = useState<string | null>(null)
  return <><PageHeading eyebrow="Integraciones y preferencias" title="Configuración" description="Administra las conexiones de Nexora. Todo lo que ves aquí es una demostración local."><span className="flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700"><CircleHelp size={14} />Conexiones simuladas</span></PageHeading><div className="mb-7 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-emerald-600" /><span>Por seguridad, Nexora no solicita ni guarda contraseñas o API keys reales en el navegador.</span></div></div><div className="space-y-5"><IntegrationCard icon={Globe2} iconClass="bg-blue-50 text-blue-600" title="Gmail" description="Conecta la cuenta de Gmail que recibe tus comprobantes." connected={connected.gmail} onToggle={() => setConnected({ ...connected, gmail: !connected.gmail })}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="Cuenta asociada" value="finanzas@acme.mx" /><SettingField label="Última sincronización" value="Hoy, 09:42 · Automática" /></div><div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700"><CheckCircle2 size={15} />Conexión activa y lista para sincronizar mensajes.</div></IntegrationCard><IntegrationCard icon={Mail} iconClass="bg-violet-50 text-violet-600" title="IMAP empresarial" description="Configura el buzón corporativo para consultar sus mensajes." connected={connected.imap} onToggle={() => setConnected({ ...connected, imap: !connected.imap })}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><SettingField label="Servidor" value="imap.acme.mx" /><SettingField label="Puerto" value="993" /><SettingField label="Usuario y correo" value="tesoreria@acme.mx" /><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Seguridad</span><select className="input"><option>SSL / TLS</option><option>STARTTLS</option></select></label></div><div className="mt-4 flex flex-wrap gap-2"><button onClick={() => setTested('imap')} className="btn-soft"><RefreshCw size={14} />Probar conexión</button>{tested === 'imap' && <span className="flex items-center gap-1.5 px-2 text-xs font-semibold text-emerald-600"><CheckCircle2 size={14} />Conexión exitosa (simulada)</span>}</div></IntegrationCard><IntegrationCard icon={Gem} iconClass="bg-violet-50 text-violet-600" title="Gemini" description="Utiliza IA para extraer datos de tus documentos bancarios." connected={connected.gemini} onToggle={() => setConnected({ ...connected, gemini: !connected.gemini })}><div className="grid gap-4 sm:grid-cols-2"><SettingField label="API key" value="No configurada" placeholder /><label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">Modelo de extracción</span><select className="input"><option>Gemini 1.5 Flash (recomendado)</option><option>Gemini 1.5 Pro</option></select></label></div><div className="mt-4 flex flex-wrap items-center gap-2"><button onClick={() => setTested('gemini')} className="btn-soft"><Sparkles size={14} />Probar conexión</button>{tested === 'gemini' && <span className="flex items-center gap-1.5 px-2 text-xs font-semibold text-amber-600"><CircleHelp size={14} />Agrega una key para conectar (simulado)</span>}</div></IntegrationCard></div><div className="mt-8 grid gap-4 md:grid-cols-3"><SmallSetting icon={Bell} title="Notificaciones" description="Alertas de nuevos documentos" /><SmallSetting icon={ShieldCheck} title="Privacidad" description="Datos de demostración protegidos" /><SmallSetting icon={Code2} title="API futura" description="Preparada para FastAPI" /></div></>
}

function IntegrationCard({ icon: CardIcon, iconClass, title, description, connected, onToggle, children }: { icon: Icon; iconClass: string; title: string; description: string; connected: boolean; onToggle: () => void; children: React.ReactNode }) { return <section className="panel p-5 sm:p-6"><div className="mb-6 flex items-start justify-between gap-4"><div className="flex gap-3"><div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}><CardIcon size={19} /></div><div><h3 className="font-display text-base font-bold text-ink">{title}</h3><p className="mt-1 text-xs text-slate-500">{description}</p></div></div>{title === 'Gmail' ? <button onClick={onToggle} className={connected ? 'btn-soft' : 'btn-primary'}>{connected ? 'Desconectar Gmail' : 'Conectar Gmail'}</button> : <button onClick={onToggle} className="flex items-center gap-2 text-xs font-semibold text-slate-500"><span className={`relative h-5 w-9 rounded-full transition ${connected ? 'bg-emerald-500' : 'bg-slate-200'}`}><span className={`absolute top-1 h-3 w-3 rounded-full bg-white shadow transition ${connected ? 'left-5' : 'left-1'}`} /></span>{connected ? 'Conectado' : 'Desconectado'}</button>}</div>{children}</section> }
function SettingField({ label, value, placeholder = false }: { label: string; value: string; placeholder?: boolean }) { return <label><span className="mb-1.5 block text-[11px] font-bold text-slate-500">{label}</span><div className={`input flex items-center justify-between ${placeholder ? 'text-slate-400' : ''}`}>{value}{placeholder && <span className="text-[10px] text-slate-400">No guardar</span>}</div></label> }
function SmallSetting({ icon: SmallIcon, title, description }: { icon: Icon; title: string; description: string }) { return <div className="panel flex items-center gap-3 p-4"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><SmallIcon size={16} /></div><div><div className="text-xs font-bold text-ink">{title}</div><div className="mt-0.5 text-[11px] text-slate-400">{description}</div></div><ChevronRight size={15} className="ml-auto text-slate-300" /></div> }

function avatarTone(tone: string) { const tones: Record<string, string> = { blue: 'bg-blue-100 text-blue-700', purple: 'bg-violet-100 text-violet-700', coral: 'bg-orange-100 text-orange-700', amber: 'bg-amber-100 text-amber-700' }; return tones[tone] ?? tones.blue }

export default App
