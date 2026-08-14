/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cognitive-pipeline`.
 * Verifies the store's probability and vector-dimension contracts whenever
 * the pipeline service is mounted alongside the invariant registry.
 * @module @deepseek-ai/dsh-cognitive-pipeline/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { ACTION_VECTOR_DIM, OUTCOME_VECTOR_DIM } from './vectorizer.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-cognitive-pipeline'

/** Cordis companion plugin name. */
export const name = 'cognitive-pipeline-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Verify persisted contracts: probabilities stay in [0, 1] and stored vectors
 * keep their declared dimensions. Runs once at install against the live
 * snapshot; the check is intentionally cheap (no full rescan on every turn).
 */
const install: InvariantInstaller = (ctx: Context, fail: (message: string) => never) => {
  const service = ctx.get('cognitivePipeline')
  if (service === undefined) return
  for (const prediction of service.store.predictionsSnapshot()) {
    if (!Number.isFinite(prediction.calibratedProbability)
      || prediction.calibratedProbability < 0
      || prediction.calibratedProbability > 1) {
      fail(`prediction ${prediction.predictionId} has calibratedProbability outside [0,1]`)
    }
    if (prediction.confidenceLow < 0 || prediction.confidenceHigh > 1 || prediction.confidenceHigh < prediction.confidenceLow) {
      fail(`prediction ${prediction.predictionId} has an invalid confidence interval`)
    }
  }
  for (const exp of service.store.experiencesSnapshot()) {
    if (exp.actionVector.length !== ACTION_VECTOR_DIM) {
      fail(`experience ${exp.expId} has actionVector of ${exp.actionVector.length} (expected ${ACTION_VECTOR_DIM})`)
    }
    if (exp.outcomeVector.length !== OUTCOME_VECTOR_DIM) {
      fail(`experience ${exp.expId} has outcomeVector of ${exp.outcomeVector.length} (expected ${OUTCOME_VECTOR_DIM})`)
    }
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
