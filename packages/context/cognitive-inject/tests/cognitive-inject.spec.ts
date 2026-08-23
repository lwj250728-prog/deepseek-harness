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
import { triggeredBy } from '@deepseek-ai/dsh-cognitive-inject'
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

  it('does not inject on routine conversation without a trigger, even when retrieval would hit', async () => {
    const { ctx, teardown } = await mount()
    try {
      // The situation literally shares tokens with the experience ("重启"), so
      // retrieval would find it — but the message carries no trigger word, so
      // the trigger gate must suppress the injection.
      seedExperience(ctx.cognitivePipeline.store, 'exp_1', '库存系统凌晨故障', '重启数据库服务器', '恢复，失败交易全部回滚')
      const { agent, session } = stubAgent('routine')
      session.append('turn/start', { turn: 1 })

      const injected = await fire(ctx, agent, 1, 1, '重启一下')

      expect(injected).toHaveLength(0)
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
})
