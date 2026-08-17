/**
 * Gateway integration suite: a mock upstream (plain HTTP + a WebSocket echo
 * server) stands in for the DSH web server, and the gateway is exercised over
 * real sockets — auth fence, signed-session login, Host/Origin rewriting,
 * PWA asset serving, HTML meta injection, and WebSocket upgrade proxying.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createGateway, type GatewayHandle } from '../src/gateway.ts'

const USERS = [{ name: 'alice', token: 'token-alice-123' }]
const SECRET = 'test-secret'

let upstream: Server
let upstreamPort = 0
let wsServer: WebSocketServer
let gateway: GatewayHandle
let base = ''

/** What the upstream observed for the last proxied request. */
let observed: { host?: string | undefined; origin?: string | undefined; path?: string | undefined; body: string } = { body: '' }

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function startMockUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      observed = {
        host: asString(req.headers.host),
        origin: asString(req.headers.origin),
        path: req.url ?? undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      if (req.url === '/index') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>dsh</title></head><body>ui</body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(observed))
    })
  })
  wsServer = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => { ws.send(data) })
      })
    } else {
      socket.destroy()
    }
  })
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      resolve()
    })
  })
}

function extractCookie(setCookieHeader: string | null | undefined): string | undefined {
  if (setCookieHeader === undefined || setCookieHeader === null) return undefined
  return setCookieHeader.split(';')[0]
}

function login(user: string | undefined, token: string): Promise<Response> {
  const body = new URLSearchParams()
  if (user !== undefined) body.set('user', user)
  body.set('token', token)
  return fetch(`${base}/__mobile/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    redirect: 'manual',
  })
}

beforeAll(async () => {
  await startMockUpstream()
  gateway = await createGateway({
    bind: '127.0.0.1',
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    users: USERS,
    secret: SECRET,
    log: () => {},
  })
  base = `http://127.0.0.1:${gateway.port}`
})

afterAll(async () => {
  await gateway?.close()
  wsServer?.close()
  await new Promise<void>((resolve) => { upstream?.close(() => { resolve() }) })
})

describe('authentication fence', () => {
  it('answers 401 to an unauthenticated API request', async () => {
    const res = await fetch(`${base}/api/session.list`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })

  it('redirects an unauthenticated navigation to the login page', async () => {
    const res = await fetch(`${base}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/__mobile/login')
  })

  it('rejects a wrong token at login', async () => {
    const res = await login('alice', 'wrong-token')
    expect(res.status).toBe(401)
  })

  it('rejects a login naming an unknown user', async () => {
    const res = await login('mallory', 'token-alice-123')
    expect(res.status).toBe(401)
  })

  it('accepts a correct (name, token) login and sets an HttpOnly cookie', async () => {
    const res = await login('alice', 'token-alice-123')
    expect(res.status).toBe(302)
    const cookie = extractCookie(res.headers.get('set-cookie'))
    expect(cookie).toBeDefined()
    expect(cookie).toMatch(/^dsh_mgw_session=/)
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('accepts token-only login (no user field)', async () => {
    const res = await login(undefined, 'token-alice-123')
    expect(res.status).toBe(302)
  })

  it('rejects a forged cookie', async () => {
    const res = await fetch(`${base}/`, {
      headers: { accept: 'application/json', cookie: 'dsh_mgw_session=dshg1.abc.def' },
    })
    expect(res.status).toBe(401)
  })
})

describe('reverse proxy', () => {
  it('forwards an authenticated request and rewrites Host/Origin to loopback', async () => {
    const loginRes = await login('alice', 'token-alice-123')
    const cookie = extractCookie(loginRes.headers.get('set-cookie'))!
    const res = await fetch(`${base}/api/echo?x=1`, {
      headers: {
        accept: 'application/json',
        cookie,
        origin: 'http://phone-lan-ip:9999',
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as typeof observed
    expect(body.host).toBe(`127.0.0.1:${upstreamPort}`)
    expect(body.origin).toBe(`http://127.0.0.1:${upstreamPort}`)
    expect(body.path).toBe('/api/echo?x=1')
  })

  it('forwards POST bodies untouched', async () => {
    const loginRes = await login('alice', 'token-alice-123')
    const cookie = extractCookie(loginRes.headers.get('set-cookie'))!
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'hello upstream',
    })
    expect(res.status).toBe(200)
    expect(observed.body).toBe('hello upstream')
  })

  it('injects PWA meta into HTML index responses', async () => {
    const loginRes = await login('alice', 'token-alice-123')
    const cookie = extractCookie(loginRes.headers.get('set-cookie'))!
    const res = await fetch(`${base}/index`, { headers: { cookie } })
    const html = await res.text()
    expect(html).toContain('<link rel="manifest" href="/__mobile/manifest.webmanifest" />')
    expect(html).toContain('<meta name="viewport"')
  })

  it('answers 502 when the upstream is unreachable', async () => {
    const dead = await createGateway({
      bind: '127.0.0.1', port: 0,
      targetHost: '127.0.0.1', targetPort: 1,
      users: USERS, secret: SECRET, log: () => {},
    })
    try {
      const loginRes = await fetch(`http://127.0.0.1:${dead.port}/__mobile/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ user: 'alice', token: 'token-alice-123' }).toString(),
        redirect: 'manual',
      })
      const cookie = extractCookie(loginRes.headers.get('set-cookie'))!
      const res = await fetch(`http://127.0.0.1:${dead.port}/`, { headers: { cookie } })
      expect(res.status).toBe(502)
    } finally {
      await dead.close()
    }
  })
})

describe('gateway surface', () => {
  it('serves the PWA manifest', async () => {
    const res = await fetch(`${base}/__mobile/manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('manifest')
    const manifest = await res.json() as { start_url?: string; icons?: unknown[] }
    expect(manifest.start_url).toBe('/')
    expect(manifest.icons).toHaveLength(2)
  })

  it('serves the login page and the icons', async () => {
    const page = await fetch(`${base}/__mobile/login`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('DSH Mobile')
    const icon = await fetch(`${base}/__mobile/icon-192.png`)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toContain('image/png')
    const png = Buffer.from(await icon.arrayBuffer())
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  })

  it('reports health with the forward target', async () => {
    const res = await fetch(`${base}/__mobile/health`)
    expect(res.status).toBe(200)
    const health = await res.json() as { ok: boolean; target: string; users: number }
    expect(health.ok).toBe(true)
    expect(health.target).toBe(`http://127.0.0.1:${upstreamPort}`)
    expect(health.users).toBe(1)
  })

  it('logs out by clearing the cookie (browser-side discard)', async () => {
    const loginRes = await login('alice', 'token-alice-123')
    const cookie = extractCookie(loginRes.headers.get('set-cookie'))!
    const logout = await fetch(`${base}/__mobile/logout`, { headers: { cookie }, redirect: 'manual' })
    expect(logout.status).toBe(302)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    // The session is a stateless signed cookie: logout discards it client-side.
    // A request WITHOUT the cookie is now unauthenticated again.
    const res = await fetch(`${base}/`, { headers: { accept: 'application/json' } })
    expect(res.status).toBe(401)
  })
})

describe('websocket upgrade proxying', () => {
  it('opens a proxied echo socket with a valid cookie and rejects without one', async () => {
    const loginRes = await login('alice', 'token-alice-123')
    const cookie = extractCookie(loginRes.headers.get('set-cookie'))!

    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => {
        socket.send('ping-frame')
      })
      socket.on('message', (data) => {
        try {
          expect((data as Buffer).toString('utf8')).toBe('ping-frame')
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        } finally {
          socket.close()
        }
      })
      socket.on('error', reject)
    })

    const refused = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, { headers: {} })
    await new Promise<void>((resolve, reject) => {
      refused.on('open', () => {
        reject(new Error('upgrade should have been refused'))
        refused.close()
      })
      refused.on('error', () => { resolve() })
      refused.on('unexpected-response', () => { resolve() })
    })
  })
})
