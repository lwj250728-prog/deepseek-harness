import { describe, expect, it } from 'vitest'
import { harness, runChild } from './helpers.ts'
import * as cognitiveOrchestration from '../src/index.ts'
import { outputText, stopReasonQuality, taskSummary } from '../src/orchestrator.ts'

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
})
