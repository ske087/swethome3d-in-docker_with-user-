/**
 * Runtime shims for browsers and origins that miss APIs the app relies on.
 *
 * `crypto.randomUUID()` and `navigator.locks` are secure-context only in Firefox, so they are
 * `undefined` when Sweet3D is opened over plain HTTP from a LAN address such as
 * `http://192.168.1.20:8180`. Both are used while the modules load (`view3d/renderQueue.ts` creates
 * an id at module scope, `sync/leader.ts` holds a lock), so without the shims the bundle throws
 * during evaluation and every route stays blank.
 *
 * The lock shim is a small lease-based lock shared through a `BroadcastChannel`: a holder
 * announces itself with a heartbeat and pages that stop beating lose their lock after a few
 * seconds. That is enough for the "editor already open in another tab" warning and for detached
 * panel windows. Whenever the native Web Locks API exists, it is used unchanged.
 */

const LOCK_CHANNEL = 'sweet3d-locks'
const HEARTBEAT_MS = 1000
const LEASE_MS = 3200
/** Time another page gets to answer a probe before the lock is claimed. */
const PROBE_MS = 60

export type UUID = `${string}-${string}-${string}-${string}-${string}`

/** RFC 4122 version 4 UUID built from `crypto.getRandomValues`, also available insecurely. */
export function randomUUID(): UUID {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface LockOptions {
  signal?: AbortSignal
  ifAvailable?: boolean
  mode?: string
}

interface HeldLock {
  name: string
  mode: 'exclusive'
  release: () => void
}

interface Waiter {
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type LockCallback = (lock: HeldLock | null) => unknown

function abortError(): DOMException {
  return new DOMException('The lock request was aborted.', 'AbortError')
}

/** Adds `crypto.randomUUID` when the browser only exposes it in secure contexts. */
export function installUUID(): void {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID === 'function') return
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, writable: true, value: randomUUID })
}

/** Adds `navigator.locks` when the browser only exposes the Web Locks API in secure contexts. */
export function installLocks(): void {
  if (typeof navigator === 'undefined' || navigator.locks) return

  const selfId = randomUUID()
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(LOCK_CHANNEL)
  } catch {
    channel = null
  }

  /** Locks held by other pages, with the time of their last heartbeat. */
  const others = new Map<string, number>()
  /** Locks held by this page. */
  const held = new Map<string, () => void>()
  const waiting = new Map<string, Waiter[]>()
  let heartbeat: number | undefined

  const post = (message: unknown) => channel?.postMessage(message)

  const isHeldElsewhere = (name: string): boolean => {
    const seen = others.get(name)
    if (seen === undefined) return false
    if (Date.now() - seen > LEASE_MS) {
      others.delete(name)
      return false
    }
    return true
  }

  const releaseWaiters = (name: string) => {
    const waiters = waiting.get(name)
    if (!waiters?.length) return
    waiting.delete(name)
    for (const waiter of waiters) {
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
  }

  const releaseAllWaiters = () => {
    for (const name of [...waiting.keys()]) releaseWaiters(name)
  }

  const waitForRelease = (name: string, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const current = waiting.get(name) ?? []
          waiting.set(
            name,
            current.filter((entry) => entry !== waiter),
          )
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiting.set(name, [...(waiting.get(name) ?? []), waiter])
    })

  const startHeartbeat = () => {
    heartbeat ??= window.setInterval(() => {
      for (const name of held.keys()) post({ type: 'beat', name, from: selfId })
    }, HEARTBEAT_MS)
  }

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) window.clearInterval(heartbeat)
    heartbeat = undefined
  }

  const claim = async (name: string, options: LockOptions): Promise<HeldLock | null> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (options.signal?.aborted) throw abortError()
      if (!isHeldElsewhere(name)) break
      if (options.ifAvailable) return null
      await waitForRelease(name, options.signal)
    }
    if (isHeldElsewhere(name)) return null

    // Another page may claim the same lock at the same moment: give it time to answer a probe.
    post({ type: 'probe', name, from: selfId })
    await new Promise((resolve) => window.setTimeout(resolve, PROBE_MS))
    if (options.signal?.aborted) throw abortError()
    if (isHeldElsewhere(name)) {
      if (options.ifAvailable) return null
      await waitForRelease(name, options.signal)
      return claim(name, options)
    }

    const release = () => {
      if (held.get(name) !== release) return
      held.delete(name)
      if (held.size === 0) stopHeartbeat()
      post({ type: 'released', name, from: selfId })
      releaseWaiters(name)
    }

    held.set(name, release)
    others.delete(name)
    startHeartbeat()
    post({ type: 'acquired', name, from: selfId })
    return { name, mode: 'exclusive', release }
  }

  const request = async (name: string, optionsOrCallback: LockOptions | LockCallback, maybeCallback?: LockCallback) => {
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (!callback) throw new TypeError('A lock callback is required')
    const lock = await claim(name, options)
    if (lock === null) return callback(null)
    try {
      return await callback(lock)
    } finally {
      lock.release()
    }
  }

  if (channel) {
    channel.onmessage = (event: MessageEvent<{ type?: string; name?: string; from?: string }>) => {
      const message = event.data
      if (!message || message.from === selfId || !message.name) return
      switch (message.type) {
        case 'beat':
        case 'acquired':
          others.set(message.name, Date.now())
          break
        case 'released':
          others.delete(message.name)
          releaseWaiters(message.name)
          break
        case 'probe':
          // Answer only for locks this page really holds.
          if (held.has(message.name)) post({ type: 'beat', name: message.name, from: selfId })
          break
      }
    }
  }

  // A page that stopped sending heartbeats (closed, crashed, reloaded) loses its locks.
  const sweep = window.setInterval(() => {
    for (const name of [...others.keys()]) if (!isHeldElsewhere(name)) releaseWaiters(name)
  }, 500)

  window.addEventListener(
    'pagehide',
    () => {
      window.clearInterval(sweep)
      stopHeartbeat()
      others.clear()
      releaseAllWaiters()
    },
    { once: true },
  )

  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
}

installUUID()
installLocks()
