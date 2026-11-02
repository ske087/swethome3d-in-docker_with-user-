import { normalizeHome, type Home } from '../model/home'
import { openDatabase, prefixRange, type ProjectSummary } from './db'
import { useSyncStatusStore, type SyncState } from './syncStatus'

/**
 * Mirror of the local IndexedDB storage on the sync server.
 *
 * The browser stays the primary store while editing. Every local write is queued here and pushed
 * in the background. On startup the newest version of each project is pulled from the server, so a
 * different computer (or a cleared browser profile) picks up the same workspace.
 *
 * Deletions are remembered locally until the server accepted them. Conflicts are resolved by the
 * `updatedAt` timestamp (last write wins).
 */

interface RemoteSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  hasThumbnail?: boolean
}

interface RemoteProjectList {
  projects: RemoteSummary[]
  deleted: string[]
}

interface RemoteProject {
  summary: RemoteSummary
  home: Home
}

const API = '/api'
const PENDING_DELETES = 'sweet3d:pending-deletes'
const UPLOADED_CONTENTS = 'sweet3d:uploaded-contents'
const LAST_PROJECT = 'sweet3d:last-project'
const LIST_TIMEOUT_MS = 6000
const DOWNLOAD_TIMEOUT_MS = 60_000
const CONTENT_CACHE_TTL_MS = 30_000

export class SyncError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface RequestOptions extends RequestInit {
  timeout?: number
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const { timeout, ...init } = options
  const controller = timeout ? new AbortController() : undefined
  const timer = controller ? window.setTimeout(() => controller.abort(), timeout) : undefined
  try {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      ...init,
      signal: controller?.signal,
    })
    if (!response.ok) throw new SyncError(response.status, `HTTP ${response.status}`)
    return response
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

async function getJson<T>(path: string, timeout?: number): Promise<T> {
  return (await request(path, { timeout })).json() as Promise<T>
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof SyncError && error.status === 401
}

let redirected = false

/** Session expired or user signed out in another tab: back to the login page. */
function handleUnauthorized(error: unknown): boolean {
  if (!isUnauthorized(error)) return false
  if (!redirected && !location.pathname.startsWith('/login')) {
    redirected = true
    location.replace('/login')
  }
  return true
}

let warned = new Set<string>()

function warnOnce(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (warned.has(message)) return
  warned.add(message)
  console.warn('[sync]', error)
}

/* -------------------------------------------------------------------------------------------- */
/* Content keys                                                                                  */
/* -------------------------------------------------------------------------------------------- */

function encodeContentKey(key: string): string {
  const bytes = new TextEncoder().encode(key)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const value = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function writeStringArray(key: string, values: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(values))
  } catch {
    // Storage full: the in-memory state still works for this session.
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Uploaded contents                                                                             */
/* -------------------------------------------------------------------------------------------- */

const uploadedContents = new Set<string>()
const uploadedContentIds = new Set<string>()
let persistContentsTimer: number | undefined

function addUploaded(key: string) {
  uploadedContents.add(key)
  uploadedContentIds.add(key.split('/')[0])
}

for (const key of readStringArray(UPLOADED_CONTENTS)) addUploaded(key)

function markUploaded(key: string) {
  addUploaded(key)
  if (persistContentsTimer) return
  persistContentsTimer = window.setTimeout(() => {
    persistContentsTimer = undefined
    writeStringArray(UPLOADED_CONTENTS, [...uploadedContents])
  }, 1000)
}

async function uploadContent(key: string, blob: Blob): Promise<void> {
  if (uploadedContents.has(key)) return
  await request(`/contents/${encodeContentKey(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    timeout: DOWNLOAD_TIMEOUT_MS,
  })
  markUploaded(key)
  contentKeysCache.clear()
}

/** Uploads all files of every imported model/texture referenced by the home. */
async function uploadReferencedContents(home: Home): Promise<void> {
  const ids = new Set<string>()
  for (const match of JSON.stringify(home).matchAll(/content:([^"\\]+)/g)) ids.add(match[1].split('/')[0])
  if (ids.size === 0) return

  const db = await openDatabase()
  for (const id of ids) {
    if (uploadedContentIds.has(id)) continue
    const keys = (await db.getAllKeys('contents', prefixRange(id))).filter(
      (key): key is string => typeof key === 'string' && (key === id || key.startsWith(`${id}/`)),
    )
    const pending = keys.filter((key) => !uploadedContents.has(key))
    if (pending.length === 0) {
      uploadedContentIds.add(id)
      continue
    }
    const blobs = await Promise.all(pending.map((key) => db.get('contents', key)))
    for (let i = 0; i < pending.length; i++) {
      const blob = blobs[i]
      if (!blob) continue
      try {
        await uploadContent(pending[i], blob)
      } catch (error) {
        warnOnce(error)
      }
    }
    uploadedContentIds.add(id)
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Per-project upload queue                                                                      */
/* -------------------------------------------------------------------------------------------- */

const queues = new Map<string, Promise<void>>()

function reportStatus(id: string, patch: { state: SyncState; lastSyncedAt?: number | null; error?: string | null }) {
  useSyncStatusStore.getState().set(id, patch)
}

const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000

const failedProjects = new Set<string>()
let retryTimer: number | undefined
let retryDelay = RETRY_MIN_MS

/** Retries failed uploads with a growing delay, so an offline server does not spin. */
function scheduleRetry(id: string) {
  failedProjects.add(id)
  if (retryTimer !== undefined) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    const ids = [...failedProjects]
    failedProjects.clear()
    for (const projectId of ids) void resyncProject(projectId)
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
}

/** Uploads the current local state of a project again, e.g. after the server was unreachable. */
async function resyncProject(id: string): Promise<void> {
  const db = await openDatabase()
  const home = await db.get('homes', id)
  // A project deleted in the meantime needs no upload; the delete has its own queue entry.
  if (!home) return
  await pushHome(id, home)
}

/** Manual retry, used by the status badge when it shows that the server was not reached. */
export function syncNow(id: string): void {
  retryDelay = RETRY_MIN_MS
  failedProjects.delete(id)
  void resyncProject(id)
}

function describeError(error: unknown): string {
  return error instanceof SyncError ? String(error.status) : 'offline'
}

function enqueue(id: string, task: () => Promise<void>): Promise<void> {
  reportStatus(id, { state: 'pending', error: null })
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      reportStatus(id, { state: 'syncing' })
      await task()
      reportStatus(id, { state: 'synced', lastSyncedAt: Date.now(), error: null })
      retryDelay = RETRY_MIN_MS
    })
    .catch((error: unknown) => {
      warnOnce(error)
      reportStatus(id, { state: 'error', error: describeError(error) })
      scheduleRetry(id)
    })
  queues.set(id, next)
  return next
}

async function uploadProject(id: string, home: Home): Promise<void> {
  const db = await openDatabase()
  const summary = await db.get('projects', id)
  if (!summary) return
  await request(`/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: summary.name, createdAt: summary.createdAt, updatedAt: summary.updatedAt, home }),
    timeout: DOWNLOAD_TIMEOUT_MS,
  })
  await uploadReferencedContents(home)
}

/** Called after a project was created locally. */
export function pushCreatedProject(summary: ProjectSummary, home: Home, contents: Record<string, Blob>): void {
  void enqueue(summary.id, async () => {
    for (const [key, blob] of Object.entries(contents)) {
      try {
        await uploadContent(key, blob)
      } catch (error) {
        warnOnce(error)
      }
    }
    await uploadProject(summary.id, home)
  })
}

/** Called after the autosave wrote a new home to IndexedDB. */
export function pushHome(id: string, home: Home): Promise<void> {
  return enqueue(id, () => uploadProject(id, home))
}

/** Called after a project was renamed locally. */
export function pushRename(id: string): void {
  void enqueue(id, async () => {
    const db = await openDatabase()
    const summary = await db.get('projects', id)
    if (!summary) return
    await request(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: summary.name, updatedAt: summary.updatedAt }),
    })
  })
}

/** Called after a project was deleted locally. Retried on the next start if the server is offline. */
export function pushDeletedProject(id: string): void {
  const pending = readStringArray(PENDING_DELETES)
  if (!pending.includes(id)) writeStringArray(PENDING_DELETES, [...pending, id])
  void enqueue(id, async () => {
    await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    writeStringArray(
      PENDING_DELETES,
      readStringArray(PENDING_DELETES).filter((entry) => entry !== id),
    )
    useSyncStatusStore.getState().forget(id)
    await request('/maintenance/cleanup', { method: 'POST', timeout: DOWNLOAD_TIMEOUT_MS }).catch(() => {})
  })
}

/** Called when the 3D view recorded a new preview image. */
export function pushThumbnail(id: string, thumbnail: Blob): void {
  void enqueue(id, async () => {
    const db = await openDatabase()
    if (!(await db.get('projects', id))) return
    await request(`/projects/${encodeURIComponent(id)}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': thumbnail.type || 'image/webp' },
      body: thumbnail,
      timeout: DOWNLOAD_TIMEOUT_MS,
    })
  })
}

/** Called for binaries saved outside a project (background images, custom textures). */
export function pushContents(contents: Record<string, Blob>): void {
  for (const [key, blob] of Object.entries(contents)) {
    void uploadContent(key, blob).catch((error) => warnOnce(error))
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Reading content from the server                                                               */
/* -------------------------------------------------------------------------------------------- */

const contentKeysCache = new Map<string, { at: number; keys: string[] }>()

/** Keys the server knows for a content id (including all files of a multi-part model). */
export async function remoteContentKeys(prefix: string): Promise<string[]> {
  const cached = contentKeysCache.get(prefix)
  if (cached && Date.now() - cached.at < CONTENT_CACHE_TTL_MS) return cached.keys
  try {
    const { keys } = await getJson<{ keys: string[] }>(`/contents/list?prefix=${encodeURIComponent(prefix)}`, LIST_TIMEOUT_MS)
    contentKeysCache.set(prefix, { at: Date.now(), keys })
    return keys
  } catch {
    return []
  }
}

/** Downloads one binary, or null when it is not on the server or the server is unreachable. */
export async function fetchRemoteContent(key: string): Promise<Blob | null> {
  try {
    const response = await request(`/contents/${encodeContentKey(key)}`, { timeout: DOWNLOAD_TIMEOUT_MS })
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    return new Blob([await response.arrayBuffer()], { type })
  } catch (error) {
    if (!handleUnauthorized(error)) warnOnce(error)
    return null
  }
}

async function fetchRemoteThumbnail(id: string): Promise<Blob | null> {
  try {
    const response = await request(`/projects/${encodeURIComponent(id)}/thumbnail`, { timeout: LIST_TIMEOUT_MS })
    return await response.blob()
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Initial synchronization                                                                       */
/* -------------------------------------------------------------------------------------------- */

let syncPromise: Promise<void> | null = null

/**
 * The server could not be reached, so no project is confirmed there. Shown as "saved locally only"
 * instead of leaving the badge silent, which would look like a successful sync.
 */
async function markAllLocalOnly(): Promise<void> {
  const db = await openDatabase()
  for (const project of await db.getAll('projects')) {
    reportStatus(project.id, { state: 'error', error: 'offline' })
  }
}

/** Pulls newer projects from the server and uploads local ones. Runs once per page load. */
export function initialSync(): Promise<void> {
  if (!syncPromise) {
    syncPromise = runInitialSync().catch((error) => {
      if (handleUnauthorized(error)) syncPromise = null
      warnOnce(error)
    })
  }
  return syncPromise
}

async function runInitialSync(): Promise<void> {
  // Deletions that could not be sent last time.
  for (const id of readStringArray(PENDING_DELETES)) {
    try {
      await request(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
      writeStringArray(
        PENDING_DELETES,
        readStringArray(PENDING_DELETES).filter((entry) => entry !== id),
      )
    } catch (error) {
      if (isUnauthorized(error)) throw error
      await markAllLocalOnly()
      return // offline: keep the local state and try again next time
    }
  }

  let listed: RemoteProjectList
  try {
    listed = await getJson<RemoteProjectList>('/projects', LIST_TIMEOUT_MS)
  } catch (error) {
    if (isUnauthorized(error)) throw error
    await markAllLocalOnly()
    return // offline
  }

  // Remember which binaries already exist on the server so they are not uploaded again.
  try {
    const { keys } = await getJson<{ keys: string[] }>('/contents/list', LIST_TIMEOUT_MS)
    for (const key of keys) addUploaded(key)
  } catch (error) {
    if (isUnauthorized(error)) throw error
  }

  const db = await openDatabase()

  // Projects deleted on another computer.
  for (const id of listed.deleted) {
    if (!(await db.get('projects', id))) continue
    const tx = db.transaction(['projects', 'homes'], 'readwrite')
    await Promise.all([tx.objectStore('projects').delete(id), tx.objectStore('homes').delete(id), tx.done])
    if (localStorage.getItem(LAST_PROJECT) === id) localStorage.removeItem(LAST_PROJECT)
  }

  // Pull projects that are new or newer on the server.
  const local = new Map((await db.getAll('projects')).map((project) => [project.id, project]))
  const remoteIds = new Set(listed.projects.map((project) => project.id))
  for (const remote of listed.projects) {
    const localProject = local.get(remote.id)
    if (localProject && remote.updatedAt <= localProject.updatedAt) {
      const home = await db.get('homes', remote.id)
      if (home) {
        // The server holds this version (or an older one we are about to overwrite).
        reportStatus(remote.id, { state: 'synced', lastSyncedAt: Date.parse(remote.updatedAt) || Date.now(), error: null })
        // Edited here while offline (or the last upload failed): the local copy wins.
        if (localProject.updatedAt > remote.updatedAt) await enqueue(remote.id, () => uploadProject(remote.id, home))
        continue
      }
    }
    try {
      const { home } = await getJson<RemoteProject>(`/projects/${encodeURIComponent(remote.id)}`, DOWNLOAD_TIMEOUT_MS)
      const thumbnail = remote.hasThumbnail ? ((await fetchRemoteThumbnail(remote.id)) ?? localProject?.thumbnail) : localProject?.thumbnail
      const summary: ProjectSummary = {
        id: remote.id,
        name: remote.name,
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        ...(thumbnail ? { thumbnail } : {}),
      }
      const tx = db.transaction(['projects', 'homes'], 'readwrite')
      await Promise.all([
        tx.objectStore('projects').put(summary),
        tx.objectStore('homes').put(normalizeHome(home), remote.id),
        tx.done,
      ])
      reportStatus(remote.id, { state: 'synced', lastSyncedAt: Date.parse(remote.updatedAt) || Date.now(), error: null })
    } catch (error) {
      if (isUnauthorized(error)) throw error
      warnOnce(error)
    }
  }

  // Push projects that exist only locally (first upload or created offline).
  for (const project of await db.getAll('projects')) {
    if (remoteIds.has(project.id) || listed.deleted.includes(project.id)) continue
    const home = await db.get('homes', project.id)
    if (!home) continue
    await enqueue(project.id, () => uploadProject(project.id, home))
  }
}
