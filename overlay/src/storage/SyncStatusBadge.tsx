import CloudDoneOutlined from '@mui/icons-material/CloudDoneOutlined'
import CloudOffOutlined from '@mui/icons-material/CloudOffOutlined'
import CloudSyncOutlined from '@mui/icons-material/CloudSyncOutlined'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { syncNow } from './serverSync'
import { useSyncStatus } from './syncStatus'

/** Project id of the main editor window; detached panels (`…/panel/…`) are ignored. */
function editorProjectId(pathname: string): string | null {
  return /^\/editor\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null
}

/**
 * Shows whether the open project is stored on the server as well. Mounted at the router root so the
 * upstream editor sources stay untouched; it sits next to the account button.
 *
 * - saving: the local change is being uploaded
 * - saved: the server acknowledged this version
 * - local only: the server could not be reached, the change is kept locally and retried
 */
export function SyncStatusBadge() {
  const { t } = useTranslation()
  const projectId = useRouterState({ select: (state) => editorProjectId(state.location.pathname) })
  const status = useSyncStatus(projectId)

  if (!projectId || !status) return null

  const saving = status.state === 'pending' || status.state === 'syncing'
  const failed = status.state === 'error'

  const time = status.lastSyncedAt
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(status.lastSyncedAt)
    : null

  const label = saving
    ? t('sync.saving')
    : failed
      ? t('sync.localOnly')
      : time
        ? t('sync.savedAt', { time })
        : t('sync.saved')

  const hint = failed ? t('sync.retryHint') : time ? t('sync.savedHint', { time }) : label

  const Icon = failed ? CloudOffOutlined : saving ? CloudSyncOutlined : CloudDoneOutlined
  const color = failed ? 'warning.main' : saving ? 'text.secondary' : 'success.main'

  return (
    <Tooltip title={hint}>
      <Box
        role={failed ? 'button' : 'status'}
        aria-label={label}
        aria-live="polite"
        onClick={failed ? () => syncNow(projectId) : undefined}
        sx={{
          position: 'fixed',
          left: 12,
          bottom: 60,
          zIndex: (theme) => theme.zIndex.tooltip,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          maxWidth: 260,
          px: 1.25,
          py: 0.5,
          borderRadius: 999,
          border: 1,
          borderColor: failed ? 'warning.main' : 'divider',
          bgcolor: 'background.paper',
          boxShadow: 1,
          cursor: failed ? 'pointer' : 'default',
          opacity: saving ? 1 : 0.92,
          transition: 'opacity 150ms ease',
        }}
      >
        {saving ? <CircularProgress size={14} thickness={5} sx={{ color }} /> : <Icon sx={{ fontSize: 16, color }} />}
        <Typography variant="caption" noWrap sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
      </Box>
    </Tooltip>
  )
}
