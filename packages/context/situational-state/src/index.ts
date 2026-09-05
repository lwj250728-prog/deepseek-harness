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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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

/** Commit provenance: who decided this node should exist. */
export type CommitOrigin = 'tool' | 'bootstrap' | 'turn-end' | 'compaction'

/** Service interface: chain persistence plus checkpoint scheduling. */
export interface SituationalStateService {
  /** The latest committed node, or undefined for an empty chain. */
  head(): Promise<SituationalStateNode | undefined>
  /** All committed nodes, oldest first. */
  list(): Promise<readonly SituationalStateNode[]>
  /** Activation statistics: how long each node was (or has been) the chain
   * head, and the cumulative total across the chain. */
  activationStats(now?: number): Promise<ActivationStats>
  /** The newest trace-ledger entries (inject/commit trajectory), newest
   * first, capped at `limit` — the host-side read the life-stream UI
   * consumes without reaching into the trace file itself. */
  traceTail(limit?: number): Promise<readonly SituationalTraceEntry[]>
  /**
   * Append one node for the given agent. When `nextUpdateAfterMs` is set,
   * arm a maintenance wake that reminds the agent at that delay.
   * @param agent - the committing agent (its id keys the wake timer).
   * @param situation - the situation summary text (non-empty).
   * @param nextUpdateAfterMs - self-decided next-update delay, or null.
   * @param origin - commit provenance recorded in the trace ledger
   * ('tool' for the model tool, 'bootstrap' for the automatic empty-chain
   * opening node, 'turn-end' for the turn-end self-check); default 'tool'.
   */
  commit(
    agent: Agent,
    situation: string,
    nextUpdateAfterMs?: number | null,
    origin?: CommitOrigin,
  ): Promise<SituationalStateCommitResult>
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
  /** True commits an automatic opening node on the first pre-step of a
   * session that finds the chain empty, so the injection hook never
   * short-circuits and the conversation starts its own state chain without a
   * manual tool call or a hand-edited chain document (default true). */
  autoBootstrap?: boolean
  /** True registers a turn-end self-check: when a completed turn did real
   * work and the chain head is older than `selfCheckMinHeadAgeMs`, the plugin
   * commits a state node from the turn's own content, so the chain advances
   * as the conversation works without the model remembering to call
   * `situational_state_commit` (default true). */
  selfCheckEnabled?: boolean
  /** Minimum age of the chain head before the turn-end self-check may commit
   * a replacement node (default 5 minutes). Bounds the cadence so a rapid
   * back-and-forth does not flood the chain with one node per turn. */
  selfCheckMinHeadAgeMs?: number
  /** Minimum tool calls in the completed turn for the self-check to count it
   * as real work worth a state commit (default 1). 0 also commits turns that
   * only produced assistant text. */
  selfCheckMinToolCalls?: number
  /** True writes the thread back into the chain when context compaction
   * summarizes an evicted arc: on the session's `compaction/summary` event,
   * one node is committed with the summary text (`origin: 'compaction'`), so
   * the post-compaction steps and later sessions recover "what was happening"
   * from the substrate rather than from the evicted surface alone
   * (default true). */
  compactionWriteBack?: boolean
  /** How many trailing text blocks feed the opening-situation extraction for
   * the empty-chain bootstrap (default 4). */
  contextDepth?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string().default(dshHomePath('situational-state')),
  minUpdateDelayMs: z.number().min(1000).default(60_000),
  busyRetryMs: z.number().min(1000).default(60_000),
  injectEnabled: z.boolean().default(true),
  staleUpdateGuideMs: z.number().min(1000).default(3600_000),
  autoBootstrap: z.boolean().default(true),
  selfCheckEnabled: z.boolean().default(true),
  selfCheckMinHeadAgeMs: z.number().min(1000).default(5 * 60_000),
  selfCheckMinToolCalls: z.number().min(0).max(20).default(1),
  compactionWriteBack: z.boolean().default(true),
  contextDepth: z.number().step(1).min(1).max(20).default(4),
})

/** Resolved configuration with every field materialized. */
export interface ResolvedConfig {
  readonly root: string
  readonly minUpdateDelayMs: number
  readonly busyRetryMs: number
  readonly injectEnabled: boolean
  readonly staleUpdateGuideMs: number
  readonly autoBootstrap: boolean
  readonly selfCheckEnabled: boolean
  readonly selfCheckMinHeadAgeMs: number
  readonly selfCheckMinToolCalls: number
  readonly compactionWriteBack: boolean
  readonly contextDepth: number
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
    autoBootstrap: config.autoBootstrap ?? true,
    selfCheckEnabled: config.selfCheckEnabled ?? true,
    selfCheckMinHeadAgeMs: config.selfCheckMinHeadAgeMs ?? 5 * 60_000,
    selfCheckMinToolCalls: config.selfCheckMinToolCalls ?? 1,
    compactionWriteBack: config.compactionWriteBack ?? true,
    contextDepth: config.contextDepth ?? 4,
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
 * When `readerSessionId` is supplied and differs from the head's committing
 * session, the preamble states the true owner instead of claiming the head
 * was committed by the reading session — a fresh session reading the life
 * thread must see "会话 X 最近提交", not a false "当前会话最近提交".
 * @param head - the chain head node.
 * @param staleGuideMs - staleness threshold for the update guide; 0 always guides.
 * @param now - reference time for age (default Date.now()).
 * @param readerSessionId - the session the context is being injected into;
 * omit for a reader-neutral render (legacy behavior).
 * @returns the rendered context text (preamble + age + session + situation [+ guide]).
 */
export function renderSituationalContext(
  head: SituationalStateNode,
  staleGuideMs: number,
  now: number = Date.now(),
  readerSessionId?: SessionId | string,
): string {
  const ageMs = Math.max(0, now - head.createdAt)
  const stale = ageMs >= staleGuideMs
  const readerGiven = readerSessionId !== undefined && readerSessionId.length > 0
  const crossSession = readerGiven && head.sessionId.length > 0 && readerSessionId !== head.sessionId
  // Reader-neutral renders keep the legacy "当前会话" wording; with a reader,
  // the owner is the head's committing session unless it IS the reader.
  const owner = !readerGiven || head.sessionId.length === 0
    ? '当前会话'
    : readerSessionId === head.sessionId ? '当前会话' : `会话 ${head.sessionId}`
  const sessionTag = head.sessionId.length > 0 ? `［会话 ${head.sessionId}］` : ''
  const crossNote = crossSession
    ? '\n【跨会话】该状态由另一会话提交。若你在延续这条线索，可基于它继续推进，并在情景变化时调用 situational_state_commit 提交本会话的新状态。'
    : ''
  const guide = stale
    ? `\n【提示】此情景状态已 ${ageText(head.createdAt, now)} 未更新（提交于${sessionTag.length > 0 ? ` ${head.sessionId}` : '较早'}）。若当前会话情景已变化（阶段切换/环境变化/任务推进），可调用 situational_state_commit 提交新的情景状态。`
    : ''
  const ownerPrefix = owner === '当前会话' ? '当前会话最近提交' : `${owner} 最近提交`
  return `${CONTEXT_PREAMBLE}${ownerPrefix}的情景状态（${ageText(head.createdAt, now)}）${sessionTag}：${head.situation}${crossNote}${guide}`
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

/** How long one auto-authored situation text may be (bounded write; the
 * model-authored tool commits stay uncapped, these are synthesized). */
const AUTO_NODE_MAX = 220

/** Extract the opening situation from the messages entering a step: the
 * trailing non-empty text blocks, joined, capped at {@link AUTO_NODE_MAX}.
 * Used by the empty-chain bootstrap to author the first node from what the
 * session actually opened with — no fabricated state, only the conversation's
 * own words. */
export function openingText(messages: readonly UserMessage[], depth = 4): string {
  const blocks: string[] = []
  for (const message of messages) {
    const content = message.content as readonly { type?: string; text?: string }[] | undefined
    for (const block of content ?? []) {
      if (block.type === 'text' && block.text !== undefined && block.text.trim().length > 0) {
        blocks.push(block.text)
      }
    }
  }
  return blocks.slice(-depth).join(' ').trim().slice(0, AUTO_NODE_MAX)
}

/** What one completed turn actually did, read back from the session ledger:
 * the tool-call count and the most recent self-authored text (the last
 * assistant statement, or the last genuine user request when the assistant
 * produced no text). Plugin-sourced messages (injected context) are skipped.
 */
export interface TurnActivity {
  /** How many tool/call events the turn recorded. */
  readonly toolCalls: number
  /** The turn's most recent self-authored text, capped at {@link AUTO_NODE_MAX}. */
  readonly text: string
}

/** Reconstruct one turn's activity from the session ledger, walking backwards
 * from the ledger tail to the turn's own `turn/start` boundary.
 * @param session - the session whose ledger holds the turn's events.
 * @param endEvent - the turn/end event that closes the turn.
 * @returns the tool-call count and the latest self-authored text.
 */
export function extractTurnActivity(session: Session, endEvent: SessionEvent<'turn/end'>): TurnActivity {
  const turn = (endEvent.data as { turn: number }).turn
  const events = session.events
  let toolCalls = 0
  let assistantText = ''
  let userText = ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/start' && event.data.turn === turn) break
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'assistant/message': {
        const message = data.message as { content?: readonly { type: string; text?: string }[] } | undefined
        const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0 && assistantText.length === 0) assistantText = text
        break
      }
      case 'user/message': {
        const source = data.source as { kind?: string } | undefined
        if (source?.kind !== 'user') break
        const content = data.content as readonly { type: string; text?: string }[] | undefined
        const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0 && userText.length === 0) userText = text
        break
      }
      case 'tool/call':
        toolCalls += 1
        break
      default:
        break
    }
  }
  const text = (assistantText.length > 0 ? assistantText : userText).trim().slice(0, AUTO_NODE_MAX)
  return { toolCalls, text }
}

/** One pending wake timer per agent id (disposer is fiber-owned). */
const wakes = new Map<string, () => void>()

/** Plugin name and required services. */
export const name = 'situational-state'

/** Services required before the plugin can mount. Declared so the loader
 * mounts this plugin after the agent registry and the tool registry exist:
 * without the declaration the commit/trace tools used to be registered into a
 * context where `ctx.get('tools')` was still undefined, and the registration
 * guard silently skipped them — the conversation could never create its own
 * first chain node (measured: empty chain until a hand-written node). */
export const inject = ['agents', 'tools']

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
    async traceTail(limit = 20) {
      const ledger = await readTrace(ctx, traceTarget)
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 100)
      return [...ledger.entries].reverse().slice(0, capped)
    },
    async commit(agent, situation, nextUpdateAfterMs = null, origin = 'tool') {
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
        origin,
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
  // Empty-chain bootstrap: a session that finds the chain empty commits its
  // opening situation as the first node instead of short-circuiting, so the
  // injection hook never silently dies and the conversation starts its own
  // state chain without a manual tool call or a hand-edited chain document.
  const lastInjected = new Map<string, string>()
  let bootstrapPending = false
  if (resolved.injectEnabled) {
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const chain = await readChain(ctx, fileTarget)
      const nodes = chain.nodes
      if (nodes.length === 0) {
        if (!resolved.autoBootstrap || bootstrapPending) return decision
        const situation = openingText(decision.messages, resolved.contextDepth)
        if (situation.length === 0) return decision
        bootstrapPending = true
        try {
          await service.commit(agent, situation, null, 'bootstrap')
        } finally {
          bootstrapPending = false
        }
        // The fresh head is the session's own opening text; injecting it back
        // on this step would be noise. The next pre-step surfaces it normally.
        return decision
      }
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
        renderSituationalContext(head, resolved.staleUpdateGuideMs, Date.now(), agent.session.id),
        `situational-ctx-${now}-${Math.random().toString(36).slice(2, 8)}`,
      )
      return { kind: 'enter', messages: [...decision.messages, message] }
    })
  }

  // Turn-end self-check: when a completed turn did real work (tool calls at
  // or above the configured floor) and the chain head is old enough, commit a
  // state node from the turn's own content — the chain advances as the
  // conversation works, without the model remembering to call
  // situational_state_commit. The age floor bounds the cadence so a rapid
  // back-and-forth does not flood the chain with one node per turn.
  if (resolved.selfCheckEnabled) {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
      if (reason !== 'completed' && reason !== 'error') return
      void (async () => {
        try {
          const chain = await readChain(ctx, fileTarget)
          const head: SituationalStateNode | undefined = chain.nodes.length > 0
            ? chain.nodes[chain.nodes.length - 1]
            : undefined
          if (head === undefined) return
          if (Date.now() - head.createdAt < resolved.selfCheckMinHeadAgeMs) return
          const activity = extractTurnActivity(session, event)
          if (activity.toolCalls < resolved.selfCheckMinToolCalls) return
          if (activity.text.trim().length === 0) return
          const agents = ctx.get('agents')
          const agent = agents?.get(session.id)
          if (agent === undefined) return
          await service.commit(agent, activity.text, null, 'turn-end')
        } catch (error: unknown) {
          ctx.logger.warn(`situational-state: turn-end self-check failed: ${String(error)}`)
        }
      })()
    })
  }

  // Compaction write-back: when context compaction summarizes an evicted arc
  // (the session's `compaction/summary` event), commit one chain node with the
  // summary text — the thread survives the token pressure in the substrate.
  // On the next pre-step the refreshed head is injected, so the model recovers
  // "what was happening" from the chain, and the node persists for later
  // sessions too. One node per compaction id (idempotent under retries).
  if (resolved.compactionWriteBack) {
    const handledCompactions = new Set<string>()
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      // The compaction/* event vocabulary lives in @deepseek-ai/dsh-compaction
      // (declaration merge over dsh-session/types), which this package does
      // not depend on; read the contractual shape through a local structural
      // type instead of importing the merge.
      const compaction = event as unknown as {
        type: 'compaction/summary'
        data: { compactionId?: unknown; summary?: readonly { type?: string; text?: string }[] }
      }
      if (compaction.type !== 'compaction/summary') return
      const compactionId = String(compaction.data.compactionId ?? '')
      if (compactionId.length === 0 || handledCompactions.has(compactionId)) return
      const summary = (compaction.data.summary ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join(' ')
        .trim()
      if (summary.length === 0) return
      handledCompactions.add(compactionId)
      void (async () => {
        try {
          const agents = ctx.get('agents')
          const agent = agents?.get(session.id)
          if (agent === undefined) return
          await service.commit(agent, summary.slice(0, 320), null, 'compaction')
        } catch (error: unknown) {
          ctx.logger.warn(`situational-state: compaction write-back failed: ${String(error)}`)
        }
      })()
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
  /** Commit provenance: which path created the node (absent for entries
   * written before the field existed, and for inject records). */
  readonly origin?: CommitOrigin
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
    description: '查询情景状态轨迹账本：记录每次情景链头注入（inject）与情景提交（commit）的时间、会话、会话位置（消息序号）、摘要与提交来源（origin：tool 为模型工具提交、bootstrap 为空链自举、turn-end 为回合末自检、compaction 为压缩写回）。可按会话、节点、类型过滤，或取最近 N 条。用于回溯"某个情景状态在哪个会话哪一步被注入/提交"。',
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
                origin: { type: 'string' },
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
