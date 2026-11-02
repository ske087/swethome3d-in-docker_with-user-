import LockOutlined from '@mui/icons-material/LockOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, login } from './api'

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      await navigate({ to: '/', replace: true })
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setError(t('auth.invalidCredentials'))
      else if (cause instanceof ApiError && cause.status === 429) setError(t('auth.tooManyAttempts'))
      else setError(t('auth.serverUnavailable'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        p: 2,
        background: (theme) =>
          theme.palette.mode === 'dark'
            ? 'radial-gradient(circle at 20% 20%, rgba(25,118,210,.22), transparent 45%), radial-gradient(circle at 80% 80%, rgba(46,125,50,.18), transparent 45%)'
            : 'radial-gradient(circle at 20% 20%, rgba(25,118,210,.14), transparent 45%), radial-gradient(circle at 80% 80%, rgba(46,125,50,.12), transparent 45%)',
      }}
    >
      <Paper elevation={6} sx={{ width: '100%', maxWidth: 420, p: { xs: 3, sm: 4 } }}>
        <Stack spacing={2.5}>
          <Stack spacing={0.5} sx={{ alignItems: 'center', textAlign: 'center' }}>
            <Box sx={{ width: 48, height: 48, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: 'primary.main', color: 'primary.contrastText' }}>
              <LockOutlined />
            </Box>
            <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
              {t('auth.loginTitle')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('auth.loginSubtitle')}
            </Typography>
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          <Box component="form" onSubmit={submit} noValidate>
            <Stack spacing={2}>
              <TextField
                label={t('auth.username')}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
                fullWidth
                disabled={busy}
              />
              <TextField
                label={t('auth.password')}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                fullWidth
                disabled={busy}
              />
              <Button type="submit" variant="contained" size="large" disabled={busy || !username.trim() || !password} fullWidth>
                {busy ? t('auth.signingIn') : t('auth.signIn')}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>
    </Box>
  )
}
