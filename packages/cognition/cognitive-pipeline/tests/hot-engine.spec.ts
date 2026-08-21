import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import { HashSemanticScorer, HotEngine } from '../src/hot-engine.ts'
import type { SemanticScorer } from '../src/hot-engine.ts'
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
  outcome = '结果',
): void {
  store.addExperience({
    expId,
    sar: {
      situation,
      action,
      outcome,
      actionKeywords: [],
      outcomeUtility: utility,
    },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(utility, outcome),
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

  it('fuses the situational channel into the ranking when the situation matches', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      // exp_1 wins the semantic channel (near-identical action, irrelevant situation);
      // exp_2 wins the situational channel (identical situation, unrelated action).
      seed(store, 'exp_1', '晨跑三公里', '深夜加班', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seed(store, 'exp_2', '原地拉伸', '清晨天气好', { materialGain: 8, emotionalValence: 7, energyCost: 3 })

      // Action-only retrieval ranks by semantics: exp_1 first.
      const byAction = ctx.cognitivePipeline.hot.retrieveTopK('晨跑五公里', 1)
      expect(byAction[0]?.exp.expId).toBe('exp_1')

      // Situation-aware retrieval lets the situational channel win: exp_2's
      // situation is identical to the query's, exp_1's is irrelevant.
      const fused = ctx.cognitivePipeline.hot.retrieveTopK('晨跑五公里', 1, '清晨天气好')
      expect(fused[0]?.exp.expId).toBe('exp_2')
    } finally {
      await teardown()
    }
  })

  it('recalls the failure lesson via the symptom and outcome channels', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      // Identical action and situation: the channels must be broken by text
      // signature and outcome polarity, not by cosine.
      seed(store, 'exp_1', '重启服务', '服务异常', { materialGain: 5, emotionalValence: 5, energyCost: 5 }, '恢复')
      seed(store, 'exp_2', '重启服务', '服务异常', { materialGain: 2, emotionalValence: 2, energyCost: 8 }, '系统挂起后恢复')

      // Query carries a failure marker (挂起): the symptom channel fires for
      // exp_2's text, and the outcome channel prefers its negative polarity.
      const hits = ctx.cognitivePipeline.hot.retrieveTopK('排查系统挂起', 2, '服务异常')
      expect(hits[0]?.exp.expId).toBe('exp_2')
    } finally {
      await teardown()
    }
  })

  it('learns the channel weights from feedback error (reward small, penalize large)', async () => {
    const { ctx, teardown } = await pipelineHarness({ channelLearningRate: 0.5 })
    try {
      await ctx.cognitivePipeline.remember({ rawText: '清晨天气晴朗。晨跑五公里。精力充沛一整天。' })
      const before = ctx.cognitivePipeline.store.channelWeightsSnapshot()
      expect(before).toEqual({ semantic: 1, situational: 1, symptom: 1, outcome: 1 })

      // Small error (observed 0.5 ≈ calibrated 0.5) rewards the dominant
      // semantic channel toward the 1.6 target: 1 + 0.5·0.6 = 1.3.
      const first = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(ctx.cognitivePipeline.store.getPrediction(first.predictionId)?.fusion?.scores).toHaveLength(4)
      await ctx.cognitivePipeline.report({ predictionId: first.predictionId, actualOutcome: '一般', outcomeQuality: 5 })
      const rewarded = ctx.cognitivePipeline.store.channelWeightsSnapshot()
      expect(rewarded.semantic).toBeGreaterThan(1)

      // Large error (observed 0.1 vs calibrated ≈ 0.5) penalizes toward 0.5:
      // 1.3 + 0.5·(0.5 − 1.3) = 0.9.
      const second = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      await ctx.cognitivePipeline.report({ predictionId: second.predictionId, actualOutcome: '很糟', outcomeQuality: 1 })
      const penalized = ctx.cognitivePipeline.store.channelWeightsSnapshot()
      expect(penalized.semantic).toBeLessThan(rewarded.semantic)
      expect(penalized.semantic).toBeGreaterThanOrEqual(0.2)
    } finally {
      await teardown()
    }
  })

  it('refines low-confidence retrieval: the LLM route drops an inapplicable top hit', async () => {
    const reject = JSON.stringify({ should_keep: false, rejected_exp_id: 'exp_1', reason: '前提矛盾：资深直接推送，新手需教学' })
    const keep = JSON.stringify({ should_keep: true, rejected_exp_id: null, reason: null })
    const oodKnown = JSON.stringify({ is_known: true, confidence_score: 90, reasoning_short: 'near-identical', suggested_initial_risk_level: 'low' })
    const calib = JSON.stringify({
      base_success_rate: 80,
      risk_factors: [],
      final_confidence_interval_low: 60,
      final_confidence_interval_high: 90,
      final_calibrated_probability: 75,
      advice_preview: '按计划行动',
    })
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm' },
      [reject, keep, oodKnown, calib],
    )
    try {
      const store = ctx.cognitivePipeline.store
      // Near-identical (but not exact) actions produce a flat-top OOD signal
      // (top1 0.8 < 0.85, spread 0) → the refine pass triggers.
      seed(store, 'exp_1', '晨跑三公里', '资深用户例行推送', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seed(store, 'exp_2', '晨跑四公里', '初学者学习推送', { materialGain: 8, emotionalValence: 7, energyCost: 3 })

      const result = await ctx.cognitivePipeline.predict({ situation: '清晨', action: '晨跑五公里' })
      expect(result.advice).toContain('检索复核')
      const prediction = ctx.cognitivePipeline.store.getPrediction(result.predictionId)
      // The LLM rejected exp_1; the bound experience is now exp_2.
      expect(prediction?.expId).toBe('exp_2')
    } finally {
      await teardown()
    }
  })

  it('does not declare a failure-flagged query novel when the symptom channel strongly matches', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      // Semantic cosine is 0 (unrelated action text), but the query carries
      // the 挂起 failure marker and the experience's text contains it, so the
      // symptom/outcome channels fire: history is relevant despite the dilution.
      seed(store, 'exp_1', '重启服务', '系统异常', { materialGain: 2, emotionalValence: 2, energyCost: 8 }, '系统挂起后恢复')
      const result = await ctx.cognitivePipeline.predict({ situation: '测试挂起', action: '排查系统挂起' })
      expect(result.isNovel).toBe(false)
      expect(result.topHitCount).toBe(1)
      expect(result.oodSignal).toBe('none')
    } finally {
      await teardown()
    }
  })

  it('uses the injected semantic scorer through the pluggable seam', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const store = ctx.cognitivePipeline.store
      seed(store, 'exp_1', '晨跑五公里', '清晨', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seed(store, 'exp_2', '晨跑五公里', '清晨', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      // A stub scorer that disagrees with the hash-bag cosine: exp_2 wins.
      const stub: SemanticScorer = { score: (_query, exp) => exp.expId === 'exp_2' ? 0.9 : 0.1 }
      const engine = new HotEngine(ctx, store, ctx.cognitivePipeline.resolved.hot, ctx.cognitivePipeline.resolved.route, stub)
      const hits = engine.retrieveTopK('晨跑五公里', 1, '清晨')
      expect(hits[0]?.exp.expId).toBe('exp_2')

      // The default hash-bag scorer ranks them identically (same action/situation).
      const defaultHits = new HashSemanticScorer().score('晨跑五公里', store.getExperience('exp_1') as Experience)
      expect(defaultHits).toBeGreaterThan(0.9)
    } finally {
      await teardown()
    }
  })
})
