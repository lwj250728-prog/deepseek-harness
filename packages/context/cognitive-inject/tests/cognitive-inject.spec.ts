/**
 * Cognitive-inject priming tests: situation-vector recall at pre-step,
 * failure-primed stronger recall, no injection on miss, and durable logging
 * of the injected reference block.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import * as cognitiveInject from '@deepseek-ai/dsh-cognitive-inject'
import type { Config } from '@deepseek-ai/dsh-cognitive-inject'
import * as cognitivePipeline from '@deepseek-ai/dsh-cognitive-pipeline'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { actionVector, outcomeVector } from '@deepseek-ai/dsh-cognitive-pipeline/src/vectorizer.ts'
import type { Experience } from '@deepseek-ai/dsh-cognitive-pipeline'

const SIGNAL = new AbortController().signal

async function mount(config: Config = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(cognitivePipeline, { enabled: false })
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(cognitiveInject, config)
  return { ctx, fiber }
}

function stubAgent(rawId: string): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(rawId))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status(): AgentStatus { return 'running' },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

function seedExperience(
  store: { addExperience(exp: Experience): void },
  expId: string,
  situation: string,
  action: string,
  outcome: string,
): void {
  store.addExperience({
    expId,
    sar: {
      situation,
      action,
      outcome,
      actionKeywords: [],
      outcomeUtility: { materialGain: 6, emotionalValence: 6, energyCost: 5 },
    },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector({ materialGain: 6, emotionalValence: 6, energyCost: 5 }, outcome),
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
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  messageText = '当前情境：测试脚本挂起，需要排查原因',
): Promise<readonly string[]> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: messageText }],
    source: { kind: 'plugin', plugin: 'cognitive-inject-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  const injected: string[] = []
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      injected.push(message.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return injected
}

function emitToolResult(ctx: Context, agent: Agent, isError: boolean): void {
  const result: ToolExecutionResult = isError
    ? { content: [{ type: 'text', text: 'boom' }], isError: true, error: { message: 'boom' } }
    : { content: [{ type: 'text', text: 'ok' }], isError: false, value: null }
  ctx.emit('tools/result', {
    callId: CallId('tick-1'),
    name: 'probe',
    arguments: {},
    agent,
    signal: SIGNAL,
  } as never, result)
}

describe('cognitive-inject priming', () => {
  it('injects a situation-matched experience at pre-step and logs it durably', async () => {
    const { ctx, fiber } = await mount()
    try {
      // Bug experience whose situation overlaps the current step text.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('prime')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1)

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('【认知经验参考】')
      expect(injected[0]).toContain('exp_1')
      // Durable: the reference block became a session user/message event.
      const event = session.events.at(-1)
      expect(event?.type).toBe('user/message')
      if (event?.type !== 'user/message') throw new Error('missing injection')
      expect(event.data.source).toMatchObject({ kind: 'plugin', plugin: 'cognitive-inject' })
      expect(event.surfaceOp).toBe('append')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('injects nothing when no experience clears the similarity threshold', async () => {
    const { ctx, fiber } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '晨跑锻炼身体', '晨跑五公里', '精力充沛')
      const { agent, session } = stubAgent('miss')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '处理财务报表的数字')

      expect(injected).toHaveLength(0)
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(0)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('recalls more aggressively after a failed step', async () => {
    const { ctx, fiber } = await mount({ minSimilarity: 0.5 })
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('failure')
      session.append('turn/start', { turn: 1 })

      // First step fails.
      emitToolResult(ctx, agent, true)

      const injected = await fire(ctx, agent, 1, 1, '测试脚本挂起，需要排查原因')

      expect(injected.length).toBeGreaterThanOrEqual(1)
      expect(injected[0]).toContain('上一步执行失败')
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('stays silent when disabled', async () => {
    const { ctx, fiber } = await mount({ enabled: false })
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('disabled')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1)

      expect(injected).toHaveLength(0)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})
