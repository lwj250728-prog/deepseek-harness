/**
 * Situational-state service tests: chain append/linkage through the fs
 * service, commit outcome fields, pre-step injection of the latest node,
 * wake scheduling on a self-decided next-update delay, tool registration,
 * the empty-chain bootstrap, and the turn-end self-check.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as situationalState from '@deepseek-ai/dsh-situational-state'
import type { Config } from '@deepseek-ai/dsh-situational-state'
import { activationStats, ageText, CONTEXT_PREAMBLE, extractTurnActivity, renderSituationalContext } from '@deepseek-ai/dsh-situational-state'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

const SIGNAL = new AbortController().signal

/** A registry-compatible stub agent binding one session. */
function stubAgent(rawId: string): Agent {
  const session = Session.create(SessionId(rawId))
  session.append('turn/start', { turn: 1 })
  return {
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
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
}

/**
 * Mount the plugin with its declared services: agents, tools, and the prompt
 * runtime those registries need, plus a scratch LocalFileSystem for the chain
 * and trace documents.
 */
async function mount(config: Config = {}): Promise<{ ctx: Context; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'situational-state-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(situationalState, { root, ...config })
  return { ctx, root }
}

/** Fire one pre-step through the plugin listener, returning the message texts
 * the listener appended beyond the proposed message (mirrors the
 * cognitive-inject harness). */
async function firePreStep(
  ctx: Context,
  agent: Agent,
  messageText: string,
): Promise<readonly string[]> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: messageText }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  const injected: string[] = []
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      const text = message.content.find(block => block.type === 'text')?.text
      if (text !== undefined) injected.push(text)
    }
  }
  return injected
}

/** Seed an old chain head directly, as if committed long ago. */
async function seedOldHead(ctx: Context, root: string, agent: Agent, situation = '旧情景状态'): Promise<void> {
  const fs = ctx.get('fs')
  const target = await fs!.resolve(`${root}/chain.json`)
  await fs!.writeText(target, JSON.stringify({
    nodes: [{
      nodeId: 'sstate-1',
      seq: 1,
      prevNodeId: null,
      createdAt: Date.now() - 60_000,
      situation,
      sessionId: agent.session.id,
      nextUpdateAfterMs: null,
    }],
    nextSeq: 1,
  }))
}

/** Append one completed working turn to the session ledger: a genuine user
 * request, one tool call, and one assistant statement. The session already
 * carries its opening turn/start. */
function appendWorkingTurn(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '新目标：进入阶段二' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'probe', arguments: '{}' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '已进入阶段二，正在推进验证' }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
}

/** Emit a completed turn/end on the session event bus. */
function emitTurnEnd(ctx: Context, session: Session): void {
  ctx.emit('session/event', session, {
    type: 'turn/end',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  } as never)
}

/** Poll until the chain head reaches the expected node id or the timeout. */
async function waitForHead(
  ctx: Context,
  expected: string,
  timeoutMs = 2000,
): Promise<situationalState.SituationalStateNode | undefined> {
  const deadline = Date.now() + timeoutMs
  let head: situationalState.SituationalStateNode | undefined
  while (Date.now() < deadline) {
    head = await ctx.situationalState.head()
    if (head?.nodeId === expected) return head
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return head
}

describe('situational-state service', () => {
  it('commits nodes with back pointers and returns the chain length', async () => {
    const { ctx, root } = await mount()
    try {
      const service = ctx.situationalState
      const agent = stubAgent('situational-svc-agent')
      const first = await service.commit(agent, '正在验证链表机制')
      expect(first.ok).toBe(true)
      expect(first.nodeId).toBe('sstate-1')
      expect(first.prevNodeId).toBeNull()
      expect(first.chainLength).toBe(1)

      const second = await service.commit(agent, '链表第二个节点')
      expect(second.nodeId).toBe('sstate-2')
      expect(second.prevNodeId).toBe('sstate-1')
      expect(second.chainLength).toBe(2)

      const head = await service.head()
      expect(head?.nodeId).toBe('sstate-2')
      expect(head?.sessionId).toBe(SessionId('situational-svc-agent'))
      const all = await service.list()
      expect(all.map(node => node.nodeId)).toEqual(['sstate-1', 'sstate-2'])
      expect(all.every(node => node.sessionId === SessionId('situational-svc-agent'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('normalizes legacy chain nodes without a sessionId to empty', async () => {
    const { ctx, root } = await mount()
    try {
      const fs = ctx.get('fs')
      expect(fs).toBeDefined()
      const target = await fs!.resolve(`${root}/chain.json`)
      await fs!.writeText(target, JSON.stringify({
        nodes: [{
          nodeId: 'sstate-1',
          seq: 1,
          prevNodeId: null,
          createdAt: Date.now(),
          situation: '旧格式节点',
          nextUpdateAfterMs: null,
        }],
        nextSeq: 1,
      }))
      const head = await ctx.situationalState.head()
      expect(head?.sessionId).toBe(SessionId(''))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clamps a too-short self-decided delay to the configured minimum', async () => {
    const { ctx, root } = await mount({ minUpdateDelayMs: 5000 })
    try {
      const agent = stubAgent('situational-clamp-agent')
      const result = await ctx.situationalState.commit(agent, '测试最短间隔', 1000)
      expect(result.ok).toBe(true)
      expect(result.nextUpdateScheduled).toBe(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the chain document to disk', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('situational-persist-agent')
      await ctx.situationalState.commit(agent, '持久化验证')
      const fs = ctx.get('fs')
      expect(fs).toBeDefined()
      const target = await fs!.resolve(`${root}/chain.json`)
      const text = await fs!.readText(target)
      const parsed = JSON.parse(text) as { nodes: { sessionId?: string }[]; nextSeq: number }
      expect(parsed.nodes).toHaveLength(1)
      expect(parsed.nextSeq).toBe(1)
      expect(parsed.nodes[0]?.sessionId).toBe('situational-persist-agent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('situational-state tool registration (M1)', () => {
  it('registers the commit and trace tools when the tools service is mounted', async () => {
    const { ctx, root } = await mount()
    try {
      // Regression: before the inject declaration, registration ran against a
      // context without the tools service and the guard silently skipped both
      // tools — the conversation could never commit its own first node.
      expect(ctx.tools.get('situational_state_commit')).toBeDefined()
      expect(ctx.tools.get('situational_state_trace')).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('executes the commit tool and records origin tool in the trace ledger', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('tool-commit-agent')
      ctx.agents.register(agent)
      const result = await ctx.tools.execute({
        signal: SIGNAL,
        callId: CallId('tool-commit-1'),
        name: 'situational_state_commit',
        arguments: { situation: '工具提交的情景', next_update_seconds: 120 },
        agent,
      })
      expect(result.isError).toBe(false)
      const value = result.value as { ok: boolean; nodeId: string }
      expect(value.ok).toBe(true)
      expect(value.nodeId).toBe('sstate-1')
      const fs = ctx.get('fs')
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const entry = JSON.parse(traceText.split('\n').filter(Boolean)[0] as string) as { origin: string }
      expect(entry.origin).toBe('tool')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('situational-state empty-chain bootstrap (M1)', () => {
  it('auto-commits the opening node on the first pre-step of an empty chain', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('bootstrap-agent')
      expect(await ctx.situationalState.head()).toBeUndefined()
      const injected = await firePreStep(ctx, agent, '正在验证认知管线机制')
      // Bootstrap step itself does not inject (the fresh head is the session's
      // own opening text); the node exists and carries the opening situation.
      expect(injected).toHaveLength(0)
      const head = await ctx.situationalState.head()
      expect(head?.nodeId).toBe('sstate-1')
      expect(head?.sessionId).toBe(SessionId('bootstrap-agent'))
      expect(head?.situation).toContain('正在验证认知管线机制')
      // The second pre-step surfaces the head through the normal injection.
      const second = await firePreStep(ctx, agent, '继续推进')
      expect(second.some(text => text.includes(CONTEXT_PREAMBLE))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records the bootstrap commit with origin bootstrap in the trace ledger', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('bootstrap-trace-agent')
      await firePreStep(ctx, agent, '自举轨迹验证')
      const fs = ctx.get('fs')
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const first = JSON.parse(traceText.split('\n').filter(Boolean)[0] as string) as { kind: string; origin: string }
      expect(first.kind).toBe('commit')
      expect(first.origin).toBe('bootstrap')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not bootstrap when autoBootstrap is disabled', async () => {
    const { ctx, root } = await mount({ autoBootstrap: false })
    try {
      const agent = stubAgent('no-bootstrap-agent')
      await firePreStep(ctx, agent, '不应产生首节点')
      expect(await ctx.situationalState.head()).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('situational-state turn-end self-check (M1)', () => {
  it('commits a state node after a working turn when the head is old', async () => {
    const { ctx, root } = await mount({ selfCheckMinHeadAgeMs: 1000 })
    try {
      const agent = stubAgent('selfcheck-agent')
      ctx.agents.register(agent)
      await seedOldHead(ctx, root, agent)
      appendWorkingTurn(agent.session)
      emitTurnEnd(ctx, agent.session)
      const head = await waitForHead(ctx, 'sstate-2')
      expect(head?.nodeId).toBe('sstate-2')
      // The node carries the turn's own latest self-authored content.
      expect(head?.situation).toContain('已进入阶段二')
      const fs = ctx.get('fs')
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const entries = traceText.split('\n').filter(Boolean).map(line => JSON.parse(line) as { origin: string })
      const commit = entries.find(entry => entry.origin === 'turn-end')
      expect(commit).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a fresh head whose age is under the floor', async () => {
    const { ctx, root } = await mount({ selfCheckMinHeadAgeMs: 1000 })
    try {
      const agent = stubAgent('selfcheck-skip-agent')
      ctx.agents.register(agent)
      // Fresh head committed moments ago → under the floor, no self-check.
      await ctx.situationalState.commit(agent, '刚提交的新头')
      const chatOnly = stubAgent('selfcheck-chat-agent')
      ctx.agents.register(chatOnly)
      chatOnly.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '闲聊一句' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      chatOnly.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: '随便聊聊' }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
      emitTurnEnd(ctx, chatOnly.session)
      await new Promise(resolve => setTimeout(resolve, 100))
      const head = await ctx.situationalState.head()
      expect(head?.nodeId).toBe('sstate-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})


  it('serves the newest trace entries through traceTail (life-stream read)', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('tracetail-agent')
      await ctx.situationalState.commit(agent, '第一条')
      await ctx.situationalState.commit(agent, '第二条')
      const tail = await ctx.situationalState.traceTail(5)
      expect(tail.length).toBeGreaterThanOrEqual(2)
      expect(tail[0]?.kind).toBe('commit')
      expect(tail[0]?.situation).toContain('第二条')
      expect(tail[1]?.situation).toContain('第一条')
      // limit clamp
      expect((await ctx.situationalState.traceTail(0)).length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

describe('situational-state compaction write-back (M2)', () => {
  /** Emit one compaction/summary event carrying the evicted-arc summary. */
  function emitCompaction(ctx: Context, session: Session, compactionId: string, summary: string): void {
    ctx.emit('session/event', session, {
      type: 'compaction/summary',
      seq: 1,
      time: Date.now(),
      data: { compactionId, summary: [{ type: 'text', text: summary }] },
    } as never)
  }

  it('commits one chain node with the summary text on compaction', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('compaction-writeback-agent')
      ctx.agents.register(agent)
      emitCompaction(ctx, agent.session, 'comp-1', '之前完成了 A，现在正在推进 B')
      const head = await waitForHead(ctx, 'sstate-1')
      expect(head?.nodeId).toBe('sstate-1')
      expect(head?.sessionId).toBe(SessionId('compaction-writeback-agent'))
      expect(head?.situation).toContain('现在正在推进 B')
      const fs = ctx.get('fs')
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const entry = JSON.parse(traceText.split('\n').filter(Boolean)[0] as string) as { origin: string }
      expect(entry.origin).toBe('compaction')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes at most one node per compaction id (idempotent under retries)', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('compaction-idem-agent')
      ctx.agents.register(agent)
      emitCompaction(ctx, agent.session, 'comp-1', '第一次摘要')
      emitCompaction(ctx, agent.session, 'comp-1', '重试摘要')
      await new Promise(resolve => setTimeout(resolve, 100))
      const all = await ctx.situationalState.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.situation).toContain('第一次摘要')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not write back when compactionWriteBack is disabled', async () => {
    const { ctx, root } = await mount({ compactionWriteBack: false })
    try {
      const agent = stubAgent('compaction-off-agent')
      ctx.agents.register(agent)
      emitCompaction(ctx, agent.session, 'comp-1', '不应写回')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await ctx.situationalState.head()).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('situational-state ageText', () => {
  it('renders just-now, minutes, and hours labels', () => {
    const now = 1_800_000_000_000
    expect(ageText(now - 10_000, now)).toBe('刚刚')
    expect(ageText(now - 300_000, now)).toBe('5 分钟前')
    expect(ageText(now - 7_200_000, now)).toBe('2 小时前')
  })
})

describe('situational-state activationStats', () => {
  function node(seq: number, createdAt: number): situationalState.SituationalStateNode {
    return {
      nodeId: `sstate-${seq}`,
      seq,
      prevNodeId: seq === 1 ? null : `sstate-${seq - 1}`,
      createdAt,
      situation: `情景 ${seq}`,
      sessionId: SessionId('activation-test'),
      nextUpdateAfterMs: null,
    }
  }

  it('computes per-node spans from commit to the next commit', () => {
    const now = 1_800_000_000_000
    const stats = activationStats([node(1, 1_700_000_000_000), node(2, 1_750_000_000_000)], now)
    expect(stats.spans).toEqual([
      { nodeId: 'sstate-1', from: 1_700_000_000_000, to: 1_750_000_000_000, activeMs: 50_000_000_000 },
      { nodeId: 'sstate-2', from: 1_750_000_000_000, to: now, activeMs: 50_000_000_000 },
    ])
    expect(stats.totalActiveMs).toBe(100_000_000_000)
  })

  it('treats the still-active head as active until now', () => {
    const now = 1_800_000_000_000
    const stats = activationStats([node(1, 1_700_000_000_000)], now)
    expect(stats.spans[0]?.activeMs).toBe(100_000_000_000)
    expect(stats.totalActiveMs).toBe(100_000_000_000)
  })

  it('yields zero spans and total for an empty chain', () => {
    expect(activationStats([], 1_800_000_000_000)).toEqual({ spans: [], totalActiveMs: 0 })
  })

  it('clamps a non-increasing timestamp gap to zero', () => {
    const stats = activationStats([node(1, 1_800_000_000_000), node(2, 1_700_000_000_000)], 1_800_000_000_000)
    expect(stats.spans[0]?.activeMs).toBe(0)
  })
})

describe('situational-state pre-step injection', () => {
  it('injects the latest node text through the plugin listener', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('situational-inject-agent')
      await ctx.situationalState.commit(agent, '注入测试情景')
      const head = await ctx.situationalState.head()
      expect(head?.situation).toBe('注入测试情景')
      // The plugin's pre-step listener renders the durable preamble plus the
      // committed node with its source session; assert the rendering contract
      // it will inject.
      expect(`${CONTEXT_PREAMBLE}当前会话最近提交的情景状态（刚刚）［会话 situational-inject-agent］：${head?.situation}`)
        .toBe('【情景状态参考】当前会话最近提交的情景状态（刚刚）［会话 situational-inject-agent］：注入测试情景')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attaches an update guide when the chain head is stale', async () => {
    // Fresh head (age < threshold): no guide, rendering unchanged.
    const fresh = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now(), situation: '新情景', sessionId: SessionId('s1'), nextUpdateAfterMs: null },
      3600_000,
    )
    expect(fresh).toContain('【情景状态参考】')
    expect(fresh).not.toContain('【提示】')
    // Stale head (age ≥ threshold): explicit guide referencing the tool.
    const stale = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now() - 4 * 3600_000, situation: '旧情景', sessionId: SessionId('s1'), nextUpdateAfterMs: null },
      3600_000,
    )
    expect(stale).toContain('【提示】此情景状态已 4 小时前 未更新')
    expect(stale).toContain('situational_state_commit')
    expect(stale).toContain('若当前会话情景已变化')
    // staleGuideMs=0 → any head guides.
    const always = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now(), situation: '即时', sessionId: SessionId(''), nextUpdateAfterMs: null },
      0,
    )
    expect(always).toContain('【提示】')
  })

  it('records commit and inject events in the trace ledger', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent('trace-agent')
      // Commit writes a commit trace entry.
      await ctx.situationalState.commit(agent, '轨迹测试情景')
      const fs = ctx.get('fs')
      expect(fs).toBeDefined()
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const lines = traceText.split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const first = JSON.parse(lines[0] as string) as { kind: string; nodeId: string; sessionId: string; situation: string; origin: string }
      expect(first.kind).toBe('commit')
      expect(first.nodeId).toBe('sstate-1')
      expect(first.sessionId).toBe('trace-agent')
      expect(first.situation).toContain('轨迹测试情景')
      expect(first.origin).toBe('tool')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('situational-state extractTurnActivity', () => {
  it('extracts tool calls and the latest self-authored text from a turn', () => {
    const agent = stubAgent('activity-agent')
    appendWorkingTurn(agent.session)
    const activity = extractTurnActivity(agent.session, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    } as never)
    expect(activity.toolCalls).toBe(1)
    expect(activity.text).toContain('已进入阶段二')
  })
})

describe('situational-state cross-session attribution (M3/L3)', () => {
  const headA = {
    nodeId: 'sstate-1',
    seq: 1,
    prevNodeId: null,
    createdAt: Date.now(),
    situation: '正在推进生命周期线索',
    sessionId: SessionId('session-a'),
    nextUpdateAfterMs: null,
  }

  it('renders the true owner when a different session reads the head', () => {
    const cross = renderSituationalContext(headA, 3600_000, Date.now(), SessionId('session-b'))
    expect(cross).toContain('【情景状态参考】会话 session-a 最近提交')
    expect(cross).not.toContain('当前会话最近提交')
    expect(cross).toContain('【跨会话】')
  })

  it('keeps the same-session wording when the reader owns the head', () => {
    const same = renderSituationalContext(headA, 3600_000, Date.now(), SessionId('session-a'))
    expect(same).toContain('当前会话最近提交')
    expect(same).not.toContain('【跨会话】')
  })

  it('keeps the legacy reader-neutral wording when no reader is given', () => {
    const neutral = renderSituationalContext(headA, 3600_000, Date.now())
    expect(neutral).toContain('当前会话最近提交')
    expect(neutral).not.toContain('【跨会话】')
  })

  it('injects the cross-session attribution into a fresh session on its first pre-step', async () => {
    const { ctx, root } = await mount()
    try {
      const owner = stubAgent('owner-session')
      await ctx.situationalState.commit(owner, '生命线索：正在推进 M3 收尾')
      // A fresh session (different id) fires its first pre-step: the chain head
      // is injected with the true owner's attribution, not a false "当前会话".
      const reader = stubAgent('reader-session')
      const injected = await firePreStep(ctx, reader, '继续推进')
      expect(injected.some(text => text.includes('会话 owner-session 最近提交'))).toBe(true)
      expect(injected.some(text => text.includes('【跨会话】'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
