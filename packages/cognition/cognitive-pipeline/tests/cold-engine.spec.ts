import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import type { Experience } from '../src/types.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

/** Seed one experience directly (bypasses the LLM SAR path for determinism). */
function seedExperience(
  store: { addExperience(exp: Experience): void },
  expId: string,
  action: string,
  outcomeText: string,
  utility: { materialGain: number; emotionalValence: number; energyCost: number },
): void {
  store.addExperience({
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
  })
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
})
