import { create } from 'zustand'
import type { AuthUser } from './api'

interface AuthState {
  user: AuthUser | null
  setUser: (user: AuthUser | null) => void
}

/** Current session user, filled by the router guards and the login page. */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}))
