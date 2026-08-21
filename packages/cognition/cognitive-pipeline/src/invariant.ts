/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-cognitive-pipeline`.
 * Verifies the store's probability, vector-dimension, and acceptance-ledger
 * contracts whenever the pipeline service is mounted alongside the invariant
 * registry.
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
  for (const cluster of service.store.clustersSnapshot()) {
    // polarity is normalized at the store load boundary, so the union is
    // trusted; the centroid dimension is still a live runtime contract.
    if (!Array.isArray(cluster.situationCentroid) || cluster.situationCentroid.length !== ACTION_VECTOR_DIM) {
      fail(`cluster ${cluster.clusterId} has situationCentroid of ${cluster.situationCentroid.length} (expected ${ACTION_VECTOR_DIM})`)
    }
  }
  for (const check of service.store.acceptanceSnapshot()) {
    // Every audit bumps invoked by exactly one and passed XOR violated by one,
    // so the ledger must stay integer and the partition sound.
    if (!Number.isInteger(check.invokedCount) || check.invokedCount < 0
      || !Number.isInteger(check.passedCount) || check.passedCount < 0
      || !Number.isInteger(check.violatedCount) || check.violatedCount < 0) {
      fail(`acceptance check ${check.checkId} has a negative or non-integer count`)
    }
    if (check.passedCount + check.violatedCount > check.invokedCount) {
      fail(`acceptance check ${check.checkId} has passed+violated exceeding invoked`)
    }
    if (check.cumulativeError < 0 || !Number.isInteger(check.errorFoldCount) || check.errorFoldCount < 0) {
      fail(`acceptance check ${check.checkId} has an invalid error ledger`)
    }
  }
  for (const audit of service.store.claimAuditsSnapshot()) {
    // An audit's verdict partition must agree with its check-id lists.
    const violated = audit.violatedCheckIds.length > 0
    if ((audit.verdict === 'violated') !== violated && audit.verdict !== 'not-applicable') {
      fail(`claim audit ${audit.auditId} has a verdict/check-list mismatch`)
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
