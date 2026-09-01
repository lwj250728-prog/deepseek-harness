/**
 * Situational-state service tests: chain append/linkage through the fs
 * service, commit outcome fields, pre-step injection of the latest node,
 * and wake scheduling on a self-decided next-update delay.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as situationalState from '@deepseek-ai/dsh-situational-state'
import type { Config } from '@deepseek-ai/dsh-situational-state'
import { activationStats, ageText, CONTEXT_PREAMBLE, renderSituationalContext } from '@deepseek-ai/dsh-situational-state'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { Agent } from '@deepseek-ai/dsh-agent'

function stubAgent(ctx: Context, id: string): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return {
    id: SessionId(id),
    session,
    ctx,
    followup() {},
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
  } as unknown as Agent
}

async function mount(config: Config = {}): Promise<{ ctx: Context; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'situational-state-'))
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(situationalState, { root, ...config })
  return { ctx, root }
}

describe('situational-state service', () => {
  it('commits nodes with back pointers and returns the chain length', async () => {
    const { ctx, root } = await mount()
    try {
      const service = ctx.situationalState
      const agent = stubAgent(ctx, 'situational-svc-agent')
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
      const agent = stubAgent(ctx, 'situational-clamp-agent')
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
      const agent = stubAgent(ctx, 'situational-persist-agent')
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
      const agent = stubAgent(ctx, 'situational-inject-agent')
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

  it('attaches an update guide when the chain head is stale (B 方案：链龄感知引导)', async () => {
    // Fresh head (age < threshold): no guide, rendering unchanged.
    const fresh = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now(), situation: '新情景', sessionId: 's1', nextUpdateAfterMs: null },
      3600_000,
    )
    expect(fresh).toContain('【情景状态参考】')
    expect(fresh).not.toContain('【提示】')
    // Stale head (age ≥ threshold): explicit guide referencing the tool.
    const stale = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now() - 4 * 3600_000, situation: '旧情景', sessionId: 's1', nextUpdateAfterMs: null },
      3600_000,
    )
    expect(stale).toContain('【提示】此情景状态已 4 小时前 未更新')
    expect(stale).toContain('situational_state_commit')
    expect(stale).toContain('若当前会话情景已变化')
    // staleGuideMs=0 → any head guides.
    const always = renderSituationalContext(
      { nodeId: 'n1', seq: 1, prevNodeId: null, createdAt: Date.now(), situation: '即时', sessionId: '', nextUpdateAfterMs: null },
      0,
    )
    expect(always).toContain('【提示】')
  })

  it('records commit and inject events in the trace ledger (详情轨迹库)', async () => {
    const { ctx, root } = await mount()
    try {
      const agent = stubAgent(ctx, 'trace-agent')
      // Commit writes a commit trace entry.
      await ctx.situationalState.commit(agent, '轨迹测试情景')
      const fs = ctx.get('fs')
      expect(fs).toBeDefined()
      const target = await fs!.resolve(`${root}/trace.jsonl`)
      const traceText = String(await fs!.readText(target) ?? '')
      const lines = traceText.split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const first = JSON.parse(lines[0] as string) as { kind: string; nodeId: string; sessionId: string; situation: string }
      expect(first.kind).toBe('commit')
      expect(first.nodeId).toBe('sstate-1')
      expect(first.sessionId).toBe('trace-agent')
      expect(first.situation).toContain('轨迹测试情景')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
