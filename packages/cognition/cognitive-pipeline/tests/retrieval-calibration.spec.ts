/**
 * Retrieval self-calibration tests: the global OOD threshold adapts to
 * per-branch feedback, each category (cluster / unassigned) keeps its own
 * threshold, the OOD gate is category-conditional, and feedback flows from
 * resolved predictions into the per-category stats.
 * @module @deepseek-ai/dsh-cognitive-pipeline/tests/retrieval-calibration
 */

import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import type { Experience } from '../src/types.ts'

/** Minimal experience rows for routing tests (only clusterId is consulted). */
function fakeExperience(clusterId: number | null): Experience {
  return {
    expId: `exp_${clusterId ?? 'null'}`,
    sar: {
      situation: 's',
      action: 'a',
      outcome: 'o',
      actionKeywords: [],
      outcomeUtility: { materialGain: 5, emotionalValence: 5, energyCost: 5 },
    },
    actionVector: [],
    outcomeVector: [],
    clusterId,
    strategyLabel: null,
    timestamp: 0,
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
  }
}

describe('retrieval self-calibration', () => {
  it('loosens the global threshold when the novel path errors dominate', async () => {
    const { ctx, teardown } = await pipelineHarness({ retrievalMinSamples: 2, retrievalStep: 0.02 })
    try {
      const store = ctx.cognitivePipeline.store
      // 3 known-path resolutions with small errors, 3 novel-path with large ones.
      for (let index = 0; index < 3; index += 1) {
        store.recordRetrievalFeedback(false, 0.1, 0.65)
        store.recordRetrievalFeedback(true, 0.8, 0.65)
      }
      const result = ctx.cognitivePipeline.hot.calibrateRetrieval()
      expect(result.adjusted).toBe(true)
      expect(result.to).toBeLessThan(result.from)
      expect(result.categoryAdjustments).toBe(0)
      expect(store.retrievalPolicy()?.oodSimThreshold).toBeCloseTo(0.63, 3)
    } finally {
      await teardown()
    }
  })

  it('holds the threshold when branch errors are balanced', async () => {
    const { ctx, teardown } = await pipelineHarness({ retrievalMinSamples: 2 })
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 0; index < 2; index += 1) {
        store.recordRetrievalFeedback(false, 0.4, 0.65)
        store.recordRetrievalFeedback(true, 0.5, 0.65)
      }
      const result = ctx.cognitivePipeline.hot.calibrateRetrieval()
      expect(result.adjusted).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('calibrates each category independently', async () => {
    const { ctx, teardown } = await pipelineHarness({ retrievalMinSamples: 2, retrievalStep: 0.02 })
    try {
      const store = ctx.cognitivePipeline.store
      // Category 1: novel errors dominate → loosens.
      for (let index = 0; index < 2; index += 1) {
        store.recordClusterRetrievalFeedback(1, false, 0.1, 0.65)
        store.recordClusterRetrievalFeedback(1, true, 0.8, 0.65)
      }
      // Category 2: known errors dominate → tightens.
      for (let index = 0; index < 2; index += 1) {
        store.recordClusterRetrievalFeedback(2, false, 0.8, 0.65)
        store.recordClusterRetrievalFeedback(2, true, 0.1, 0.65)
      }
      const result = ctx.cognitivePipeline.hot.calibrateRetrieval()
      expect(result.categoryAdjustments).toBe(2)
      expect(store.clusterRetrievalState(1)?.oodSimThreshold).toBeCloseTo(0.63, 3)
      expect(store.clusterRetrievalState(2)?.oodSimThreshold).toBeCloseTo(0.67, 3)
      expect(store.clusterRetrievalState(1)?.oodSimThreshold)
        .not.toBe(store.clusterRetrievalState(2)?.oodSimThreshold)
    } finally {
      await teardown()
    }
  })

  it('routes the OOD gate through the top-1 hit category threshold', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      const hot = ctx.cognitivePipeline.hot
      // Global seed 0.65; category 1 loosened to 0.3.
      store.applyClusterRetrievalPolicy(1, { oodSimThreshold: 0.3 })
      const hits = [
        { exp: fakeExperience(1), similarity: 0.4 },
        { exp: fakeExperience(1), similarity: 0.1 },
        { exp: fakeExperience(1), similarity: 0.05 },
      ]
      // Under category 1's loosened gate, top1 0.4 is NOT low-similarity.
      expect(hot.effectiveClusterThreshold(1)).toBeCloseTo(0.3, 3)
      expect(hot.detectOod(hits).signal).toBe('none')
      // Under the global gate, the same top1 would be flagged.
      expect(hot.effectiveOodThreshold()).toBeCloseTo(0.65, 3)
      expect(hot.detectOod([{ exp: fakeExperience(null), similarity: 0.4 },
        { exp: fakeExperience(null), similarity: 0.1 },
        { exp: fakeExperience(null), similarity: 0.05 }]).signal).toBe('low-similarity')
    } finally {
      await teardown()
    }
  })

  it('records per-category feedback from resolved predictions and exposes it', async () => {
    const { ctx, teardown } = await pipelineHarness({ retrievalMinSamples: 2, retrievalCalibrationInterval: 10 })
    try {
      const store = ctx.cognitivePipeline.store
      // Give the store one clustered experience so queries route to category 1.
      store.addExperience({
        ...fakeExperience(1),
        expId: 'exp_1',
        timestamp: Date.now(),
      })
      const first = await ctx.cognitivePipeline.predict({ situation: 's', action: '晨跑五公里' })
      expect(first.retrievedClusterId).toBe(1)
      await ctx.cognitivePipeline.report({ predictionId: first.predictionId, actualOutcome: 'ok', outcomeQuality: 8 })
      const cat = store.clusterRetrievalState(1)
      expect((cat?.knownCount ?? 0) + (cat?.novelCount ?? 0)).toBe(1)
      const inspect = ctx.cognitivePipeline.inspect()
      expect(inspect.retrieval.categories.length).toBe(1)
      expect(inspect.retrieval.categories[0]?.clusterId).toBe(1)
    } finally {
      await teardown()
    }
  })
})
