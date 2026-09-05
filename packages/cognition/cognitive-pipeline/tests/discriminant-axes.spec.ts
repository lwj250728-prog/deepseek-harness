import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'

const AXES_JSON = JSON.stringify({
  axes: [
    {
      dimension: 'situation',
      axisName: '用户熟练度',
      terms: ['新手', '资深'],
      rationale: '新手需要讲解而资深直接执行，策略不同',
    },
    {
      dimension: 'action',
      axisName: '执行深度',
      terms: ['详细指导', '直接执行'],
      rationale: '动作姿态区分教学与直跑',
    },
  ],
})

/** 直接写一条经验（绕过 remember 的 LLM 路径，测试只消耗 adapter 给轴提炼）。 */
function addRawExp(service: { store: { addExperience(exp: unknown): void } }, id: string, novice: boolean, i: number): void {
  const situation = `用户${novice ? '新手' : '资深'}打包推送插件到GitHub`
  const action = novice ? '详细指导每个命令并附检查清单' : '直接执行最小命令集'
  service.store.addExperience({
    expId: id,
    sar: {
      situation,
      action,
      outcome: '成功',
      actionKeywords: ['打包', '推送'],
      outcomeUtility: { materialGain: 7, emotionalValence: 6, energyCost: 4 },
    },
    actionVector: actionVector(action, actionKeywordsOf(action)),
    outcomeVector: outcomeVector({ materialGain: 7, emotionalValence: 6, energyCost: 4 }, '成功'),
    clusterId: null,
    strategyLabel: null,
    timestamp: Date.now() + i,
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
  })
}

function actionKeywordsOf(action: string): string[] {
  return action.includes('指导') ? ['指导'] : ['执行']
}

describe('discriminant axes (template 10, LLM 定轴)', () => {
  it('extracts and persists axes from an over-broad cluster with a route', async () => {
    const { ctx, adapter, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [AXES_JSON])
    try {
      const ids: string[] = []
      for (let i = 0; i < 8; i += 1) {
        const id = `exp_ax_${i}`
        addRawExp(ctx.cognitivePipeline, id, i % 2 === 0, i)
        ids.push(id)
      }
      const clusterId = ctx.cognitivePipeline.store.nextClusterId()
      ctx.cognitivePipeline.store.applyTaxonomy(
        [{
          clusterId,
          name: '打包推送策略簇',
          decisionRule: 'if 打包推送 then 按熟练度分流',
          expectedUtilityRange: { low: 5, high: 8 },
          supportingEvidenceIds: ids,
          fallbackAction: '询问是否需要帮助',
          createdAt: Date.now(),
          origin: 'cold-loop',
          sampleCount: 8,
          cumPredictionError: 0,
          polarity: 'success',
          situationCentroid: [],
        }],
        { version: 1, summaryShort: 'v1', rules: [], updatedAt: Date.now() },
        new Map(ids.map(id => [id, { clusterId, strategyLabel: '打包推送策略簇' }])),
      )

      const result = await ctx.cognitivePipeline.extractDiscriminantAxes()
      expect(result.clustersExamined).toBe(1)
      expect(result.axesCount).toBe(2)
      expect(adapter?.consumed).toBe(1)

      const axes = ctx.cognitivePipeline.discriminantAxes()
      expect(axes).toHaveLength(2)
      expect(axes[0]?.clusterId).toBe(clusterId)
      expect(axes[0]?.dimension).toBe('situation')
      expect(axes[0]?.axisName).toBe('用户熟练度')
      expect(axes[0]?.terms).toEqual(['新手', '资深'])
      expect(axes[1]?.dimension).toBe('action')

      await ctx.cognitivePipeline.store.flush()
      expect(ctx.cognitivePipeline.store.discriminantAxesSnapshot()).toHaveLength(2)
    } finally {
      await teardown()
    }
  })

  it('extracts nothing without an explicit route (fallback)', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      const result = await ctx.cognitivePipeline.extractDiscriminantAxes()
      expect(result.axesCount).toBe(0)
      expect(result.clustersExamined).toBe(0)
      expect(ctx.cognitivePipeline.discriminantAxes()).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('skips small clusters (axis needs ≥8 members to be discriminable)', async () => {
    const { ctx, adapter, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [AXES_JSON])
    try {
      const ids: string[] = []
      for (let i = 0; i < 4; i += 1) {
        const id = `exp_small_${i}`
        addRawExp(ctx.cognitivePipeline, id, i % 2 === 0, i)
        ids.push(id)
      }
      const clusterId = ctx.cognitivePipeline.store.nextClusterId()
      ctx.cognitivePipeline.store.applyTaxonomy(
        [{
          clusterId,
          name: '小簇',
          decisionRule: 'if 打包 then 执行',
          expectedUtilityRange: { low: 5, high: 8 },
          supportingEvidenceIds: ids,
          fallbackAction: '默认',
          createdAt: Date.now(),
          origin: 'cold-loop',
          sampleCount: 4,
          cumPredictionError: 0,
          polarity: 'success',
          situationCentroid: [],
        }],
        { version: 1, summaryShort: 'v1', rules: [], updatedAt: Date.now() },
        new Map(),
      )
      const result = await ctx.cognitivePipeline.extractDiscriminantAxes()
      expect(result.clustersExamined).toBe(0)
      expect(result.axesCount).toBe(0)
      expect(adapter?.consumed).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('drops malformed axes (missing dimension / <2 terms)', async () => {
    const malformed = JSON.stringify({
      axes: [
        { dimension: 'bogus', axisName: '坏轴', terms: ['a', 'b'], rationale: 'x' },
        { dimension: 'situation', axisName: '缺词', terms: ['单个'], rationale: 'y' },
        { dimension: 'action', axisName: '好轴', terms: ['讲解', '直跑'], rationale: 'z' },
      ],
    })
    const { ctx, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [malformed])
    try {
      const ids: string[] = []
      for (let i = 0; i < 8; i += 1) {
        const id = `exp_bad_${i}`
        addRawExp(ctx.cognitivePipeline, id, i % 2 === 0, i)
        ids.push(id)
      }
      const clusterId = ctx.cognitivePipeline.store.nextClusterId()
      ctx.cognitivePipeline.store.applyTaxonomy(
        [{
          clusterId,
          name: '簇',
          decisionRule: 'if 打包 then 执行',
          expectedUtilityRange: { low: 5, high: 8 },
          supportingEvidenceIds: ids,
          fallbackAction: '默认',
          createdAt: Date.now(),
          origin: 'cold-loop',
          sampleCount: 8,
          cumPredictionError: 0,
          polarity: 'success',
          situationCentroid: [],
        }],
        { version: 1, summaryShort: 'v1', rules: [], updatedAt: Date.now() },
        new Map(ids.map(id => [id, { clusterId, strategyLabel: '簇' }])),
      )
      await ctx.cognitivePipeline.extractDiscriminantAxes()
      const axes = ctx.cognitivePipeline.discriminantAxes()
      expect(axes).toHaveLength(1)
      expect(axes[0]?.axisName).toBe('好轴')
    } finally {
      await teardown()
    }
  })
})
