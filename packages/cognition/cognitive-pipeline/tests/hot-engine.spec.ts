import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import type { Experience } from '../src/types.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

const POSITIVE_UTILITY = {
  situation: '清晨天气晴朗',
  action: '晨跑五公里',
  outcome: '精力充沛一整天，工作效率提升',
}

function seed(
  store: { addExperience(exp: Experience): void },
  expId: string,
  action: string,
  situation: string,
  utility: { materialGain: number; emotionalValence: number; energyCost: number },
): void {
  store.addExperience({
    expId,
    sar: {
      situation,
      action,
      outcome: '结果',
      actionKeywords: [],
      outcomeUtility: utility,
    },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(utility, '结果'),
    clusterId: null,
    strategyLabel: null,
    timestamp: Date.now(),
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
  })
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
          simulated: false,
          verification: 'verified',
          evidenceScore: 0,
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
      // The bound experience (remembered as neutral 5/5/5 in the fallback)
      // gained a real material-gain label from the quality-9 feedback.
      const exp = ctx.cognitivePipeline.store.getExperience(resolved?.expId ?? '')
      expect(exp?.sar.outcomeUtility.materialGain).toBeGreaterThan(5)
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

  it('does not count neutral experiences as failures in the frequency prior', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      // Two clear successes plus three neutral experiences, all retrieved for
      // the same action. The neutral ones carry no net utility signal and must
      // not depress the positive prior.
      seed(store, 'exp_1', '晨跑五公里', '清晨', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seed(store, 'exp_2', '晨跑五公里', '清晨', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seed(store, 'exp_3', '晨跑五公里', '清晨', { materialGain: 5, emotionalValence: 5, energyCost: 5 })
      seed(store, 'exp_4', '晨跑五公里', '清晨', { materialGain: 5, emotionalValence: 5, energyCost: 5 })
      seed(store, 'exp_5', '晨跑五公里', '清晨', { materialGain: 5, emotionalValence: 5, energyCost: 5 })
      const result = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(result.isNovel).toBe(false)
      expect(result.topHitCount).toBe(5)
      // Prior = 2/2 positive (neutrals excluded), shrunk by alpha=50, k=5:
      // (5/55)·1 + (50/55)·0.5 ≈ 0.545. Counting neutrals as failures would
      // have produced 2/5 ≈ 0.4 → ≈ 0.491.
      expect(result.calibratedProbability).toBeGreaterThan(0.52)
      expect(result.calibratedProbability).toBeLessThan(0.58)
    } finally {
      await teardown()
    }
  })

  it('returns a success-cluster reference when the situation matches', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      seed(store, 'exp_1', '晨跑五公里', '清晨天气晴朗', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      // A proven success cluster whose situation centroid matches "清晨".
      store.applyTaxonomy(
        [{
          clusterId: 1,
          name: '清晨运动簇',
          decisionRule: 'if 清晨 then 坚持晨跑',
          expectedUtilityRange: { low: 6, high: 10 },
          supportingEvidenceIds: ['exp_1'],
          fallbackAction: '适度运动',
          createdAt: Date.now(),
          origin: 'cold-loop',
          sampleCount: 1,
          cumPredictionError: 0,
          polarity: 'success',
          situationCentroid: actionVector('清晨天气晴朗', []),
        }],
        {
          version: 1,
          summaryShort: '清晨运动簇',
          rules: [{ condition: '清晨运动簇', action: '坚持晨跑', utilityRange: { low: 6, high: 10 }, polarity: 'success' }],
          updatedAt: Date.now(),
        },
        new Map([['exp_1', { clusterId: 1, strategyLabel: '清晨运动簇' }]]),
      )
      const result = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(result.successReference).not.toBeNull()
      expect(result.successReference?.clusterName).toBe('清晨运动簇')
      expect(result.advice).toContain('参照成功策略')
    } finally {
      await teardown()
    }
  })

  it('keeps success_reference null without any success cluster', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const result = await ctx.cognitivePipeline.predict({ situation: '深夜', action: '立即起身去健身房' })
      expect(result.successReference).toBeNull()
    } finally {
      await teardown()
    }
  })

  it('consults the taxonomy during retrieval: covered vs gap', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seed(store, `exp_${index}`, '晨跑五公里', '清晨天气晴朗适合晨跑', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      }
      for (let index = 9; index <= 16; index += 1) {
        seed(store, `exp_${index}`, '熬夜刷剧', '深夜独自刷剧', { materialGain: 2, emotionalValence: 2, energyCost: 8 })
      }
      const rebuild = await ctx.cognitivePipeline.rebuild('global')
      expect(rebuild.accepted).toBe(true)

      // Covered: the query situation is close to a cluster's situation centroid.
      const covered = await ctx.cognitivePipeline.predict({ situation: '清晨天气晴朗适合晨跑五公里', action: '出门晨跑' })
      expect(covered.taxonomyContext.coverage).toBe('covered')
      expect(covered.taxonomyContext.cluster).not.toBeNull()
      expect(covered.taxonomyContext.similarity).toBeGreaterThanOrEqual(0)
      expect(covered.taxonomyContext.margin).toBeGreaterThanOrEqual(0)
      expect(covered.advice).toContain('检索建议')
      expect(covered.advice).toContain('命中簇')

      // Gap: the query situation is far from every cluster's situation centroid.
      const gap = await ctx.cognitivePipeline.predict({ situation: '准备诗歌创作素材', action: '写一首诗' })
      expect(gap.taxonomyContext.coverage).toBe('gap')
      expect(gap.taxonomyContext.cluster).toBeNull()
      expect(gap.advice).toContain('覆盖缺口')
    } finally {
      await teardown()
    }
  })

  it('reports no-taxonomy before the first rebuild', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const result = await ctx.cognitivePipeline.predict({ situation: '任何情境', action: '任何行动' })
      expect(result.taxonomyContext.coverage).toBe('no-taxonomy')
      expect(result.taxonomyContext.cluster).toBeNull()
    } finally {
      await teardown()
    }
  })
})
