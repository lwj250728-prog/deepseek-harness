/**
 * @deepseek-ai/dsh-session-handover — 会话继承: 上下文压缩后静默续接到后继会话.
 *
 * 动机: 会话日志随对话无限增长, 而 resume 必须把整份日志读进内存 —— 于是"长会话"
 * 从"慢"变成"打不开"(本部署实测: 78.6MB / 682 万事件的会话会 OOM 宿主)。物化预算把
 * 它变成明确报错, 但报错不是出路: 会话仍在长大。
 *
 * 策略: 在**上下文压缩发生后**交接。压缩本身就会让供应商的 prompt 前缀缓存失效,
 * 所以这是切换到新会话最不亏的时刻 —— 缓存无论如何都要重建。后继会话的种子就是压缩
 * 后的**有效视图**(压缩摘要 + 被遮蔽区间之后的全部事件), 因此模型上下文与压缩后本该
 * 发送的内容一致, 日志体量回到起点。
 *
 * 阈值默认 1: 保守起见每次压缩都交接, 宁可多切几次也不要让日志长到打不开。交接时机
 * 是**回合边界**(压缩发生在回合中, 此时不能动会话), 静默进行。
 *
 * ⚠ setup 必须与宿主同构(exp_272 的教训): 少传 setup 会把预设工具全剥掉, 后继会话就成
 * 了没有工具的空壳。故此处完全复刻宿主 `composeAgent` 的组合路径: 装模型选择 + mount 预设。
 *
 * @module @deepseek-ai/dsh-session-handover
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
// Ambient Context augmentation: `ctx.workspaceRegistry`.
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One session handed its conversation over to a fresh successor. Emitted
     * once per successful handover: clients use it to move the user silently,
     * and any mechanism bound to the predecessor id (timers, sentinels,
     * watchers) re-binds here instead of writing to a session nobody is in.
     */
    'session/handover'(payload: SessionHandoverNotice): void
  }
}

/** What one successful handover publishes. */
export interface SessionHandoverNotice {
  /** The session that reached the compaction threshold. */
  readonly predecessorId: SessionId
  /** The fresh session that now carries the conversation. */
  readonly successorId: SessionId
  /** How many events the successor inherited as its seed. */
  readonly seedLength: number
}

/**
 * Load-time diagnostic: proves the module was imported at all, which is a
 * different question from whether `apply` ran (a plugin held back for a missing
 * injected service never reaches apply, and a loader that never imports the
 * package prints nothing anywhere).
 */
console.log(`[session-handover] module loaded (pid ${process.pid})`)

/**
 * Lifecycle reporting.
 *
 * This plugin's own `ctx.logger` output does not reach the deployment's journal
 * — verified in production: console lines from the same module appear while the
 * logger line never does — so a handover that reported only through the logger
 * would be invisible exactly when someone needs to audit it. Lifecycle lines go
 * to the console sink the rest of the host plane uses.
 */
function report(line: string): void {
  console.log(`[session-handover] ${line}`)
}

export const name = 'session-handover'

/** Services this plugin relies on. */
export const inject = ['agents', 'agentPresets', 'workspaceRegistry']

/**
 * Plugin config schema.
 *
 * The loader validates a profile entry's `config` through this runtime schema —
 * a plugin that declares only a TypeScript interface receives nothing usable,
 * which silently disables it. Declaring the schema is therefore not just
 * validation: it is what makes the entry's configuration reach `apply` at all.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  compactionsPerSession: z.number().step(1).min(1).default(1),
  archivePredecessor: z.boolean().default(true),
  targetSessionIds: z.array(z.string()).default([]),
  dryRun: z.boolean().default(false),
})

/** Plugin config. */
export interface Config {
  /** Master switch; absent or `false` makes the plugin a no-op. */
  enabled?: boolean
  /**
   * How many context compactions one session may accumulate before it hands
   * over. Default 1: a long log is what makes a session unopenable, so hand over
   * at the first opportunity instead of waiting for the log to grow.
   */
  compactionsPerSession?: number
  /**
   * Whether the predecessor joins the archive set once its successor is live.
   * Default true: its transcript stays readable (unarchiving restores it), while
   * the session list keeps showing the conversation the user is actually in.
   */
  archivePredecessor?: boolean
  /** Restrict handover to these sessions (empty or absent means every session). */
  targetSessionIds?: string[]
  /** Observe and log the decision without creating a successor. */
  dryRun?: boolean
}

/** Event types the compaction plugins append as their durable record. */
const COMPACTION_RECORD_TYPES: ReadonlySet<string> = new Set(['compaction/summary', 'compaction/prune'])

/** Whether one event is a compaction's durable record. */
export function isCompactionRecord(event: SessionEvent): boolean {
  return COMPACTION_RECORD_TYPES.has(event.type)
}

/** How many compactions a log already carries. */
export function compactionCount(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) if (isCompactionRecord(event)) count += 1
  return count
}

/** The replacement range one event shadows, when it carries a replace op. */
export function replaceRange(event: SessionEvent): { start: number; end: number } | undefined {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (typeof op !== 'object' || op === null) return undefined
  const { op: kind, start, end } = op as { op?: unknown; start?: unknown; end?: unknown }
  if (kind !== 'replace' || typeof start !== 'number' || typeof end !== 'number') return undefined
  return { start, end }
}

/**
 * Build the seed of a successor session from a compacted log.
 *
 * The successor inherits the log's EFFECTIVE view, not its bytes:
 * - the newest compaction checkpoint becomes an ordinary append — it IS the
 *   summary the model was about to see, so carrying it verbatim keeps the
 *   provider's prompt prefix cacheable;
 * - the newest request header before it comes along, so the successor starts on
 *   the model the predecessor was actually using;
 * - every event after the checkpoint is kept, except events a later replacement
 *   already shadowed and compaction bookkeeping records;
 * - any replacement in the tail is downgraded to an append, because its shadowed
 *   originals are not in the seed and a range pointing at them could not
 *   validate (the same trap a log migration hits).
 *
 * Returns `undefined` when the log carries no compaction checkpoint: there is
 * nothing to inherit, so the caller leaves the session alone.
 * @param events - the live session's events, in seq order.
 * @returns the seed events and the seq of the checkpoint it was cut at.
 */
export function buildSuccessorSeed(
  events: readonly SessionEvent[],
): { seed: SessionEvent[]; checkpointSeq: number } | undefined {
  // The cut is the checkpoint the NEWEST compaction appended — not simply the
  // newest replacement: a later prune (tool-result compaction) also carries a
  // replace op, and cutting there would drop the compaction summary itself.
  let checkpointIndex = -1
  for (let index = events.length - 1; index >= 0 && checkpointIndex === -1; index -= 1) {
    const event = events[index]
    if (event === undefined || !isCompactionRecord(event)) continue
    for (let after = index + 1; after < events.length; after += 1) {
      const candidate = events[after]
      if (candidate !== undefined && replaceRange(candidate) !== undefined) {
        checkpointIndex = after
        break
      }
    }
  }
  if (checkpointIndex === -1) {
    // A log whose compaction record is gone (older format, pruned record) still
    // hands over from its newest replacement.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event !== undefined && replaceRange(event) !== undefined) {
        checkpointIndex = index
        break
      }
    }
  }
  if (checkpointIndex === -1) return undefined
  const checkpoint = events[checkpointIndex] as SessionEvent

  // Everything a later replacement shadows is already replaced in the view.
  const shadowed = new Set<number>()
  for (let index = checkpointIndex; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    for (const seq of (event as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? []) shadowed.add(seq)
    for (const seq of (event as { data?: { shadowedSeqs?: number[] } }).data?.shadowedSeqs ?? []) {
      shadowed.add(seq)
    }
  }

  /**
   * One event as a plain append: no replace op, no citation of absent events.
   *
   * A replacement is DOWNGRADED to `'append'`, never stripped: a surface-eligible
   * event must carry a surfaceOp at all, and the seeded copy has no shadowed
   * originals left to replace.
   */
  const asAppend = (event: SessionEvent, seq: number): SessionEvent => {
    const { surfaceOp, sourceEventSeqs, ...rest } = event as SessionEvent & {
      surfaceOp?: unknown
      sourceEventSeqs?: number[]
    }
    void sourceEventSeqs
    const carriesSurfaceOp = surfaceOp !== undefined
    const data = (rest as { data?: Record<string, unknown> }).data
    if (data === undefined || (data['shadowedSeqs'] === undefined && data['shadowedRange'] === undefined)) {
      return {
        ...(rest as SessionEvent),
        seq,
        ...carriesSurfaceOp ? { surfaceOp: 'append' } : {},
      } as SessionEvent
    }
    const { shadowedSeqs, shadowedRange, ...keptData } = data
    void shadowedSeqs
    void shadowedRange
    return {
      ...(rest as SessionEvent),
      seq,
      data: keptData,
      ...carriesSurfaceOp ? { surfaceOp: 'append' } : {},
    } as SessionEvent
  }

  let lastHeader: SessionEvent | undefined
  for (let index = checkpointIndex; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') { lastHeader = event; break }
  }

  const seed: SessionEvent[] = []
  let seq = 0
  if (lastHeader !== undefined) seed.push(asAppend(lastHeader, seq++))
  seed.push(asAppend(checkpoint, seq++))
  for (let index = checkpointIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (isCompactionRecord(event)) continue
    if (shadowed.has(event.seq) && replaceRange(event) === undefined) continue
    seed.push(asAppend(event, seq++))
  }
  return { seed, checkpointSeq: checkpoint.seq }
}

/**
 * Install the session-handover hooks.
 * @param ctx - Host context (agents, presets, workspace registry).
 * @param config - Plugin configuration.
 * @returns a disposer removing every hook this plugin installed.
 */
export function apply(ctx: Context, config: Config): () => void {
  console.log(`[session-handover] apply() reached: enabled=${String(config.enabled)} dryRun=${String(config.dryRun)}`)
  if (config.enabled !== true) {
    report('disabled (config.enabled is not true); no-op')
    return () => {}
  }
  const threshold = Math.max(1, Math.floor(config.compactionsPerSession ?? 1))
  const archive = config.archivePredecessor ?? true
  const dryRun = config.dryRun ?? false
  const targets = config.targetSessionIds === undefined || config.targetSessionIds.length === 0
    ? undefined
    : new Set(config.targetSessionIds)

  // Startup self-report: a deployment needs to see that the switch is armed
  // (and how), not infer it from an absence of handovers.
  report(
    `armed: threshold=${threshold} compaction(s), archivePredecessor=${String(archive)}, `
    + `dryRun=${String(dryRun)}, targets=${targets === undefined ? 'all sessions' : String(targets.size)}`,
  )

  /** Sessions past the threshold, waiting for a turn boundary they can be moved at. */
  const armed = new Set<SessionId>()
  const inFlight = new Set<SessionId>()

  /**
   * Install the model selection the predecessor was using, the way the host
   * does: the successor's own request header (carried in the seed) decides.
   */
  const installSelection = (agentCtx: Context): void => {
    const agent = agentCtx.agent
    if (agent === undefined) return
    installModelSelection(agentCtx, {
      get current(): ModelSelection | undefined {
        const logged = agent.session.requestHeader()?.config
        if (logged === undefined) return undefined
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(_next: ModelSelection | undefined) {
        // The seeded header is the successor's starting selection; later
        // selections come from the ordinary host path.
      },
      assembled: undefined,
    })
  }

  const handover = async (session: Session): Promise<void> => {
    if (inFlight.has(session.id)) return
    inFlight.add(session.id)
    try {
      const built = buildSuccessorSeed(session.events)
      if (built === undefined) return
      const predecessor = session.header
      const presets = ctx.agentPresets
      const resolved = await presets.resolve(resolveSessionPreset({ header: predecessor, events: session.events }))
      const successorId = `session-${randomUUID()}` as SessionId
      if (dryRun) {
        report(
          `dry run: ${session.id} → ${successorId} `
          + `(${built.seed.length} seed events, preset ${String(resolved.id)})`,
        )
        return
      }
      await ctx.agents.create({
        sessionId: successorId,
        seed: built.seed,
        meta: {
          ...predecessor.cwd === undefined ? {} : { cwd: predecessor.cwd },
          parentSession: predecessor.id,
          seedLength: built.seed.length,
          ...resolved.id === undefined ? {} : { agentPreset: resolved.id },
        },
        setup: async (agentCtx) => {
          installSelection(agentCtx)
          await presets.mount(agentCtx, resolved.id)
        },
      })
      try {
        const workspace = predecessor.cwd === undefined
          ? undefined
          : await ctx.workspaceRegistry.resolveByPath(predecessor.cwd)
        await workspace?.attachSession(successorId)
      } catch (error: unknown) {
        ctx.logger.warn(`[session-handover] successor ${successorId} could not attach to a workspace: ${String(error)}`)
      }
      if (archive) {
        try {
          await ctx.workspaceRegistry.archiveSession(predecessor.id)
        } catch (error: unknown) {
          ctx.logger.warn(`[session-handover] could not archive predecessor ${predecessor.id}: ${String(error)}`)
        }
      }
      ctx.emit('session/handover', {
        predecessorId: predecessor.id,
        successorId,
        seedLength: built.seed.length,
      })
      report(
        `${predecessor.id} → ${successorId}: ${built.seed.length} seed events inherited `
        + `(preset ${String(resolved.id)}, checkpoint seq ${built.checkpointSeq})`,
      )
    } catch (error: unknown) {
      // Fail soft: a session that cannot hand over keeps running exactly as
      // before, which is strictly better than losing the conversation.
      ctx.logger.warn(`[session-handover] handover for ${session.id} failed: ${String(error)}`)
    } finally {
      inFlight.delete(session.id)
      armed.delete(session.id)
    }
  }

  const eligible = (session: Session): boolean => targets === undefined || targets.has(session.id)

  const disposeEvent = ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!eligible(session)) return
    if (isCompactionRecord(event)) {
      const count = compactionCount(session.events)
      if (count >= threshold) {
        armed.add(session.id)
        report(
          `${session.id} carries ${count} compaction(s) (threshold ${threshold}); `
          + 'handing over at the next turn boundary',
        )
      }
      return
    }
    if (event.type !== 'turn/end') return
    if (!armed.has(session.id)) return
    void handover(session)
  })

  // A session armed by a compaction that happened while it was already idle
  // (for example a model-free prune) still needs its move.
  const disposeStatus = ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
    if (status !== 'idle') return
    if (!armed.has(agent.session.id)) return
    void handover(agent.session)
  })

  return () => {
    disposeEvent()
    disposeStatus()
  }
}
