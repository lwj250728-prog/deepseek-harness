/**
 * Self-scheduled situational state chain: the main-session agent commits
 * periodic situation snapshots and decides the next update time; the latest
 * node is injected at every agent pre-step as ongoing model context.
 *
 * The chain is a persisted linked list (`situational-state/chain.json` under
 * `$DSH_HOME`): each node carries its timestamp, situation text, a back
 * pointer, and the agent's self-decided next-update delay. The model tool
 * `situational_state_commit` appends a node; an optional next-update delay
 * arms a maintenance wake that reminds the agent to consider another commit.
 *
 * @module @deepseek-ai/dsh-situational-state
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** One committed situational-state node (a linked-list cell). */
export interface SituationalStateNode {
  /** Stable node id (`sstate-<n>`). */
  readonly nodeId: string
  /** Monotonic sequence, also the nextSeq cursor. */
  readonly seq: number
  /** The previous node's id, or null for the head. */
  readonly prevNodeId: string | null
  /** Epoch milliseconds at commit. */
  readonly createdAt: number
  /** The agent's situation summary. */
  readonly situation: string
  /** The committing session id. The chain document is shared across
   * sessions, so every node records its source session for attribution;
   * empty when read from a legacy chain written before this field existed. */
  readonly sessionId: SessionId
  /** Self-decided next-update delay in ms, or null when none was scheduled. */
  readonly nextUpdateAfterMs: number | null
}

/** The persisted chain document. */
export interface SituationalStateChain {
  readonly nodes: readonly SituationalStateNode[]
  readonly nextSeq: number
}

/** Commit outcome returned to the model tool and service callers. */
export interface SituationalStateCommitResult {
  readonly ok: true
  readonly nodeId: string
  readonly seq: number
  readonly prevNodeId: string | null
  readonly chainLength: number
  readonly nextUpdateScheduled: number | null
}

/** One node's activation span: the period it was the chain head. */
export interface ActivationSpan {
  /** The node whose activation this span describes. */
  readonly nodeId: string
  /** Epoch ms when the node became the head (its commit). */
  readonly from: number
  /** Epoch ms when the next node replaced it, or `now` while it is still head. */
  readonly to: number
  /** `to - from`, in ms. */
  readonly activeMs: number
}

/** Activation statistics over the whole chain. */
export interface ActivationStats {
  /** Per-node activation spans, oldest first. */
  readonly spans: readonly ActivationSpan[]
  /** Sum of all spans' `activeMs`. */
  readonly totalActiveMs: number
}

/** Service interface: chain persistence plus checkpoint scheduling. */
export interface SituationalStateService {
  /** The latest committed node, or undefined for an empty chain. */
  head(): Promise<SituationalStateNode | undefined>
  /** All committed nodes, oldest first. */
  list(): Promise<readonly SituationalStateNode[]>
  /** Activation statistics: how long each node was (or has been) the chain
   * head, and the cumulative total across the chain. */
  activationStats(now?: number): Promise<ActivationStats>
  /**
   * Append one node for the given agent. When `nextUpdateAfterMs` is set,
   * arm a maintenance wake that reminds the agent at that delay.
   * @param agent - the committing agent (its id keys the wake timer).
   * @param situation - the situation summary text (non-empty).
   * @param nextUpdateAfterMs - self-decided next-update delay, or null.
   */
  commit(agent: Agent, situation: string, nextUpdateAfterMs?: number | null): Promise<SituationalStateCommitResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    situationalState: SituationalStateService
  }
}

/** Plugin configuration (all fields optional). */
export interface Config {
  /** Storage directory; defaults to `$DSH_HOME/situational-state`. */
  root?: string
  /** Minimum next-update delay in ms (default 60_000). */
  minUpdateDelayMs?: number
  /** Retry delay when the agent is busy at wake time (default 60_000). */
  busyRetryMs?: number
  /** False disables pre-step injection while keeping the tool and service (default true). */
  injectEnabled?: boolean
  /** When the chain head is older than this, the injected context carries an
   * explicit "consider updating" guide (default 1 hour). The self-scheduled
   * design relied on the agent calling situational_state_commit unprompted;
   * a long session never did, so the chain went stale (measured: 4 days with
   * no update). The guide makes the staleness visible at every pre-step
   * instead of depending on an optional wake timer. */
  staleUpdateGuideMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string().default(dshHomePath('situational-state')),
  minUpdateDelayMs: z.number().min(1000).default(60_000),
  busyRetryMs: z.number().min(1000).default(60_000),
  injectEnabled: z.boolean().default(true),
  staleUpdateGuideMs: z.number().min(1000).default(3600_000),
})

/** Resolved configuration with every field materialized. */
export interface ResolvedConfig {
  readonly root: string
  readonly minUpdateDelayMs: number
  readonly busyRetryMs: number
  readonly injectEnabled: boolean
  readonly staleUpdateGuideMs: number
}

/** Resolve the plugin configuration.
 * @param config - partial configuration.
 * @returns the resolved immutable configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    root: config.root ?? dshHomePath('situational-state'),
    minUpdateDelayMs: config.minUpdateDelayMs ?? 60_000,
    busyRetryMs: config.busyRetryMs ?? 60_000,
    injectEnabled: config.injectEnabled ?? true,
    staleUpdateGuideMs: config.staleUpdateGuideMs ?? 3600_000,
  })
}

/** Render one situation age as a short human label. */
export function ageText(createdAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - createdAt)
  if (ageMs < 60_000) return '刚刚'
  if (ageMs < 3600_000) return `${Math.round(ageMs / 60_000)} 分钟前`
  return `${Math.round(ageMs / 3600_000)} 小时前`
}

/** Compute per-node activation spans: each node is "active" (the chain head)
 * from its own commit until the next node's commit — or until `now` when it is
 * still the head. Returns the spans oldest first plus the cumulative total.
 * @param nodes - committed nodes, oldest first.
 * @param now - the reference moment for the still-active head (default now).
 */
export function activationStats(nodes: readonly SituationalStateNode[], now = Date.now()): ActivationStats {
  const spans: ActivationSpan[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    const next = nodes[index + 1]
    const from = node.createdAt
    const to = next === undefined ? now : next.createdAt
    const activeMs = Math.max(0, to - from)
    spans.push({ nodeId: node.nodeId, from, to, activeMs })
  }
  return {
    spans,
    totalActiveMs: spans.reduce((sum, span) => sum + span.activeMs, 0),
  }
}

/** Durable chain preamble for injected context messages. */
export const CONTEXT_PREAMBLE = '【情景状态参考】'
/** Durable wake preamble for checkpoint reminders. */
export const WAKE_PREAMBLE = '【情景状态检查点】'

/**
 * Render the injected situational-context text for one chain head. When the
 * head is stale (age ≥ staleGuideMs), an explicit update guide is appended so
 * the model sees that the committed state is old and may call
 * `situational_state_commit` — the self-scheduled design's weak point was
 * that nothing prompted the agent to commit (measured: chain frozen for days).
 * @param head - the chain head node.
 * @param staleGuideMs - staleness threshold for the update guide; 0 always guides.
 * @param now - reference time for age (default Date.now()).
 * @returns the rendered context text (preamble + age + session + situation [+ guide]).
 */
export function renderSituationalContext(
  head: SituationalStateNode,
  staleGuideMs: number,
  now: number = Date.now(),
): string {
  const ageMs = Math.max(0, now - head.createdAt)
  const stale = ageMs >= staleGuideMs
  const sessionTag = head.sessionId.length > 0 ? `［会话 ${head.sessionId}］` : ''
  const guide = stale
    ? `\n【提示】此情景状态已 ${ageText(head.createdAt, now)} 未更新（提交于${sessionTag.length > 0 ? ` ${head.sessionId}` : '较早'}）。若当前会话情景已变化（阶段切换/环境变化/任务推进），可调用 situational_state_commit 提交新的情景状态。`
    : ''
  return `${CONTEXT_PREAMBLE}当前会话最近提交的情景状态（${ageText(head.createdAt, now)}）${sessionTag}：${head.situation}${guide}`
}
/** Plugin source name stamped on every message this package produces. */
export const SOURCE_NAME = 'situational-state'
/** Default file name of the chain document. */
export const CHAIN_FILE = 'chain.json'
/** Default file name of the situational trace ledger (append-only JSONL). */
export const TRACE_FILE = 'trace.jsonl'

/** Build one plugin-sourced user message. */
export function createSituationalMessage(text: string, id: string): UserMessage {
  return {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }] satisfies ContentBlock[],
    source: { kind: 'plugin', plugin: SOURCE_NAME },
  }
}

/** One pending wake timer per agent id (disposer is fiber-owned). */
const wakes = new Map<string, () => void>()

/** Plugin name and required services. */
export const name = 'situational-state'

/**
 * Mount the plugin: persist the chain under `$DSH_HOME/situational-state`,
 * register the `situational_state_commit` model tool, arm maintenance wakes
 * for self-decided checkpoints, and inject the latest node at pre-step.
 * @param ctx - plugin context carrying the fs/agents/tools/timer services.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const fileTarget = `${resolved.root}/${CHAIN_FILE}`
  const traceTarget = `${resolved.root}/${TRACE_FILE}`

  const service: SituationalStateService = {
    async head() {
      const chain = await readChain(ctx, fileTarget)
      const nodes = chain.nodes
      return nodes.length > 0 ? nodes[nodes.length - 1] : undefined
    },
    async list() {
      const chain = await readChain(ctx, fileTarget)
      return [...chain.nodes]
    },
    async activationStats(now = Date.now()) {
      const chain = await readChain(ctx, fileTarget)
      return activationStats(chain.nodes, now)
    },
    async commit(agent, situation, nextUpdateAfterMs = null) {
      const delay = nextUpdateAfterMs === null || nextUpdateAfterMs === undefined
        ? null
        : Math.max(resolved.minUpdateDelayMs, nextUpdateAfterMs)
      const chain = await readChain(ctx, fileTarget)
      const seq = chain.nextSeq + 1
      const tail: SituationalStateNode | undefined = chain.nodes.length > 0
        ? chain.nodes[chain.nodes.length - 1]
        : undefined
      const node: SituationalStateNode = {
        nodeId: `sstate-${seq}`,
        seq,
        prevNodeId: tail === undefined ? null : tail.nodeId,
        createdAt: Date.now(),
        situation,
        sessionId: agent.session.id,
        nextUpdateAfterMs: delay,
      }
      await writeChain(ctx, fileTarget, {
        nodes: [...chain.nodes, node],
        nextSeq: seq,
      })
      // Record the commit in the trace ledger too, so the trajectory shows
      // both what was surfaced (inject) and what was newly committed.
      const ledger = await readTrace(ctx, traceTarget)
      await appendTrace(ctx, traceTarget, {
        traceId: `trace-${ledger.nextSeq}`,
        seq: ledger.nextSeq,
        nodeId: node.nodeId,
        kind: 'commit',
        sessionId: agent.session.id,
        situation: node.situation.slice(0, 120),
        createdAt: node.createdAt,
        position: `seq:${agent.session.seq}`,
      })
      if (delay !== null) {
        scheduleWake(ctx, agent.id, delay, `已到自决更新时间（节点 ${node.nodeId} 提交后 ${Math.round(delay / 1000)} 秒）。`)
      }
      return {
        ok: true,
        nodeId: node.nodeId,
        seq,
        prevNodeId: node.prevNodeId,
        chainLength: seq,
        nextUpdateScheduled: delay === null ? null : Math.round(delay / 1000),
      }
    },
  }
  ctx.provide('situationalState', service)

  registerCommitTool(ctx, service, resolved)
  registerTraceTool(ctx, traceTarget)

  // Pre-step injection: once per committed node, surface the latest state as
  // model context. Track per-agent to avoid re-injecting the same node.
  // When the head is stale (older than staleUpdateGuideMs), the injected
  // context carries an explicit update guide — the self-scheduled design's
  // weak point was that nothing prompted the agent to commit, so a long
  // session left the chain frozen (measured 4 days). The guide makes the
  // staleness visible at every pre-step.
  const lastInjected = new Map<string, string>()
  if (resolved.injectEnabled) {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const chain = await readChain(ctx, fileTarget)
      const nodes = chain.nodes
      if (nodes.length === 0) return decision
      const head: SituationalStateNode | undefined = nodes[nodes.length - 1]
      if (head === undefined) return decision
      if (lastInjected.get(agent.id) === head.nodeId) return decision
      lastInjected.set(agent.id, head.nodeId)
      // Record the injection in the trace ledger (cooldown-suppressed so an
      // unchanged head does not spam identical entries every pre-step).
      const now = Date.now()
      if (!(await traceInCooldown(ctx, traceTarget, agent.session.id, head.nodeId, now))) {
        const ledger = await readTrace(ctx, traceTarget)
        await appendTrace(ctx, traceTarget, {
          traceId: `trace-${ledger.nextSeq}`,
          seq: ledger.nextSeq,
          nodeId: head.nodeId,
          kind: 'inject',
          sessionId: agent.session.id,
          situation: head.situation.slice(0, 120),
          createdAt: now,
          position: `seq:${agent.session.seq}`,
        })
      }
      const message = createSituationalMessage(
        renderSituationalContext(head, resolved.staleUpdateGuideMs),
        `situational-ctx-${now}-${Math.random().toString(36).slice(2, 8)}`,
      )
      return { kind: 'enter', messages: [...decision.messages, message] }
    })
  }
}

/** Read the chain document; an absent or corrupt file yields an empty chain.
 * Nodes written before the `sessionId` field existed are normalized to an
 * empty session id so legacy documents keep loading. */
async function readChain(ctx: Context, fileTarget: string): Promise<SituationalStateChain> {
  const fs = ctx.get('fs')
  if (fs === undefined) return { nodes: [], nextSeq: 0 }
  try {
    const target = await fs.resolve(fileTarget)
    const text = await fs.readText(target)
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object'
      && Array.isArray((parsed as { nodes?: unknown }).nodes)) {
      const chain = parsed as { nodes: SituationalStateNode[]; nextSeq: number }
      return {
        nodes: chain.nodes.map(node => ({
          ...node,
          sessionId: typeof node.sessionId === 'string' ? node.sessionId : SessionId(''),
        })),
        nextSeq: chain.nextSeq,
      }
    }
  } catch (_err) {
    // First run or a transient read failure: start empty.
  }
  return { nodes: [], nextSeq: 0 }
}

/** Write the chain document through the fs service. */
async function writeChain(ctx: Context, fileTarget: string, chain: SituationalStateChain): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('situational-state: fs service is unavailable')
  const target = await fs.resolve(fileTarget)
  await fs.writeText(target, JSON.stringify(chain, null, 2))
}

// ── situational trace ledger (finding: 链只是笼统概括，无法回溯注入轨迹) ────

/** One trace entry: a chain-head injection (or commit) with its session
 * position, so the trajectory of "what situational state was surfaced, where"
 * is queryable instead of a single vague summary. */
export interface SituationalTraceEntry {
  /** Stable trace id (`trace-<n>`). */
  readonly traceId: string
  /** Monotonic sequence, also the nextTraceSeq cursor. */
  readonly seq: number
  /** The chain node surfaced or committed. */
  readonly nodeId: string
  /** inject = a pre-step surfaced the chain head; commit = a new node was appended. */
  readonly kind: 'inject' | 'commit'
  /** The session where this happened. */
  readonly sessionId: SessionId
  /** The situation summary at that point. */
  readonly situation: string
  /** Epoch ms of the event. */
  readonly createdAt: number
  /** Session message/step position when known (e.g. turn/step of the pre-step). */
  readonly position?: string
}

/** The persisted trace ledger (append-only JSONL). */
export interface SituationalTraceLedger {
  readonly entries: readonly SituationalTraceEntry[]
  readonly nextSeq: number
}

/** Trace cooldown: how long one (session, node) pair is suppressed from
 * duplicate inject records (default 5 min). The head rarely changes, so
 * without a cooldown every pre-step would append a near-identical entry. */
const TRACE_COOLDOWN_MS = 5 * 60_000

/** Read the trace ledger; absent/corrupt yields empty. */
async function readTrace(ctx: Context, traceTarget: string): Promise<SituationalTraceLedger> {
  const fs = ctx.get('fs')
  if (fs === undefined) return { entries: [], nextSeq: 0 }
  try {
    const target = await fs.resolve(traceTarget)
    const text = String(await fs.readText(target) ?? '')
    const lines = text.split('\n').filter(line => line.trim().length > 0)
    const entries: SituationalTraceEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SituationalTraceEntry
        if (typeof entry.traceId === 'string') entries.push(entry)
      } catch (_err) {
        // Skip corrupt line; keep the rest.
      }
    }
    const nextSeq = entries.length > 0 ? Math.max(...entries.map(e => e.seq)) + 1 : 0
    return { entries, nextSeq }
  } catch (_err) {
    return { entries: [], nextSeq: 0 }
  }
}

/** Append one trace entry (JSONL). */
async function appendTrace(
  ctx: Context,
  traceTarget: string,
  entry: SituationalTraceEntry,
): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const target = await fs.resolve(traceTarget)
  try {
    const existing = String(await fs.readText(target) ?? '')
    await fs.writeText(target, `${existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' : existing}${JSON.stringify(entry)}\n`)
  } catch (_err) {
    await fs.writeText(target, `${JSON.stringify(entry)}\n`)
  }
}

/** Whether the last trace for this (session, node) pair is within cooldown —
 * suppresses duplicate inject records while the head is unchanged. */
async function traceInCooldown(
  ctx: Context,
  traceTarget: string,
  sessionId: string,
  nodeId: string,
  now: number,
): Promise<boolean> {
  const ledger = await readTrace(ctx, traceTarget)
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (entry === undefined) continue
    if (entry.sessionId !== sessionId || entry.nodeId !== nodeId) continue
    return now - entry.createdAt < TRACE_COOLDOWN_MS
  }
  return false
}

/** Arm one maintenance wake for an agent; replaces any prior wake for it. */
function scheduleWake(ctx: Context, agentId: string, afterMs: number, reason: string): void {
  const prior = wakes.get(agentId)
  if (prior !== undefined) {
    prior()
    wakes.delete(agentId)
  }
  // Native timer owned by a fiber effect: stop/update/undefine clears it.
  let timer: ReturnType<typeof setTimeout> | undefined
  const disposer = ctx.effect(() => {
    timer = setTimeout(() => {
      timer = undefined
      wakes.delete(agentId)
      void wakeAgent(ctx, agentId, reason, 60_000)
    }, afterMs)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  })
  wakes.set(agentId, disposer)
}

/** Remind one agent through a maintenance follow-up; retry when busy. */
async function wakeAgent(
  ctx: Context,
  agentId: string,
  reason: string,
  busyRetryMs: number,
): Promise<void> {
  const agents = ctx.get('agents')
  if (agents === undefined) return
  const agent = agents.get(SessionId(agentId))
  if (agent === undefined) return
  try {
    await agent.runMaintenance(async () => {
      const message = createSituationalMessage(
        `${WAKE_PREAMBLE}${reason}。请根据当前会话判断是否需要调用 situational_state_commit 更新情景状态链表，或忽略本次提醒。`,
        `situational-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
      agent.followup(message)
    })
  } catch (_busy) {
    // Another activity owns the idle phase; retry after a delay.
    ctx.effect(() => {
      const timer = setTimeout(() => { void wakeAgent(ctx, agentId, reason, busyRetryMs) }, busyRetryMs)
      return () => clearTimeout(timer)
    })
  }
}

/** Register the model-facing commit tool. */
function registerCommitTool(
  ctx: Context,
  service: SituationalStateService,
  resolved: ResolvedConfig,
): void {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  tools.register(defineTool({
    name: 'situational_state_commit',
    description: '提交当前会话情景状态到持久链表，并可自决下一次状态更新的时间。每次提交追加一个链表节点（含时间戳与前驱指针）；next_update_seconds 决定何时再次收到情景状态检查点提醒，省略则不安排下次更新。适合在会话阶段切换、环境变化或长时间任务节点时使用。',
    parameters: {
      situation: {
        type: 'string',
        required: true,
        description: '当前会话情景状态摘要：正在做什么、目标、关键环境事实（cwd/工具/状态）。',
      },
      next_update_seconds: {
        type: 'number',
        description: '自决的下一次更新间隔（秒，至少 60）。到点后 agent 会收到情景状态检查点提醒，可再决定是否更新。省略则不安排。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          nodeId: { type: 'string' },
          seq: { type: 'number' },
          prevNodeId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          chainLength: { type: 'number' },
          nextUpdateScheduled: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const agents = ctx.get('agents')
      const agent = exec?.agent ?? (agents !== undefined ? agents.currentInitiator() : undefined)
      if (agent === undefined) return { ok: false, error: 'no agent' }
      const situation = String(args.situation ?? '').trim()
      if (situation.length === 0) return { ok: false, error: 'situation required' }
      const raw = args.next_update_seconds
      const nextSeconds = raw === undefined || raw === null ? null : Number(raw)
      if (nextSeconds !== null && (!Number.isFinite(nextSeconds) || nextSeconds * 1000 < resolved.minUpdateDelayMs)) {
        return { ok: false, error: `next_update_seconds must schedule at least ${Math.round(resolved.minUpdateDelayMs / 1000)}s` }
      }
      return service.commit(agent, situation, nextSeconds === null ? null : nextSeconds * 1000)
    },
  }))
}

/** Register the model-facing trace-query tool: filter the situational trace
 * ledger by session, node, kind, or recency, so a session can look back at
 * "which situational states were surfaced/committed, where in the session". */
function registerTraceTool(ctx: Context, traceTarget: string): void {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  tools.register(defineTool({
    name: 'situational_state_trace',
    description: '查询情景状态轨迹账本：记录每次情景链头注入（inject）与情景提交（commit）的时间、会话、会话位置（消息序号）与摘要。可按会话、节点、类型过滤，或取最近 N 条。用于回溯"某个情景状态在哪个会话哪一步被注入/提交"。',
    parameters: {
      session_id: { type: 'string', description: '按会话过滤（可选）。' },
      node_id: { type: 'string', description: '按链节点过滤（可选，如 sstate-3）。' },
      kind: { type: 'string', enum: ['inject', 'commit'], description: '按类型过滤（可选）。' },
      limit: { type: 'number', description: '返回条数上限（默认 20，最大 100）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                traceId: { type: 'string' },
                seq: { type: 'number' },
                nodeId: { type: 'string' },
                kind: { type: 'string' },
                sessionId: { type: 'string' },
                situation: { type: 'string' },
                createdAt: { type: 'number' },
                position: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args) {
      const ledger = await readTrace(ctx, traceTarget)
      let entries = [...ledger.entries]
      const sessionFilter = typeof args.session_id === 'string' ? args.session_id : undefined
      const nodeFilter = typeof args.node_id === 'string' ? args.node_id : undefined
      const kindFilter = args.kind === 'inject' || args.kind === 'commit' ? args.kind : undefined
      if (sessionFilter !== undefined) entries = entries.filter(e => e.sessionId === sessionFilter)
      if (nodeFilter !== undefined) entries = entries.filter(e => e.nodeId === nodeFilter)
      if (kindFilter !== undefined) entries = entries.filter(e => e.kind === kindFilter)
      entries = [...entries].reverse() // newest first
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Number(args.limit), 1), 100) : 20
      return { ok: true, entries: entries.slice(0, limit) }
    },
  }))
}
