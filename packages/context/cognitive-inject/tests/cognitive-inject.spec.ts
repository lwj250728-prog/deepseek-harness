/**
 * Cognitive-inject priming tests: situation-vector recall at pre-step,
 * failure-primed stronger recall, no injection on miss, and durable logging
 * of the injected reference block.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import * as cognitiveInject from '@deepseek-ai/dsh-cognitive-inject'
import type { Config } from '@deepseek-ai/dsh-cognitive-inject'
import { triggeredBy, buildReviewPrompt } from '@deepseek-ai/dsh-cognitive-inject'
import * as cognitivePipeline from '@deepseek-ai/dsh-cognitive-pipeline'
import { CallId, createMessage, createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { actionVector, outcomeVector } from '@deepseek-ai/dsh-cognitive-pipeline/src/vectorizer.ts'
import type { Experience } from '@deepseek-ai/dsh-cognitive-pipeline'

const SIGNAL = new AbortController().signal

/** One text per call; the veto-gate tests drive the template-7 route. */
class ScriptedAdapter extends LlmAdapter {
  private cursor = 0
  constructor(private readonly responses: readonly string[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.responses[this.cursor] ?? '{}'
    this.cursor += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  }
}

async function mount(
  config: Config = {},
  route?: { provider: string; model: string; script: readonly string[] },
  pipelineExtra: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'cognition-inject-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const pipelineConfig: { enabled: boolean; root: string; provider?: string; model?: string } & Record<string, unknown>
    = { enabled: false, root, ...pipelineExtra }
  if (route !== undefined) {
    pipelineConfig.provider = route.provider
    pipelineConfig.model = route.model
  }
  await ctx.plugin(cognitivePipeline, pipelineConfig)
  if (route !== undefined) {
    ctx.llm.registerAdapter([route.provider], new ScriptedAdapter(route.script))
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(cognitiveInject, config)
  const teardown = async (): Promise<void> => {
    await fiber.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return { ctx, teardown }
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
  utility: { materialGain: number; emotionalValence: number; energyCost: number } = { materialGain: 6, emotionalValence: 6, energyCost: 5 },
  selfReflexive?: boolean,
  chainId?: string,
): void {
  store.addExperience({
    expId,
    sar: {
      situation,
      action,
      outcome,
      actionKeywords: [],
      outcomeUtility: utility,
    },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(utility, outcome),
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
    ...selfReflexive === true ? { selfReflexive: true } : {},
    ...chainId === undefined ? {} : { chainId },
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
    const { ctx, teardown } = await mount()
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
      await teardown()
    }
  })

  it('injects nothing when no experience clears the similarity threshold', async () => {
    const { ctx, teardown } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '晨跑锻炼身体', '晨跑五公里', '精力充沛')
      const { agent, session } = stubAgent('miss')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '处理财务报表的数字')

      expect(injected).toHaveLength(0)
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('does not re-inject the same experience within the cooldown window (去重/冷却)', async () => {
    const { ctx, teardown } = await mount({ injectCooldownMs: 60 * 60 * 1000 })
    try {
      // The default message text matches this experience's situation.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('cooldown')
      session.append('turn/start', { turn: 1 })

      // First pre-step injects exp_1 (nothing injected yet in this session).
      const first = await fire(ctx, agent, 1, 1)
      expect(first).toHaveLength(1)
      expect(first[0]).toContain('exp_1')

      // Second pre-step in the SAME session within the cooldown window: the
      // memory was already injected, so the cooldown filter suppresses it.
      const second = await fire(ctx, agent, 1, 2)
      expect(second).toHaveLength(0)
      expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    } finally {
      await teardown()
    }
  })

  it('re-injects after the cooldown window expires (冷却过期后重新注入)', async () => {
    const { ctx, teardown } = await mount({ injectCooldownMs: 10 })
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('cooldown-expired')
      session.append('turn/start', { turn: 1 })

      const first = await fire(ctx, agent, 1, 1)
      expect(first).toHaveLength(1)

      // Wait past the 10ms cooldown, then the same memory is injectable again
      // (a later recall is genuinely new).
      await new Promise(resolve => setTimeout(resolve, 20))
      const second = await fire(ctx, agent, 1, 2)
      expect(second).toHaveLength(1)
      expect(second[0]).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('recalls more aggressively after a failed step', async () => {
    const { ctx, teardown } = await mount({ minSimilarity: 0.5 })
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
      await teardown()
    }
  })

  it('stays silent when disabled', async () => {
    const { ctx, teardown } = await mount({ enabled: false })
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起，发现浮点死循环', '改为无循环算法', '测试全部恢复')
      const { agent, session } = stubAgent('disabled')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1)

      expect(injected).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('ranks the semantically relevant experience above a symptom-only literal hit', async () => {
    const { ctx, teardown } = await mount()
    try {
      // exp_1 shares only the 失败 literal marker with the query (irrelevant);
      // exp_2 matches the situation semantically (web boot needing a dependency
      // link) without carrying the marker. The symptom channel must be a
      // capped bonus, not a full-score channel that drowns relevance.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '库存系统凌晨故障', '重启数据库服务器', '恢复，失败交易全部回滚')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', 'web启动需要补充依赖链接', '把插件加入bundle依赖并重新安装', '解析成功插件正常加载')
      const { agent, session } = stubAgent('rank')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '启动失败了需要补充依赖链接')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_2')
      expect(injected[0]).not.toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('does not inject on routine conversation with only a weak similarity hit (situation gate)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // The situation shares only generic tokens with the experience ("重启"),
      // far below the direct-similarity threshold; the message carries no
      // trigger word, so neither the situation nor the soft trigger boost
      // opens the gate. Routine chat stays silent (finding #12: chitchat
      // p75 0.362 < direct 0.45).
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '库存系统凌晨故障', '重启数据库服务器', '恢复，失败交易全部回滚')
      const { agent, session } = stubAgent('routine')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '重启一下')

      expect(injected).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('injects on a high-similarity situation WITHOUT any trigger word (situation-driven recall)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // The message IS the business situation itself (服务重启后需要验证恢复) —
      // token-identical to the seeded experience, so top similarity clears
      // the direct threshold WITHOUT any static/derived/jump trigger. This is
      // the architecture change: a strong situation match opens the gate by
      // itself; trigger words are no longer the only key.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务重启后需要验证恢复', '重启服务并验证', '服务恢复')
      const { agent, session } = stubAgent('situation-gate')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('serves the matching CHAIN tree and records its chainId (cl-351: 链的检索入口)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // 三条同链成员: 链要过 chainMinMembers(3) 门槛才会被 consolidate。
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '服务重启后需要验证恢复', '查看日志确认', '确认无异常', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '服务重启后需要验证恢复', '跑一次冒烟', '通过', undefined, undefined, 'chain-restart')
      await ctx.cognitivePipeline.consolidateChain('chain-restart', '服务重启后验证恢复')
      expect(ctx.cognitivePipeline.store.chainsSnapshot().length).toBe(1)

      const { agent, session } = stubAgent('chain-serve')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')

      const chainText = injected.find(text => text.includes('【经验链参考】'))
      expect(chainText).toBeDefined()
      // 链树渲染 + 引用契约必须点名 chainId(结算只认字面 id, cl-044)。
      expect(chainText).toContain('chain-restart')
      expect(chainText).toContain('目标：服务重启后验证恢复')
      // **账本第一次有链可折**: 注入记录必须带上 chainId, 否则结算侧永远折不到它。
      const records = ctx.cognitivePipeline.store.injectionsSnapshot()
      expect(records.some(record => record.chainId === 'chain-restart')).toBe(true)
    } finally {
      await teardown()
    }
  })

  it('serves a chain whose GOAL matches even when no member text does (链的目标表述也是检索键)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // 成员文本与当前情境**不**相似, 但链的目标表述与情境一致 —— 现在的准入只看成员, 于是这条链找不到。
      // 检索键必须包含链自己的语义(目标/蒸馏原则), 否则"记得这个目标怎么做的"在换个说法后就失效。
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '旧事一', '执行甲', '结果甲', undefined, undefined, 'chain-goal')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '旧事二', '执行乙', '结果乙', undefined, undefined, 'chain-goal')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '旧事三', '执行丙', '结果丙', undefined, undefined, 'chain-goal')
      // 另有一条与情境匹配的经验负责打开闸门(确保"链没被服务"不是因为整条注入没发生)。
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功')
      await ctx.cognitivePipeline.consolidateChain('chain-goal', '服务重启后需要验证恢复')

      const { agent, session } = stubAgent('chain-goal-key')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(true)
      const chainText = injected.find(text => text.includes('【经验链参考】'))
      expect(chainText).toContain('chain-goal')
    } finally {
      await teardown()
    }
  })

  it('serves at most maxPerSession chains per session (链是大块头, 不许慢慢吃预算; cl-358)', async () => {
    // injectCooldownMs: 0 ⇒ 第二回合的经验侧仍会发生注入(否则"第二回合没有链"是空过, 什么都证明不了)。
    const { ctx, teardown } = await mount({ injectCooldownMs: 0 })
    try {
      // 两条**都**与情境匹配的不同链: 默认 maxPerSession=1 ⇒ 本会话只许服务一条。
      for (const [chain, prefix] of [['chain-a', '甲'], ['chain-b', '乙']] as const) {
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}1`, '服务重启后需要验证恢复', `重启服务并验证${prefix}`, '恢复成功', undefined, undefined, chain)
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}2`, '服务重启后需要验证恢复', `查看日志确认${prefix}`, '确认无异常', undefined, undefined, chain)
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}3`, '服务重启后需要验证恢复', `跑一次冒烟${prefix}`, '通过', undefined, undefined, chain)
        await ctx.cognitivePipeline.consolidateChain(chain, '服务重启后验证恢复')
      }
      // 第二回合的"经验侧"候选: 不在任何链里, 用来证明**第二回合确实发生了一次注入**(否则"没有链"是空过的)。
      seedExperience(ctx.cognitivePipeline.store, 'exp_free', '服务重启后需要验证恢复', '再确认一次端口占用', '恢复成功')
      const { agent, session } = stubAgent('chain-cap')
      session.append('turn/start', { turn: 1 })
      const first = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      expect(first.some(text => text.includes('【经验链参考】'))).toBe(true)
      const second = await fire(ctx, agent, 1, 2, '服务重启后需要验证恢复')
      // 前提: 第二回合真的有注入(经验块在), 否则下面那句"没有链"不能说明任何事。
      expect(second.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(second.some(text => text.includes('【经验链参考】'))).toBe(false)
      expect(ctx.cognitivePipeline.store.injectionsSnapshot().filter(r => r.chainId !== null)).toHaveLength(1)
    } finally {
      await teardown()
    }
  })

  it('serves a second chain when maxPerSession is raised (上限是配置, 不是硬编码)', async () => {
    const { ctx, teardown } = await mount({ injectCooldownMs: 0, chain: { maxPerSession: 2 } })
    try {
      for (const [chain, prefix] of [['chain-a', '甲'], ['chain-b', '乙']] as const) {
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}1`, '服务重启后需要验证恢复', `重启服务并验证${prefix}`, '恢复成功', undefined, undefined, chain)
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}2`, '服务重启后需要验证恢复', `查看日志确认${prefix}`, '确认无异常', undefined, undefined, chain)
        seedExperience(ctx.cognitivePipeline.store, `exp_${prefix}3`, '服务重启后需要验证恢复', `跑一次冒烟${prefix}`, '通过', undefined, undefined, chain)
        await ctx.cognitivePipeline.consolidateChain(chain, '服务重启后验证恢复')
      }
      seedExperience(ctx.cognitivePipeline.store, 'exp_free', '服务重启后需要验证恢复', '再确认一次端口占用', '恢复成功')
      const { agent, session } = stubAgent('chain-cap-2')
      session.append('turn/start', { turn: 1 })
      await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      const second = await fire(ctx, agent, 1, 2, '服务重启后需要验证恢复')
      expect(second.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(second.some(text => text.includes('【经验链参考】'))).toBe(true)
      expect(ctx.cognitivePipeline.store.injectionsSnapshot().filter(r => r.chainId !== null)).toHaveLength(2)
    } finally {
      await teardown()
    }
  })

  it('uses the SEMANTIC space for chain keys when an embedder exists (换个说法也找得到; cl-360)', async () => {
    const { ctx, teardown } = await mount()
    try {
      const SIT = '服务重启后需要验证恢复'
      const GOAL = '上线后要把服务拉起来并确认一切正常'      // 与情境**词面不同**, 但在假向量空间里语义相近
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '旧事一', '执行甲', '结果甲', undefined, undefined, 'chain-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '旧事二', '执行乙', '结果乙', undefined, undefined, 'chain-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '旧事三', '执行丙', '结果丙', undefined, undefined, 'chain-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', SIT, '重启服务并验证', '恢复成功')   // 负责开闸(词面命中)
      await ctx.cognitivePipeline.consolidateChain('chain-sem', GOAL)
      // 假 embedder: 情境向量与链目标向量**语义相近**(词面无关) —— 只有走语义空间才可能命中。
      const fake = { embed: async (text: string) => (text === SIT ? [1, 0] : text === GOAL ? [0.92, 0.08] : null) }
      Object.defineProperty(ctx.cognitivePipeline, 'embedder', { value: fake, configurable: true })
      const { agent, session } = stubAgent('chain-sem')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, SIT)
      const chainText = injected.find(text => text.includes('【经验链参考】'))
      expect(chainText).toBeDefined()
      expect(chainText).toContain('chain-sem')
    } finally {
      await teardown()
    }
  })

  it('honours the semantic-space floor when configured (语义空间的门槛单独可调; cl-361)', async () => {
    // 真 embedding 实测: 域外(不相关)对的成员分 p99=0.697, 所以 0.4 在语义空间里**不是门槛**(210/210 全过)。
    // 这条用例钉"语义门槛确实被用上" —— 用假 embedder 造一个语义 0.6 的链: 门槛 0.5 时服务, 门槛 0.7 时拒绝。
    const SIT = '服务重启后需要验证恢复'
    const GOAL = '与情境词面无关的目标表述'
    const seed = async (ctx: Awaited<ReturnType<typeof mount>>['ctx']): Promise<void> => {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '旧事一', '执行甲', '结果甲', undefined, undefined, 'chain-floor')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '旧事二', '执行乙', '结果乙', undefined, undefined, 'chain-floor')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '旧事三', '执行丙', '结果丙', undefined, undefined, 'chain-floor')
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', SIT, '重启服务并验证', '恢复成功')
      await ctx.cognitivePipeline.consolidateChain('chain-floor', GOAL)
    }
    // 语义相似度 = 0.6(cos([1,0],[0.6,0.8]))
    const fake = { embed: async (text: string) => (text === SIT ? [1, 0] : text === GOAL ? [0.6, 0.8] : null) }
    const low = await mount({ injectCooldownMs: 0, chain: { semanticMargin: 0.1 } })   // 门槛 0.4+0.1=0.5 ⇒ 0.6 过
    try {
      await seed(low.ctx)
      Object.defineProperty(low.ctx.cognitivePipeline, 'embedder', { value: fake, configurable: true })
      const { agent, session } = stubAgent('chain-floor-low')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(low.ctx, agent, 1, 1, SIT)
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(true)
    } finally {
      await low.teardown()
    }
    const high = await mount({ injectCooldownMs: 0, chain: { semanticMargin: 0.3 } })   // 门槛 0.7 ⇒ 0.6 被拒
    try {
      await seed(high.ctx)
      Object.defineProperty(high.ctx.cognitivePipeline, 'embedder', { value: fake, configurable: true })
      const { agent, session } = stubAgent('chain-floor-high')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(high.ctx, agent, 1, 1, SIT)
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(true)   // 前提: 注入确实发生了
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(false)   // 但链被语义门槛挡住
    } finally {
      await high.teardown()
    }
  })

  it('scores chain members in the SAME field (情境 vs 情境), not situation-vs-action (cl-362)', async () => {
    // 真数据对照: 情境vs成员action 的相关群中位 0.645 而域外 p99 0.697(重叠); 情境vs情境把相关群抬到 0.716。
    // 这条用例只可能由"成员**情境**对齐"命中: 成员的 action/词面都与情境无关, 目标键也不命中。
    const { ctx, teardown } = await mount()
    try {
      const SIT = '服务重启后需要验证恢复'
      const MEMBER_SITS = ['旧事一', '旧事二', '旧事三']
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', MEMBER_SITS[0], '执行甲', '结果甲', undefined, undefined, 'chain-mem-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', MEMBER_SITS[1], '执行乙', '结果乙', undefined, undefined, 'chain-mem-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', MEMBER_SITS[2], '执行丙', '结果丙', undefined, undefined, 'chain-mem-sem')
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', SIT, '重启服务并验证', '恢复成功')   // 开闸
      await ctx.cognitivePipeline.consolidateChain('chain-mem-sem', '与环境无关的目标表述')
      const fake = {
        embed: async (text: string) => {
          if (text === SIT) return [1, 0]
          if (MEMBER_SITS.includes(text)) return [0.98, 0.02]   // 成员**情境**语义很近
          return null                                            // 其它一律嵌不出(含目标键与所有 action)
        },
      }
      Object.defineProperty(ctx.cognitivePipeline, 'embedder', { value: fake, configurable: true })
      const { agent, session } = stubAgent('chain-mem-sem')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, SIT)
      const chainText = injected.find(text => text.includes('【经验链参考】'))
      expect(chainText).toBeDefined()
      expect(chainText).toContain('chain-mem-sem')
    } finally {
      await teardown()
    }
  })

  it('keeps the lexical fallback when the embedder cannot embed (退化不许变成不服务; cl-360)', async () => {
    const { ctx, teardown } = await mount()
    try {
      const SIT = '服务重启后需要验证恢复'
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', SIT, '重启服务并验证', '恢复成功', undefined, undefined, 'chain-lex')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', SIT, '查看日志确认', '确认无异常', undefined, undefined, 'chain-lex')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', SIT, '跑一次冒烟', '通过', undefined, undefined, 'chain-lex')
      await ctx.cognitivePipeline.consolidateChain('chain-lex', SIT)   // 目标与情境词面一致 ⇒ 词面路本就该命中
      // embedder 存在但**嵌入失败**(返回 null): 必须退回词面, 而不是整条链检索失效。
      const failing = { embed: async () => null }
      Object.defineProperty(ctx.cognitivePipeline, 'embedder', { value: failing, configurable: true })
      const { agent, session } = stubAgent('chain-lex')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, SIT)
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(true)
    } finally {
      await teardown()
    }
  })

  it('does NOT serve a chain whose GOAL only shares generic wording (薄边不算命中, cl-356)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // 链的目标与情境**只**共享通用词(这里整句都带"机制/系统"这类词), 成员文本无关 ⇒ 不应被服务。
      // 离线对照(1498 对)显示: 目标/原则键的新增命中几乎都是这种"撞通用词"(0.41~0.44), 而真正
      // "换个说法问同一件事"时分数会接近 1 —— 所以给链自身语义键加余量, 用薄边换不来服务。
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '旧事一', '执行甲', '结果甲', undefined, undefined, 'chain-generic')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '旧事二', '执行乙', '结果乙', undefined, undefined, 'chain-generic')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '旧事三', '执行丙', '结果丙', undefined, undefined, 'chain-generic')
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功')
      // 目标与情境共享"机制/系统/验证"等通用词, 但语义不同。
      await ctx.cognitivePipeline.consolidateChain('chain-generic', '机制与系统的验证流程')
      const { agent, session } = stubAgent('chain-generic-key')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('does NOT serve a chain whose members are unrelated to the situation', async () => {
    const { ctx, teardown } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '菜谱里的糖和盐比例如何调整', '调整配方', '味道变好', undefined, undefined, 'chain-cook')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '菜谱里的糖和盐比例如何调整', '少放糖', '更好吃', undefined, undefined, 'chain-cook')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '菜谱里的糖和盐比例如何调整', '多加盐', '偏咸', undefined, undefined, 'chain-cook')
      // 当前情境与这条链无关(靠静态触发词打开闸门, 好让"链没被服务"不是"整条注入没发生")。
      seedExperience(ctx.cognitivePipeline.store, 'exp_9', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功')
      await ctx.cognitivePipeline.consolidateChain('chain-cook', '菜谱调味')
      const { agent, session } = stubAgent('chain-nomatch')
      session.append('turn/start', { turn: 1 })
      const injected = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      expect(injected.some(text => text.includes('【经验链参考】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('serves the same chain only once per session (链不重复挤占预算)', async () => {
    const { ctx, teardown } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '服务重启后需要验证恢复', '查看日志确认', '确认无异常', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '服务重启后需要验证恢复', '跑一次冒烟', '通过', undefined, undefined, 'chain-restart')
      await ctx.cognitivePipeline.consolidateChain('chain-restart', '服务重启后验证恢复')
      const { agent, session } = stubAgent('chain-once')
      session.append('turn/start', { turn: 1 })
      const first = await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      expect(first.some(text => text.includes('【经验链参考】'))).toBe(true)
      const second = await fire(ctx, agent, 1, 2, '服务重启后需要验证恢复')
      expect(second.some(text => text.includes('【经验链参考】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('settles a cited chain into its measured-utility ledger (hitCount/citedCount 不再恒 0)', async () => {
    const { ctx, teardown } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务重启后需要验证恢复', '重启服务并验证', '恢复成功', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '服务重启后需要验证恢复', '查看日志确认', '确认无异常', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_3', '服务重启后需要验证恢复', '跑一次冒烟', '通过', undefined, undefined, 'chain-restart')
      seedExperience(ctx.cognitivePipeline.store, 'exp_4', '服务重启后需要验证恢复', '记录耗时', '记录完成', undefined, undefined, 'chain-restart')
      await ctx.cognitivePipeline.consolidateChain('chain-restart', '服务重启后验证恢复')
      const before = ctx.cognitivePipeline.store.getChain('chain-restart')
      expect(before?.hitCount).toBe(0)
      const { agent, session } = stubAgent('chain-cite')
      session.append('turn/start', { turn: 1 })
      await fire(ctx, agent, 1, 1, '服务重启后需要验证恢复')
      // 引用: 回复里字面写出 chainId(cl-044 的口径) ⇒ 折进链的效用账本。
      const settled = await ctx.cognitivePipeline.settleInjectionCitations(String(session.id), '按 chain-restart 这条链的骨架来做')
      expect(settled.cited).toBeGreaterThanOrEqual(1)
      const after = ctx.cognitivePipeline.store.getChain('chain-restart')
      expect(after?.hitCount).toBe(1)
      expect(after?.citedCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('soft trigger boost lifts a mid-similarity hit across the gate (求助信号加权)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // The message has a weak semantic hit (top ≈ 0.3, below direct 0.45) but
      // carries a trigger word (排查): the boost (0.3) lifts it to 0.6+ and
      // the gate opens. Without the trigger it would stay silent.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务启动失败排查日志', '检查依赖并重启', '定位到配置问题')
      const { agent, session } = stubAgent('boost')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '帮我排查一下这个服务')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('injects when a static behavior trigger appears', async () => {
    const { ctx, teardown } = await mount()
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '测试脚本挂起', '改为无循环算法', '测试恢复')
      const { agent, session } = stubAgent('static-trigger')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '帮我排查测试挂起')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('injects when a SAR-derived keyword of an important experience appears', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A high-importance experience (failed push: low utility, negative)
      // whose action keywords 打包/插件/GitHub become derived trigger words.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '发布插件时测试全部失败', '打包插件并推送到GitHub仓库失败', '回滚并修复依赖后恢复')
      const { agent, session } = stubAgent('derived-trigger')
      session.append('turn/start', { turn: 1 })

      // No static trigger word, but the derived keywords 打包/插件/GitHub appear.
      const injected = await fire(ctx, agent, 1, 1, '打包插件到GitHub')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
    } finally {
      await teardown()
    }
  })

  it('vetoes the over-threshold candidate when the refine route rejects it (no injection)', async () => {
    const reject = JSON.stringify({ should_keep: false, rejected_exp_id: 'exp_1', reason: '情境不可迁移' })
    const { ctx, teardown } = await mount(
      {},
      { provider: 'cognition-test', model: 'm', script: [reject] },
    )
    try {
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '库存系统凌晨故障', '重启数据库服务器', '恢复，失败交易全部回滚')
      const { agent, session } = stubAgent('veto')
      session.append('turn/start', { turn: 1 })

      // Trigger word present (排查) and retrieval would hit — but the route
      // rejects the candidate, so the veto gate suppresses injection.
      const injected = await fire(ctx, agent, 1, 1, '帮我排查测试挂起')

      expect(injected).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('moves to the next candidate when the top hit is vetoed, noting the rejection', async () => {
    const reject = JSON.stringify({ should_keep: false, rejected_exp_id: 'exp_2', reason: '前提矛盾' })
    const keep = JSON.stringify({ should_keep: true, rejected_exp_id: null, reason: null })
    const { ctx, teardown } = await mount(
      { minSimilarity: 0.3, topK: 2 },
      { provider: 'cognition-test', model: 'm', script: [reject, keep] },
    )
    try {
      // exp_2 (situation identical to the query) is the fused top hit; the
      // route vetoes it, so injection falls through to the second candidate.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '服务启动失败排查日志', '检查依赖并重启', '恢复运行')
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '启动失败需要补充链接', '把插件加入bundle依赖并重新安装', '解析成功插件正常加载')
      const { agent, session } = stubAgent('veto-next')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '启动失败需要补充链接')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
      expect(injected[0]).not.toContain('exp_2')
      expect(injected[0]).toContain('已否决 1 条')
    } finally {
      await teardown()
    }
  })

  it('covers both viewpoints: injects a failure AND a success experience when both exist', async () => {
    const { ctx, teardown } = await mount({ topK: 1 })
    try {
      // Both experiences share the query's situation wording (重启dsh失败), so
      // both clear the threshold; exp_1 is the failure lesson (negative
      // outcome utility), exp_2 the success approach (positive). Viewpoint
      // coverage injects BOTH even though topK is 1.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '重启dsh失败，会话中断需要恢复', '直接在会话内重启', '进程被杀，脚本中断', { materialGain: 2, emotionalValence: 2, energyCost: 8 })
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '重启dsh失败，外部脚本可以恢复', '用独立PowerShell进程重启', '重启成功，服务恢复', { materialGain: 8, emotionalValence: 8, energyCost: 3 })
      const { agent, session } = stubAgent('coverage')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '帮我排查重启dsh失败')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
      expect(injected[0]).toContain('exp_2')
    } finally {
      await teardown()
    }
  })

  it('does not force viewpoint coverage when only one polarity exists', async () => {
    const { ctx, teardown } = await mount({ topK: 1 })
    try {
      // Only a success experience clears the threshold; the 晨跑 experience is
      // irrelevant. No failure lesson to pair, so injection stays a single
      // top-1 hit.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '重启dsh失败，外部脚本可以恢复', '用独立PowerShell进程重启', '重启成功，服务恢复', { materialGain: 8, emotionalValence: 8, energyCost: 3 })
      seedExperience(ctx.cognitivePipeline.store, 'exp_2', '晨跑锻炼身体', '晨跑五公里', '精力充沛', { materialGain: 6, emotionalValence: 6, energyCost: 5 })
      const { agent, session } = stubAgent('single-polarity')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '帮我排查重启dsh失败')

      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_1')
      expect(injected[0]).not.toContain('exp_2')
    } finally {
      await teardown()
    }
  })

  it('marks self-reflexive experiences in the injected block (ACTION 未经外部见证)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A self-reflexive restart experience: its action may be speculative.
      seedExperience(ctx.cognitivePipeline.store, 'exp_sr', '需要重启 DSH 服务', '停止进程并重启服务', '服务已恢复', undefined, true)
      const { agent } = stubAgent('selfref-inject')
      const injected = await fire(ctx, agent, 1, 1, '帮我重启 DSH Web 服务')
      expect(injected.length).toBe(1)
      expect(injected[0]).toContain('exp_sr')
      expect(injected[0]).toContain('自反操作')
      expect(injected[0]).toContain('未经外部见证')
    } finally {
      await teardown()
    }
  })

  it('opens the trigger gate through a learned jump word alone (跳转词)', async () => {
    // A jump word the store never derived (multi-char LLM-style variant) is the
    // ONLY signal: no static trigger, empty derived lexicon → the jump route
    // decides. Scale 0.7 makes one weight-1.0 jump cross the 0.6 threshold.
    const { ctx, teardown } = await mount({}, undefined, { triggerJumpWeightScale: 0.7 })
    try {
      ctx.cognitivePipeline.store.upsertTriggerJump({
        jumpWord: '发版',
        triggers: [{ trigger: '发布', weight: 1.0, evidenceCount: 0 }],
        evidenceCount: 0,
        source: 'llm',
        rationale: '发版是发布的口语变体',
        hitCount: 0,
        citedCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const message = createUserMessage({
        content: [{ type: 'text', text: '这周要发版，需要注意什么' }],
        source: { kind: 'user' },
      })
      const verdict = triggeredBy([message], ctx.cognitivePipeline, 4)
      expect(verdict.fired).toBe(true)
      expect(verdict.triggerSource).toBe('jump:发版→发布')
      expect(verdict.jumpWords).toEqual(['发版'])

      // Control: without the jump the same message stays inert (no static
      // trigger, empty derived lexicon).
      const bare = await mount()
      try {
        const message2 = createUserMessage({
          content: [{ type: 'text', text: '这周要发版，需要注意什么' }],
          source: { kind: 'user' },
        })
        expect(triggeredBy([message2], bare.ctx.cognitivePipeline, 4).fired).toBe(false)
      } finally {
        await bare.teardown()
      }

      // The injection record carries the jump source for citation measurement.
      const record = ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_1'],
        triggerSource: verdict.triggerSource,
        sessionId: 's1',
        jumpWords: verdict.jumpWords,
      })
      expect(record.jumpWords).toEqual(['发版'])
      expect(record.triggerSource).toBe('jump:发版→发布')
    } finally {
      await teardown()
    }
  })

  it('skips task-restatement experiences so they cannot crowd the injection head (exp_155/168 lesson)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A task-restatement record: situation is the verbatim task text, action
      // merely re-states the delegation (no real tool trace). It would rank at
      // the top for any injection of the same task.
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_tsk',
        '需要重启本机的 DSH Web 服务并验证重启成功，服务监听在 http://127.0.0.1:3080',
        '子代理执行重启任务，包括停止现有进程、重启服务，并验证服务在指定端口上可正常访问',
        '任务完成',
      )
      // The genuine lesson experience (independent-process restart).
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_real',
        '需要重启 DSH Web 服务',
        '使用独立 PowerShell 进程执行重启，Start-Process 脱离会话进程树',
        '重启成功',
      )
      const { agent } = stubAgent('taskrest-inject')
      const injected = await fire(ctx, agent, 1, 1, '帮我重启 DSH Web 服务')
      expect(injected.length).toBe(1)
      // The restatement is skipped; the genuine experience is injected instead.
      expect(injected[0]).not.toContain('exp_tsk')
      expect(injected[0]).toContain('exp_real')
    } finally {
      await teardown()
    }
  })

  it('injects a solidified strategy when the retrieved experience links to its chain (策略优先)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A chain-linked experience for the restart goal.
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_chain',
        '需要重启本机的 DSH Web 服务',
        '调用 dsh-web-autorestart.ps1 执行重启',
        '重启成功，selfPerformed=true',
        undefined,
        false,
        'chain-restart',
      )
      // The solidified strategy seeded by that chain.
      ctx.cognitivePipeline.solidifyStrategy({
        goalDomain: '重启',
        action: '调用 scripts/dsh-web-autorestart.ps1',
        verificationAnchor: 'restart-result.json ok=true AND selfPerformed=true',
        preChecks: ['端口 3080 存在监听'],
        sourceChainId: 'chain-restart',
      })
      const { agent } = stubAgent('strategy-inject')
      const injected = await fire(ctx, agent, 1, 1, '帮我重启 DSH Web 服务')
      expect(injected.length).toBe(1)
      // The STRATEGY block is injected, not scattered experiences.
      expect(injected[0]).toContain('【固化策略 重启】')
      expect(injected[0]).toContain('验收锚点')
      expect(injected[0]).toContain('autorestart.ps1')
      expect(injected[0]).toContain('前置校验')
    } finally {
      await teardown()
    }
  })

  it('does not promote a strategy when the chain-linked hit lacks the goal domain (情境不匹配)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A chain-linked experience whose situation merely RECORDS the chain's
      // past verification (the exp_182 lesson: "固化策略实跑验证" talk, not a
      // restart request). It carries chainId=chain-restart, so the old Channel-1
      // rule would promote the restart strategy out of context.
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_record',
        '固化策略机制实跑验证时，核查注入记录和固化策略表确认根因',
        '核查注入记录与固化策略表，确认链成员资格误配',
        '确认根因：链成员资格不等于情境可迁移',
        undefined,
        false,
        'chain-restart',
      )
      ctx.cognitivePipeline.solidifyStrategy({
        goalDomain: '重启',
        action: '调用 scripts/dsh-web-autorestart.ps1',
        verificationAnchor: 'restart-result.json ok=true AND selfPerformed=true',
        preChecks: ['端口 3080 存在监听'],
        sourceChainId: 'chain-restart',
      })
      const { agent } = stubAgent('strategy-context-mismatch')
      // The situation discusses the verification run itself, NOT a restart.
      // "经验" is a static trigger; the chain-linked experience clears the
      // similarity threshold. The strategy must NOT be promoted: its goal
      // domain (重启) is absent from the situation.
      const injected = await fire(ctx, agent, 1, 1, '帮我排查固化策略验证经验注入的问题')
      expect(injected.length).toBe(1)
      expect(injected[0]).not.toContain('【固化策略 重启】')
      // The plain reference block carries the record experience instead.
      expect(injected[0]).toContain('【认知经验参考】')
      expect(injected[0]).toContain('exp_record')
    } finally {
      await teardown()
    }
  })

  it('vetoes a chain-linked candidate before any strategy promotion (否决先行)', async () => {
    const reject = JSON.stringify({ should_keep: false, rejected_exp_id: 'exp_chain', reason: '情境不可迁移：仅记录链验证，非重启请求' })
    const { ctx, teardown } = await mount(
      {},
      { provider: 'cognition-test', model: 'm', script: [reject] },
    )
    try {
      // Even a goal-domain-matching chain hit is suppressed when the veto
      // route rejects it: promotion must not bypass the applicability
      // judgement (the B2 fix).
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_chain',
        '需要重启本机的 DSH Web 服务',
        '调用 dsh-web-autorestart.ps1 执行重启',
        '重启成功，selfPerformed=true',
        undefined,
        false,
        'chain-restart',
      )
      ctx.cognitivePipeline.solidifyStrategy({
        goalDomain: '重启',
        action: '调用 scripts/dsh-web-autorestart.ps1',
        verificationAnchor: 'restart-result.json ok=true AND selfPerformed=true',
        preChecks: ['端口 3080 存在监听'],
        sourceChainId: 'chain-restart',
      })
      const { agent } = stubAgent('strategy-veto-first')
      const injected = await fire(ctx, agent, 1, 1, '帮我重启 DSH Web 服务')
      // The veto route rejected the only candidate → no injection at all.
      expect(injected).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('enriches the veto-gate situation with prewarm context (上下文预热)', async () => {
    // The veto route REJECTS the over-threshold candidate when the prewarm
    // reveals the real context differs from the literal match. Setup: a
    // "启动失败" experience that would match the short message "重启" by
    // surface words, plus a veto route that sees the prewarm (the session was
    // actually doing a build, not a restart) and rejects it.
    const reject = JSON.stringify({
      should_keep: false,
      rejected_exp_id: 'exp_lit',
      reason: '字面重合：会话实际在做构建，与启动失败排查无关',
    })
    const { ctx, teardown } = await mount({}, { provider: 'cognition-test', model: 'm', script: [reject] })
    try {
      seedExperience(
        ctx.cognitivePipeline.store,
        'exp_lit',
        '服务启动失败需要排查日志',
        '检查依赖并重启',
        '恢复运行',
      )
      const { agent, session } = stubAgent('prewarm-inject')
      // The session's ongoing activity: it is BUILDING, not restarting.
      session.append('turn/start', { turn: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId: CallId('pre-1'), name: 'pwsh', arguments: '{}' })
      ctx.emit('session/event', session, {
        type: 'tool/call', turn: 1, step: 1, callId: CallId('pre-1'), name: 'pwsh', arguments: '{}',
      } as never)
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: '构建进行中，正在编译前端' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      ctx.emit('session/event', session, {
        type: 'assistant/message', turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: '构建进行中，正在编译前端' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      } as never)

      // Now a short message "重启" fires the trigger gate and retrieves exp_lit;
      // the veto route, seeing the prewarm ("正在编译前端"), rejects it.
      const injected = await fire(ctx, agent, 1, 2, '重启')
      expect(injected).toHaveLength(0)
    } finally {
      await teardown()
    }
  })

  it('defers settlement: a pending injection is settled at the next pre-step (延迟结算)', async () => {
    const { ctx, teardown } = await mount()
    try {
      // A pending injection (cited=null — e.g. interrupted by a host restart)
      // carrying a strategy reference.
      const { agent, session } = stubAgent('deferred-settle')
      const record = ctx.cognitivePipeline.recordInjection({
        expIds: ['exp_late'],
        triggerSource: 'static:重启',
        sessionId: session.id,
        strategyId: 'solidified-1',
      })
      expect(record.cited).toBeNull()

      // The next pre-step settles it: the step text references the expId, so
      // the deferred settlement marks it cited and folds the strategy usage.
      await fire(ctx, agent, 1, 1, '按 exp_late 的策略执行重启')
      const settled = ctx.cognitivePipeline.store.injectionsSnapshot()
        .find(inj => inj.injectionId === record.injectionId)
      expect(settled?.cited).toBe(true)
    } finally {
      await teardown()
    }
  })
})

describe('cognitive-inject pre-input review (M3)', () => {
  /** A fake subagents seam returning one canned review text per spawn. */
  function fakeSubagents(text = '根据 exp_1 的经验，应先核对配置再重启，避免重复踩坑。'): unknown {
    return {
      start(_name: string, _request: unknown) {
        return Promise.resolve({
          result: Promise.resolve({
            output: [{ type: 'text', text }],
            stopReason: 'completed',
          }),
          dispose: () => Promise.resolve(),
        })
      },
    }
  }

  /** Seed one experience matching the standard probe message. */
  function seedReviewMemory(ctx: Context, expId = 'exp_review'): void {
    seedExperience(
      ctx.cognitivePipeline.store,
      expId,
      '测试脚本挂起需要排查原因',
      '核对配置后重启测试脚本',
      '脚本恢复运行',
    )
  }

  function reviewMount(overrides: Record<string, unknown> = {}) {
    return mount({
      topK: 1,
      minSimilarity: 0,
      directSimilarityThreshold: 0,
      triggerBoost: 0,
      review: { enabled: true, provider: 'review-test', minTextChars: 1, cooldownMs: 0 },
      ...overrides,
    } as Config)
  }

  it('injects the review synthesis instead of the raw blocks on step 1 of a root session', async () => {
    const { ctx, teardown } = await reviewMount()
    try {
      ctx.provide('subagents' as never, fakeSubagents() as never)
      const { agent } = stubAgent('review-root-agent')
      seedReviewMemory(ctx)
      const injected = await fire(ctx, agent, 1, 1, '当前情境：测试脚本挂起，需要排查原因')
      expect(injected.some(text => text.includes('【过往经验回顾】'))).toBe(true)
      expect(injected.some(text => text.includes('根据 exp_1 的经验'))).toBe(true)
      // The raw reference block did not also inject.
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(false)
      const record = ctx.cognitivePipeline.store.injectionsSnapshot()
        .find(inj => inj.sessionId === agent.session.id)
      expect(record?.triggerSource.startsWith('pre-input-review:')).toBe(true)
      // A real recall refreshes the activation clock: the used experience now
      // carries a review record (recall-as-use wiring).
      const used = ctx.cognitivePipeline.store.getExperience('exp_review')
      expect(used?.lastReviewedAt).toBeGreaterThan(0)
      expect(used?.reviewCount).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('falls back to the raw reference blocks when the subagents seam is absent', async () => {
    const { ctx, teardown } = await reviewMount()
    try {
      const { agent } = stubAgent('review-no-subagents')
      seedReviewMemory(ctx)
      const injected = await fire(ctx, agent, 1, 1, '当前情境：测试脚本挂起，需要排查原因')
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(injected.some(text => text.includes('【过往经验回顾】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('falls back to raw blocks when the review returns no text', async () => {
    const { ctx, teardown } = await reviewMount()
    try {
      ctx.provide('subagents' as never, fakeSubagents('') as never)
      const { agent } = stubAgent('review-empty')
      seedReviewMemory(ctx)
      const injected = await fire(ctx, agent, 1, 1, '当前情境：测试脚本挂起，需要排查原因')
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(injected.some(text => text.includes('【过往经验回顾】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('does not review a later step of the same turn (raw blocks instead)', async () => {
    const { ctx, teardown } = await reviewMount()
    try {
      ctx.provide('subagents' as never, fakeSubagents() as never)
      const { agent } = stubAgent('review-later-step')
      seedReviewMemory(ctx)
      const injected = await fire(ctx, agent, 1, 2, '当前情境：测试脚本挂起，需要排查原因')
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(injected.some(text => text.includes('【过往经验回顾】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('never reviews a subagent child session (recursion guard via parentSession)', async () => {
    const { ctx, teardown } = await reviewMount()
    try {
      ctx.provide('subagents' as never, fakeSubagents() as never)
      const root = Session.create(SessionId('review-root-session'))
      const childId = SessionId('review-child-session')
      const session = Session.create(
        childId,
        undefined,
        { ...root.header, id: childId, parentSession: SessionId('review-root-session'),
          origin: 'subagent' } as never,   // cl-327: 根会话判据已改为 origin !== 'subagent', 只设 parentSession 不再能表达「子代理」
      )
      const agent = {
        id: session.id,
        session,
        ctx: new Context(),
        followup() {},
        runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
          return task(new AbortController().signal)
        },
      } as unknown as Agent
      seedReviewMemory(ctx)
      const injected = await fire(ctx, agent, 1, 1, '当前情境：测试脚本挂起，需要排查原因')
      expect(injected.some(text => text.includes('【认知经验参考】'))).toBe(true)
      expect(injected.some(text => text.includes('【过往经验回顾】'))).toBe(false)
    } finally {
      await teardown()
    }
  })

  it('buildReviewPrompt carries the input, head, and expIds', () => {
    const prompt = buildReviewPrompt('如何排查挂起的测试脚本', {
      head: '正在验证认知管线机制',
      hits: [{ expId: 'exp_review', text: '核对配置后重启测试脚本' }],
    })
    expect(prompt).toContain('如何排查挂起的测试脚本')
    expect(prompt).toContain('正在验证认知管线机制')
    expect(prompt).toContain('exp_review')
    expect(prompt).toContain('建议的推进方式')
  })
})
