import { create } from 'zustand'

/**
 * Per-project upload state, shown in the editor so it is clear whether a change only reached the
 * local IndexedDB or also the server.
 *
 * `pending` and `syncing` are presented as one state ("saving"), `synced` means the server
 * acknowledged the current version, `error` means the server could not be reached and the change
 * is kept locally until a retry succeeds.
 */
export type SyncState = 'pending' | 'syncing' | 'synced' | 'error'

export interface SyncStatus {
  state: SyncState
  /** Time of the last successful upload in ms since epoch, null if never uploaded. */
  lastSyncedAt: number | null
  /** Short reason for `error`, e.g. `offline` or an HTTP status. */
  error: string | null
}

const initial: SyncStatus = { state: 'synced', lastSyncedAt: null, error: null }

interface SyncStatusStore {
  projects: Record<string, SyncStatus>
  set: (id: string, patch: Partial<SyncStatus>) => void
  forget: (id: string) => void
}

export const useSyncStatusStore = create<SyncStatusStore>((set) => ({
  projects: {},
  set: (id, patch) =>
    set((state) => ({
      projects: { ...state.projects, [id]: { ...(state.projects[id] ?? initial), ...patch } },
    })),
  forget: (id) =>
    set((state) => {
      const projects = { ...state.projects }
      delete projects[id]
      return { projects }
    }),
}))

/** Undefined until the project was touched; the badge then shows nothing rather than guessing. */
export function useSyncStatus(projectId: string | null): SyncStatus | undefined {
  return useSyncStatusStore((state) => (projectId ? state.projects[projectId] : undefined))
}
