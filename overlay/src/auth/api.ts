import { redirect } from '@tanstack/react-router'
import { useAuthStore } from './authStore'

export type Role = 'admin' | 'user'

export interface AuthUser {
  id: string
  username: string
  role: Role
  disabled?: boolean
  createdAt?: string
}

export interface AdminUser extends AuthUser {
  disabled: boolean
  createdAt: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (response.status === 401) useAuthStore.getState().setUser(null)
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      message = body.message ?? body.error ?? message
    } catch {
      // Not JSON, keep the HTTP status.
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function jsonBody(value: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const { user } = await request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', ...jsonBody({ username, password }) })
  useAuthStore.getState().setUser(user)
  return user
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/api/auth/logout', { method: 'POST' })
  } finally {
    useAuthStore.getState().setUser(null)
  }
}

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const { user } = await request<{ user: AuthUser }>('/api/auth/me')
    useAuthStore.getState().setUser(user)
    return user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      useAuthStore.getState().setUser(null)
      return null
    }
    throw error
  }
}

/** Route guard: returns the signed-in user or redirects to the login page. */
export async function requireUser(): Promise<AuthUser> {
  const user = await fetchMe().catch(() => null)
  if (!user) throw redirect({ to: '/login', replace: true })
  return user
}

export async function listUsers(): Promise<AdminUser[]> {
  const { users } = await request<{ users: AdminUser[] }>('/api/admin/users')
  return users
}

export async function createUser(input: { username: string; password: string; role: Role }): Promise<AdminUser> {
  const { user } = await request<{ user: AdminUser }>('/api/admin/users', { method: 'POST', ...jsonBody(input) })
  return user
}

export async function updateUser(id: string, patch: { role?: Role; password?: string; disabled?: boolean }): Promise<AdminUser> {
  const { user } = await request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    ...jsonBody(patch),
  })
  return user
}

export async function deleteUser(id: string): Promise<void> {
  await request<void>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
