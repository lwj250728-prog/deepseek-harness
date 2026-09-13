/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-handover`.
 * @module @deepseek-ai/dsh-session-handover/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-handover'

/** Cordis companion plugin name. */
export const name = 'session-handover-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package decides WHEN to continue a conversation
 * elsewhere and delegates every durable effect to the session, agent, and
 * workspace services — it appends no event of its own, so there is no
 * package-owned data relation for an independent companion to observe. The seed
 * it builds is validated by the ordinary resume path, which the package's tests
 * exercise directly.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
