/**
 * Gateway authentication primitives: per-user token validation and
 * HMAC-signed session cookies. Zero network code — pure functions over the
 * user whitelist, so the trust decisions are unit-testable in isolation.
 * @module @deepseek-ai/dsh-mobile-gateway/auth
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** One named phone user: the whitelist entry the gateway is configured with. */
export interface GatewayUser {
  /** Human-readable name; appears in the audit log (never sent to DSH). */
  name: string
  /** Secret shared with this user's phone. Use `openssl rand -hex 24`-grade entropy. */
  token: string
}

/** Cookie name the gateway owns on its own origin (never forwarded upstream). */
export const SESSION_COOKIE = 'dsh_mgw_session'

/** Session value version prefix, so future formats can migrate cleanly. */
const SESSION_PREFIX = 'dshg1.'

/** Length-checked, timing-safe string equality (attacker-controlled input first). */
export function constantEqual(expected: string, given: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Resolve a login by (name, token). The name must exist and the token must
 * match that user's token exactly (timing-safe). Unknown names and wrong
 * tokens are indistinguishable failures.
 */
export function authenticate(users: readonly GatewayUser[], name: string, token: string): GatewayUser | undefined {
  const user = users.find(candidate => candidate.name === name)
  if (user === undefined || !constantEqual(user.token, token)) return undefined
  return user
}

/**
 * Token-only login fallback: find ANY whitelisted user carrying the token.
 * Iterates the whole list so the time cost does not reveal the matching slot.
 */
export function authenticateByToken(users: readonly GatewayUser[], token: string): GatewayUser | undefined {
  let hit: GatewayUser | undefined
  for (const user of users) {
    if (constantEqual(user.token, token)) hit = user
  }
  return hit
}

/** Session payload inside the signed cookie. */
export interface SessionPayload {
  /** The authenticated user's name. */
  n: string
  /** Expiry as a Unix epoch in seconds. */
  e: number
}

/** base64url, no padding — safe in a cookie value. */
function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Mint a signed session cookie value for one user. The signature is
 * HMAC-SHA256 over the payload with the gateway secret; the payload carries
 * the user and an absolute expiry, and {@link verifySession} re-checks the
 * whitelist on every read, so rotating a token revokes live sessions.
 */
export function createSession(secret: string, name: string, ttlSeconds: number): string {
  const payload: SessionPayload = { n: name, e: Math.floor(Date.now() / 1000) + ttlSeconds }
  const encoded = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(encoded).digest('hex')
  return `${SESSION_PREFIX}${encoded}.${sig}`
}

/**
 * Verify a cookie value and return the authenticated user name, or null when
 * the value is missing, malformed, unverifiable, expired, or names a user no
 * longer on the whitelist.
 */
export function verifySession(
  secret: string,
  cookieValue: string | undefined,
  users: readonly GatewayUser[],
): string | null {
  if (cookieValue === undefined || !cookieValue.startsWith(SESSION_PREFIX)) return null
  const rest = cookieValue.slice(SESSION_PREFIX.length)
  const dot = rest.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = rest.slice(0, dot)
  const signature = rest.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(encoded).digest('hex')
  if (!constantEqual(expected, signature)) return null
  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return null
  }
  if (typeof payload.n !== 'string' || typeof payload.e !== 'number' || Number.isNaN(payload.e)) return null
  if (payload.e < Math.floor(Date.now() / 1000)) return null
  if (!users.some(user => user.name === payload.n)) return null
  return payload.n
}

/** A fresh random gateway secret (used when config leaves `secret` empty). */
export function randomSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Parse the `DSH_MOBILE_GATEWAY_USERS` env format `name1:token1,name2:token2`
 * into whitelist entries. Malformed pairs are dropped (fail closed). Also
 * accepts a bare `name=token` separator for shells that dislike colons in
 * variable values.
 */
export function parseUsersEnv(raw: string | undefined): GatewayUser[] {
  if (raw === undefined || raw.trim() === '') return []
  const users: GatewayUser[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    const equals = trimmed.indexOf('=')
    const at = colon === -1 ? equals : equals === -1 ? colon : Math.min(colon, equals)
    if (at <= 0) continue
    const name = trimmed.slice(0, at).trim()
    const token = trimmed.slice(at + 1).trim()
    if (name !== '' && token !== '') users.push({ name, token })
  }
  return users
}
