/**
 * Sweet3D sync server.
 *
 * - Stores projects, thumbnails and imported binaries on disk under DATA_DIR.
 * - Authenticates users with username/password (scrypt) and httpOnly session cookies.
 * - Provides a small admin API for user management.
 * - Is shipped without npm dependencies so the Docker image stays tiny.
 *
 * The API is consumed by src/src/storage/serverSync.ts and src/src/auth/api.ts.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

const PORT = Number(process.env.PORT ?? 8080)
const DATA_DIR = process.env.DATA_DIR ?? '/data'
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS ?? 30) * 86_400_000
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ''
const MAX_JSON = Number(process.env.MAX_JSON_MB ?? 64) * 1024 * 1024
const MAX_CONTENT = Number(process.env.MAX_CONTENT_MB ?? 1024) * 1024 * 1024
const MAX_THUMBNAIL = 10 * 1024 * 1024
const COOKIE_NAME = 'sweet3d_session'
const LOGIN_WINDOW_MS = 5 * 60_000
const LOGIN_MAX_ATTEMPTS = 10

const projectsDir = path.join(DATA_DIR, 'projects')
const contentsDir = path.join(DATA_DIR, 'contents')
const usersFile = path.join(DATA_DIR, 'users.json')
const sessionsFile = path.join(DATA_DIR, 'sessions.json')
const tombstonesFile = path.join(DATA_DIR, 'tombstones.json')

/** key -> { key, file, type, size } */
const contentIndex = new Map()
let users = []
let usersMtimeMs = 0
let sessions = new Map()
let tombstones = {}

const loginAttempts = new Map()

let stateLock = Promise.resolve()
let projectLock = Promise.resolve()
let sessionWriteTimer = null

function withLock(fn) {
  const next = stateLock.then(fn, fn)
  stateLock = next.then(
    () => {},
    () => {},
  )
  return next
}

function withProjectLock(fn) {
  const next = projectLock.then(fn, fn)
  projectLock = next.then(
    () => {},
    () => {},
  )
  return next
}

class HttpError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders, ...headers })
  res.end(body)
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  send(res, status, body, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
}

function fail(res, status, code) {
  return sendJson(res, status, { error: code, message: code })
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(tmp, data, { mode })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

function writeJsonAtomic(file, value) {
  return writeAtomic(file, JSON.stringify(value, null, 2))
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function mtimeMs(file) {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return 0
  }
}

async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
}

async function readBinaryBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64)
  return { salt, hash: Buffer.from(derived).toString('hex') }
}

async function verifyPassword(password, user) {
  const derived = await scrypt(password, user.passwordSalt, 64)
  const expected = Buffer.from(user.passwordHash, 'hex')
  const actual = Buffer.from(derived)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  }
}

function publicSummary(meta) {
  return { id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt }
}

function parseCookies(header = '') {
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

function sessionToken(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
  if (token) return token
  const authorization = req.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null
}

function currentUser(req) {
  const token = sessionToken(req)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    scheduleSessionWrite()
    return null
  }
  return users.find((user) => user.id === session.userId && !user.disabled) ?? null
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? '; Secure' : ''}`
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`
}

function scheduleSessionWrite() {
  if (sessionWriteTimer) return
  sessionWriteTimer = setTimeout(() => {
    sessionWriteTimer = null
    void persistSessions()
  }, 200)
  sessionWriteTimer.unref?.()
}

async function persistSessions() {
  await writeJsonAtomic(sessionsFile, Object.fromEntries(sessions))
}

async function persistUsers() {
  await writeJsonAtomic(usersFile, users)
  usersMtimeMs = await mtimeMs(usersFile)
}

async function persistTombstones() {
  await writeJsonAtomic(tombstonesFile, tombstones)
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function loginAllowed(ip) {
  const attempt = loginAttempts.get(ip)
  if (!attempt || attempt.resetAt <= Date.now()) return true
  return attempt.count < LOGIN_MAX_ATTEMPTS
}

function recordLoginFailure(ip) {
  const now = Date.now()
  const attempt = loginAttempts.get(ip)
  if (!attempt || attempt.resetAt <= now) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
  else attempt.count += 1
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip)
}

function requireString(value, name, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `invalid_${name}`)
  const trimmed = value.trim()
  if (trimmed.length < min || trimmed.length > max) throw new HttpError(400, `invalid_${name}`)
  return trimmed
}

function validUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{3,32}$/.test(value)
}

function validRole(value) {
  return value === 'admin' || value === 'user'
}

function isoTimestamp(value) {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(NaN)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function validProjectId(id) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function contentPaths(base64) {
  return {
    bin: path.join(contentsDir, `${base64}.bin`),
    meta: path.join(contentsDir, `${base64}.json`),
  }
}

function encodeContentKey(key) {
  return Buffer.from(key, 'utf8').toString('base64url')
}

function decodeContentParam(param) {
  if (typeof param !== 'string' || !/^[A-Za-z0-9_-]+$/.test(param)) throw new HttpError(400, 'invalid_content_key')
  const key = Buffer.from(param, 'base64url').toString('utf8')
  if (!key || key.length > 1024) throw new HttpError(400, 'invalid_content_key')
  return key
}

async function projectIds() {
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && validProjectId(entry.name)).map((entry) => entry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function sendFile(res, file, type, cacheControl = 'no-store') {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return fail(res, 404, 'not_found')
  }
  res.writeHead(200, {
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': type,
    'Content-Length': stat.size,
  })
  await pipeline(createReadStream(file), res).catch(() => {})
}

async function loadContentIndex() {
  contentIndex.clear()
  let entries
  try {
    entries = await fs.readdir(contentsDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const base64 = entry.name.slice(0, -'.json'.length)
    try {
      const info = JSON.parse(await fs.readFile(path.join(contentsDir, entry.name), 'utf8'))
      const file = contentPaths(base64).bin
      if (typeof info.key === 'string' && (await exists(file))) {
        contentIndex.set(info.key, {
          key: info.key,
          file,
          type: typeof info.type === 'string' ? info.type : 'application/octet-stream',
          size: Number(info.size) || 0,
        })
      }
    } catch {
      // Broken metadata is ignored; the binary can be uploaded again.
    }
  }
}

async function createInitialAdmin() {
  const password = ADMIN_PASSWORD || randomBytes(18).toString('base64url')
  const { salt, hash } = await hashPassword(password)
  const admin = {
    id: randomUUID(),
    username: ADMIN_USER,
    role: 'admin',
    disabled: false,
    createdAt: new Date().toISOString(),
    passwordSalt: salt,
    passwordHash: hash,
  }
  users.push(admin)
  await persistUsers()
  if (ADMIN_PASSWORD) {
    console.log(`[sync] Created initial admin "${ADMIN_USER}" with the password from ADMIN_PASSWORD.`)
  } else {
    console.log(
      [
        '',
        '============================================================',
        ' Sweet3D sync server - initial admin account',
        `   username: ${ADMIN_USER}`,
        `   password: ${password}`,
        ' Change the password after the first login.',
        '============================================================',
        '',
      ].join('\n'),
    )
  }
}

/**
 * The users file can be changed outside this process (the `--reset-password` CLI writing through a
 * second container), so it is reloaded whenever its timestamp changes. Without this, a password
 * reset would only take effect after a restart.
 */
async function refreshUsersIfChanged() {
  const stamp = await mtimeMs(usersFile)
  if (stamp === usersMtimeMs) return
  usersMtimeMs = stamp
  users = await readJson(usersFile, [])
}

async function handleLogin(req, res) {
  const ip = clientIp(req)
  if (!loginAllowed(ip)) return fail(res, 429, 'too_many_attempts')
  await refreshUsersIfChanged()
  let body
  try {
    body = await readJsonBody(req, 64 * 1024)
  } catch {
    return fail(res, 400, 'invalid_json')
  }
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const user = users.find((entry) => entry.username.toLowerCase() === username.toLowerCase())
  const valid = user && !user.disabled && (await verifyPassword(password, user))
  if (!valid) {
    recordLoginFailure(ip)
    return fail(res, 401, 'invalid_credentials')
  }
  clearLoginFailures(ip)
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS })
  await persistSessions()
  return sendJson(
    res,
    200,
    { user: publicUser(user) },
    { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) },
  )
}

async function handleLogout(req, res) {
  const token = sessionToken(req)
  if (token) {
    sessions.delete(token)
    await persistSessions()
  }
  return send(res, 204, '', { 'Set-Cookie': clearCookie() })
}

async function handleAdminUsers(req, res, url) {
  await refreshUsersIfChanged()
  const user = currentUser(req)
  if (!user) return fail(res, 401, 'unauthorized')
  if (user.role !== 'admin') return fail(res, 403, 'forbidden')

  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts[3]

  if (!id) {
    if (req.method === 'GET') return sendJson(res, 200, { users: users.map(publicUser) })
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed')
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      return fail(res, 400, 'invalid_json')
    }
    return withLock(async () => {
      const username = body.username
      if (!validUsername(username)) return fail(res, 400, 'invalid_username')
      if (users.some((entry) => entry.username.toLowerCase() === username.toLowerCase()))
        return fail(res, 409, 'username_exists')
      const password = requireString(body.password, 'password', { min: 8, max: 256 })
      const role = validRole(body.role) ? body.role : 'user'
      const { salt, hash } = await hashPassword(password)
      const created = {
        id: randomUUID(),
        username,
        role,
        disabled: false,
        createdAt: new Date().toISOString(),
        passwordSalt: salt,
        passwordHash: hash,
      }
      users.push(created)
      await persistUsers()
      return sendJson(res, 201, { user: publicUser(created) })
    })
  }

  if (!validProjectId(id)) return fail(res, 400, 'invalid_user_id')
  const existing = users.find((entry) => entry.id === id)
  if (!existing) return fail(res, 404, 'not_found')

  if (req.method === 'PATCH') {
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      return fail(res, 400, 'invalid_json')
    }
    return withLock(async () => {
      const current = users.find((entry) => entry.id === id)
      if (!current) return fail(res, 404, 'not_found')
      const nextRole = body.role === undefined ? current.role : body.role
      if (!validRole(nextRole)) return fail(res, 400, 'invalid_role')
      const nextDisabled = body.disabled === undefined ? Boolean(current.disabled) : Boolean(body.disabled)
      const activeAdmins = users.filter((entry) => entry.role === 'admin' && !entry.disabled).length
      const losesAdmin = current.role === 'admin' && !current.disabled && (nextRole !== 'admin' || nextDisabled)
      if (losesAdmin && activeAdmins <= 1) return fail(res, 400, 'last_admin')
      if (current.id === user.id && nextDisabled) return fail(res, 400, 'cannot_disable_self')
      current.role = nextRole
      current.disabled = nextDisabled
      if (body.password !== undefined) {
        const password = requireString(body.password, 'password', { min: 8, max: 256 })
        const { salt, hash } = await hashPassword(password)
        current.passwordSalt = salt
        current.passwordHash = hash
        for (const [token, session] of sessions) {
          if (session.userId === current.id) sessions.delete(token)
        }
        scheduleSessionWrite()
      }
      await persistUsers()
      return sendJson(res, 200, { user: publicUser(current) })
    })
  }

  if (req.method === 'DELETE') {
    return withLock(async () => {
      if (existing.id === user.id) return fail(res, 400, 'cannot_delete_self')
      const activeAdmins = users.filter((entry) => entry.role === 'admin' && !entry.disabled && entry.id !== existing.id).length
      if (existing.role === 'admin' && !existing.disabled && activeAdmins === 0) return fail(res, 400, 'last_admin')
      users = users.filter((entry) => entry.id !== existing.id)
      for (const [token, session] of sessions) {
        if (session.userId === existing.id) sessions.delete(token)
      }
      await persistUsers()
      await persistSessions()
      return send(res, 204)
    })
  }

  return fail(res, 405, 'method_not_allowed')
}

async function handleProjects(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean) // api, projects, [id], [thumbnail]
  const id = parts[2]

  if (!id) {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed')
    const ids = await projectIds()
    const projects = []
    for (const projectId of ids) {
      const meta = await readJson(path.join(projectsDir, projectId, 'meta.json'), null)
      if (!meta) continue
      projects.push({
        ...publicSummary(meta),
        hasThumbnail: await exists(path.join(projectsDir, projectId, 'thumbnail.webp')),
      })
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return sendJson(res, 200, { projects, deleted: Object.keys(tombstones) })
  }

  if (!validProjectId(id)) return fail(res, 400, 'invalid_project_id')
  const directory = path.join(projectsDir, id)

  if (parts[3] === 'thumbnail') {
    if (req.method === 'GET') {
      return sendFile(res, path.join(directory, 'thumbnail.webp'), 'image/webp', 'private, max-age=60')
    }
    if (req.method === 'PUT') {
      let data
      try {
        data = await readBinaryBody(req, MAX_THUMBNAIL)
      } catch {
        return fail(res, 413, 'payload_too_large')
      }
      if (data.length === 0) return fail(res, 400, 'empty_body')
      await fs.mkdir(directory, { recursive: true })
      await writeAtomic(path.join(directory, 'thumbnail.webp'), data)
      return send(res, 204)
    }
    return fail(res, 405, 'method_not_allowed')
  }

  if (parts[3]) return fail(res, 404, 'not_found')

  if (req.method === 'GET') {
    const [meta, home] = await Promise.all([
      readJson(path.join(directory, 'meta.json'), null),
      readJson(path.join(directory, 'home.json'), null),
    ])
    if (!meta || !home) return fail(res, 404, 'not_found')
    return sendJson(res, 200, { summary: publicSummary(meta), home })
  }

  if (req.method === 'PUT') {
    let body
    try {
      body = await readJsonBody(req, MAX_JSON)
    } catch (error) {
      return fail(res, error.status ?? 400, error.code ?? 'invalid_json')
    }
    if (!body.home || typeof body.home !== 'object' || Array.isArray(body.home)) return fail(res, 400, 'invalid_home')
    return withProjectLock(async () => {
      const name = requireString(body.name ?? 'Sweet3D', 'name', { max: 500 })
      await fs.mkdir(directory, { recursive: true })
      await writeAtomic(path.join(directory, 'home.json'), JSON.stringify(body.home))
      const meta = {
        id,
        name,
        createdAt: isoTimestamp(body.createdAt ?? new Date().toISOString()),
        updatedAt: isoTimestamp(body.updatedAt ?? new Date().toISOString()),
      }
      await writeAtomic(path.join(directory, 'meta.json'), JSON.stringify(meta, null, 2))
      if (tombstones[id]) {
        delete tombstones[id]
        await persistTombstones()
      }
      return sendJson(res, 200, { summary: meta })
    })
  }

  if (req.method === 'PATCH') {
    let body
    try {
      body = await readJsonBody(req, 64 * 1024)
    } catch {
      return fail(res, 400, 'invalid_json')
    }
    return withProjectLock(async () => {
      const meta = await readJson(path.join(directory, 'meta.json'), null)
      if (!meta) return fail(res, 404, 'not_found')
      meta.name = requireString(body.name ?? meta.name, 'name', { max: 500 })
      meta.updatedAt = isoTimestamp(body.updatedAt ?? new Date().toISOString())
      await writeJsonAtomic(path.join(directory, 'meta.json'), meta)
      return sendJson(res, 200, { summary: publicSummary(meta) })
    })
  }

  if (req.method === 'DELETE') {
    return withProjectLock(async () => {
      await fs.rm(directory, { recursive: true, force: true })
      tombstones[id] = new Date().toISOString()
      await persistTombstones()
      return send(res, 204)
    })
  }

  return fail(res, 405, 'method_not_allowed')
}

async function handleContents(req, res, url) {
  const prefix = url.searchParams.get('prefix')

  if (url.pathname === '/api/contents/list') {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed')
    const keys = [...contentIndex.keys()].filter((key) => (prefix ? key.startsWith(prefix) : true))
    return sendJson(res, 200, { keys })
  }

  const base64 = url.pathname.slice('/api/contents/'.length)
  const key = decodeContentParam(base64)
  const { bin, meta } = contentPaths(base64)

  if (req.method === 'GET') {
    const entry = contentIndex.get(key)
    if (!entry) return fail(res, 404, 'not_found')
    return sendFile(res, entry.file, entry.type, 'private, max-age=31536000, immutable')
  }

  if (req.method === 'PUT') {
    const type = String(req.headers['content-type'] ?? 'application/octet-stream').slice(0, 200)
    await fs.mkdir(contentsDir, { recursive: true })
    const tmp = `${bin}.tmp-${randomUUID()}`
    let size = 0
    try {
      await pipeline(
        req,
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length
            if (size > MAX_CONTENT) throw new HttpError(413, 'payload_too_large')
            yield chunk
          }
        },
        createWriteStream(tmp),
      )
      await fs.rename(tmp, bin)
      const info = { key, type, size, updatedAt: new Date().toISOString() }
      await writeJsonAtomic(meta, info)
      contentIndex.set(key, { key, file: bin, type, size })
      return send(res, 204)
    } catch (error) {
      await fs.rm(tmp, { force: true })
      throw error
    }
  }

  if (req.method === 'DELETE') {
    await fs.rm(bin, { force: true })
    await fs.rm(meta, { force: true })
    contentIndex.delete(key)
    return send(res, 204)
  }

  return fail(res, 405, 'method_not_allowed')
}

async function handleCleanup(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed')
  const used = new Set()
  for (const id of await projectIds()) {
    try {
      const text = await fs.readFile(path.join(projectsDir, id, 'home.json'), 'utf8')
      for (const match of text.matchAll(/content:([^"\\]+)/g)) {
        const key = match[1]
        used.add(key.split('/')[0])
      }
    } catch {
      // Missing home files are ignored.
    }
  }
  let removed = 0
  for (const [key, entry] of [...contentIndex]) {
    if (used.has(key.split('/')[0])) continue
    await fs.rm(entry.file, { force: true })
    await fs.rm(contentPaths(encodeContentKey(key)).meta, { force: true })
    contentIndex.delete(key)
    removed += 1
  }
  return sendJson(res, 200, { removed })
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  if (!pathname.startsWith('/api/')) return fail(res, 404, 'not_found')

  if (pathname === '/api/health') {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed')
    return sendJson(res, 200, { ok: true })
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res)
  if (pathname === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res)

  if (pathname === '/api/auth/me') {
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed')
    const user = currentUser(req)
    if (!user) return fail(res, 401, 'unauthorized')
    return sendJson(res, 200, { user: publicUser(user) })
  }

  const user = currentUser(req)
  if (!user) return fail(res, 401, 'unauthorized')

  if (pathname === '/api/admin/users' || pathname.startsWith('/api/admin/users/')) {
    return handleAdminUsers(req, res, url)
  }

  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
    return handleProjects(req, res, url)
  }

  if (pathname === '/api/contents/list' || pathname.startsWith('/api/contents/')) {
    return handleContents(req, res, url)
  }

  if (pathname === '/api/maintenance/cleanup') return handleCleanup(req, res)

  return fail(res, 404, 'not_found')
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof HttpError) {
      if (!res.headersSent) fail(res, error.status, error.code)
      else res.destroy()
      return
    }
    console.error('[sync] request failed', error)
    if (!res.headersSent) fail(res, 500, 'internal_error')
    else res.destroy()
  })
})

async function init() {
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.mkdir(contentsDir, { recursive: true })
  users = await readJson(usersFile, [])
  usersMtimeMs = await mtimeMs(usersFile)
  const storedSessions = await readJson(sessionsFile, {})
  const now = Date.now()
  sessions = new Map(
    Object.entries(storedSessions).filter(([, session]) => session && session.expiresAt > now),
  )
  tombstones = await readJson(tombstonesFile, {})
  await loadContentIndex()
  if (users.length === 0) await createInitialAdmin()

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[sync] listening on :${PORT}, data in ${DATA_DIR}`)
  })
}
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})

/**
 * `node index.mjs --reset-password [username]` sets a new random password (also used to recover a
 * lost admin account) and invalidates the open sessions of that user. The password is printed once.
 */
async function resetPassword(username) {
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.mkdir(contentsDir, { recursive: true })
  users = await readJson(usersFile, [])
  const name = username ?? ADMIN_USER
  const user = users.find((entry) => entry.username.toLowerCase() === name.toLowerCase())
  if (!user) {
    console.error(`[sync] no user named "${name}"`)
    process.exit(1)
  }
  const password = ADMIN_PASSWORD || randomBytes(18).toString('base64url')
  const { salt, hash } = await hashPassword(password)
  user.passwordSalt = salt
  user.passwordHash = hash
  await persistUsers()
  const stored = await readJson(sessionsFile, {})
  await writeJsonAtomic(
    sessionsFile,
    Object.fromEntries(Object.entries(stored).filter(([, session]) => session?.userId !== user.id)),
  )
  console.log(
    [
      '',
      '============================================================',
      ' Sweet3D sync server - password reset',
      `   username: ${user.username}`,
      `   password: ${password}`,
      ' Open sessions of this user were signed out.',
      '============================================================',
      '',
    ].join('\n'),
  )
}

const resetIndex = process.argv.indexOf('--reset-password')
if (resetIndex !== -1) {
  await resetPassword(process.argv[resetIndex + 1])
  process.exit(0)
}

await init()
