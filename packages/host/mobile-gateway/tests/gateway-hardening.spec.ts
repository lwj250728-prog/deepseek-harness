/**
 * Gateway hardening integration suite: login rate limiting (429 + Retry-After,
 * no credential check once limited), security headers on every surface
 * (nosniff always, HSTS only on TLS, no-store on auth responses), and
 * X-Forwarded-For hygiene (a client-supplied value is never trusted; the true
 * socket peer is forwarded instead). Each test gets a FRESH HTTP gateway so
 * the per-peer login limiter cannot leak between tests.
 */

import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from 'vitest'
import { createGateway, type GatewayHandle } from '../src/gateway.ts'

const USERS = [{ name: 'alice', token: 'token-alice-123' }]
const SECRET = 'hardening-test-secret'

/** Test-only self-signed pair (CN=dsh-gateway-test, SAN IP:127.0.0.1). */
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCknAI+E5/ag1cT
xPvLdzVaFr3wG7Gg+wKi1Au/2jKUdkpvLzbyjC9cLRH67cnEbIxE5zT52Hb4LeUo
HiG++JpJcKLSt3GCVquXaiX/KJ3SI3DCovLnrGE5D/yejYXadwcnHAxH3xEaeXf6
CW3lqNaOEOOOzqvZ5YaLcMkqnkKVZPYxwMZZRKEY+6Ktc32uhKXRN3NWAhUyXl/R
kDK2eLolOd6m9dtAiY6eNxaBBdHqsxejYnyoS/zGgVXv719cogfgBMImJwtDJ9mS
YRnK+NQJFfBKP71Hko6uP7+Ez05+GGhwgfKQMl9ytbq3cV99MqEMNIQ5zYeYsLVG
QCSv946XAgMBAAECggEAMhp6ZEK86VoI6y+OJMRILP+3GJqVWpaMmttIKEFWG/JV
fbo1U2ZwE/J0ApjWTT9tApwNd+73Z1sw4SEqzGIHNEtghBrqJe4TlKbuodfPEeNP
sy6+GN5TSXcgQXJ6R6DrQHA9HLM9FX3bkvPDy5+0jtF9Mj6d+FjwtwjBcoNxaN8x
OBNg8Uz2YRADzW9p9bJWUIsLUgpdZXT9e78ZH+hmTJSwq66ZuqgBhEspOkyam42B
IaWqT7cR66vpTM9ANP5DExZTipF9e0d0QXwEBki2M3T/gnTHJNt+rlLgYwL0SGM+
FisTIXy6ovvcM16MIjOlH2swwqY4fv4pEi+aHwxNAQKBgQDUFUI0MaR7vkZEG+j4
UwwZmMZJTbkdZ2XIBbP3cr2g+ztYAC1fzW3C8WKOVgpuADFvzDrgYXhDl0G81mG/
afZB/BsHlqu7JzrSYWfEbxr40i4aCz6AM7dkqlgLBW8NT2aa77g5N1YZHVMW9hQx
GjAmm4zlVSbfDTrVFbipms8aNwKBgQDGsh+xj+klblal50ct3u6dVDIuBb+BD5LC
zef5xpyT8OylWBkpCxWvSKt/N5YmKO0wwfgtyhGpcPur4Ozi/H7N1GRu707bhVpS
sNeWhdkTeUpBpInrSEj46sh1pCOji7eFNRuIa0p8cVR7asfOo+Xk6u1USDMeIljE
0wrW1Td+oQKBgQDNMLA37Vu1eXdkSBiTwU2wqjYWEAOs5i/8YUAohbPgP5G/55P+
37N1a7OuAKLgoIE0KEVCeCsyQfKRMF2sI2nll3PTWLxYO3FWwHT0AYb3++osunpC
8UZbN9AtAZnbJ9oexxXXDanYbJ3KVlVc2HiDsfWUoFkWbydfqD9coPIE6wKBgBJP
6EvdD4e7m5C+t/iqSyOE1vsW3Idwf/4kK/UBMP0Rfz3d2LPHqb/12phm7xelPfb4
aX8O2IHdP9SfbjWdP7KImJkAxSvGJoTod3YP7+mzi/xwxaVBjDgkq0TsU7yG6+sC
8f6opLzDVR3qwW9x+4YVgLn7zXpBgBzjtmQGUo8BAoGAE+EPqhrz+iwFNjQdWt0s
h8UyYeWKb2ej+yrdXWFj9HugCpzdIX2pTKXvRWokP2U0mKFjOQ0PnCZTGZFLWH/t
ZzereQ+iCP1f89vip2nz1qeRoRXmvsfg4v1bVkZiYWpmSuvGeQeHpwLRQwWcm56i
nWmA8nvogiapKLnJbQvP+64=
-----END PRIVATE KEY-----
`
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIUPkAirXn5qMjd23TccbhRbxfH36IwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQZHNoLWdhdGV3YXktdGVzdDAgFw0yNjA4MTgwMzEyNDha
GA8yMTI2MDcyNTAzMTI0OFowGzEZMBcGA1UEAwwQZHNoLWdhdGV3YXktdGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKScAj4Tn9qDVxPE+8t3NVoW
vfAbsaD7AqLUC7/aMpR2Sm8vNvKML1wtEfrtycRsjETnNPnYdvgt5SgeIb74mklw
otK3cYJWq5dqJf8ondIjcMKi8uesYTkP/J6Nhdp3ByccDEffERp5d/oJbeWo1o4Q
447Oq9nlhotwySqeQpVk9jHAxllEoRj7oq1zfa6EpdE3c1YCFTJeX9GQMrZ4uiU5
3qb120CJjp43FoEF0eqzF6NifKhL/MaBVe/vX1yiB+AEwiYnC0Mn2ZJhGcr41AkV
8Eo/vUeSjq4/v4TPTn4YaHCB8pAyX3K1urdxX30yoQw0hDnNh5iwtUZAJK/3jpcC
AwEAAaNkMGIwHQYDVR0OBBYEFAlsDxzZxxrybQdSddNRuFbVwaygMB8GA1UdIwQY
MBaAFAlsDxzZxxrybQdSddNRuFbVwaygMA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0R
BAgwBocEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAEqSI2RL5k/2w1PG3HSE2LoM4
g2xMmO1tqgHU+ydIkcQ8a7NweJLglVM97HdnJPkfAiHSxuc8vNdrTsFR+sr6ndKg
17Klr+bH5m5qmmTCEWD0n6gvzJd6AaFdgzgKDqunBjvdRhsOnVdjANNdZVeDqvED
7TpQg43/3OoSQSdg+zEkJDZw5dO108XeOHQdM29J2aB1gJqNcy1AXz96VDxHbyXG
9Xtj1zyjRQm5M3tJEZ1MgEEudnniP2kDJ+dBjrPyvyrQ5eErimlNqGUW3AbrfEYS
zaTgQwZoxRdW4dgl6kasvohSSUdtaPOpiK6EcRC0zJi5BHVziGGLj4Ue+hYlZA==
-----END CERTIFICATE-----
`

let upstream: Server
let upstreamPort = 0
let httpGateway: GatewayHandle
let tlsGateway: GatewayHandle
let httpBase = ''
let tlsPort = 0

/** Last request the mock upstream observed (headers + body). */
let observed: { host?: string | undefined; xff?: string | undefined; path?: string | undefined } = {}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function startMockUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    observed = {
      host: asString(req.headers.host),
      xff: asString(req.headers['x-forwarded-for']),
      path: req.url ?? undefined,
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(observed))
  })
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      resolve()
    })
  })
}

async function startHttpGateway(): Promise<void> {
  httpGateway = await createGateway({
    bind: '127.0.0.1',
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    users: USERS,
    secret: SECRET,
    loginRateLimit: { windowMs: 60_000, maxFailures: 2 },
    log: () => {},
  })
  httpBase = `http://127.0.0.1:${httpGateway.port}`
}

function login(base: string, user: string, token: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const body = new URLSearchParams()
  body.set('user', user)
  body.set('token', token)
  return fetch(`${base}/__mobile/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...extraHeaders },
    body: body.toString(),
    redirect: 'manual',
  })
}

/** Minimal TLS request against the test gateway (self-signed, not verified). */
function tlsRequest(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  text: () => Promise<string>
}> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: '127.0.0.1',
      port: tlsPort,
      path,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    if (init?.body !== undefined) req.write(init.body)
    req.end()
  })
}

beforeAll(async () => {
  await startMockUpstream()
  tlsGateway = await createGateway({
    bind: '127.0.0.1',
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    users: USERS,
    secret: SECRET,
    tls: { key: Buffer.from(TLS_KEY), cert: Buffer.from(TLS_CERT) },
    log: () => {},
  })
  tlsPort = tlsGateway.port
})

beforeEach(async () => {
  await startHttpGateway()
})

afterEach(async () => {
  await httpGateway?.close()
})

afterAll(async () => {
  await tlsGateway?.close()
  await new Promise<void>((resolve) => { upstream?.close(() => { resolve() }) })
})

describe('login rate limiting', () => {
  it('trips after the configured failures and stops checking credentials', async () => {
    const wrong = await login(httpBase, 'alice', 'nope')
    expect(wrong.status).toBe(401)
    const wrong2 = await login(httpBase, 'alice', 'nope')
    expect(wrong2.status).toBe(401)
    // The third failure exceeds maxFailures=2 → 429 with Retry-After.
    const tripped = await login(httpBase, 'alice', 'nope')
    expect(tripped.status).toBe(429)
    expect(tripped.headers.get('retry-after')).not.toBeNull()
    // Once limited, even the CORRECT token is rejected without a check.
    const correct = await login(httpBase, 'alice', 'token-alice-123')
    expect(correct.status).toBe(429)
  })

  it('a successful login resets the failure streak for that caller', async () => {
    await login(httpBase, 'alice', 'nope')
    await login(httpBase, 'alice', 'nope')
    const ok = await login(httpBase, 'alice', 'token-alice-123')
    expect(ok.status).toBe(302)
    // The streak is cleared: failures start counting again.
    const again = await login(httpBase, 'alice', 'nope')
    expect(again.status).toBe(401)
  })
})

describe('security headers', () => {
  it('serves nosniff on every surface over plain HTTP (no HSTS without TLS)', async () => {
    const page = await fetch(`${httpBase}/__mobile/login`)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('strict-transport-security')).toBeNull()
    const health = await fetch(`${httpBase}/__mobile/health`)
    expect(health.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds HSTS and Secure cookies on the TLS listener', async () => {
    const page = await tlsRequest('/__mobile/login')
    expect(page.status).toBe(200)
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.headers['strict-transport-security']).toContain('max-age=31536000')
    const body = new URLSearchParams({ user: 'alice', token: 'token-alice-123' }).toString()
    const res = await tlsRequest('/__mobile/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    expect(res.status).toBe(302)
    // node:http presents set-cookie as an array; take the first.
    const raw = res.headers['set-cookie']
    const cookie = Array.isArray(raw) ? raw[0] : raw
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(asString(res.headers['cache-control'])).toBe('no-store')
  })

  it('marks auth responses no-store so the browser never caches them', async () => {
    const failed = await login(httpBase, 'alice', 'nope')
    expect(failed.headers.get('cache-control')).toBe('no-store')
    const logout = await fetch(`${httpBase}/__mobile/logout`, { redirect: 'manual' })
    expect(logout.headers.get('cache-control')).toBe('no-store')
  })
})

describe('X-Forwarded-For hygiene', () => {
  it('never forwards a client-supplied XFF; the true socket peer is sent instead', async () => {
    const res = await login(httpBase, 'alice', 'token-alice-123')
    expect(res.status).toBe(302)
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    const proxied = await fetch(`${httpBase}/api/anything`, {
      headers: { cookie, 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.99' },
    })
    expect(proxied.status).toBe(200)
    expect(observed.xff).toBe('127.0.0.1')
    expect(observed.host).toBe(`127.0.0.1:${upstreamPort}`)
  })
})
