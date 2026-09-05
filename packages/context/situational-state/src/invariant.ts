/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-situational-state`.
 * Verifies every message this plugin appended: a plugin-sourced message with
 * exactly one text block, source ownership retained, and a text that opens
 * with the durable context or wake preamble — so replay and dispatch observe
 * the same format the plugin writes.
 * @module @deepseek-ai/dsh-situational-state/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { CONTEXT_PREAMBLE, SOURCE_NAME, WAKE_PREAMBLE } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-situational-state'

/** Cordis companion plugin name. */
export const name = 'situational-state-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one plugin-attributed message against its source and block shape. */
function validateMessage(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const blockValue: unknown = event.data.content[0]
  const block = typeof blockValue === 'object' && blockValue !== null
    ? blockValue as Record<string, unknown>
    : undefined
  const blockText = block?.text
  if (event.data.content.length !== 1
    || block === undefined
    || block.type !== 'text'
    || typeof blockText !== 'string') {
    fail('situational-state messages must contain exactly one text block')
  }
  if (typeof blockText !== 'string'
    || (!blockText.startsWith(CONTEXT_PREAMBLE) && !blockText.startsWith(WAKE_PREAMBLE))) {
    fail('situational-state message must open with the durable context or wake preamble')
  }
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('situational-state source must retain package ownership')
  }
}

/** Validate all package-owned messages already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateMessage(event, fail)
  }
}

/** Install validation for loaded and newly appended message events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateMessage(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the situational-state invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
