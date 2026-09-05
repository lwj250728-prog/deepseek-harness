/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-fiscal-map`.
 * @module @deepseek-ai/dsh-client-ui-fiscal-map/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-fiscal-map'

/** Cordis companion plugin name. */
export const name = 'client-ui-fiscal-map-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings-section registration is an effect owned
 * and observed by the slot registry, exercised through the public wire
 * protocol; the choropleth stays a pure projection of the embedded dataset.
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
