// Must stay the first import: it installs crypto.randomUUID and navigator.locks when the page is
// opened over plain HTTP, before other modules use them at module scope.
import './compat'
import { createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import { AccountMenu } from './auth/AccountMenu'
import { LoginPage } from './auth/LoginPage'
import { DashboardPage } from './auth/DashboardPage'
import { fetchMe, requireUser } from './auth/api'
import './auth/authI18n'
import { EditorPage } from './editor/EditorPage'
import { PanelWindowPage } from './editor/PanelWindowPage'
import i18n from './i18n'
import { SyncStatusBadge } from './storage/SyncStatusBadge'
import { createProject, lastProjectId, listProjects } from './storage/projects'

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <SyncStatusBadge />
      <AccountMenu />
    </>
  ),
})

/** Anmeldung; wer schon angemeldet ist, landet direkt in der Übersicht. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async () => {
    const user = await fetchMe().catch(() => null)
    if (user) throw redirect({ to: '/', replace: true })
  },
  component: LoginPage,
})

/** Übersicht: App starten und, für Administratoren, Benutzer verwalten. */
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    await requireUser()
  },
  component: DashboardPage,
})

/** Startet die App mit dem zuletzt bearbeiteten Projekt bzw. legt beim ersten Start eines an. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: async () => {
    await requireUser()
    const last = lastProjectId()
    const projects = await listProjects()
    const existing = projects.find((p) => p.id === last) ?? projects[0]
    const projectId = existing?.id ?? (await createProject(i18n.t('projects.defaultName'))).id
    throw redirect({ to: '/editor/$projectId', params: { projectId }, replace: true })
  },
})

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/editor/$projectId',
  beforeLoad: async () => {
    await requireUser()
  },
  component: EditorPage,
})

/** Herausgelöstes Panel; {@code leader} identifiziert das zugehörige Editor-Hauptfenster. */
const panelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/editor/$projectId/panel/$panelId',
  validateSearch: (search: Record<string, unknown>) => ({ leader: String(search.leader ?? '') }),
  beforeLoad: async () => {
    await requireUser()
  },
  component: PanelWindowPage,
})

const routeTree = rootRoute.addChildren([loginRoute, dashboardRoute, appRoute, editorRoute, panelRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
