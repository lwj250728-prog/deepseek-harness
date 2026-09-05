/**
 * Memory-anchored compaction write-back: when context compaction folds a long
 * arc into one summary (`compaction/summary`), the pipeline feeds the arc
 * through the accumulation gate at most once per compaction id (only under
 * auto-accumulation; the gate decides worth).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { pipelineHarness } from './helpers.ts'

/** Emit one compaction/summary event carrying the evicted-arc summary. */
function emitCompactionSummary(
  ctx: Context,
  session: Session,
  compactionId: string,
  summary: string,
): void {
  ctx.emit('session/event', session, {
    type: 'compaction/summary',
    seq: 1,
    time: Date.now(),
    data: { compactionId, summary: [{ type: 'text', text: summary }] },
  } as never)
}

/** Poll until the experience store reaches the expected count or timeout. */
async function waitForExperienceCount(
  ctx: Context,
  expected: number,
  timeoutMs = 3000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = ctx.cognitivePipeline.store.experiencesSnapshot().length
    if (count >= expected) return count
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return ctx.cognitivePipeline.store.experiencesSnapshot().length
}

const GATE = JSON.stringify({
  should_accumulate: true,
  situation: '长弧段压缩记忆：发布流程踩坑',
  action: '把压缩摘要整理为经验记录',
  outcome: '发布流程教训已写回记忆',
  material_gain: 5,
  emotional_valence: 4,
  energy_cost: 3,
})

/** A compaction summary comfortably above the accumulation pre-filter's
 * minimum outcome length (160 chars), as real compaction summaries are. */
const LONG_SUMMARY = '之前修复了 X，现在正在推进 Y。整个弧段跨过三个阶段：先排查了构建失败并恢复依赖基线，然后补齐了缺失的环境变量与凭据配置，最后把发布脚本参数化并验证了端到端流程，包括对超时与重试参数的调优。下一步计划把同样的发布流程复用到第二个服务，并补上监控告警。该弧段还记录了三个关键决策的理由，以及两处踩坑后的规避方式，供后续同类发布直接参考复用。'

describe('cognitive-pipeline compaction accumulation', () => {
  it('writes one gated experience per compaction summary when autoAccumulate is on', async () => {
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', autoAccumulate: true },
      [GATE],
    )
    try {
      const session = Session.create(SessionId('compaction-acc-session'))
      emitCompactionSummary(ctx, session, 'comp-1', LONG_SUMMARY)
      const count = await waitForExperienceCount(ctx, 1)
      expect(count).toBe(1)
      const stored = ctx.cognitivePipeline.store.experiencesSnapshot()[0]
      expect(stored?.sar.situation).toBe('长弧段压缩记忆：发布流程踩坑')
      expect(stored?.sar.outcomeUtility.materialGain).toBe(5)
    } finally {
      await teardown()
    }
  })

  it('writes at most one experience per compaction id (idempotent under retries)', async () => {
    const { ctx, adapter, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', autoAccumulate: true },
      [GATE],
    )
    try {
      const session = Session.create(SessionId('compaction-idem-session'))
      emitCompactionSummary(ctx, session, 'comp-1', LONG_SUMMARY)
      emitCompactionSummary(ctx, session, 'comp-1', '重试摘要')
      const count = await waitForExperienceCount(ctx, 1)
      expect(count).toBe(1)
      // The gate ran exactly once — the second event for the same compaction
      // id was suppressed before any LLM call.
      expect(adapter?.consumed).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('writes nothing without an explicit route (the gate rejects unjudged)', async () => {
    const { ctx, teardown } = await pipelineHarness({ autoAccumulate: true })
    try {
      const session = Session.create(SessionId('compaction-noroute-session'))
      emitCompactionSummary(ctx, session, 'comp-1', '无路由时不应积累')
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(ctx.cognitivePipeline.store.experiencesSnapshot()).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('writes nothing when autoAccumulate is off (no automatic experience inflow)', async () => {
    const { ctx, teardown } = await pipelineHarness(
      { provider: 'cognition-test', model: 'm', autoAccumulate: false },
      [GATE],
    )
    try {
      const session = Session.create(SessionId('compaction-off-session'))
      emitCompactionSummary(ctx, session, 'comp-1', '关闭自动积累时不写')
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(ctx.cognitivePipeline.store.experiencesSnapshot()).toHaveLength(0)
    } finally {
      await teardown()
    }
  })
})
