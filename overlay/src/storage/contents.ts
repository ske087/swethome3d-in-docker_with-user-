import { useEffect, useState } from 'react'
import { contentKey, isContentRef } from '../model/contents'
import { openDatabase, prefixRange } from './db'
import { fetchRemoteContent, remoteContentKeys } from './serverSync'

const urls = new Map<string, Promise<string | null>>()

/** Local binary from IndexedDB, falling back to the sync server and caching what it downloads. */
async function loadContent(key: string): Promise<Blob | null> {
  const db = await openDatabase()
  const local = await db.get('contents', key)
  if (local) return local
  const remote = await fetchRemoteContent(key)
  if (remote) await db.put('contents', remote, key)
  return remote
}

/** Object-URL of an imported content, created once per window. */
export function contentUrl(key: string): Promise<string | null> {
  let url = urls.get(key)
  if (!url) {
    url = loadContent(key).then((blob) => (blob ? URL.createObjectURL(blob) : null))
    urls.set(key, url)
  }
  return url
}

/** Object-URLs of every file of a multi-part model, keys `<id>/<file>`. */
export async function contentUrlsWithPrefix(prefix: string): Promise<Map<string, string>> {
  const db = await openDatabase()
  const [localKeys, remoteKeys] = await Promise.all([db.getAllKeys('contents', prefixRange(prefix)), remoteContentKeys(prefix)])
  const keys = [...new Set([...localKeys, ...remoteKeys])].filter((key): key is string => typeof key === 'string')
  const entries = await Promise.all(keys.map(async (key) => [key, await contentUrl(key)] as const))
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null))
}

/** Contents for the export: one key, or everything with this prefix. Downloads missing files. */
export async function contentBlobs(keyOrPrefix: string, prefix: boolean): Promise<[string, Blob][]> {
  if (!prefix) {
    const blob = await loadContent(keyOrPrefix)
    return blob ? [[keyOrPrefix, blob]] : []
  }
  const db = await openDatabase()
  const [localKeys, remoteKeys] = await Promise.all([db.getAllKeys('contents', prefixRange(keyOrPrefix)), remoteContentKeys(keyOrPrefix)])
  const keys = [...new Set([...localKeys, ...remoteKeys])].filter((key): key is string => typeof key === 'string')
  const blobs = await Promise.all(keys.map((key) => loadContent(key)))
  return keys.flatMap((key, index) => {
    const blob = blobs[index]
    return blob ? [[key, blob] as [string, Blob]] : []
  })
}

/** Loadable URL for a catalog URL or a reference to imported content (once loaded). */
export function useResolvedRef(ref: string | null): string | null {
  const [resolved, setResolved] = useState<{ ref: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!ref || !isContentRef(ref)) return
    let cancelled = false
    void contentUrl(contentKey(ref)).then((url) => !cancelled && setResolved({ ref, url }))
    return () => {
      cancelled = true
    }
  }, [ref])
  if (!ref || !isContentRef(ref)) return ref
  return resolved?.ref === ref ? resolved.url : null
}
