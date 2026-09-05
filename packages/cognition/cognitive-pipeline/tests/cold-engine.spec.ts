import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import type { Experience } from '../src/types.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

/** Build one experience shape (bypasses the LLM SAR path for determinism). */
function experienceShape(
  expId: string,
  action: string,
  outcomeText: string,
  utility: { materialGain: number; emotionalValence: number; energyCost: number },
): Experience {
  return {
    expId,
    sar: {
      situation: `情境${expId}`,
      action,
      outcome: outcomeText,
      actionKeywords: ['x'],
      outcomeUtility: utility,
    },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(utility, outcomeText),
    clusterId: null,
    strategyLabel: null,
    timestamp: Date.now() - (Number(expId.slice(4)) * 1000),
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
  }
}

/** Seed one experience directly into the store. */
function seedExperience(
  store: { addExperience(exp: Experience): void },
  expId: string,
  action: string,
  outcomeText: string,
  utility: { materialGain: number; emotionalValence: number; energyCost: number },
): void {
  store.addExperience(experienceShape(expId, action, outcomeText, utility))
}

const POSITIVE = { materialGain: 8, emotionalValence: 7, energyCost: 3 }
const NEGATIVE = { materialGain: 2, emotionalValence: 2, energyCost: 8 }

describe('cold loop (rebuild_taxonomy)', () => {
  it('re-clusters in utility space and accepts a ≥15% validation improvement', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }

      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(true)
      expect(result.clusterCount).toBeGreaterThanOrEqual(2)
      expect(result.taxonomyVersion).toBe(1)
      expect(result.reason).toContain('沙盒验证通过')

      const taxonomy = ctx.cognitivePipeline.taxonomy()
      expect(taxonomy?.version).toBe(1)
      expect(taxonomy?.rules.length).toBeGreaterThanOrEqual(1)
      // Every seeded experience should have been claimed by a cluster.
      const unassigned = store.experiencesSnapshot().filter(exp => exp.clusterId === null)
      expect(unassigned).toHaveLength(0)
      // The prompt prefix carries the new taxonomy summary.
      expect(ctx.cognitivePipeline.taxonomyPrefix()).toContain('分类体系摘要')
    } finally {
      await teardown()
    }
  })

  it('rejects evidence-thin LLM clusters via the backend hard constraint', async () => {
    const script = [
      JSON.stringify({
        new_clusters: [
          {
            cluster_name: '幻觉簇A',
            decision_rule: 'if x then y',
            expected_utility_range: { low: 0, high: 10 },
            supporting_evidence_ids: ['exp_1'],
            fallback_action: 'z',
          },
          {
            cluster_name: '幻觉簇B',
            decision_rule: 'if x then y',
            expected_utility_range: { low: 0, high: 10 },
            supporting_evidence_ids: ['exp_9'],
            fallback_action: 'z',
          },
        ],
        taxonomy_summary_short: '两簇证据不足',
      }),
    ]
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', predictionErrorThreshold: 0, maxSampleRatio: 1 },
      script,
    )
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      // Both LLM clusters were rejected; the deterministic fallback recovered.
      expect(result.rejectedClusters).toBe(2)
      expect(result.accepted).toBe(true)
      expect(result.clusterCount).toBeGreaterThanOrEqual(2)
    } finally {
      await teardown()
    }
  })

  it('rolls back when the proposal does not cut validation error by 15%', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }
      const first = await ctx.cognitivePipeline.rebuild('global')
      expect(first.accepted).toBe(true)
      const versionAfterFirst = ctx.cognitivePipeline.taxonomy()?.version

      // Nothing changed; the same proposal cannot improve on the accepted one.
      const second = await ctx.cognitivePipeline.rebuild('global')
      expect(second.accepted).toBe(false)
      expect(second.oldError).toBeLessThanOrEqual(1e-9)
      expect(second.reason).toContain('接近完美')
      expect(ctx.cognitivePipeline.taxonomy()?.version).toBe(versionAfterFirst)
    } finally {
      await teardown()
    }
  })

  it('skips rebuild when there is nothing to sample', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('无经验样本')
    } finally {
      await teardown()
    }
  })

  it('samples proven successes even when they carry no prediction error', async () => {
    const { ctx, teardown } = await pipelineHarness({
      predictionErrorThreshold: 0.9,
      successUtilityThreshold: 3,
      maxSampleRatio: 1,
    })
    try {
      const store = ctx.cognitivePipeline.store
      // High-utility successes with zero error: previously excluded from the
      // cold loop, now admitted as success anchors.
      for (let index = 1; index <= 6; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.sampleCount).toBe(6)
      expect(result.reason).not.toContain('采样样本不足')
    } finally {
      await teardown()
    }
  })

  it('excludes neutral experiences from backtest rollback failure promotion', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      // exp_1 is the newest experience (timestamp = now - 1s) so it lands in
      // the validation slice; it is neutral. Positives form the train cluster.
      seedExperience(store, 'exp_1', '晨跑五公里', '精力充沛', { materialGain: 5, emotionalValence: 5, energyCost: 5 })
      for (let index = 2; index <= 5; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(false)
      // Old behavior promoted |predicted − 0| into cumulativeError for the
      // neutral validation sample; the fix skips it entirely.
      expect(store.getExperience('exp_1')?.cumulativeError).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('annotates clusters and taxonomy rules with polarity', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(true)
      const clusters = ctx.cognitivePipeline.store.clustersSnapshot()
      expect(clusters.some(cluster => cluster.polarity === 'success')).toBe(true)
      expect(clusters.some(cluster => cluster.polarity === 'risk')).toBe(true)
      const taxonomy = ctx.cognitivePipeline.taxonomy()
      expect(taxonomy?.rules.some(rule => rule.polarity === 'success')).toBe(true)
      expect(ctx.cognitivePipeline.taxonomyPrefix()).toContain('✅成功')
    } finally {
      await teardown()
    }
  })

  it('accepts a first build against the empty-view baseline instead of the 1e-9 deadlock', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      // Two clean utility families; a first build must beat the baseRate guess
      // by sandboxImprovement, not reach the unreachable `newError <= 1e-9`.
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(true)
      // First build has no old taxonomy, so oldError is the empty-view
      // baseline (pure baseRate prediction) — a finite reference, not null,
      // and the proposal improved on it by ≥ sandboxImprovement.
      expect(result.oldError).not.toBeNull()
      expect(result.deltaError).not.toBeNull()
      expect(result.deltaError).toBeLessThanOrEqual(-0.15)
      expect(result.reason).toContain('沙盒验证通过')
    } finally {
      await teardown()
    }
  })

  it('accepts a first build that only ties the baseRate (cold-start bar)', async () => {
    const { ctx, teardown } = await pipelineHarness({
      predictionErrorThreshold: 0,
      maxSampleRatio: 1,
      minValidationCount: 2,
    })
    try {
      const store = ctx.cognitivePipeline.store
      // exp_1/exp_2 are the newest, so they form the validation slice. The
      // train is one clean success family, so a verified cluster can only TIE
      // the baseRate guess — it can never beat it by 15% — and the first build
      // must still be accepted on the non-worsening bar and written.
      seedExperience(store, 'exp_1', '熬夜刷剧', '疲惫不堪', { materialGain: 5, emotionalValence: 6, energyCost: 3 })
      seedExperience(store, 'exp_2', '晨跑五公里', '精力充沛', { materialGain: 7, emotionalValence: 7, energyCost: 4 })
      for (let index = 3; index <= 10; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', { materialGain: 7, emotionalValence: 7, energyCost: 4 })
      }

      const first = await ctx.cognitivePipeline.rebuild('global')
      expect(first.accepted).toBe(true)
      expect(first.deltaError).not.toBeNull()
      // The measured improvement is a tie with the baseRate null model — far
      // below the 15% iteration bar, but the first build must not be blocked
      // by a margin that a 2-sample validation slice cannot measure.
      expect(first.deltaError).toBeGreaterThan(-0.15)
      expect(first.deltaError).toBeLessThanOrEqual(0)
      expect(first.clusterCount).toBe(1)
      expect(first.reason).toContain('冷启动')
      expect(ctx.cognitivePipeline.taxonomy()?.version).toBe(1)

      // Iteration keeps the 15% bar: the same store cannot improve on the
      // existing taxonomy, so the rebuild is rejected without version churn.
      const second = await ctx.cognitivePipeline.rebuild('global')
      expect(second.accepted).toBe(false)
      expect(second.reason).toContain('沙盒验证未达标')
      expect(ctx.cognitivePipeline.taxonomy()?.version).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('writes nothing when every candidate cluster fails the evidence hard constraint', async () => {
    const script = [
      JSON.stringify({
        new_clusters: [
          {
            cluster_name: '远距簇',
            decision_rule: 'if x then y',
            expected_utility_range: { low: 0, high: 10 },
            supporting_evidence_ids: ['exp_1', 'exp_2', 'exp_3'],
            fallback_action: 'z',
          },
        ],
        taxonomy_summary_short: '三证据远距',
      }),
    ]
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', predictionErrorThreshold: 0, maxSampleRatio: 1, minValidationCount: 1 },
      script,
    )
    try {
      const store = ctx.cognitivePipeline.store
      // Three mutually distant utility patterns: the model cluster citing all
      // three fails the pairwise-distance check, and no deterministic group
      // reaches the ≥3 evidence floor — so the fallback has nothing verified
      // to write and the rebuild must reject instead of bypassing verification.
      seedExperience(store, 'exp_1', '晨跑五公里', '精力充沛', { materialGain: 8, emotionalValence: 7, energyCost: 3 })
      seedExperience(store, 'exp_2', '熬夜修bug', '代价高昂', { materialGain: 6, emotionalValence: 7, energyCost: 9 })
      seedExperience(store, 'exp_3', '排查代理', '网络失败', { materialGain: 7, emotionalValence: 3, energyCost: 8 })

      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(false)
      expect(result.rejectedClusters).toBeGreaterThanOrEqual(1)
      expect(result.reason).toContain('证据校验未通过')
      expect(result.clusterCount).toBe(0)
      // Nothing was written: no clusters, no taxonomy.
      expect(ctx.cognitivePipeline.store.clustersSnapshot()).toHaveLength(0)
      expect(ctx.cognitivePipeline.taxonomy()).toBeNull()
    } finally {
      await teardown()
    }
  })

  it('requests reasoning off for budget-constrained template calls', async () => {
    const script = [
      JSON.stringify({ new_clusters: [], taxonomy_summary_short: '无簇' }),
    ]
    const harness = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', predictionErrorThreshold: 0, maxSampleRatio: 1 },
      script,
    )
    try {
      const { ctx } = harness
      const store = ctx.cognitivePipeline.store
      for (let index = 1; index <= 8; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      for (let index = 9; index <= 16; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', NEGATIVE)
      }
      await ctx.cognitivePipeline.rebuild('global')
      // The reconstruct template runs on a small token budget; chain-of-thought
      // would starve the JSON answer (finish=max-tokens with zero text), so the
      // request must explicitly disable reasoning.
      expect(harness.adapter?.lastOptions?.reasoningEffort).toBe('off')
    } finally {
      await harness.teardown()
    }
  })

  it('defers a rebuild when labeled validation samples are insufficient', async () => {
    const { ctx, teardown } = await pipelineHarness({
      predictionErrorThreshold: 0,
      maxSampleRatio: 1,
      minValidationCount: 4,
    })
    try {
      const store = ctx.cognitivePipeline.store
      // 6 experiences → validation slice of 1, below the minValidationCount=4.
      for (let index = 1; index <= 6; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(false)
      expect(result.deferred).toBe(true)
      expect(result.reason).toContain('暂缓重建')
      expect(result.clusterCount).toBe(0)
      // The store is untouched.
      expect(ctx.cognitivePipeline.store.clustersSnapshot()).toHaveLength(0)
      expect(ctx.cognitivePipeline.taxonomy()).toBeNull()
    } finally {
      await teardown()
    }
  })

  it('excludes unverified simulated experiences from cold-loop sampling', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      // Verified positives that can cluster.
      for (let index = 1; index <= 6; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      // An unverified simulated experience with high utility must not join.
      const simulated: Experience = {
        ...experienceShape('exp_7', '晨跑五公里', '精力充沛', POSITIVE),
        simulated: true,
        verification: 'unverified',
        evidenceScore: 0,
      }
      store.addExperience(simulated)
      const result = await ctx.cognitivePipeline.rebuild('global')
      // The simulated sample is excluded; only the 6 verified are sampled.
      expect(result.sampleCount).toBe(6)
      expect(result.reason).not.toContain('采样样本不足')
    } finally {
      await teardown()
    }
  })

  it('accepts on the continuous utility axis, not just polarity', async () => {
    const { ctx, teardown } = await pipelineHarness({
      predictionErrorThreshold: 0,
      maxSampleRatio: 1,
      minValidationCount: 1,
    })
    try {
      const store = ctx.cognitivePipeline.store
      // Two utility families with distinct material gain (continuous labels).
      for (let index = 1; index <= 6; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', { materialGain: 9, emotionalValence: 7, energyCost: 3 })
      }
      for (let index = 7; index <= 12; index += 1) {
        seedExperience(store, `exp_${index}`, '熬夜刷剧', '疲惫不堪', { materialGain: 2, emotionalValence: 2, energyCost: 8 })
      }
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.accepted).toBe(true)
      // The metric is continuous: oldError is the baseRate material-gain error,
      // and the proposal improved on it by ≥15%.
      expect(result.oldError).not.toBeNull()
      expect(result.deltaError).not.toBeNull()
      expect(result.deltaError).toBeLessThanOrEqual(-0.15)
      // A neutral experience with a backfilled material gain now participates
      // in the acceptance denominator (it is a real label, not "no signal").
      const labeled = store.experiencesSnapshot()
        .filter(exp => Number.isFinite(exp.sar.outcomeUtility.materialGain))
      expect(labeled.length).toBeGreaterThan(0)
    } finally {
      await teardown()
    }
  })

  it('includes pipeline-own meta failure experiences in the rebuild sample', async () => {
    const { ctx, teardown } = await pipelineHarness({ predictionErrorThreshold: 0.9, maxSampleRatio: 1 })
    try {
      const store = ctx.cognitivePipeline.store
      // Proven successes (sampled by utility).
      for (let index = 1; index <= 4; index += 1) {
        seedExperience(store, `exp_${index}`, '晨跑五公里', '精力充沛', POSITIVE)
      }
      // A meta failure: negative utility, no prediction error. The plain
      // errorful/successful filter would exclude it; the meta channel admits it
      // so the cold loop can cluster pipeline-own failure modes.
      store.addExperience({
        ...experienceShape('exp_5', '晨跑五公里', '路线堵塞', { materialGain: 2, emotionalValence: 3, energyCost: 7 }),
        meta: true,
      })
      const result = await ctx.cognitivePipeline.rebuild('global')
      expect(result.sampleCount).toBe(5)
    } finally {
      await teardown()
    }
  })
})
