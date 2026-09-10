/**
 * Prediction-error-driven dynamic cognition (DCA-PED) as a harness plugin:
 * SAR experience memory, a hot-loop online predictor with OOD detection and
 * five-layer confidence calibration, a temp-strategy scratchpad, simulated
 * experience generation, a cold-loop taxonomy rebuild gated by sandbox
 * backtesting, meta-cognition loops, acceptance-criteria claim audits, and
 * derived cognition objects (goal-anchored chains).
 * The plugin exposes fifteen model-facing tools, the
 * `ctx.cognitivePipeline` service, and a dynamic `cognition:taxonomy`
 * system-prompt section.
 *
 * @module @deepseek-ai/dsh-cognitive-pipeline
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  CognitiveLoopRegistry,
  CognitivePipelineService,
  Config,
} from './service.ts'
import type { CognitivePipelineConfig } from './service.ts'
import { registerPipelineTools } from './tools.ts'
import type { TurnEpisode } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'cognitive-pipeline'

/** Services required before the pipeline can mount. */
export const inject = ['llm', 'tools', 'systemPrompt']

/** Re-export the service and config schema for consumers and Loader validation. */
export { CognitiveLoopRegistry, CognitivePipelineService, Config }
export type { CognitivePipelineConfig } from './service.ts'
export * from './types.ts'
export * from './vectorizer.ts'
export {
  experienceDueForReview, strategyDueForReview, experienceRecordDue, strategyRecordDue,
  isHighCost, lastReviewOrCreation, reviewInterval, resolveScheduleOptions,
} from './review-schedule.ts'
export type { ReviewableExperience, ReviewableStrategy, ReviewScheduleOptions } from './review-schedule.ts'

/** Task-restatement detection, shared by the accumulation gate (reject new
 * records) and the injection retrieval (skip existing ones). */
export { isTaskRestatement } from './task-restatement.ts'
/** Self-frame detection (cl-102): frame-born records never re-enter a frame's
 * context — the same two-sided wiring as the task-restatement gate. */
export { isSelfFrameExperience } from './self-frame.ts'
/** Template-7 retrieval refinement, reused by consumers (cognitive-inject)
 * as the pre-injection veto gate. */
export { refineRetrieval, refineRetrievalFallback } from './llm.ts'
export type { CognitiveLlmRoute } from './llm.ts'
/** Session-ledger tool-call evidence: the non-self-referential witness used
 * by log-anchored claim audits. */
export { findToolCallEvidence } from './log-evidence.ts'
export type { ToolCallEvidence } from './log-evidence.ts'

/** Text of one user message (concatenated text blocks). */
function textOf(message: unknown): string {
  const content = (message as { content?: readonly { type?: string; text?: string }[] }).content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ').trim()
}

/**
 * cl-062: is this turn autonomous? An autonomous turn's only user-side input is
 * a plugin-injected frame (quiet-driver's action/three-question/test-review
 * frames); a genuine operator message has `source.kind === 'user'`. The model
 * is the only caller of `predict_outcome`, so while the operator is away the
 * calibration ruler and the refine A/B sample would otherwise freeze — the
 * exact freeze this detection exists to break.
 * @param messages - the pre-step user-side messages.
 * @returns the injected frame text when the turn is autonomous, else undefined.
 */
function autonomousFrame(messages: readonly unknown[]): string | undefined {
  // 只看**最后一条带来源的**用户侧消息: pre-step 的 messages 可能带完整历史,
  // 若按"出现过任何真实用户消息"判定, 一个曾经有用户发言的会话会永远判不出自主回合
  // (09-09 15:0x 自查发现该误判风险)。从尾往头找第一条有 source 的消息:
  // kind==='user' → 不是自主回合; 带 plugin → 就是插件帧。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = (messages[index] as { source?: { kind?: string; plugin?: string } }).source
    if (source === undefined) continue
    if (source.kind === 'user') return undefined
    if (source.plugin !== undefined) {
      const text = textOf(messages[index])
      return text.length > 0 ? text : undefined
    }
  }
  return undefined
}

/** Objective artifact fingerprint: mtime+size of the durable outputs this
 * agent actually produces. A turn "produced something" iff this changes. */
const WATCHED = [
  '~/.dsh/cognitive-pipeline/claims-ledger.jsonl',
  '~/.dsh/cognitive-pipeline/dormant-goals.jsonl',
  '~/.dsh/cognitive-pipeline/experiences.jsonl',
  '~/.dsh/cognitive-pipeline/test-pending.jsonl',
  '~/.dsh/cognitive-pipeline/predictions.jsonl',
  '~/.dsh/cognitive-pipeline/incubation-log.jsonl',
  '~/dsh-fork/dsh-cog-tests.sh',
  '~/dsh-workshop/novels/qizhongjiyi/audit/progress.md',
  '~/dsh-fork',
  '~/.dsh/cognitive-pipeline',
]

async function artifactFingerprint(): Promise<string> {
  const parts: string[] = []
  for (const raw of WATCHED) {
    const path = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    try {
      const info = await stat(path)
      parts.push(`${raw}:${info.mtimeMs}:${info.size}`)
    } catch {
      parts.push(`${raw}:missing`)
    }
  }
  return parts.join('|')
}

/** Reconstruct one completed turn into candidate accumulation material.
 * Reads the turn's events back from the session ledger: the genuine user
 * request (source kind 'user') becomes the situation, tool calls become the
 * action, the final assistant text and the end reason become the outcome.
 * @param session - the session whose ledger holds the turn's events.
 * @param endEvent - the turn/end event that closes the turn.
 * @returns the reconstructed episode.
 */
export function reconstructTurn(session: Session, endEvent: SessionEvent<'turn/end'>): TurnEpisode {
  const turn = (endEvent.data as { turn: number }).turn
  const events = session.events
  const texts: string[] = []
  const actions: string[] = []
  const outcomes: string[] = []
  let toolCallCount = 0
  let failed = false
  let selfReflexive = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/start' && event.data.turn === turn) break
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        // The user/message payload IS the message ({ content, source }), not a
        // { message } wrapper. Only the genuine user request (source kind
        // 'user') feeds the situation; injected reference blocks are noise.
        const source = data.source as { kind?: string } | undefined
        if (source?.kind !== 'user') break
        const content = data.content as readonly { type: string; text?: string }[] | undefined
        const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0) texts.push(text)
        break
      }
      case 'assistant/message': {
        const message = data.message as { content?: readonly { type: string; text?: string }[] } | undefined
        const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0) outcomes.push(text)
        break
      }
      case 'tool/call': {
        toolCallCount += 1
        const name = typeof data.name === 'string' ? data.name : '?'
        actions.push(`调用 ${name}`)
        // Self-reflexive detection: a tool call whose arguments plausibly kill
        // the agent's own host (process termination / service restart). The
        // causal chain AFTER this call is unobservable from this ledger —
        // whatever "restarted the service" did was done by something outside
        // this session, so the reconstructed action may be speculative.
        if (selfReflexiveArguments(name, typeof data.arguments === 'string' ? data.arguments : '')) {
          selfReflexive = true
        }
        break
      }
      case 'tool/result': {
        // Failure lives on the result message's content blocks, not on the
        // event payload itself.
        const message = data.message as { content?: readonly { isError?: boolean }[] } | undefined
        if (message?.content?.some(block => block.isError === true) === true || data.error !== undefined) failed = true
        break
      }
      default:
        break
    }
  }
  const reason = (endEvent.data as { reason?: { kind?: string } }).reason?.kind ?? 'unknown'
  const outcome = [...outcomes, `轮次结束（${reason}）`].join(' ').trim()
  return {
    situation: texts.reverse().join(' ').slice(0, 800),
    action: actions.reverse().join('；').slice(0, 800) || outcome.slice(0, 300),
    outcome: outcome.slice(0, 800),
    outcomeFull: outcome,
    toolCallCount,
    failed,
    turnId: turn,
    selfReflexive,
  }
}

/**
 * Whether a reconstructed turn carries real assistant text, as opposed to only
 * the synthetic `轮次结束（reason）` marker {@link reconstructTurn} appends.
 * cl-100: citation settlement is only meaningful when the model actually spoke.
 * @param outcome - the reconstructed outcome text.
 * @param reason - the turn/end reason kind.
 * @returns true when the outcome contains more than the end marker.
 */
function hasAssistantText(outcome: string, reason: string | undefined): boolean {
  return outcome.replace(`轮次结束（${reason ?? 'unknown'}）`, '').trim().length > 0
}

/** Whether one tool call plausibly terminates or restarts the agent's own host
 * process — the self-reflexive operations after which this session's ledger
 * cannot observe what actually happened (the causal chain is broken at the
 * kill point; any later "restart" was done by an external actor). Checks the
 * tool arguments (the JSON string) for process-termination signatures, since
 * the tool NAME alone (e.g. `pwsh`) is shared with countless benign calls. */
function selfReflexiveArguments(name: string, argumentsJson: string): boolean {
  if (name === 'pwsh' || name === 'shell' || name === 'bash') {
    return /Stop-Process|kill\b|taskkill|net stop|restart.*service|Restart-|sc stop/i.test(argumentsJson)
  }
  return /(^|_)(stop|kill|restart|terminate)(_|$)/i.test(name)
}

/**
 * Mount the pipeline: construct the service (its `Service` base registers
 * `ctx.cognitivePipeline` on this fiber's context), wait for the store, then
 * register the dynamic taxonomy prompt section and (unless disabled) the
 * model tools. When `autoAccumulate` is enabled, also listen for completed
 * turns and run each through the accumulation gate.
 * @param ctx - plugin context carrying llm/tools/systemPrompt.
 * @param config - pipeline configuration; every field optional.
 */
export async function apply(ctx: Context, config: CognitivePipelineConfig = {}): Promise<void> {
  const service = new CognitivePipelineService(ctx, config)
  await service.ready()

  ctx.systemPrompt.section({
    name: 'cognition:taxonomy',
    order: 300,
    text: () => service.taxonomyPrefix(),
  })

  if (service.resolved.enabled) {
    registerPipelineTools(ctx, service)
  }

  // cl-062: 自主回合预测闭环。用户离场时, predict_outcome 的唯一调用者是模型自己,
  // 于是校准尺与精排 A/B 样本双双冻结(实测 09-09 白天 A 组只有 1 条)。这里在 pre-step
  // 判定"本轮是否为自主回合", 是则自动创建一条预测(问的是"本轮会产出落盘产物吗"),
  // 并在 turn/end 用客观产物指纹结算——预测不再依赖模型是否想起来调用工具。
  const pendingAutonomous = new Map<string, { predictionId: string; before: string; sessionId: string; createdAt: number }>()
  const lastAutonomousAt = new Map<string, number>()
  /** 结算一条自主预测: 产物指纹变了=该回合真的落盘了东西。 */
  const settleAutonomous = (key: string): void => {
    const pending = pendingAutonomous.get(key)
    if (pending === undefined) return
    pendingAutonomous.delete(key)
    void artifactFingerprint().then((after) => {
      const produced = after !== pending.before
      return service.report({
        predictionId: pending.predictionId,
        actualOutcome: produced
          ? '本轮产出落盘产物（账本/脚本/草稿等受监视路径的 mtime 或体积发生变化）'
          : '本轮无落盘产物（受监视路径指纹未变）',
        outcomeQuality: produced ? 8 : 3,
      }, { sessionId: pending.sessionId as never })
    }).catch((error: unknown) => {
      ctx.logger.warn(`cognitive-pipeline: autonomous prediction feedback failed: ${String(error)}`)
    })
  }
  /** cl-081: 兜底扫描——turn/end 可能缺失(实测 quiet-frame 子会话 17:01 建了预测却无 turn/end
   * 事件, 预测永久悬空), 所以任何一次 pre-step 都顺手结算超龄未结算项。 */
  const AUTONOMOUS_SETTLE_TTL_MS = 10 * 60 * 1000
  /** 跨进程兜底: 扫账本里超龄未结算的自主预测(重启会清空内存 map, 只靠内存永远补不上)。 */
  const sweepStaleFromStore = (): void => {
    const now = Date.now()
    for (const prediction of service.store.predictionsSnapshot()) {
      if (!prediction.situation.startsWith('自主回合')) continue
      if (prediction.actualOutcome !== null) continue
      if (now - prediction.timestamp < AUTONOMOUS_SETTLE_TTL_MS) continue
      void service.report({
        predictionId: prediction.predictionId,
        actualOutcome: '无法判定（该回合结算机制当时缺失/进程重启，产物指纹未采集）',
        outcomeQuality: 5,
      }, {}).catch(() => undefined)
    }
  }
  let lastStaleSweepAt = 0
  const sweepAutonomous = (): void => {
    const now = Date.now()
    for (const [key, pending] of pendingAutonomous) {
      if (now - pending.createdAt >= AUTONOMOUS_SETTLE_TTL_MS) settleAutonomous(key)
    }
    if (now - lastStaleSweepAt > AUTONOMOUS_SETTLE_TTL_MS) {
      lastStaleSweepAt = now
      sweepStaleFromStore()
    }
  }
  if (service.resolved.autonomousPrediction) sweepStaleFromStore()
  if (service.resolved.autonomousPrediction) {
    ctx.on('agent/pre-step', async (
      { agent, messages: stepMessages }: { agent: Agent; messages: UserMessage[] },
      next: () => Promise<PreStepDecision>,
    ) => {
      const decision = await next()
      sweepAutonomous()
      const frame = autonomousFrame(stepMessages)
      if (frame === undefined) return decision
      const session = agent.session
      const key = String(session.id)
      if (pendingAutonomous.has(key)) return decision
      const last = lastAutonomousAt.get(key) ?? 0
      if (Date.now() - last < service.resolved.autonomousPredictionCooldownMs) return decision
      try {
        const before = await artifactFingerprint()
        const action = /nextAction[:：]\s*([^\n]{1,300})/.exec(frame)?.[1]?.trim()
          ?? frame.slice(0, 300)
        const result = await service.predict({
          situation: `自主回合(无用户在场)｜帧指示: ${frame.slice(0, 400)}`,
          action: `执行该帧的下一步并落盘产物: ${action}`,
        }, { sessionId: session.id })
        pendingAutonomous.set(key, {
          predictionId: result.predictionId, before, sessionId: String(session.id), createdAt: Date.now(),
        })
        lastAutonomousAt.set(key, Date.now())
      } catch (error) {
        ctx.logger.warn(`cognitive-pipeline: autonomous prediction failed: ${String(error)}`)
      }
      return decision
    })
  }

  // Completed-turn cognition activity: settle the turn's injection citations
  // (unconditionally — the jump-weight reinforcement loop depends on it),
  // accumulate the episode when autoAccumulate is on, and surface the summary
  // to the GUI as a cognition/turn-summary event when the turn produced
  // activity (a quiet turn appends nothing).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    // cl-062: 自主回合预测结算——放在原因过滤**之前**: 无论回合以什么原因结束
    // (completed/error/interrupted/...), 产物指纹都能判定"这一轮有没有落盘东西"。
    settleAutonomous(String(session.id))
    const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
    if (reason !== 'completed' && reason !== 'error') {
      // cl-100: 中断/中止的回合此前完全不结算——只要模型产出了文本, 引用判定
      // 就该发生(否则该回合的注入只能等 24h TTL 按"未引用"结账)。
      const partial = reconstructTurn(session, event)
      if (hasAssistantText(partial.outcome, reason)) {
        void service.summarizeTurn(session.id, partial, { accumulate: false }).catch((error: unknown) => {
          ctx.logger.warn(`cognitive-pipeline: partial turn settlement failed: ${String(error)}`)
        })
      }
      return
    }
    const episode = reconstructTurn(session, event)
    // cl-100: 帧回合(自主回合)没有 source.kind==='user' 的用户消息, 旧逻辑在
    // `situation` 为空时直接 return, 于是帧回合的注入永不结算——实测 09-09 起
    // 105 条注入只产生 11 次结算, 其余滞留到 TTL 按"未引用"结账。结算只看
    // assistant 产出文本, 与"有没有真实用户输入"无关; 只有累计成经验才需要。
    const hasUser = episode.situation.trim().length > 0
    if (!hasUser && !hasAssistantText(episode.outcome, reason)) return
    void service.summarizeTurn(session.id, episode, { accumulate: hasUser }).then((summary) => {
      if (summary !== null) session.append('cognition/turn-summary', summary)
    }).catch((error: unknown) => {
      ctx.logger.warn(`cognitive-pipeline: turn summary failed: ${String(error)}`)
    })
  })

  // Memory-anchored compaction write-back: when context compaction folds a
  // long arc into one summary (`compaction/summary`), the summarized arc is
  // worth at most one GATED experience — the durable lesson of the whole
  // evicted range — fed through the same accumulation gate as completed
  // turns. Only runs under auto-accumulation (the operator has opted into
  // automatic experience writes), and the gate itself decides worth; a
  // rejected summary writes nothing. Idempotent per compaction id.
  if (service.resolved.autoAccumulate) {
    const handledCompactions = new Set<string>()
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      // The compaction/* event vocabulary lives in @deepseek-ai/dsh-compaction
      // (declaration merge over dsh-session/types), which this package does
      // not depend on; read the contractual shape structurally instead.
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
      void service.accumulateTurn({
        situation: '（会话长弧段被上下文压缩）',
        action: '上下文压缩把一段长对话弧段折叠为摘要并写回记忆',
        outcome: summary.slice(0, 800),
        toolCallCount: 0,
        failed: false,
        turnId: 0,
        selfReflexive: false,
      }, { sessionId: session.id }).catch((error: unknown) => {
        ctx.logger.warn(`cognitive-pipeline: compaction accumulation failed: ${String(error)}`)
      })
    })
  }
}
