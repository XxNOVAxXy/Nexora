import { gmailApi, type GmailMessage, type GmailStatus } from './gmailApi'
import type { ClassificationCache, EmailClassification } from './emailClassification'

export type MailFolder = 'inbox' | 'sent' | 'archive' | 'trash'
export type ClassificationOverride = { classification: EmailClassification; fingerprint: string }

/** How long a folder listing is reused before asking Gmail again (each listing costs ~130 quota units). */
const MESSAGES_TTL_MS = 60_000
const OVERRIDES_STORAGE_KEY = 'nexora.classificationOverrides'

type FolderEntry = { messages: GmailMessage[]; fetchedAt: number }

const messagesByFolder = new Map<MailFolder, FolderEntry>()
const inflightMessages = new Map<MailFolder, Promise<GmailMessage[]>>()
let inflightStatus: Promise<GmailStatus> | null = null
let lastStatus: GmailStatus | null = null
let lastFolder: MailFolder = 'inbox'
let classificationCache: ClassificationCache = {}
let version = 0
const listeners = new Set<() => void>()
const notify = () => { version += 1; listeners.forEach((listener) => listener()) }

export const inboxStore = {
  /** For useSyncExternalStore: components re-render when status or cached listings change. */
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  version: () => version,
  lastFolder: () => lastFolder,
  setLastFolder: (folder: MailFolder) => { lastFolder = folder },
  cachedStatus: () => lastStatus,
  cachedMessages: (folder: MailFolder) => messagesByFolder.get(folder)?.messages ?? null,
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
        if (!status.connected || accountChanged) messagesByFolder.clear()
        lastStatus = status.connected && !status.email ? { ...status, email: lastStatus?.email ?? null } : status
        notify()
        return status
      })
      .finally(() => { inflightStatus = null })
    return inflightStatus
  },

  loadMessages: (folder: MailFolder, { force = false }: { force?: boolean } = {}): Promise<GmailMessage[]> => {
    const entry = messagesByFolder.get(folder)
    if (!force && entry && Date.now() - entry.fetchedAt < MESSAGES_TTL_MS) return Promise.resolve(entry.messages)
    const pending = inflightMessages.get(folder)
    if (pending) return pending
    const request = gmailApi.messages(folder)
      .then((messages) => {
        messagesByFolder.set(folder, { messages, fetchedAt: Date.now() })
        notify()
        return messages
      })
      .finally(() => { inflightMessages.delete(folder) })
    inflightMessages.set(folder, request)
    return request
  },

  clear: () => {
    messagesByFolder.clear()
    lastStatus = null
    classificationCache = {}
    notify()
  },

  loadOverrides: (): Record<string, ClassificationOverride> => {
    try {
      const raw = window.localStorage.getItem(OVERRIDES_STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed as Record<string, ClassificationOverride> : {}
    } catch {
      return {}
    }
  },

  saveOverrides: (overrides: Record<string, ClassificationOverride>) => {
    try {
      window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
    } catch {
      // Storage may be unavailable (private mode); corrections then last for the session only.
    }
  },
}
