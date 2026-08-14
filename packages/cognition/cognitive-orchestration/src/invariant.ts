/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-cognitive-orchestration`.
 * @module @deepseek-ai/dsh-cognitive-orchestration/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-cognitive-orchestration'

/** Cordis companion plugin name. */
export const name = 'cognitive-orchestration-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the orchestration layer owns no independent event
 * stream or mutable data beyond the pipeline and subagent services it
 * composes, whose own invariants cover their contracts; the loader and unit
 * tests cover the wrapper wiring.
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
