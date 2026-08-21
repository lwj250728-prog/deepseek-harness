import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { harness, runChild } from './helpers.ts'
import * as cognitiveOrchestration from '../src/index.ts'
import { delegationOutput, delegationTask, outputText, stopReasonQuality, taskSummary } from '../src/orchestrator.ts'
import { CallId } from '@deepseek-ai/dsh-llm'

/** Emit a fake tool-level subagent delegation outcome. */
function emitDelegation(ctx: Context, arguments_: Record<string, unknown>, result: Record<string, unknown>): void {
  ctx.emit('tools/result', {
    callId: CallId('del-1'),
    name: 'subagent',
    arguments: arguments_,
  } as never, result as never)
}

/** Wait for the async delegation-capture chain (predict/report/remember) to settle. */
async function settleAsync(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 80))
}

describe('cognitive-orchestration', () => {
  it('registers the wrapper provider with delegated capabilities', async () => {
    const { ctx, teardown } = await harness()
    try {
      expect(ctx.subagents.list()).toContain('cognitive')
      const wrapper = ctx.subagents.getProvider('cognitive')
      expect(wrapper?.capabilities).toEqual({ outputSchema: true, depthLimit: true, toolFilter: true, persona: true })
      expect(wrapper?.inheritsParentContext).toBe(true)
    } finally {
      await teardown()
    }
  })

  it('injects related experience into the child prompt in conservative mode', async () => {
    const { ctx, parent, delegate, teardown } = await harness({ policyEnabled: false })
    try {
      await ctx.cognitivePipeline.remember({
        rawText: '深夜测试挂起。修复会死循环的浮点计算问题。测试全部恢复。',
      })
      await runChild(ctx, parent, '修复会死循环的浮点计算问题并验证测试通过')
      expect(delegate.prompts.length).toBe(1)
      const promptText = outputText(delegate.prompts[0] ?? [])
      expect(promptText).toContain('【认知经验参考】')
      expect(promptText).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('writes the settled child outcome back into the experience store', async () => {
    const { ctx, parent, teardown } = await harness({ policyEnabled: false })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      await runChild(ctx, parent, '实现一个任务并返回结果')
      const after = ctx.cognitivePipeline.store.experiencesSnapshot().length
      expect(after).toBe(before + 1)
      const latest = ctx.cognitivePipeline.store.experiencesSnapshot().at(-1)
      expect(latest?.sar.situation).toContain('任务调度')
      expect(latest?.sar.outcome).toContain('completed')
    } finally {
      await teardown()
    }
  })

  it('predicts and calibrates the inject decision in policy mode', async () => {
    const { ctx, parent, delegate, teardown } = await harness({ policyEnabled: true })
    try {
      await ctx.cognitivePipeline.remember({
        rawText: '测试脚本挂起，发现浮点下溢死循环。改成无循环算法。测试全部恢复。',
      })
      await runChild(ctx, parent, '修复会死循环的浮点计算问题并验证测试通过')
      // Without an LLM route the policy prediction shrinks to the 0.5 line,
      // which is below the 0.55 threshold: no injection, but a prediction log.
      const promptText = outputText(delegate.prompts[0] ?? [])
      expect(promptText).not.toContain('【认知经验参考】')
      const policyPredictions = ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:inject'))
      expect(policyPredictions.length).toBe(1)
      expect(policyPredictions[0]?.resolvedAt).not.toBeNull()
    } finally {
      await teardown()
    }
  })

  it('writes the policy:update decision and calibrates it', async () => {
    const { ctx, parent, teardown } = await harness({ policyEnabled: true })
    try {
      await runChild(ctx, parent, '实现一个任务并返回结果')
      const updatePredictions = ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:update'))
      expect(updatePredictions.length).toBe(1)
      expect(updatePredictions[0]?.resolvedAt).not.toBeNull()
    } finally {
      await teardown()
    }
  })

  it('fails loud when the delegate provider is missing', async () => {
    const { ctx, teardown } = await harness()
    try {
      await expect(ctx.plugin(cognitiveOrchestration, { delegate: 'missing' })).rejects.toThrow(/not registered/)
    } finally {
      await teardown()
    }
  })

  it('captures a tool-level delegation: policy:delegate calibration and 委派决策 write-back', async () => {
    const { ctx, teardown } = await harness({ policyEnabled: true })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      emitDelegation(ctx, { description: '同步认知包', prompt: '把认知包同步到SAR仓库并推送' }, {
        isError: false,
        content: [{ type: 'text', text: '同步完成，推送成功' }],
      })
      await settleAsync()

      // The delegation pattern was written back as an experience.
      const after = ctx.cognitivePipeline.store.experiencesSnapshot().length
      expect(after).toBe(before + 1)
      const latest = ctx.cognitivePipeline.store.experiencesSnapshot().at(-1)
      expect(latest?.sar.situation).toContain('委派决策')
      expect(latest?.sar.situation).toContain('同步到SAR仓库')

      // The policy:delegate decision was predicted and calibrated.
      const delegatePredictions = ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:delegate'))
      expect(delegatePredictions.length).toBe(1)
      expect(delegatePredictions[0]?.resolvedAt).not.toBeNull()
      expect(delegatePredictions[0]?.predictionError).not.toBeNull()
    } finally {
      await teardown()
    }
  })

  it('records a failed delegation with a low calibration quality', async () => {
    const { ctx, teardown } = await harness({ policyEnabled: true })
    try {
      emitDelegation(ctx, { prompt: '尝试一个会失败的任务' }, {
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      })
      await settleAsync()

      const latest = ctx.cognitivePipeline.store.experiencesSnapshot().at(-1)
      expect(latest?.sar.outcome).toContain('失败')
      const delegatePredictions = ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:delegate'))
      // Outcome quality 2 drives the calibration error signal.
      expect(delegatePredictions[0]?.resolvedAt).not.toBeNull()
    } finally {
      await teardown()
    }
  })

  it('ignores tool calls outside the delegation tool names', async () => {
    const { ctx, teardown } = await harness({ policyEnabled: true })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      ctx.emit('tools/result', {
        callId: CallId('pwsh-1'),
        name: 'pwsh',
        arguments: { command: 'ls' },
      } as never, { isError: false, content: [{ type: 'text', text: 'ok' }] } as never)
      await settleAsync()

      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before)
      expect(ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:delegate'))).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('skips policy calibration in conservative mode but still writes the delegation', async () => {
    const { ctx, teardown } = await harness({ policyEnabled: false })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      emitDelegation(ctx, { prompt: '直接执行任务' }, { isError: false, content: [{ type: 'text', text: 'done' }] })
      await settleAsync()

      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before + 1)
      expect(ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:delegate'))).toHaveLength(0)
    } finally {
      await teardown()
    }
  })
})

describe('orchestration helpers', () => {
  it('maps stop reasons to outcome quality', () => {
    expect(stopReasonQuality('completed')).toBe(8)
    expect(stopReasonQuality('error')).toBe(2)
    expect(stopReasonQuality('refusal')).toBe(2)
    expect(stopReasonQuality('max-tokens')).toBe(4)
    expect(stopReasonQuality('aborted')).toBe(4)
  })

  it('summarizes the task from the label or first text block', () => {
    expect(taskSummary([{ type: 'text', text: '  完成任务甲  ' }], '标签乙')).toBe('标签乙')
    expect(taskSummary([{ type: 'text', text: '完成任务甲' }])).toBe('完成任务甲')
  })

  it('joins text blocks into output text', () => {
    expect(outputText([{ type: 'text', text: '完成' }, { type: 'text', text: '结果' }])).toBe('完成 结果')
    expect(outputText([])).toBe('')
  })

  it('extracts the delegation task from prompt or description', () => {
    expect(delegationTask({ prompt: '  把认知包同步到SAR仓库并推送  ' })).toBe('把认知包同步到SAR仓库并推送')
    expect(delegationTask({ description: '同步认知包', prompt: '' })).toBe('同步认知包')
    expect(delegationTask({})).toBe('')
    expect(delegationTask(undefined)).toBe('')
  })

  it('joins delegation result text blocks', () => {
    expect(delegationOutput({ isError: false, content: [{ type: 'text', text: '同步完成' }, { type: 'text', text: '推送成功' }] }))
      .toBe('同步完成 推送成功')
    expect(delegationOutput({ isError: true })).toBe('')
  })
})
