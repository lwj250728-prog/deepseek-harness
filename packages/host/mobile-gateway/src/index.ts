/**
 * @deepseek-ai/dsh-mobile-gateway — the Cordis plugin mounting the mobile
 * access gateway inside the `dsh --profile web` process. The row injects
 * `webServer` so the forward target resolves to the ACTUAL loopback DSH web
 * port (including `--port 0` OS-assigned ports); the gateway then listens on
 * its own second socket (`bind:port`, default 0.0.0.0:4080) and only forwards
 * authenticated traffic to the loopback server.
 *
 * The DSH web process keeps its safety posture: the upstream stays bound to
 * loopback (`--host 0.0.0.0` remains refused), and every forwarded request
 * carries rewritten `Host`/`Origin` headers, so the browser-trust fence
 * accepts it as a local request. An empty `users` list denies every login.
 * @module @deepseek-ai/dsh-mobile-gateway
 */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parseUsersEnv, type GatewayUser } from './auth.ts'
import { createGateway } from './gateway.ts'

/** Stable Cordis plugin name. */
export const name = 'mobile-gateway'

/** Services required before the forward target can be resolved. */
export const inject = ['webServer']

/** Plugin config: the gateway's own listener plus the loopback forward target. */
export interface Config {
  /** Gateway listen address; `0.0.0.0` exposes the AUTHENTICATED gateway to the LAN. */
  bind: string
  /** Gateway listen port. */
  port: number
  /** Upstream host (normally the loopback DSH web server). */
  targetHost: string
  /** Upstream port; 0 resolves from `ctx.webServer.port` at activation. */
  targetPort: number
  /** The phone-user whitelist; empty denies every login (fail closed). */
  users: GatewayUser[]
  /** Signed-session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Optional stable HMAC secret; empty mints a per-process random secret. */
  secret: string
  /** Optional PEM private key path; must be set together with `tlsCertPath`. */
  tlsKeyPath: string
  /** Optional PEM certificate path; must be set together with `tlsKeyPath`. */
  tlsCertPath: string
}

export const Config: z<Config> = z.object({
  bind: z.string().default('0.0.0.0'),
  port: z.natural().max(65535).default(4080),
  targetHost: z.string().default('127.0.0.1'),
  targetPort: z.natural().max(65535).default(0),
  users: z.array(z.object({
    name: z.string().required(),
    token: z.string().required(),
  })).default([]),
  sessionTtlSeconds: z.natural().default(7 * 24 * 60 * 60),
  secret: z.string().default(''),
  tlsKeyPath: z.string().default(''),
  tlsCertPath: z.string().default(''),
})

/**
 * Mount the gateway. Activation awaits the listener bind, so a bind failure
 * (EADDRINUSE…) rejects the fiber and the Loader reports it; disposal closes
 * the listener and every upgraded socket.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 * @returns disposal that closes the gateway.
 */
export function apply(ctx: Context, config: Config): Promise<() => void> {
  // Env fallback for the whitelist: DSH_MOBILE_GATEWAY_USERS=name1:token1,name2:token2.
  // Env entries override same-named config entries (useful for rotating a
  // token without touching the patch file) and never duplicate a config user.
  const users = [...config.users]
  for (const envUser of parseUsersEnv(process.env.DSH_MOBILE_GATEWAY_USERS)) {
    const existing = users.findIndex(user => user.name === envUser.name)
    if (existing === -1) users.push(envUser)
    else users[existing] = envUser
  }

  const targetPort = config.targetPort > 0 ? config.targetPort : ctx.webServer.port
  const tls = config.tlsKeyPath !== '' && config.tlsCertPath !== ''
    ? { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) }
    : undefined

  return createGateway({
    bind: config.bind,
    port: config.port,
    targetHost: config.targetHost,
    targetPort,
    users,
    secret: config.secret === '' ? undefined : config.secret,
    sessionTtlSeconds: config.sessionTtlSeconds,
    tls,
  }).then((gateway) => {
    // ctx.effect runs its disposer on fiber disposal (profile reload, shutdown).
    ctx.effect(() => () => { void gateway.close() }, 'mobile-gateway: proxy listener')
    return () => { void gateway.close() }
  })
}
