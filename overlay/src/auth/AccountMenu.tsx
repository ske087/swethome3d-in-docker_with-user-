import Logout from '@mui/icons-material/Logout'
import PersonOutlined from '@mui/icons-material/PersonOutlined'
import SpaceDashboardOutlined from '@mui/icons-material/SpaceDashboardOutlined'
import Fab from '@mui/material/Fab'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tooltip from '@mui/material/Tooltip'
import { useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logout } from './api'
import { useAuthStore } from './authStore'

/**
 * Small account button in the editor. The editor itself is upstream code and stays untouched:
 * this component is mounted next to the router outlet, so signing out and returning to the
 * dashboard are always possible without patching the editor toolbar.
 */
export function AccountMenu() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.user)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  // Only in the main editor window; detached panels and the dashboard do not need it.
  if (!user || !pathname.startsWith('/editor/') || pathname.includes('/panel/')) return null

  return (
    <>
      <Tooltip title={t('auth.signedInAs', { name: user.username })}>
        <Fab
          size="small"
          color="default"
          aria-label={t('auth.signedInAs', { name: user.username })}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ position: 'fixed', left: 12, bottom: 12, zIndex: (theme) => theme.zIndex.tooltip }}
        >
          <PersonOutlined fontSize="small" />
        </Fab>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'top', horizontal: 'left' }}>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            window.location.assign('/')
          }}
        >
          <ListItemIcon>
            <SpaceDashboardOutlined fontSize="small" />
          </ListItemIcon>
          {t('auth.dashboard')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            void logout().finally(() => window.location.assign('/login'))
          }}
        >
          <ListItemIcon>
            <Logout fontSize="small" />
          </ListItemIcon>
          {t('auth.logout')}
        </MenuItem>
      </Menu>
    </>
  )
}
