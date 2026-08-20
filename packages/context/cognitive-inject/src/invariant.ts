/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cognitive-inject`.
 * Verifies every injection event the plugin appended: the message must be a
 * plugin-sourced snapshot carrying exactly one text block whose source keeps
 * package ownership, and the reference text must open with the durable
 * preamble — so replay and dispatch observe the same format the plugin writes.
 * @module @deepseek-ai/dsh-cognitive-inject/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-cognitive-inject'
const SOURCE_NAME = 'cognitive-inject'
const PREAMBLE = '【认知经验参考】'

/** Cordis companion plugin name. */
export const name = 'cognitive-inject-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one plugin-attributed injection against its source and block shape. */
function validateInjection(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const blockValue: unknown = event.data.content[0]
  const block = typeof blockValue === 'object' && blockValue !== null
    ? blockValue as Record<string, unknown>
    : undefined
  const blockText = block?.text
  if (event.data.content.length !== 1
    || block === undefined
    || block.type !== 'text'
    || typeof blockText !== 'string') {
    fail('cognitive-inject messages must contain exactly one text block')
  }
  if (!blockText.startsWith(PREAMBLE)) {
    fail('cognitive-inject message must open with the durable reference preamble')
  }
  const source = event.data.source
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('cognitive-inject source must retain package ownership')
  }
  const sections: unknown = 'sections' in source ? source.sections : undefined
  const sectionValue: unknown = Array.isArray(sections) ? sections[0] : undefined
  const section = typeof sectionValue === 'object' && sectionValue !== null
    ? sectionValue as Record<string, unknown>
    : undefined
  if (source.form !== 'snapshot'
    || !Array.isArray(sections)
    || sections.length !== 1
    || section === undefined
    || Object.keys(section).length !== 2
    || section.name !== SOURCE_NAME
    || section.text !== blockText) {
    fail('cognitive-inject source must carry only the exact snapshot text, not request authority')
  }
}

/** Validate all package-owned injections already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.events) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateInjection(event, fail)
  }
}

/** Install validation for loaded and newly appended injection events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateInjection(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the cognitive-inject invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
