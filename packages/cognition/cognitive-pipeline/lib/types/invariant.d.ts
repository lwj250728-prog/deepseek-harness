/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cognitive-pipeline`.
 * Verifies the store's probability, vector-dimension, and acceptance-ledger
 * contracts whenever the pipeline service is mounted alongside the invariant
 * registry.
 * @module @deepseek-ai/dsh-cognitive-pipeline/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "cognitive-pipeline-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map