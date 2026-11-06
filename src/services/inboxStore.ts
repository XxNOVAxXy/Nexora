import { gmailApi, type FiltroCorreo, type GmailMessage, type GmailStatus } from './gmailApi'
import { FINGERPRINT_LEGADO, type ClassificationCache, type EmailClassification } from './emailClassification'
import { extraccionesApi, type EntradaListado } from './extraccionesApi'
import { preferenciasApi, type ConfigRemitentes } from './preferenciasApi'

export type MailFolder = 'inbox' | 'sent' | 'archive' | 'trash'
export type ClassificationOverride = { classification: EmailClassification; fingerprint: string }
export type EstadosExtraccion = Record<string, EntradaListado>

/** Listado acumulado de una carpeta con un filtro y una configuración de remitentes concretos. */
export type Listado = {
  clave: string
  messages: GmailMessage[]
  nextPageToken: string | null
  sinRemitentes: boolean
  remitentes: number
  descartados: number
  firmaFiltro: string
  /** Tokens de las páginas ya cargadas (null = primera página). */
  paginas: (string | null)[]
  fetchedAt: number
}

/** How long a listing is reused before asking Gmail again. */
const MESSAGES_TTL_MS = 60_000
const ESTADOS_TTL_MS = 30_000
/** Clave antigua, sin cuenta: se conserva intacta como respaldo y solo se reparte a la cuenta dueña de cada correo. */
const LEGACY_OVERRIDES_KEY = 'nexora.classificationOverrides'
const RESPALDO_OVERRIDES_KEY = 'nexora.classificationOverrides.respaldo'
const claveOverrides = (cuentaId: string) => `${LEGACY_OVERRIDES_KEY}.${cuentaId}`
const ID_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CLASIFICACIONES_VALIDAS = new Set<EmailClassification>(['ESTADO_DE_CUENTA', 'NO_ES_ESTADO_DE_CUENTA', 'REQUIERE_REVISION'])

const listados = new Map<string, Listado>()
const inflightListados = new Map<string, Promise<Listado>>()
let inflightStatus: Promise<GmailStatus> | null = null
let lastStatus: GmailStatus | null = null
let lastFolder: MailFolder = 'inbox'
let lastFiltro: FiltroCorreo = 'estados'
let classificationCache: ClassificationCache = {}
let estados: { cuentaId: string; mapa: EstadosExtraccion; fetchedAt: number } | null = null
let inflightEstados: Promise<EstadosExtraccion> | null = null
let remitentes: (ConfigRemitentes & { cuentaId: string | null }) | null = null
let clasificaciones: { cuentaId: string | null; mapa: Record<string, ClassificationOverride>; migradoEn: string | null } | null = null
let inflightMigracion: Promise<ResultadoMigracion> | null = null
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version += 1; listeners.forEach((listener) => listener()) }

export type ResultadoMigracion = { migradas: number; yaMigrado: boolean }

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function leerOverrides(clave: string): Record<string, ClassificationOverride> {
  try {
    const raw = storage()?.getItem(clave)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, ClassificationOverride> : {}
  } catch {
    return {}
  }
}

const limpiarCuenta = () => {
  listados.clear()
  classificationCache = {}
  estados = null
  remitentes = null
  clasificaciones = null
}

export const claveEstado = (messageId: string, partId: string) => `${messageId}__${partId}`
/** La clave del listado incluye carpeta, filtro y, con el filtro por remitentes, la firma de la lista con que se filtró. */
export const claveListado = (folder: MailFolder, filtro: FiltroCorreo, firma: string | null) => `${folder}|${filtro}|${filtro === 'remitentes' ? firma ?? '?' : '-'}`

function guardarPagina(clave: string, folder: MailFolder, filtro: FiltroCorreo, pagina: Awaited<ReturnType<typeof gmailApi.listar>>, previo: Listado | null, token: string | null): Listado {
  const vistos = new Set(previo?.messages.map((message) => message.id) ?? [])
  const nuevos = pagina.messages.filter((message) => !vistos.has(message.id) && vistos.add(message.id))
  const listado: Listado = {
    clave,
    messages: [...(previo?.messages ?? []), ...nuevos],
    nextPageToken: pagina.nextPageToken,
    sinRemitentes: pagina.sinRemitentes,
    remitentes: pagina.remitentes,
    descartados: (previo?.descartados ?? 0) + pagina.descartados,
    firmaFiltro: pagina.firmaFiltro,
    paginas: [...(previo?.paginas ?? []), token],
    fetchedAt: previo?.fetchedAt ?? Date.now(),
  }
  // Si la configuración cambió en otra pestaña, la firma de la respuesta manda: se guarda bajo su clave real.
  const claveReal = claveListado(folder, filtro, pagina.firmaFiltro)
  if (filtro === 'remitentes' && remitentes && remitentes.firma !== pagina.firmaFiltro) remitentes = null
  listados.set(claveReal, { ...listado, clave: claveReal })
  if (claveReal !== clave) listados.delete(clave)
  return listados.get(claveReal)!
}

export const inboxStore = {
  /** For useSyncExternalStore: components re-render when status or cached listings change. */
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  version: () => version,
  lastFolder: () => lastFolder,
  setLastFolder: (folder: MailFolder) => { lastFolder = folder },
  lastFiltro: () => lastFiltro,
  setLastFiltro: (filtro: FiltroCorreo) => { lastFiltro = filtro },
  cachedStatus: () => lastStatus,
  classificationCache: () => classificationCache,
  setClassificationCache: (cache: ClassificationCache) => { classificationCache = cache },

  /** Shares one in-flight request so double mounts (StrictMode) or quick navigation don't duplicate calls. */
  loadStatus: (): Promise<GmailStatus> => {
    if (inflightStatus) return inflightStatus
    inflightStatus = gmailApi.status()
      .then((status) => {
        // A different (or no) account invalidates everything cached for the previous one.
        // While Gmail throttles, the backend reports connected without an email: keep the cache then.
        const accountChanged = Boolean(status.email && lastStatus?.email && status.email !== lastStatus.email)
        if (!status.connected || accountChanged) limpiarCuenta()
        lastStatus = status.connected && !status.email ? { ...status, email: lastStatus?.email ?? null, cuentaId: lastStatus?.cuentaId ?? null } : status
        notify()
        return lastStatus
      })
      .finally(() => { inflightStatus = null })
    return inflightStatus
  },

  // --- Remitentes (configuración del backend) ---------------------------------------------------
  cachedRemitentes: () => (remitentes && remitentes.cuentaId === (lastStatus?.cuentaId ?? null) ? remitentes : null),
  loadRemitentes: async ({ force = false }: { force?: boolean } = {}): Promise<ConfigRemitentes> => {
    const cuenta = lastStatus?.cuentaId ?? null
    if (!force && remitentes && remitentes.cuentaId === cuenta) return remitentes
    const config = await preferenciasApi.remitentes()
    remitentes = { ...config, cuentaId: cuenta }
    return remitentes
  },
  /** Tras guardar remitentes: los listados filtrados con la configuración anterior dejan de valer. */
  setRemitentes: (config: ConfigRemitentes) => {
    remitentes = { ...config, cuentaId: lastStatus?.cuentaId ?? null }
    listados.clear()
    notify()
  },
  invalidarListados: () => { listados.clear(); notify() },

  // --- Listados paginados -------------------------------------------------------------------------
  cachedListado: (folder: MailFolder, filtro: FiltroCorreo): Listado | null => listados.get(claveListado(folder, filtro, remitentes?.firma ?? null)) ?? null,

  /** Primera página (o la caché si tiene menos de 60 s). La clave incluye filtro y firma de remitentes. */
  loadListado: async (folder: MailFolder, filtro: FiltroCorreo, { force = false }: { force?: boolean } = {}): Promise<Listado> => {
    if (filtro === 'remitentes' && !inboxStore.cachedRemitentes()) await inboxStore.loadRemitentes()
    const clave = claveListado(folder, filtro, remitentes?.firma ?? null)
    const entrada = listados.get(clave)
    if (!force && entrada && Date.now() - entrada.fetchedAt < MESSAGES_TTL_MS) return entrada
    const pendiente = inflightListados.get(clave)
    if (pendiente) return pendiente
    const peticion = gmailApi.listar(folder, { filtro })
      .then((pagina) => { const listado = guardarPagina(clave, folder, filtro, pagina, null, null); notify(); return listado })
      .finally(() => { inflightListados.delete(clave) })
    inflightListados.set(clave, peticion)
    return peticion
  },

  /** "Cargar más": añade la siguiente página sin perder lo cargado y sin repetir correos. */
  loadMore: async (folder: MailFolder, filtro: FiltroCorreo): Promise<Listado | null> => {
    const clave = claveListado(folder, filtro, remitentes?.firma ?? null)
    const entrada = listados.get(clave)
    if (!entrada?.nextPageToken) return entrada ?? null
    const token = entrada.nextPageToken
    const claveVuelo = `${clave}#${token}`
    const pendiente = inflightListados.get(claveVuelo)
    if (pendiente) return pendiente
    const peticion = gmailApi.listar(folder, { filtro, pageToken: token })
      .then((pagina) => {
        const actual = listados.get(clave)
        // Si mientras tanto se recargó la primera página o cambió el filtro, esta página ya no corresponde.
        if (!actual || actual.nextPageToken !== token) return actual ?? entrada
        const listado = guardarPagina(clave, folder, filtro, pagina, actual, token)
        notify()
        return listado
      })
      .finally(() => { inflightListados.delete(claveVuelo) })
    inflightListados.set(claveVuelo, peticion)
    return peticion
  },

  /** Estado guardado (borrador/revisado) de cada documento de la cuenta conectada, por `messageId__partId`. */
  loadEstados: ({ force = false }: { force?: boolean } = {}): Promise<EstadosExtraccion> => {
    if (!force && estados && estados.cuentaId === lastStatus?.cuentaId && Date.now() - estados.fetchedAt < ESTADOS_TTL_MS) return Promise.resolve(estados.mapa)
    if (inflightEstados) return inflightEstados
    inflightEstados = extraccionesApi.listar()
      .then(({ cuentaId, extracciones }) => {
        const mapa = Object.fromEntries(extracciones.map((entrada) => [claveEstado(entrada.messageId, entrada.partId), entrada]))
        // Solo se conserva si la respuesta es de la cuenta que la interfaz considera conectada.
        if (!lastStatus?.cuentaId || lastStatus.cuentaId === cuentaId) estados = { cuentaId, mapa, fetchedAt: Date.now() }
        return lastStatus?.cuentaId && lastStatus.cuentaId !== cuentaId ? {} : mapa
      })
      .finally(() => { inflightEstados = null })
    return inflightEstados
  },
  invalidarEstados: () => { estados = null },

  clear: () => {
    limpiarCuenta()
    lastStatus = null
    notify()
  },

  // --- Clasificaciones manuales (backend) -----------------------------------------------------------
  cachedClasificaciones: (): Record<string, ClassificationOverride> => (clasificaciones && clasificaciones.cuentaId === (lastStatus?.cuentaId ?? null) ? clasificaciones.mapa : {}),
  loadClasificaciones: async ({ force = false }: { force?: boolean } = {}) => {
    const cuenta = lastStatus?.cuentaId ?? null
    if (!force && clasificaciones && clasificaciones.cuentaId === cuenta) return clasificaciones
    const estado = await preferenciasApi.clasificaciones()
    const mapa = Object.fromEntries(Object.entries(estado.clasificaciones).map(([id, entrada]) => [id, { classification: entrada.classification, fingerprint: entrada.fingerprint }]))
    clasificaciones = { cuentaId: cuenta, mapa, migradoEn: estado.migrado_en }
    return clasificaciones
  },
  ponerClasificacion: async (messageId: string, override: ClassificationOverride) => {
    await preferenciasApi.ponerClasificacion(messageId, override)
    if (clasificaciones) clasificaciones = { ...clasificaciones, mapa: { ...clasificaciones.mapa, [messageId]: override } }
  },
  quitarClasificacion: async (messageId: string) => {
    await preferenciasApi.quitarClasificacion(messageId)
    if (clasificaciones) clasificaciones = { ...clasificaciones, mapa: Object.fromEntries(Object.entries(clasificaciones.mapa).filter(([id]) => id !== messageId)) }
  },

  /**
   * Migración única de las clasificaciones de este navegador al backend.
   * 1) reparte la clave antigua sin cuenta (solo correos visibles de esta cuenta);
   * 2) envía las de `nexora.classificationOverrides.<cuenta>`: los correos visibles con su huella nueva y el resto
   *    como "legado" (se adoptará la huella la primera vez que se vean);
   * 3) si el backend la aceptó, renombra la clave a `.migrado` (respaldo; nunca se borra su contenido).
   */
  migrarClasificaciones: (cuentaId: string, visibles: GmailMessage[], huella: (message: GmailMessage) => string): Promise<ResultadoMigracion> => {
    if (inflightMigracion) return inflightMigracion
    inflightMigracion = (async () => {
      const estado = await inboxStore.loadClasificaciones()
      if (estado.migradoEn) return { migradas: 0, yaMigrado: true }
      inboxStore.asignarOverridesLegados(cuentaId, visibles.map((message) => message.id))
      const clave = claveOverrides(cuentaId)
      const locales = leerOverrides(clave)
      const porId = new Map(visibles.map((message) => [message.id, message]))
      const payload = Object.fromEntries(Object.entries(locales)
        .filter(([id, override]) => ID_SEGURO.test(id) && CLASIFICACIONES_VALIDAS.has(override?.classification))
        .map(([id, override]) => [id, { classification: override.classification, fingerprint: porId.has(id) ? huella(porId.get(id)!) : FINGERPRINT_LEGADO }]))
      const respuesta = await preferenciasApi.migrarClasificaciones(payload)
      const almacen = storage()
      if (!respuesta.ya_migrado && almacen && almacen.getItem(clave) !== null) {
        try {
          almacen.setItem(`${clave}.migrado`, almacen.getItem(clave)!)
          almacen.removeItem(clave)
        } catch {
          // Sin almacenamiento: la copia original simplemente se queda donde está.
        }
      }
      await inboxStore.loadClasificaciones({ force: true })
      notify()
      return { migradas: respuesta.migradas, yaMigrado: respuesta.ya_migrado }
    })().finally(() => { inflightMigracion = null })
    return inflightMigracion
  },

  /** Clasificaciones de una cuenta guardadas en este navegador antes de pasar al backend (solo para migrar). */
  loadOverrides: (cuentaId: string | null): Record<string, ClassificationOverride> => (cuentaId ? leerOverrides(claveOverrides(cuentaId)) : {}),

  saveOverrides: (cuentaId: string | null, overrides: Record<string, ClassificationOverride>) => {
    if (!cuentaId) return
    try {
      storage()?.setItem(claveOverrides(cuentaId), JSON.stringify(overrides))
    } catch {
      // Storage may be unavailable (private mode).
    }
  },

  /**
   * Reparte las clasificaciones de la clave antigua (sin cuenta) a la cuenta conectada, solo para los correos
   * que aparecen en ella. La clave antigua se renombra a `.respaldo` y nunca se borra su contenido.
   * Devuelve cuántas clasificaciones se asignaron ahora.
   */
  asignarOverridesLegados: (cuentaId: string, messageIds: string[]): number => {
    const almacen = storage()
    if (!almacen) return 0
    try {
      const legado = almacen.getItem(LEGACY_OVERRIDES_KEY)
      if (legado !== null) {
        const respaldo = { ...leerOverrides(LEGACY_OVERRIDES_KEY), ...leerOverrides(RESPALDO_OVERRIDES_KEY) }
        almacen.setItem(RESPALDO_OVERRIDES_KEY, JSON.stringify(respaldo))
        almacen.removeItem(LEGACY_OVERRIDES_KEY)
      }
      const respaldo = leerOverrides(RESPALDO_OVERRIDES_KEY)
      if (Object.keys(respaldo).length === 0) return 0
      const actuales = leerOverrides(claveOverrides(cuentaId))
      let asignadas = 0
      for (const id of messageIds) {
        if (respaldo[id] && !actuales[id]) {
          actuales[id] = respaldo[id]
          asignadas += 1
        }
      }
      if (asignadas) almacen.setItem(claveOverrides(cuentaId), JSON.stringify(actuales))
      return asignadas
    } catch {
      return 0
    }
  },
}
