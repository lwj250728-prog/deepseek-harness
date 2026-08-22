/**
 * Chain-experience coverage: the derived cognition object (goal-anchored
 * causal skeletons) — assembly (failure steps kept, routine collapsed,
 * delegation nodes structural), the evidence gate, the generic object driver,
 * chain-level citation folding, structured expose, and persistence.
 */

import { describe, expect, it } from 'vitest'
import type { CognitivePipelineService } from '../src/service.ts'
import { CognitiveStore } from '../src/store.ts'
import { actionVector, outcomeVector } from '../src/vectorizer.ts'
import { executeTool, pipelineHarness } from './helpers.ts'

/** Seed one chain-tagged experience directly into the store. */
function seed(
  service: CognitivePipelineService,
  chainId: string,
  sequence: number,
  situation: string,
  action: string,
  gain: number,
  parentNodeId?: string,
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
    chainId,
    sequence,
    ...parentNodeId === undefined ? {} : { parentNodeId },
  })
  return expId
}

describe('goal-anchored chains (the derived cognition object)', () => {
  it('consolidates the causal skeleton: failure steps kept, routine successes collapsed', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, 'chain-1', 1, '目标开始', '准备发布', 8)
      seed(ctx.cognitivePipeline, 'chain-1', 2, '发布', '执行发布', 2)   // failure
      seed(ctx.cognitivePipeline, 'chain-1', 3, '回退', '回滚版本', 2)   // failure
      seed(ctx.cognitivePipeline, 'chain-1', 4, '重试', '重新发布', 8)
      const chain = await ctx.cognitivePipeline.consolidateChain('chain-1', '发布到生产')
      expect(chain).not.toBeNull()
      expect(chain?.goal).toBe('发布到生产')
      expect(chain?.status).toBe('consolidated')
      // The two failure steps are structural; the two successes collapse.
      expect(chain?.steps.length).toBe(2)
      expect(chain?.steps.every(step => step.polarity === 'failure')).toBe(true)
      expect(chain?.memberExpIds.length).toBe(4)
      expect(chain?.collapsedCount).toBe(2)
      // Order follows the explicit sequence: the kept steps are 0-based in chain order.
      expect(chain?.steps[0]?.sequence).toBe(0)
      expect(chain?.steps[1]?.sequence).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('keeps cross-agent delegation nodes as structural steps with their receipts', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, 'chain-2', 1, '目标', '准备', 8)
      seed(ctx.cognitivePipeline, 'chain-2', 2, '委派子代理', '委托子代理执行', 8, 'pred_7@orchestration.delegate-create')
      seed(ctx.cognitivePipeline, 'chain-2', 3, '收尾', '完成', 8)
      const chain = await ctx.cognitivePipeline.consolidateChain('chain-2', '委派测试')
      expect(chain?.delegationNodeIds).toEqual(['pred_7@orchestration.delegate-create'])
      // The delegation member is kept as the single structural step; the two
      // routine successes collapse.
      expect(chain?.steps.length).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('applies the evidence gate: below chainMinMembers no chain consolidates', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, 'chain-3', 1, '目标', '行动', 8)
      seed(ctx.cognitivePipeline, 'chain-3', 2, '目标', '行动二', 8)
      expect(await ctx.cognitivePipeline.consolidateChain('chain-3', '短链')).toBeNull()
    } finally {
      await teardown()
    }
  })

  it('remember_experience tags a goal trace: chain_id passes through to the experience', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      // The tool path (the exp_73 gap): remembering with chain_id must tag the
      // stored experience so the offline consolidation can assemble the chain.
      const first = await executeTool(ctx, 'remember_experience', {
        raw_text: '目标开始。准备发布。顺利。',
        chain_id: 'chain-tag-1',
      }) as { exp_id: string; chain_id?: string }
      expect(first.chain_id).toBe('chain-tag-1')
      expect(ctx.cognitivePipeline.store.getExperience(first.exp_id)?.chainId).toBe('chain-tag-1')

      // Without chain_id the experience stays untagged (the default path).
      const untagged = await executeTool(ctx, 'remember_experience', { raw_text: '普通记录。无目标标签。顺利。' }) as { exp_id: string; chain_id?: string }
      expect(untagged.chain_id).toBeUndefined()
      expect(ctx.cognitivePipeline.store.getExperience(untagged.exp_id)?.chainId).toBeUndefined()
    } finally {
      await teardown()
    }
  })

  it('chain-tagged experiences consolidate into a chain from the tool path', async () => {
    // Scripted LLM: two successful steps (positive utility) + one failure
    // (negative utility), so the skeleton keeps the failure step.
    const ok = JSON.stringify({
      situation: '发布流程',
      action: '执行发布步骤',
      outcome: '顺利完成',
      action_keywords: ['发布'],
      outcome_utility_score: { material_gain: 8, emotional_valence: 6, energy_cost: 3 },
    })
    const fail = JSON.stringify({
      situation: '发布流程',
      action: '执行发布步骤',
      outcome: '执行失败需要回退',
      action_keywords: ['发布', '回退'],
      outcome_utility_score: { material_gain: 2, emotional_valence: 2, energy_cost: 8 },
    })
    const { ctx, teardown } = await pipelineHarness({ provider: 'cognition-test', model: 'm' }, [ok, fail, ok])
    try {
      // Three tagged members via the public tool path, then consolidate.
      await executeTool(ctx, 'remember_experience', { raw_text: '发布开始。准备。顺利。', chain_id: 'chain-tag-2' })
      await executeTool(ctx, 'remember_experience', { raw_text: '发布执行。失败。回退。', chain_id: 'chain-tag-2' })
      await executeTool(ctx, 'remember_experience', { raw_text: '发布重试。成功。完成。', chain_id: 'chain-tag-2' })

      const result = await executeTool(ctx, 'consolidate_chain', { chain_id: 'chain-tag-2', goal: '发布流程' })
      expect((result as { status: string }).status).toBe('consolidated')
      const chain = ctx.cognitivePipeline.store.getChain('chain-tag-2')
      expect(chain?.goal).toBe('发布流程')
      // The single failure step is structural; the two successes collapse.
      expect(chain?.steps.length).toBe(1)
      expect(chain?.steps[0]?.polarity).toBe('failure')
      expect(chain?.memberExpIds.length).toBe(3)
    } finally {
      await teardown()
    }
  })

  it('folds chain-level citation outcomes into the chain ledger and exposes structured steps', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, 'chain-4', 1, '目标', '准备', 8)
      seed(ctx.cognitivePipeline, 'chain-4', 2, '发布', '执行发布', 2)
      seed(ctx.cognitivePipeline, 'chain-4', 3, '重试', '重新发布', 8)
      await ctx.cognitivePipeline.consolidateChain('chain-4', '发布流程')

      ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_1'],
        triggerSource: 'static:发布',
        sessionId: 's1',
        chainId: 'chain-4',
      })
      ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_2'],
        triggerSource: 'static:发布',
        sessionId: 's1',
        chainId: 'chain-4',
      })
      await ctx.cognitivePipeline.settleInjectionCitations('s1', '按 chain-4 的发布流程重试')
      const chain = ctx.cognitivePipeline.store.getChain('chain-4')!
      // Chain-level citation: the turn referenced the chain, so both records
      // that carried it count as cited.
      expect(chain.hitCount).toBe(2)
      expect(chain.citedCount).toBe(2)

      const exposed = ctx.cognitivePipeline.chainExpose('chain-4')
      expect(exposed).toContain('目标：发布流程')
      expect(exposed).toContain('失败→回退')
      expect(exposed).toContain('坍缩')
    } finally {
      await teardown()
    }
  })

  it('drives chains through the generic object lifecycle and persists them', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      seed(ctx.cognitivePipeline, 'chain-5', 1, '目标', '准备', 8)
      seed(ctx.cognitivePipeline, 'chain-5', 2, '失败', '执行失败', 2)
      seed(ctx.cognitivePipeline, 'chain-5', 3, '重试', '重试成功', 8)
      const result = await ctx.cognitivePipeline.rebuildCognitionObject('chain')
      expect(result.kind).toBe('chain')
      expect(result.built).toBe(1)
      expect(result.pruned).toBe(0)
      expect(ctx.cognitivePipeline.cognitionObjects().map(kind => kind.name)).toContain('chain')
      await expect(ctx.cognitivePipeline.rebuildCognitionObject('nope')).rejects.toThrow(/not registered/)

      const store = new CognitiveStore(root)
      await store.load()
      expect(store.getChain('chain-5')).toBeDefined()
      expect(store.getChain('chain-5')?.steps.length).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('derives tree edges: a delegated sub-goal chain hangs under the delegating chain', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      // Parent chain delegates one step (its member carries the receipt id).
      seed(ctx.cognitivePipeline, 'chain-p', 1, '目标', '准备', 8)
      seed(ctx.cognitivePipeline, 'chain-p', 2, '委派', '委托子代理执行', 8, 'pred_7@orchestration.delegate-create')
      seed(ctx.cognitivePipeline, 'chain-p', 3, '收尾', '完成', 8)
      // The sub-goal chain: its members derive from the parent's receipt.
      seed(ctx.cognitivePipeline, 'chain-c', 1, '子目标', '子代理执行', 8, 'pred_7@orchestration.delegate-create')
      seed(ctx.cognitivePipeline, 'chain-c', 2, '子目标', '子代理完成', 8, 'pred_7@orchestration.delegate-create')
      seed(ctx.cognitivePipeline, 'chain-c', 3, '子目标', '子代理汇报', 8, 'pred_7@orchestration.delegate-create')

      await ctx.cognitivePipeline.consolidateChain('chain-p', '父目标')
      await ctx.cognitivePipeline.consolidateChain('chain-c', '子目标')

      expect(ctx.cognitivePipeline.chainChildren('chain-p')).toEqual(['chain-c'])
      expect(ctx.cognitivePipeline.chainChildren('chain-c')).toEqual([])
      expect(ctx.cognitivePipeline.chainChildren('unknown')).toEqual([])

      const tree = ctx.cognitivePipeline.chainTreeExpose('chain-p')
      expect(tree).toContain('目标：父目标')
      expect(tree).toContain('目标：子目标')
      expect(ctx.cognitivePipeline.chainTreeExpose('unknown')).toBeNull()

      // The offline projection derives the same edges.
      await ctx.cognitivePipeline.rebuildCognitionObject('chain')
      expect(ctx.cognitivePipeline.store.getChain('chain-p')?.childChainIds).toEqual(['chain-c'])
    } finally {
      await teardown()
    }
  })
})

describe('chain patterns (the recursive derived cognition object)', () => {
  /** Seed a chain whose single failure step yields the signature `发:失败`. */
  function seedPublishChain(service: CognitivePipelineService, chainId: string): void {
    seed(service, chainId, 1, '发布', '准备发布', 8)
    seed(service, chainId, 2, '发布', '执行发布', 2)   // failure (structural)
    seed(service, chainId, 3, '发布', '完成发布', 8)
  }

  it('aggregates chains sharing a structural signature into one pattern', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seedPublishChain(ctx.cognitivePipeline, 'p1')
      seedPublishChain(ctx.cognitivePipeline, 'p2')
      await ctx.cognitivePipeline.rebuildCognitionObject('chain')

      const result = await ctx.cognitivePipeline.rebuildCognitionObject('chain-pattern')
      expect(result.kind).toBe('chain-pattern')
      expect(result.built).toBe(1)
      expect(ctx.cognitivePipeline.cognitionObjects().map(kind => kind.name)).toContain('chain-pattern')

      const pattern = ctx.cognitivePipeline.store.chainPatternsSnapshot()[0]!
      expect([...pattern.chainIds].sort()).toEqual(['p1', 'p2'])
      // Skeleton = the deduped union of member steps (both failure steps are
      // the same text, so one structural step survives).
      expect(pattern.skeleton.length).toBe(1)
      expect(pattern.signature).toBe('发:失败')
      expect(pattern.goalDomain).toBe('发布')
    } finally {
      await teardown()
    }
  })

  it('applies the evidence gate: a singleton signature does not project', async () => {
    const { ctx, teardown } = await pipelineHarness()
    try {
      seedPublishChain(ctx.cognitivePipeline, 'only')
      await ctx.cognitivePipeline.rebuildCognitionObject('chain')
      const result = await ctx.cognitivePipeline.rebuildCognitionObject('chain-pattern')
      expect(result.built).toBe(0)
      expect(ctx.cognitivePipeline.store.chainPatternsSnapshot()).toEqual([])
    } finally {
      await teardown()
    }
  })

  it('measures patterns from member-chain citation outcomes and persists them', async () => {
    const { ctx, root, teardown } = await pipelineHarness()
    try {
      seedPublishChain(ctx.cognitivePipeline, 'p1')
      seedPublishChain(ctx.cognitivePipeline, 'p2')
      await ctx.cognitivePipeline.rebuildCognitionObject('chain')
      await ctx.cognitivePipeline.rebuildCognitionObject('chain-pattern')

      // Fold citation outcomes on one member chain; the pattern aggregate
      // recomputes through the generic measure dispatch.
      ctx.cognitivePipeline.recordInjection({ expIds: ['exp_1'], triggerSource: 'static:发布', sessionId: 's1', chainId: 'p1' })
      ctx.cognitivePipeline.recordInjection({ expIds: ['exp_2'], triggerSource: 'static:发布', sessionId: 's1', chainId: 'p2' })
      ctx.cognitivePipeline.recordInjection({ expIds: ['exp_3'], triggerSource: 'static:发布', sessionId: 's1', chainId: 'p1' })
      await ctx.cognitivePipeline.settleInjectionCitations('s1', '按 p1 的发布流程重试')

      const pattern = ctx.cognitivePipeline.store.getChainPattern('发:失败')!
      // p1: 2 hits/2 cited; p2: 1 hit/0 cited — the pattern sums its members.
      expect(pattern.hitCount).toBe(3)
      expect(pattern.citedCount).toBe(2)

      const store = new CognitiveStore(root)
      await store.load()
      expect(store.getChainPattern('发:失败')).toBeDefined()
      expect(store.getChainPattern('发:失败')?.chainIds).toBeDefined()
      expect([...(store.getChainPattern('发:失败')?.chainIds ?? [])].sort()).toEqual(['p1', 'p2'])
    } finally {
      await teardown()
    }
  })
})
