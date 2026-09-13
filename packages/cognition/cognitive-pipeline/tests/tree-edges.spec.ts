/**
 * The GOAL TREE's **encoding entry point** (cl-347). The decoding side
 * (assembly, `childChainIdsOf`, `chainChildren`, `chainTreeExpose`) was
 * already covered by chains.spec — but nothing could ever WRITE a delegation
 * receipt: `remember_experience` had no `parent_node_id`/`sequence` parameter,
 * so 210 stored experiences carried `parentNodeId`/`sequence` zero times, every
 * chain's `childChainIds` came out empty, and the tree degenerated into seven
 * flat roots. These cases drive the tool (not the store) so a regression in the
 * plumbing — tool schema → service.remember → persisted experience → tree edge
 * — turns red.
 */

import { describe, expect, it } from 'vitest'
import { executeTool, pipelineHarness } from './helpers.ts'

/** Record one chain member through the tool and return the new exp id. */
async function remember(
  ctx: Awaited<ReturnType<typeof pipelineHarness>>['ctx'],
  args: Record<string, unknown>,
): Promise<string> {
  const result = await executeTool(ctx, 'remember_experience', args) as { exp_id: string }
  expect(typeof result.exp_id).toBe('string')
  return result.exp_id
}

describe('goal tree: encoding a delegation receipt', () => {
  it('grows a child chain under its parent, and renders it indented', async () => {
    const h = await pipelineHarness()
    try {
      const { ctx } = h
      // Parent chain: its middle member is the one delegated out ("@" receipt).
      await remember(ctx, { raw_text: '父目标开始|准备|顺利', chain_id: 'chain-p', sequence: 1 })
      await remember(ctx, {
        raw_text: '父目标委派|委托子代理执行|已派出',
        chain_id: 'chain-p',
        sequence: 2,
        parent_node_id: 'pred_7@orchestration.delegate-create',
      })
      await remember(ctx, { raw_text: '父目标收尾|完成|收拢', chain_id: 'chain-p', sequence: 3 })
      // Sub-goal chain: its ROOT derives from the parent's receipt.
      await remember(ctx, {
        raw_text: '子目标入口|子代理执行|开始',
        chain_id: 'chain-c',
        sequence: 1,
        parent_node_id: 'pred_7@orchestration.delegate-create',
      })
      await remember(ctx, { raw_text: '子目标推进|子代理完成|完成', chain_id: 'chain-c', sequence: 2 })
      await remember(ctx, { raw_text: '子目标汇报|子代理汇报|回报', chain_id: 'chain-c', sequence: 3 })

      await ctx.cognitivePipeline.consolidateChain('chain-p', '父目标')
      await ctx.cognitivePipeline.consolidateChain('chain-c', '子目标')

      // The receipt actually made it into the stored experiences (the plumbing).
      const stored = ctx.cognitivePipeline.store.experiencesSnapshot()
        .filter(exp => exp.parentNodeId !== undefined)
      // Exactly the two members we tagged carry a receipt (parent's delegate
      // step + the sub-goal's ROOT) — the plumbing preserved both.
      expect(stored).toHaveLength(2)
      expect(stored.every(exp => exp.parentNodeId === 'pred_7@orchestration.delegate-create')).toBe(true)

      // …and the tree edge was derived from it.
      expect(ctx.cognitivePipeline.chainChildren('chain-p')).toEqual(['chain-c'])
      expect(ctx.cognitivePipeline.chainChildren('chain-c')).toEqual([])
      const tree = ctx.cognitivePipeline.chainTreeExpose('chain-p')
      expect(tree).toContain('目标：父目标')
      expect(tree).toContain('目标：子目标')
      // The child is INDENTED under the parent (that is what "tree" means here).
      expect(tree).toContain('  【经验链 chain-c】')
    } finally {
      await h.teardown()
    }
  })

  it('does NOT grow an edge from a receipt without "@" (it is not a delegation)', async () => {
    const h = await pipelineHarness()
    try {
      const { ctx } = h
      await remember(ctx, { raw_text: '目标甲|准备|好', chain_id: 'chain-q', sequence: 1 })
      await remember(ctx, { raw_text: '目标甲|推进|好', chain_id: 'chain-q', sequence: 2 })
      await remember(ctx, { raw_text: '目标甲|收尾|好', chain_id: 'chain-q', sequence: 3 })
      // Same shape as the passing case, but the receipt lacks the "@" marker.
      await remember(ctx, {
        raw_text: '目标乙入口|干活|开始',
        chain_id: 'chain-r',
        sequence: 1,
        parent_node_id: 'pred_9-no-at-marker',
      })
      await remember(ctx, { raw_text: '目标乙|干活|继续', chain_id: 'chain-r', sequence: 2 })
      await remember(ctx, { raw_text: '目标乙|干活|完成', chain_id: 'chain-r', sequence: 3 })

      await ctx.cognitivePipeline.consolidateChain('chain-q', '目标甲')
      await ctx.cognitivePipeline.consolidateChain('chain-r', '目标乙')

      // The field is stored (the caller's intent is preserved)…
      expect(ctx.cognitivePipeline.store.experiencesSnapshot()
        .some(exp => exp.parentNodeId === 'pred_9-no-at-marker')).toBe(true)
      // …but a receipt without "@" is not a delegation edge, so no child appears.
      expect(ctx.cognitivePipeline.chainChildren('chain-q')).toEqual([])
      const tree = ctx.cognitivePipeline.chainTreeExpose('chain-q')
      expect(tree).not.toContain('目标：目标乙')
    } finally {
      await h.teardown()
    }
  })

  it('keeps a chain below chainMinMembers out of the tree (the gate still holds)', async () => {
    const h = await pipelineHarness()
    try {
      const { ctx } = h
      await remember(ctx, { raw_text: '独苗|干活|结束', chain_id: 'chain-solo', sequence: 1 })
      const chain = await ctx.cognitivePipeline.consolidateChain('chain-solo', '独苗目标')
      expect(chain).toBeNull()
      expect(ctx.cognitivePipeline.store.getChain('chain-solo')).toBeUndefined()
    } finally {
      await h.teardown()
    }
  })
})
