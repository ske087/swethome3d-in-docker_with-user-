import { CONTENT_PREFIX, dataUrlToBytes, guessMime } from '../model/contents'
import { createEmptyHome, normalizeHome, type Home } from '../model/home'
import { openDatabase, type ProjectSummary } from './db'
import {
  initialSync,
  pushContents,
  pushCreatedProject,
  pushDeletedProject,
  pushHome,
  pushRename,
  pushThumbnail,
} from './serverSync'

export type { ProjectSummary } from './db'

const LAST_KEY = 'sweet3d:last-project'

let migrated: Promise<void> | null = null

/**
 * Datenbank, vorher einmalig Projekte aus der früheren localStorage-Ablage übernehmen und den
 * lokalen Stand mit dem Server abgleichen.
 */
async function database() {
  migrated ??= migrateFromLocalStorage().then(() => initialSync())
  await migrated
  return openDatabase()
}

/** Alle Projekte, zuletzt geänderte zuerst. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const projects = await (await database()).getAll('projects')
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getProject(id: string): Promise<{ summary: ProjectSummary; home: Home } | null> {
  const db = await database()
  const [summary, home] = await Promise.all([db.get('projects', id), db.get('homes', id)])
  return summary && home ? { summary, home: normalizeHome(home) } : null
}

/**
 * Legt ein Projekt samt importierter Dateien in einer Transaktion an. Wirft bei zu wenig
 * Speicherplatz (QuotaExceededError), ohne etwas anzulegen.
 */
export async function createProject(name: string, home: Home = createEmptyHome(), contents: Record<string, Blob> = {}): Promise<ProjectSummary> {
  const db = await database()
  const now = new Date().toISOString()
  const summary: ProjectSummary = { id: crypto.randomUUID(), name: uniqueName(name, await db.getAll('projects')), createdAt: now, updatedAt: now }
  const tx = db.transaction(['projects', 'homes', 'contents'], 'readwrite')
  await Promise.all([
    ...Object.entries(contents).map(([key, blob]) => tx.objectStore('contents').put(blob, key)),
    tx.objectStore('homes').put(home, summary.id),
    tx.objectStore('projects').put(summary),
    tx.done,
  ])
  pushCreatedProject(summary, home, contents)
  return summary
}

/** Speichert den Inhalt eines Projekts; ein inzwischen gelöschtes Projekt wird nicht wieder angelegt. */
export async function saveHome(id: string, home: Home) {
  const db = await database()
  const tx = db.transaction(['projects', 'homes'], 'readwrite')
  const summary = await tx.objectStore('projects').get(id)
  if (summary) {
    const updated = { ...summary, updatedAt: new Date().toISOString() }
    await Promise.all([tx.objectStore('homes').put(home, id), tx.objectStore('projects').put(updated)])
  }
  await tx.done
  if (summary) pushHome(id, home)
}

export async function renameProject(id: string, name: string) {
  const db = await database()
  const summary = await db.get('projects', id)
  if (summary) {
    await db.put('projects', { ...summary, name: name.trim(), updatedAt: new Date().toISOString() })
    pushRename(id)
  }
}

/** Kopie mit demselben Inhalt; importierte Dateien werden gemeinsam genutzt. */
export async function duplicateProject(id: string, name: string, home?: Home): Promise<ProjectSummary | null> {
  const source = home ?? (await getProject(id))?.home
  return source ? createProject(name, source) : null
}

export async function deleteProject(id: string) {
  const db = await database()
  const tx = db.transaction(['projects', 'homes'], 'readwrite')
  await Promise.all([tx.objectStore('projects').delete(id), tx.objectStore('homes').delete(id), tx.done])
  if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY)
  pushDeletedProject(id)
  await removeUnusedContents()
}

/** Löscht importierte Dateien, auf die weder ein Projekt noch eine importierte Bibliothek verweist. */
export async function removeUnusedContents() {
  const db = await database()
  // Verweise stecken in Modellen, Symbolen und Texturen: im ganzen Projekt bzw. der Bibliothek danach suchen
  const pattern = new RegExp(`${CONTENT_PREFIX}([^/"]+)`, 'g')
  const used = new Set<string>()
  for (const owner of [...(await db.getAll('homes')), ...(await db.getAll('libraries'))]) {
    for (const match of JSON.stringify(owner).matchAll(pattern)) used.add(match[1])
  }
  const tx = db.transaction('contents', 'readwrite')
  for (const key of await tx.store.getAllKeys()) {
    if (!used.has(key.split('/')[0])) await tx.store.delete(key)
  }
  await tx.done
}

/** Legt Dateien ab, z. B. ein eigenes Texturbild; Schlüssel wie in „content:<Schlüssel>“. */
export async function saveContents(contents: Record<string, Blob>) {
  const db = await database()
  const tx = db.transaction('contents', 'readwrite')
  await Promise.all([...Object.entries(contents).map(([key, blob]) => tx.store.put(blob, key)), tx.done])
  pushContents(contents)
}

/** Speichert das Vorschaubild, ohne das Änderungsdatum anzufassen. */
export async function saveThumbnail(id: string, thumbnail: Blob) {
  const db = await database()
  const tx = db.transaction('projects', 'readwrite')
  const summary = await tx.store.get(id)
  if (summary) await tx.store.put({ ...summary, thumbnail })
  await tx.done
  if (summary) pushThumbnail(id, thumbnail)
}

export function lastProjectId(): string | null {
  return localStorage.getItem(LAST_KEY)
}

export function setLastProject(id: string) {
  localStorage.setItem(LAST_KEY, id)
}

/** Hängt bei Namensgleichheit eine Nummer an: „Neues Projekt 2“. */
function uniqueName(name: string, projects: ProjectSummary[]): string {
  const base = name.trim() || 'Sweet3D'
  const names = new Set(projects.map((p) => p.name))
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Belegter und verfügbarer Speicher dieser Seite laut Browser (in Bytes). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const estimate = await navigator.storage?.estimate?.()
  return estimate?.usage !== undefined && estimate?.quota !== undefined ? { usage: estimate.usage, quota: estimate.quota } : null
}

/** Bittet den Browser, die Daten nicht bei Platzmangel automatisch zu löschen. */
export function requestPersistentStorage() {
  void navigator.storage?.persist?.().catch(() => false)
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)
}

/**
 * Übernimmt Projekte der früheren localStorage-Ablage (Index „sweet3d:projects“, Inhalte
 * „sweet3d:project:<id>“ mit importierten Dateien als Data-URLs) und entfernt sie dort.
 */
async function migrateFromLocalStorage() {
  const index = localStorage.getItem('sweet3d:projects')
  if (index === null) return
  const db = await openDatabase()
  for (const summary of JSON.parse(index) as ProjectSummary[]) {
    const raw = localStorage.getItem(`sweet3d:project:${summary.id}`)
    if (raw === null) continue
    const { contents = {}, ...home } = JSON.parse(raw) as Home & { contents?: Record<string, string> }
    const tx = db.transaction(['projects', 'homes', 'contents'], 'readwrite')
    await Promise.all([
      ...Object.entries(contents).map(([key, url]) => {
        const bytes = dataUrlToBytes(url)
        return tx.objectStore('contents').put(new Blob([bytes], { type: guessMime(bytes, key) }), key)
      }),
      tx.objectStore('homes').put(normalizeHome(home), summary.id),
      tx.objectStore('projects').put(summary),
      tx.done,
    ])
    localStorage.removeItem(`sweet3d:project:${summary.id}`)
  }
  localStorage.removeItem('sweet3d:projects')
}
