/**
 * The mobile gateway core: an authenticated reverse proxy in front of the
 * loopback DSH web server. A second `node:http`/`node:https` listener owns a
 * whitelist of named phone users; every other path is forwarded to
 * `http://<targetHost>:<targetPort>` with `Host`/`Origin` rewritten to the
 * loopback authority, so the DSH browser-trust fence treats the forwarded
 * request exactly like a local one. WebSocket upgrades (the DSH event mux
 * downlink) are proxied with the same cookie check and header rewrite.
 *
 * The proxy never exposes DSH itself: the upstream stays bound to loopback,
 * and the gateway answers 401/302 before a byte reaches it. Plain-HTTP LAN
 * use is the default; `tlsKey`/`tlsCert` upgrade the listener to https so the
 * PWA install prompt works over the network.
 * @module @deepseek-ai/dsh-mobile-gateway/gateway
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import {
  authenticate,
  authenticateByToken,
  createSession,
  randomSecret,
  verifySession,
  SESSION_COOKIE,
  type GatewayUser,
} from './auth.ts'
import { GATEWAY_VERSION, PREFIX, loginPageHtml, manifestFile, serviceWorkerFile, iconFile, webMetaSnippet } from './static.ts'

/** One named phone user (re-exported for plugin config convenience). */
export type { GatewayUser } from './auth.ts'

/** TLS material for the optional https listener. */
export interface GatewayTls {
  /** PEM-encoded private key. */
  key: Buffer
  /** PEM-encoded certificate chain. */
  cert: Buffer
}

/** Full gateway configuration. */
export interface GatewayOptions {
  /** Listen address; `0.0.0.0` exposes the AUTHENTICATED gateway to the LAN. */
  bind: string
  /** Listen port; `0` requests an OS-assigned port. */
  port: number
  /** Upstream host, normally the loopback DSH web server. */
  targetHost: string
  /** Upstream port (from the webServer service in the DSH plugin). */
  targetPort: number
  /** The whitelist. Empty = deny every login (fail closed). */
  users: readonly GatewayUser[]
  /** HMAC secret for session cookies; a random per-process secret when absent. */
  secret?: string | undefined
  /** Signed-session lifetime in seconds; defaults to 7 days. */
  sessionTtlSeconds?: number
  /** Optional TLS termination. */
  tls?: GatewayTls | undefined
  /** Log sink; defaults to `console.log` with a stable prefix. */
  log?: (line: string) => void
  /** Inject viewport/PWA meta into DSH HTML index responses; defaults true. */
  injectWebMeta?: boolean
}

/** The running gateway. */
export interface GatewayHandle {
  readonly server: Server
  /** The actual listening port (the OS-assigned value when `port` was 0). */
  readonly port: number
  /** Close the listener and every upgraded socket. */
  close(): Promise<void>
}

/** Maximum login form body we will read. */
const MAX_LOGIN_BODY = 16 * 1024

/** Response headers that must never cross the proxy hop. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Cap on buffering an HTML response for meta injection (larger passes through). */
const MAX_INJECT_BYTES = 1024 * 1024

interface GatewayState {
  options: GatewayOptions
  secret: string
  ttlSeconds: number
  users: readonly GatewayUser[]
  log: (line: string) => void
  upgradedSockets: Set<Duplex>
}

function defaultLog(line: string): void {
  console.log(`[mobile-gateway] ${line}`)
}

/** Read a request body up to a byte limit. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Parse a login body as either form-urlencoded or JSON. */
function parseLoginBody(raw: string, contentType: string | undefined): { user?: string | undefined; token?: string | undefined } {
  const type = ((contentType ?? '').split(';')[0] ?? '').trim().toLowerCase()
  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw) as { user?: unknown; token?: unknown }
      return {
        user: typeof parsed.user === 'string' ? parsed.user : undefined,
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
      }
    } catch {
      return {}
    }
  }
  const form = new URLSearchParams(raw)
  const user = form.get('user')
  const token = form.get('token')
  return {
    user: user === null ? undefined : user,
    token: token === null ? undefined : token,
  }
}

/** Read the named cookie from a request. */
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    if (trimmed.slice(0, at).trim() === name) return trimmed.slice(at + 1)
  }
  return undefined
}

/** Build a Set-Cookie header line for our session cookie. */
function sessionCookieHeader(value: string, secure: boolean, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Authorize one request from its cookie; returns the user name or null. */
function authorize(state: GatewayState, req: IncomingMessage): string | null {
  return verifySession(state.secret, readCookie(req, SESSION_COOKIE), state.users)
}

function remoteAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded !== '') return (forwarded.split(',')[0] ?? forwarded).trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location })
  res.end()
}

/** Serve the gateway's own paths (login, logout, health, PWA assets). */
function handleLocal(state: GatewayState, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const secure = state.options.tls !== undefined
  if (req.method === 'POST' && pathname === `${PREFIX}/login`) {
    void (async () => {
      const raw = await readBody(req, MAX_LOGIN_BODY)
      const { user, token } = parseLoginBody(raw, req.headers['content-type'])
      const found = (user !== undefined && user !== '' && token !== undefined)
        ? authenticate(state.users, user, token)
        : token !== undefined
          ? authenticateByToken(state.users, token)
          : undefined
      if (found === undefined) {
        state.log(`login failed from ${remoteAddress(req)} for user=${user ?? '(token-only)'}`)
        const wantsJson = (req.headers.accept ?? '').includes('application/json')
        if (wantsJson) {
          writeJson(res, 401, { error: 'invalid credentials' })
        } else {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          res.end(loginPageHtml(GATEWAY_VERSION, secure).replace('{{ERROR}}', '登录失败：用户名或访问令牌不正确'))
        }
        return
      }
      const cookie = createSession(state.secret, found.name, state.ttlSeconds)
      state.log(`login ok: ${found.name} from ${remoteAddress(req)}`)
      res.writeHead(302, {
        location: '/',
        'set-cookie': sessionCookieHeader(cookie, secure, state.ttlSeconds),
      })
      res.end()
    })().catch((error: unknown) => {
      state.log(`login handler error: ${String(error)}`)
      if (!res.headersSent) writeJson(res, 400, { error: 'bad request' })
    })
    return
  }

  if (pathname === `${PREFIX}/logout`) {
    res.writeHead(302, {
      location: `${PREFIX}/login`,
      'set-cookie': sessionCookieHeader('', secure, 0),
    })
    res.end()
    return
  }

  if (pathname === `${PREFIX}/health`) {
    writeJson(res, 200, {
      ok: true,
      gateway: 'dsh-mobile-gateway',
      version: GATEWAY_VERSION,
      target: `http://${state.options.targetHost}:${state.options.targetPort}`,
      users: state.users.length,
    })
    return
  }

  if (pathname === `${PREFIX}/manifest.webmanifest`) {
    const file = manifestFile()
    res.writeHead(200, { 'content-type': file.contentType, 'content-length': String(file.bytes.length) })
    res.end(file.bytes)
    return
  }

  if (pathname === `${PREFIX}/sw.js`) {
    const file = serviceWorkerFile()
    res.writeHead(200, { 'content-type': file.contentType, 'content-length': String(file.bytes.length) })
    res.end(file.bytes)
    return
  }

  if (pathname === `${PREFIX}/icon-192.png` || pathname === `${PREFIX}/icon-512.png`) {
    const file = iconFile(pathname.endsWith('512.png') ? 512 : 192)
    res.writeHead(200, { 'content-type': file.contentType, 'content-length': String(file.bytes.length) })
    res.end(file.bytes)
    return
  }

  // Login page (GET) for the prefix itself, the trailing-slash form, or /login.
  if ((req.method === 'GET' || req.method === 'HEAD')
    && (pathname === PREFIX || pathname === `${PREFIX}/` || pathname === `${PREFIX}/login`)) {
    if (authorize(state, req) !== null) {
      redirect(res, '/')
      return
    }
    const body = loginPageHtml(GATEWAY_VERSION, secure).replace('{{ERROR}}', '')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }

  writeJson(res, 404, { error: 'not found' })
}

/**
 * Rewrite the meta block of a DSH HTML index response so the UI is
 * installable as a PWA (viewport, manifest, theme, apple touch icon).
 */
function injectWebMeta(html: string): string {
  let out = html
  if (!/<meta[^>]*name=["']viewport["']/i.test(out)) {
    out = out.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
  }
  return out.replace('</head>', `${webMetaSnippet()}</head>`)
}

/** Whether this response qualifies for HTML meta injection. */
function qualifiesForInjection(req: IncomingMessage, upRes: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  const contentType = upRes.headers['content-type']
  if (typeof contentType !== 'string' || !/text\/html/i.test(contentType)) return false
  if (upRes.headers['content-encoding'] !== undefined) return false
  const length = Number(upRes.headers['content-length'])
  return Number.isNaN(length) || length <= MAX_INJECT_BYTES
}

/** Forward one authenticated HTTP request to the DSH web server. */
function forward(
  state: GatewayState,
  req: IncomingMessage,
  res: ServerResponse,
  user: string,
  startedAt: number,
): void {
  const { targetHost, targetPort } = state.options
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin') continue
    if (typeof value === 'string') headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(', ')
  }
  // The browser-trust fence reads Host (and Origin when present): rewrite both
  // to the loopback authority so the forwarded request is exactly a local one.
  headers.host = `${targetHost}:${targetPort}`
  if (req.headers.origin !== undefined) headers.origin = `http://${targetHost}:${targetPort}`

  const upstream = httpRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url ?? '/',
      method: req.method,
      headers,
    },
    (upRes) => {
      const outHeaders: Record<string, string> = {}
      for (const [name, value] of Object.entries(upRes.headers)) {
        const lower = name.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (typeof value === 'string') outHeaders[name] = value
        else if (Array.isArray(value)) outHeaders[name] = value.join(', ')
      }
      const inject = (state.options.injectWebMeta ?? true) && qualifiesForInjection(req, upRes)
      if (inject) {
        const chunks: Buffer[] = []
        upRes.on('data', (chunk: Buffer) => chunks.push(chunk))
        upRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8')
          const rewritten = injectWebMeta(html)
          outHeaders['content-length'] = String(Buffer.byteLength(rewritten))
          res.writeHead(upRes.statusCode ?? 200, outHeaders)
          res.end(rewritten)
          state.log(`${user} ${req.method} ${req.url} ${upRes.statusCode ?? 0} ${Date.now() - startedAt}ms`)
        })
        return
      }
      res.writeHead(upRes.statusCode ?? 200, outHeaders)
      upRes.pipe(res)
      state.log(`${user} ${req.method} ${req.url} ${upRes.statusCode ?? 0} ${Date.now() - startedAt}ms`)
    },
  )
  upstream.on('error', (error: Error) => {
    state.log(`${user} ${req.method} ${req.url} upstream error: ${error.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad gateway: DSH web unreachable')
    } else {
      res.destroy()
    }
  })
  req.pipe(upstream)
}

/** Handle an unauthenticated request: redirect navigations, 401 everything else. */
function deny(state: GatewayState, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  state.log(`denied ${remoteAddress(req)} ${req.method} ${pathname}`)
  const accept = req.headers.accept ?? ''
  if (accept.includes('text/html') && req.method === 'GET') {
    redirect(res, `${PREFIX}/login`)
    return
  }
  writeJson(res, 401, { error: 'unauthorized', login: `${PREFIX}/login` })
}

/** Forward one authenticated WebSocket upgrade to the DSH event mux. */
function forwardUpgrade(state: GatewayState, req: IncomingMessage, socket: Duplex, head: Buffer, user: string): void {
  const { targetHost, targetPort } = state.options
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'origin') continue
    if (typeof value === 'string') headers[name] = value
  }
  headers.host = `${targetHost}:${targetPort}`
  if (req.headers.origin !== undefined) headers.origin = `http://${targetHost}:${targetPort}`
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upstream = httpRequest({
    hostname: targetHost,
    port: targetPort,
    path: req.url ?? '/',
    method: 'GET',
    headers,
  })
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    state.upgradedSockets.delete(socket)
    const close = (): void => {
      socket.destroy()
      upSocket.destroy()
    }
    upSocket.on('error', close)
    socket.on('error', close)
    if (upHead.length > 0) upSocket.unshift(upHead)
    // A 101 needs the standard upgrade headers or Node's HTTP client will not
    // parse the response as an upgrade (and WebSocket clients reject it).
    let response = 'HTTP/1.1 101 Switching Protocols\r\n'
    response += 'Upgrade: websocket\r\n'
    response += 'Connection: Upgrade\r\n'
    for (const [name, value] of Object.entries(upRes.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'connection' || lower === 'upgrade' || lower === 'transfer-encoding') continue
      if (typeof value === 'string') response += `${name}: ${value}\r\n`
    }
    response += '\r\n'
    socket.write(response)
    if (head.length > 0) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    state.log(`ws open: ${user} ${req.url}`)
  })
  upstream.on('error', () => {
    socket.destroy()
  })
  upstream.end()
  state.upgradedSockets.add(socket)
}

/**
 * Create and start the gateway. Resolves once the listener is bound; rejects
 * on bind failure (EADDRINUSE and friends), so the DSH Loader reports the
 * failed fiber.
 * @param options - the gateway configuration.
 * @returns the started gateway handle.
 */
export function createGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const state: GatewayState = {
    options,
    secret: options.secret !== undefined && options.secret !== '' ? options.secret : randomSecret(),
    ttlSeconds: options.sessionTtlSeconds ?? 7 * 24 * 60 * 60,
    users: options.users,
    log: options.log ?? defaultLog,
    upgradedSockets: new Set(),
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = new URL(req.url ?? '/', 'http://gateway').pathname
    if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) {
      handleLocal(state, req, res, pathname)
      return
    }
    const user = authorize(state, req)
    if (user === null) {
      deny(state, req, res, pathname)
      return
    }
    forward(state, req, res, user, Date.now())
  }

  const server = options.tls !== undefined
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : createServer(handler)

  server.on('upgrade', (req, socket, head) => {
    const user = authorize(state, req)
    if (user === null) {
      state.log(`denied ws ${remoteAddress(req)} ${req.url ?? '/'}`)
      socket.destroy()
      return
    }
    forwardUpgrade(state, req, socket, head, user)
  })

  return new Promise<GatewayHandle>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      if (state.users.length === 0) {
        state.log('WARNING: no users configured — every login is denied (fail closed)')
      }
      const scheme = options.tls !== undefined ? 'https' : 'http'
      state.log(
        `listening ${scheme}://${options.bind}:${port} → http://${options.targetHost}:${options.targetPort} `
        + `(${state.users.length} user(s): ${state.users.map(user => user.name).join(', ') || 'none'})`,
      )
      let closed = false
      resolve({
        server,
        port,
        close: () => new Promise<void>((done) => {
          if (closed) {
            done()
            return
          }
          closed = true
          for (const socket of state.upgradedSockets) socket.destroy()
          state.upgradedSockets.clear()
          server.closeAllConnections()
          server.close(() => { done() })
        }),
      })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.bind)
  })
}
