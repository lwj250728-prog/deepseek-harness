import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { harness, runChild } from './helpers.ts'
import * as cognitiveOrchestration from '../src/index.ts'
import {
  delegationOutput,
  delegationTask,
  outputText,
  stopReasonQuality,
  taskSummary,
  usageLine,
  usageOf,
} from '../src/orchestrator.ts'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Register the dedicated exploration anchor agent under its stable id. */
function registerExplorer(ctx: Context): void {
  const session = Session.create(SessionId('cognitive-explorer'))
  ctx.agents.register({
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status(): import('@deepseek-ai/dsh-agent').AgentStatus { return 'idle' },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  })
}

/** Emit a fake tool-level subagent delegation outcome. */
function emitDelegation(ctx: Context, agent: Agent, arguments_: Record<string, unknown>, result: Record<string, unknown>): void {
  ctx.emit('tools/result', {
    callId: CallId('del-1'),
    name: 'subagent',
    arguments: arguments_,
    agent,
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
    const { ctx, parent, teardown } = await harness({ policyEnabled: true })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      emitDelegation(ctx, parent, { description: '同步认知包', prompt: '把认知包同步到SAR仓库并推送' }, {
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
    const { ctx, parent, teardown } = await harness({ policyEnabled: true })
    try {
      emitDelegation(ctx, parent, { prompt: '尝试一个会失败的任务' }, {
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
    const { ctx, parent, teardown } = await harness({ policyEnabled: false })
    try {
      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      emitDelegation(ctx, parent, { prompt: '直接执行任务' }, { isError: false, content: [{ type: 'text', text: 'done' }] })
      await settleAsync()

      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before + 1)
      expect(ctx.cognitivePipeline.store.predictionsSnapshot()
        .filter(p => p.situation.startsWith('policy:delegate'))).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('dispatches a pending exploration task: silent cognitive child, experience write-back, task completed', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness({ exploreMaxConcurrent: 1 })
    try {
      // Register the dedicated explorer anchor agent the dispatcher reuses.
      registerExplorer(ctx)

      const before = ctx.cognitivePipeline.store.experiencesSnapshot().length
      await ctx.cognitivePipeline.explore('验证新的检索重排策略是否稳定')
      await orchestrator.dispatchExplorations()
      await settleAsync()

      // The child prompt carries the silent exploration goal.
      expect(delegate.prompts.length).toBe(1)
      const promptText = outputText(delegate.prompts[0] ?? [])
      expect(promptText).toContain('验证新的检索重排策略是否稳定')
      expect(promptText).toContain('静默')

      // The outcome was written back as an experience and the task settled.
      expect(ctx.cognitivePipeline.store.experiencesSnapshot().length).toBe(before + 1)
      const latest = ctx.cognitivePipeline.store.experiencesSnapshot().at(-1)
      expect(latest?.sar.situation).toContain('探索目标')
      const task = ctx.cognitivePipeline.store.explorationTasksSnapshot()[0]
      expect(task?.status).toBe('completed')
      expect(task?.pickedUpAt).not.toBeNull()
      expect(task?.result).toContain('completed')
    } finally {
      await teardown()
    }
  })

  it('marks a failed exploration child as a failed task', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness()
    try {
      registerExplorer(ctx)
      delegate.script('error', '模型调用失败')
      await ctx.cognitivePipeline.explore('尝试有风险的探索')
      await orchestrator.dispatchExplorations()
      await settleAsync()

      const task = ctx.cognitivePipeline.store.explorationTasksSnapshot()[0]
      expect(task?.status).toBe('failed')
      expect(task?.result).toContain('error')
    } finally {
      await teardown()
    }
  })

  it('respects the exploration concurrency cap and skips running tasks', async () => {
    const { ctx, orchestrator, teardown } = await harness({ exploreMaxConcurrent: 1 })
    try {
      registerExplorer(ctx)
      await ctx.cognitivePipeline.explore('任务甲')
      await ctx.cognitivePipeline.explore('任务乙')
      await orchestrator.dispatchExplorations()
      await settleAsync()

      const tasks = ctx.cognitivePipeline.store.explorationTasksSnapshot()
      expect(tasks.length).toBe(2)
      // With max 1 concurrent, at most one task runs per tick; the other stays
      // pending (the first completed synchronously through the fake delegate,
      // so a second tick would pick it up).
      expect(tasks.some(task => task.status === 'completed')).toBe(true)
      expect(tasks.filter(task => task.status === 'pending').length).toBeGreaterThanOrEqual(1)
    } finally {
      await teardown()
    }
  })

  it('does not dispatch when exploration is disabled', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness({ exploreEnabled: false })
    try {
      registerExplorer(ctx)
      await ctx.cognitivePipeline.explore('不会执行的任务')
      await orchestrator.dispatchExplorations()
      await settleAsync()
      expect(delegate.prompts.length).toBe(0)
      const task = ctx.cognitivePipeline.store.explorationTasksSnapshot()[0]
      expect(task?.status).toBe('pending')
    } finally {
      await teardown()
    }
  })

  it('drives a real delegation through a loop-attached delegation sink', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness()
    try {
      registerExplorer(ctx)
      ctx.cognitivePipeline.registerLoop({
        name: 'when-to-delegate',
        description: '该不该委派给子代理',
        execution: [orchestrator.createDelegationSink()],
      })

      // An approved decision passes the sink's discipline and actually spawns
      // a cognitive child with the decision as its task.
      const result = await ctx.cognitivePipeline.decideAndExecute('when-to-delegate', '同步认知包到SAR仓库并验证构建', '任务复杂', 0.5)
      expect(result.approved).toBe(true)
      expect(result.executions[0]?.rejected).toBe(false)
      expect(result.executions[0]?.target).toBe('orchestration.delegate-create')
      await settleAsync()

      // The child really ran (the delegate provider saw the task prompt).
      expect(delegate.prompts.length).toBe(1)
      const promptText = outputText(delegate.prompts[0] ?? [])
      expect(promptText).toContain('同步认知包到SAR仓库并验证构建')

      // The execution outcome flowed back: the receipt settled executed and
      // the loop decision prediction resolved on the same calibration ruler.
      const receipt = ctx.cognitivePipeline.store.loopExecutionsSnapshot()[0]
      expect(receipt?.status).toBe('executed')
      expect(receipt?.receiptId).toBe(`${result.decision.predictionId}@orchestration.delegate-create`)
      const resolved = ctx.cognitivePipeline.store.getPrediction(result.decision.predictionId)
      expect(resolved?.resolvedAt).not.toBeNull()
      expect(resolved?.actualOutcome).toContain('completed')

      // The delegation pattern is training data, like the tool-level path.
      const latest = ctx.cognitivePipeline.store.experiencesSnapshot().at(-1)
      expect(latest?.sar.situation).toContain('委派决策')
      const loop = ctx.cognitivePipeline.inspect().loops.find(item => item.name === 'when-to-delegate')
      expect(loop?.executedCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('settles a failed delegation child as a failed receipt', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness()
    try {
      registerExplorer(ctx)
      delegate.script('error', '模型调用失败')
      ctx.cognitivePipeline.registerLoop({
        name: 'when-to-delegate',
        description: '该不该委派给子代理',
        execution: [orchestrator.createDelegationSink()],
      })
      const result = await ctx.cognitivePipeline.decideAndExecute('when-to-delegate', '尝试一个有风险的委派', '任务复杂', 0.5)
      await settleAsync()

      const receipt = ctx.cognitivePipeline.store.loopExecutionsSnapshot()[0]
      expect(receipt?.status).toBe('failed')
      expect(receipt?.outcomeQuality).toBe(2)
      const resolved = ctx.cognitivePipeline.store.getPrediction(result.decision.predictionId)
      expect(resolved?.resolvedAt).not.toBeNull()
      const loop = ctx.cognitivePipeline.inspect().loops.find(item => item.name === 'when-to-delegate')
      expect(loop?.failedCount).toBe(1)
      expect(loop?.executedCount).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('refuses delegation under the sink discipline (safety gate, budget, concurrency)', async () => {
    const { ctx, delegate, orchestrator, teardown } = await harness({
      delegateDailyBudget: 1,
      delegateMaxConcurrent: 1,
    })
    try {
      registerExplorer(ctx)
      ctx.cognitivePipeline.registerLoop({
        name: 'when-to-delegate',
        description: '该不该委派给子代理',
        execution: [orchestrator.createDelegationSink()],
      })

      // Safety gate: a decision containing an irreversible marker is refused
      // BEFORE anything executes.
      const unsafe = await ctx.cognitivePipeline.decideAndExecute('when-to-delegate', '删除全部记录并推送', '任务复杂', 0.5)
      expect(unsafe.executions[0]?.rejected).toBe(true)
      expect(unsafe.executions[0]?.reason).toContain('不可逆')
      await settleAsync()
      expect(delegate.prompts.length).toBe(0)

      // Budget: the first accepted delegation consumes the only daily slot.
      const first = await ctx.cognitivePipeline.decideAndExecute('when-to-delegate', '同步认知包到SAR仓库', '任务复杂', 0.5)
      expect(first.executions[0]?.rejected).toBe(false)
      const second = await ctx.cognitivePipeline.decideAndExecute('when-to-delegate', '验证构建产物', '任务复杂', 0.5)
      expect(second.approved).toBe(true)
      expect(second.executions[0]?.rejected).toBe(true)
      expect(second.executions[0]?.reason).toContain('预算已耗尽')
      await settleAsync()
    } finally {
      await teardown()
    }
  })

  it('refuses a second delegation under the sink concurrency cap', async () => {
    const { orchestrator, teardown } = await harness({ delegateMaxConcurrent: 1 })
    try {
      const sink = orchestrator.createDelegationSink()
      const request = (predictionId: string, decision: string) => ({
        loopName: 'when-to-delegate',
        decision,
        situation: 'loop:when-to-delegate 情境=直接调用',
        approved: true,
        probability: 0.8,
        confidenceLow: 0.6,
        confidenceHigh: 0.95,
        predictionId,
      })
      // Two in-flight applications: the cap refuses the second synchronously.
      const accepted = sink.apply(request('p-concurrent-1', '任务甲'))
      expect(accepted).toBeNull()
      const refused = sink.apply(request('p-concurrent-2', '任务乙'))
      expect(refused).toContain('并发已满')
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

  it('sums the token accounting of a session, including cache splits', () => {
    const session = Session.create(SessionId('usage-child'))
    const step = (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }) => session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'm', model: 'm' } }),
      usage,
    }, { surfaceOp: 'append' })
    step({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 900 })
    step({ inputTokens: 40, outputTokens: 10, cacheWriteTokens: 5, reasoningTokens: 8 })

    const totals = usageOf(session)
    expect(totals?.inputTokens).toBe(160)
    expect(totals?.outputTokens).toBe(40)
    expect(totals?.cacheReadTokens).toBe(900)
    expect(totals?.cacheWriteTokens).toBe(5)
    expect(totals?.reasoningTokens).toBe(8)

    expect(usageOf(Session.create(SessionId('empty')))).toBeNull()
  })

  it('renders the one-line usage summary', () => {
    expect(usageLine({ inputTokens: 160, outputTokens: 40, cacheReadTokens: 900 }))
      .toBe('token：输入 160 / 输出 40 / 缓存命中 900')
    expect(usageLine({ inputTokens: 1, outputTokens: 2 })).toBe('token：输入 1 / 输出 2')
  })
})
