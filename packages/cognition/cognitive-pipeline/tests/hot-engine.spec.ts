import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

const POSITIVE_UTILITY = {
  situation: '清晨天气晴朗',
  action: '晨跑五公里',
  outcome: '精力充沛一整天，工作效率提升',
}

describe('hot loop (predict_outcome)', () => {
  it('treats a cold-store action as novel and creates a scratchpad strategy', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const result = await ctx.cognitivePipeline.predict({ situation: '深夜', action: '立即起身去健身房' })
      expect(result.isNovel).toBe(true)
      expect(result.usedTempStrategy).toBe(false)
      expect(result.oodSignal).toBe('low-similarity')
      expect(result.calibratedProbability).toBe(0.5)
      expect(result.confidenceHigh - result.confidenceLow).toBeGreaterThanOrEqual(0.2)

      const second = await ctx.cognitivePipeline.predict({ situation: '深夜', action: '立即起身去健身房' })
      expect(second.isNovel).toBe(true)
      expect(second.usedTempStrategy).toBe(true)
      expect(second.advice).toContain('临时试行方案')
    } finally {
      await teardown()
    }
  })

  it('predicts along the familiar path with a calibrated probability from the frequency prior', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 5; index += 1) {
        store.addExperience({
          expId: `exp_${index}`,
          sar: {
            situation: POSITIVE_UTILITY.situation,
            action: POSITIVE_UTILITY.action,
            outcome: POSITIVE_UTILITY.outcome,
            actionKeywords: [],
            outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 3 },
          },
          actionVector: actionVector(POSITIVE_UTILITY.action, []),
          outcomeVector: outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, POSITIVE_UTILITY.outcome),
          clusterId: null,
          strategyLabel: null,
          timestamp: Date.now(),
          predictionError: null,
          cumulativeError: 0,
          hitCount: 0,
          positiveCount: 0,
        })
      }
      const result = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(result.isNovel).toBe(false)
      expect(result.oodSignal).toBe('none')
      expect(result.topHitCount).toBe(5)
      // 5/5 positive prior shrunk toward the 0.5 line by alpha=50.
      expect(result.calibratedProbability).toBeGreaterThan(0.5)
      expect(result.calibratedProbability).toBeLessThan(0.75)
      expect(result.confidenceHigh - result.confidenceLow).toBeGreaterThanOrEqual(0.2 - 1e-9)
      expect(ctx.cognitivePipeline.store.getPrediction(result.predictionId)?.expId).not.toBeNull()
    } finally {
      await teardown()
    }
  })

  it('flags an action far from history as OOD and routes to the scratchpad', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      await ctx.cognitivePipeline.remember({ rawText: `${POSITIVE_UTILITY.situation}。${POSITIVE_UTILITY.action}。${POSITIVE_UTILITY.outcome}。` })
      const result = await ctx.cognitivePipeline.predict({ situation: '度假', action: '去海底潜水探索沉船' })
      expect(result.isNovel).toBe(true)
      expect(result.oodSignal).toBe('low-similarity')
    } finally {
      await teardown()
    }
  })

  it('persists predictions and resolves them through feedback with a calibration bucket update', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      await ctx.cognitivePipeline.remember({ rawText: `${POSITIVE_UTILITY.situation}。${POSITIVE_UTILITY.action}。${POSITIVE_UTILITY.outcome}。` })
      const prediction = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      const feedback = await ctx.cognitivePipeline.report({
        predictionId: prediction.predictionId,
        actualOutcome: '跑完后精神很好',
        outcomeQuality: 9,
      })
      expect(feedback.status).toBe('logged')
      expect(feedback.predictionError).toBeGreaterThan(0)
      expect(feedback.triggerRebuild).toBe(false)
      const resolved = ctx.cognitivePipeline.store.getPrediction(prediction.predictionId)
      expect(resolved?.resolvedAt).not.toBeNull()
      expect(resolved?.predictionError).toBe(feedback.predictionError)
      const buckets = ctx.cognitivePipeline.store.calibrationBucketsSnapshot()
      expect(buckets.some(bucket => bucket.totalCount > 0)).toBe(true)
    } finally {
      await teardown()
    }
  })

  it('rejects double resolution of the same prediction', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const prediction = await ctx.cognitivePipeline.predict({ situation: 's', action: 'a' })
      await ctx.cognitivePipeline.report({ predictionId: prediction.predictionId, actualOutcome: 'x', outcomeQuality: 5 })
      await expect(ctx.cognitivePipeline.report({ predictionId: prediction.predictionId, actualOutcome: 'x', outcomeQuality: 5 }))
        .rejects.toThrow(/already resolved/)
    } finally {
      await teardown()
    }
  })
})
