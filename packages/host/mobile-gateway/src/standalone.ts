#!/usr/bin/env node
/**
 * Standalone runner for the mobile gateway — the no-DSH way to front an
 * already-running DSH web server, superseding the old hand-rolled
 * `data/plugins/dsh-web-gateway/gateway.mjs` script with the same
 * authenticated-reverse-proxy behavior plus signed-session login and the PWA
 * shell. Configuration is all environment variables:
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `DSH_MOBILE_GATEWAY_BIND` | `127.0.0.1` | listen address |
 * | `DSH_MOBILE_GATEWAY_PORT` | `4080` | listen port |
 * | `DSH_MOBILE_GATEWAY_TARGET_HOST` | `127.0.0.1` | upstream host |
 * | `DSH_MOBILE_GATEWAY_TARGET_PORT` | `3080` | upstream port |
 * | `DSH_MOBILE_GATEWAY_USERS` | — | `name1:token1,name2:token2` whitelist |
 * | `DSH_MOBILE_GATEWAY_TOKENS` | — | bare token list, names auto `user-1`… |
 * | `DSH_MOBILE_GATEWAY_SECRET` | random | stable session HMAC secret |
 * | `DSH_MOBILE_GATEWAY_TTL_SECONDS` | `604800` | session lifetime |
 * | `DSH_MOBILE_GATEWAY_TLS_KEY` | — | PEM key path (pair with CERT) |
 * | `DSH_MOBILE_GATEWAY_TLS_CERT` | — | PEM cert path |
 * @module @deepseek-ai/dsh-mobile-gateway/standalone
 */

import { readFileSync } from 'node:fs'
import { parseUsersEnv, type GatewayUser } from './auth.ts'
import { createGateway } from './gateway.ts'

function env(name: string): string | undefined {
  return process.env[name]
}

function envInt(name: string, fallback: number): number {
  const raw = env(name)
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 65535 ? value : fallback
}

/** Bare-token env (`DSH_MOBILE_GATEWAY_TOKENS`) becomes auto-named users. */
function tokensEnvUsers(raw: string | undefined): GatewayUser[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(',').map(token => token.trim()).filter(token => token !== '')
    .map((token, index) => ({ name: `user-${index + 1}`, token }))
}

const users = [...parseUsersEnv(env('DSH_MOBILE_GATEWAY_USERS')), ...tokensEnvUsers(env('DSH_MOBILE_GATEWAY_TOKENS'))]

const tlsKeyPath = env('DSH_MOBILE_GATEWAY_TLS_KEY')
const tlsCertPath = env('DSH_MOBILE_GATEWAY_TLS_CERT')
const tls = tlsKeyPath !== undefined && tlsCertPath !== undefined
  ? { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) }
  : undefined

const gateway = await createGateway({
  bind: env('DSH_MOBILE_GATEWAY_BIND') ?? '127.0.0.1',
  port: envInt('DSH_MOBILE_GATEWAY_PORT', 4080),
  targetHost: env('DSH_MOBILE_GATEWAY_TARGET_HOST') ?? '127.0.0.1',
  targetPort: envInt('DSH_MOBILE_GATEWAY_TARGET_PORT', 3080),
  users,
  secret: env('DSH_MOBILE_GATEWAY_SECRET'),
  sessionTtlSeconds: envInt('DSH_MOBILE_GATEWAY_TTL_SECONDS', 7 * 24 * 60 * 60),
  tls,
})

const scheme = tls !== undefined ? 'https' : 'http'
console.log(`[mobile-gateway] ready at ${scheme}://${env('DSH_MOBILE_GATEWAY_BIND') ?? '127.0.0.1'}:${gateway.port}`)

const shutdown = (code: number): void => {
  void gateway.close().then(() => process.exit(code))
}
process.on('SIGINT', () => { shutdown(130) })
process.on('SIGTERM', () => { shutdown(0) })
