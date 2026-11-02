import DeleteOutlined from '@mui/icons-material/DeleteOutlined'
import KeyOutlined from '@mui/icons-material/KeyOutlined'
import PersonAddOutlined from '@mui/icons-material/PersonAddOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  ApiError,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  type AdminUser,
  type Role,
} from './api'

function adminError(t: TFunction, cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.message === 'last_admin') return t('admin.lastAdmin')
    if (cause.message === 'username_exists') return t('admin.usernameExists')
  }
  return t('admin.error')
}

interface UserManagementProps {
  currentUserId: string
}

export function UserManagement({ currentUserId }: UserManagementProps) {
  const { t, i18n } = useTranslation()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await listUsers())
    } catch (cause) {
      setError(adminError(t, cause))
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    listUsers()
      .then((next) => !cancelled && setUsers(next))
      .catch((cause: unknown) => !cancelled && setError(adminError(t, cause)))
    return () => {
      cancelled = true
    }
  }, [t])

  const run = async (id: string, action: () => Promise<unknown>) => {
    setError(null)
    setBusyId(id)
    try {
      await action()
    } catch (cause) {
      setError(adminError(t, cause))
    } finally {
      setBusyId(null)
      await load()
    }
  }

  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium' })

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
        <Button variant="outlined" size="small" startIcon={<PersonAddOutlined />} onClick={() => setCreateOpen(true)}>
          {t('admin.newUser')}
        </Button>
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}

      {users === null ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 560 }}>
            <TableHead>
              <TableRow>
                <TableCell>{t('admin.username')}</TableCell>
                <TableCell>{t('admin.role')}</TableCell>
                <TableCell>{t('admin.active')}</TableCell>
                <TableCell>{t('admin.createdAt')}</TableCell>
                <TableCell align="right">{t('admin.actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => {
                const self = user.id === currentUserId
                const busy = busyId === user.id
                return (
                  <TableRow key={user.id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {user.username}
                        </Typography>
                        {self && <Chip size="small" label={t('admin.self')} />}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Select
                        size="small"
                        value={user.role}
                        disabled={busy}
                        onChange={(event) =>
                          void run(user.id, () => updateUser(user.id, { role: event.target.value as Role }))
                        }
                        sx={{ minWidth: 130 }}
                      >
                        <MenuItem value="admin">{t('admin.admin')}</MenuItem>
                        <MenuItem value="user">{t('admin.user')}</MenuItem>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Switch
                          size="small"
                          checked={!user.disabled}
                          disabled={busy || self}
                          onChange={(event) =>
                            void run(user.id, () => updateUser(user.id, { disabled: !event.target.checked }))
                          }
                          slotProps={{ input: { 'aria-label': t('admin.active') } }}
                        />
                        <Typography variant="caption" color={user.disabled ? 'text.secondary' : 'text.primary'}>
                          {user.disabled ? t('admin.disabled') : t('admin.active')}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {dateFormat.format(new Date(user.createdAt))}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={t('admin.resetPassword')}>
                        <span>
                          <IconButton size="small" disabled={busy} onClick={() => setResetTarget(user)}>
                            <KeyOutlined fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={t('admin.delete')}>
                        <span>
                          <IconButton size="small" disabled={busy || self} onClick={() => setDeleteTarget(user)}>
                            <DeleteOutlined fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Box>
      )}

      {createOpen && <CreateUserDialog onClose={() => setCreateOpen(false)} onCreated={() => void load()} />}
      {resetTarget && (
        <ResetPasswordDialog target={resetTarget} onClose={() => setResetTarget(null)} onSaved={() => void load()} />
      )}
      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>{t('admin.delete')}</DialogTitle>
        <DialogContent>
          <Typography>{t('admin.deleteConfirm', { name: deleteTarget?.username ?? '' })}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>{t('admin.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const target = deleteTarget
              setDeleteTarget(null)
              if (target) void run(target.id, () => deleteUser(target.id))
            }}
          >
            {t('admin.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createUser({ username: username.trim(), password, role })
      onClose()
      onCreated()
    } catch (cause) {
      setError(adminError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <Box component="form" onSubmit={submit}>
        <DialogTitle>{t('admin.newUser')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label={t('admin.username')}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoFocus
              fullWidth
              helperText="3–32, a–z, 0–9, . _ -"
            />
            <TextField
              label={t('admin.password')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              helperText={t('admin.passwordHint')}
              fullWidth
            />
            <TextField select label={t('admin.role')} value={role} onChange={(event) => setRole(event.target.value as Role)} fullWidth>
              <MenuItem value="user">{t('admin.user')}</MenuItem>
              <MenuItem value="admin">{t('admin.admin')}</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('admin.cancel')}</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={busy || username.trim().length < 3 || password.length < 8}
          >
            {t('admin.create')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}

function ResetPasswordDialog({
  target,
  onClose,
  onSaved,
}: {
  target: AdminUser
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await updateUser(target.id, { password })
      onClose()
      onSaved()
    } catch (cause) {
      setError(adminError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <Box component="form" onSubmit={submit}>
        <DialogTitle>{t('admin.resetPassword')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <Typography variant="body2" color="text.secondary">
              {target.username}
            </Typography>
            <TextField
              label={t('admin.newPassword')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              helperText={t('admin.passwordHint')}
              autoFocus
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('admin.cancel')}</Button>
          <Button type="submit" variant="contained" disabled={busy || password.length < 8}>
            {t('admin.save')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  )
}
