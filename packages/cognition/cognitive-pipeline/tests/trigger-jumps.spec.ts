/**
 * Trigger-jump coverage: the deterministic co-occurrence build (evidence gate,
 * directionality, normalization), the citation-rate loop (record, settle,
 * reinforcement), and the LLM synonym-variant enhancement (template 9).
 */

import { describe, expect, it } from 'vitest'
import type { CognitivePipelineService } from '../src/service.ts'
import { CognitiveStore } from '../src/store.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'
import { pipelineHarness } from './helpers.ts'

/** Seed one important experience (gain 8 → importance > 0) directly into the store. */
function seed(
  service: CognitivePipelineService,
  situation: string,
  action: string,
  gain = 8,
): string {
  const expId = service.store.nextExpId()
  const sar = {
    situation,
    action,
    outcome: '结果',
    actionKeywords: [],
    outcomeUtility: { materialGain: gain, emotionalValence: 5, energyCost: 5 },
  }
  service.store.addExperience({
    expId,
    sar,
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(sar.outcomeUtility, '结果'),
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
  return expId
}

describe('trigger-jump learning', () => {
  it('applies the evidence gate: fewer than the minimum distinct experiences never build a jump', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      // Two experiences only: the co-occurrence evidence is below the minimum.
      seed(ctx.cognitivePipeline, '打包发布时遇到问题', '发布流程卡住排查')
      seed(ctx.cognitivePipeline, '推送前检查', '发布前确认')
      const result = await ctx.cognitivePipeline.learnTriggerJumps()
      expect(result.jumpCount).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('builds directional jumps from co-occurrence with evidence and normalized weights', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      // Three distinct experiences where "发版" (non-trigger) co-occurs with
      // "发布" (a static trigger): the jump 版→发布 must exist, evidence 3.
      seed(ctx.cognitivePipeline, '发版窗口临近', '准备发布到生产环境')
      seed(ctx.cognitivePipeline, '发版失败回滚', '排查发布超时问题')
      seed(ctx.cognitivePipeline, '发版计划变更', '调整发布流程')
      const result = await ctx.cognitivePipeline.learnTriggerJumps()
      expect(result.jumpCount).toBeGreaterThan(0)
      expect(result.cooccurrenceCount).toBeGreaterThan(0)
      const jump = ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '版')
      expect(jump).toBeDefined()
      const trigger = jump?.triggers.find(entry => entry.trigger === '发布')
      expect(trigger).toBeDefined()
      expect(trigger?.evidenceCount).toBe(3)
      expect(trigger?.weight).toBeGreaterThanOrEqual(0.3)
      expect(trigger?.weight).toBeLessThanOrEqual(1)
      expect(jump?.source).toBe('cooccurrence')
      expect(jump?.evidenceCount).toBe(3)
    } finally {
      await teardown()
    }
  })

  it('records injections, settles citations, and folds the outcome into the jump ledger', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, '发版窗口临近', '准备发布到生产环境')
      seed(ctx.cognitivePipeline, '发版失败回滚', '排查发布超时问题')
      seed(ctx.cognitivePipeline, '发版计划变更', '调整发布流程')
      await ctx.cognitivePipeline.learnTriggerJumps()

      const cited = ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_1'],
        triggerSource: 'jump:版→发布',
        sessionId: 's1',
        jumpWords: ['版'],
      })
      const uncited = ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_2'],
        triggerSource: 'jump:版→发布',
        sessionId: 's1',
        jumpWords: ['版'],
      })
      expect(await ctx.cognitivePipeline.settleInjectionCitations('s1', '参考了 exp_1 的发布做法'))
        .toEqual({ settled: 2, cited: 1 })
      const jump = ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '版')!
      expect(jump.hitCount).toBe(2)
      expect(jump.citedCount).toBe(1)
      // The settled records persist and never re-settle.
      const store = new CognitiveStore(root)
      await store.load()
      const records = store.injectionsSnapshot()
      expect(records.find(record => record.injectionId === cited.injectionId)?.cited).toBe(true)
      expect(records.find(record => record.injectionId === uncited.injectionId)?.cited).toBe(false)
      expect(await ctx.cognitivePipeline.settleInjectionCitations('s1', 'again')).toEqual({ settled: 0, cited: 0 })
    } finally {
      await teardown()
    }
  })

  it('reinforces by citation rate: prunes never-cited jumps and boosts well-cited ones', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, '发版窗口临近', '准备发布到生产环境')
      seed(ctx.cognitivePipeline, '发版失败回滚', '排查发布超时问题')
      seed(ctx.cognitivePipeline, '发版计划变更', '调整发布流程')
      seed(ctx.cognitivePipeline, '程序卡住时', '排查卡壳问题')
      seed(ctx.cognitivePipeline, '服务卡住', '处理卡壳现象')
      seed(ctx.cognitivePipeline, '测试卡住', '分析卡壳原因')
      // Seed measured stats directly (the rebuild regenerates both jumps from
      // the store and carries the stats): 版 never cited, 壳 always cited.
      ctx.cognitivePipeline.store.upsertTriggerJump({
        jumpWord: '版',
        triggers: [{ trigger: '发布', weight: 0.8, evidenceCount: 3 }],
        evidenceCount: 3,
        source: 'cooccurrence',
        rationale: '',
        hitCount: 5,
        citedCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      ctx.cognitivePipeline.store.upsertTriggerJump({
        jumpWord: '壳',
        triggers: [{ trigger: '卡住', weight: 0.5, evidenceCount: 3 }],
        evidenceCount: 3,
        source: 'cooccurrence',
        rationale: '',
        hitCount: 5,
        citedCount: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const result = await ctx.cognitivePipeline.learnTriggerJumps()
      // 版 (rate 0 ≤ 0.1, 5 hits) pruned; 壳 (rate 1.0) boosted.
      expect(result.pruned).toBeGreaterThanOrEqual(1)
      const boosted = ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '壳')
      expect(boosted?.triggers[0]?.weight).toBeGreaterThan(0.5)
      expect(ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '版')).toBeUndefined()
    } finally {
      await teardown()
    }
  })

  it('adds LLM synonym variants at zero evidence when the route proposes them, and rejects non-trigger targets', async () => {
    const proposal = JSON.stringify({
      jumps: [
        { trigger: '卡住', variants: ['卡壳', '死循环'], reason: '用户口语常把卡住说成卡壳' },
        { trigger: '不存在的词', variants: ['变体'], reason: '应被拒绝：目标不是触发词' },
      ],
    })
    const { ctx, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [proposal])
    try {
      seed(ctx.cognitivePipeline, '程序卡住', '排查挂起问题')
      const result = await ctx.cognitivePipeline.learnTriggerJumps()
      expect(result.llmAdded).toBe(2)
      const card = ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '卡壳')
      expect(card?.source).toBe('llm')
      expect(card?.evidenceCount).toBe(0)
      expect(card?.triggers[0]?.trigger).toBe('卡住')
      expect(card?.rationale).toContain('卡壳')
      // The non-trigger target proposal never entered the table.
      expect(ctx.cognitivePipeline.triggerJumps().find(entry => entry.jumpWord === '变体')).toBeUndefined()
    } finally {
      await teardown()
    }
  })
})
