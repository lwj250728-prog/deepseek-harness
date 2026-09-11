/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-goal-tree`.
 * @module @deepseek-ai/dsh-client-ui-goal-tree/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-goal-tree'

/** Cordis companion plugin name. */
export const name = 'client-ui-goal-tree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the panel is a read-only projection of a file an
 * out-of-tree generator publishes, and both of its runtime edges are already
 * owned elsewhere — the endpoint is a Connection route (disposed with the
 * plugin's effect) and the sidebar occupant is a slot registration (disposed by
 * the slot registry).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
