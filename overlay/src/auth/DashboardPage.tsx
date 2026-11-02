import AdminPanelSettingsOutlined from '@mui/icons-material/AdminPanelSettingsOutlined'
import CloudOutlined from '@mui/icons-material/CloudOutlined'
import Logout from '@mui/icons-material/Logout'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { logout } from './api'
import { useAuthStore } from './authStore'
import { UserManagement } from './UserManagement'

export function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore((state) => state.user)

  if (!user) return null

  const signOut = async () => {
    await logout()
    await navigate({ to: '/login', replace: true })
  }

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default' }}>
      <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar>
          <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
            Sweet3D
          </Typography>
          <Chip
            size="small"
            label={user.role === 'admin' ? t('auth.admin') : t('auth.user')}
            color={user.role === 'admin' ? 'primary' : 'default'}
            sx={{ mr: 1 }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ mr: 1, display: { xs: 'none', sm: 'block' } }}>
            {user.username}
          </Typography>
          <Tooltip title={t('auth.logout')}>
            <Button size="small" startIcon={<Logout />} onClick={() => void signOut()}>
              {t('auth.logout')}
            </Button>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
              {t('auth.welcome', { name: user.username })}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('auth.serverStorage')}
            </Typography>
          </Box>

          <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 } }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CloudOutlined color="primary" /> Sweet3D
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {t('auth.launchHint')}
                </Typography>
              </Box>
              <Button size="large" variant="contained" startIcon={<PlayArrowRounded />} onClick={() => void navigate({ to: '/app' })}>
                {t('auth.launchApp')}
              </Button>
            </Stack>
          </Paper>

          {user.role === 'admin' && (
            <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 } }}>
              <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <AdminPanelSettingsOutlined color="primary" /> {t('auth.userManagement')}
              </Typography>
              <UserManagement currentUserId={user.id} />
            </Paper>
          )}
        </Stack>
      </Container>
    </Box>
  )
}
