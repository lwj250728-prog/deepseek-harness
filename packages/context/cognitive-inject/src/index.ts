/**
 * Step-level SAR experience priming for the cognitive pipeline. At every
 * agent pre-step it extracts the current situation from the messages about to
 * enter the model request, retrieves situation-related experiences from the
 * pipeline store, and injects the closest hits as reference context. After a
 * failed step it recalls more aggressively — the "memory chaining" analogue:
 * a failure is the strongest situation cue, so the previous setback surfaces
 * related past experience for faster matching on the retry step.
 *
 * Injection rides the same mechanism as other pre-step context plugins: the
 * reference block is folded into the step's `decision.messages`, so the agent
 * loop appends it as a durable `user/message` event — model-visible and logged
 * together, per the "model-visible ⟺ logged" invariant.
 *
 * @module @deepseek-ai/dsh-cognitive-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  actionVector,
  cosine,
  isTaskRestatement,
  outcomePolarity,
  reconstructTurn,
  refineRetrieval,
  symptomOverlap,
  tokenize,
} from '@deepseek-ai/dsh-cognitive-pipeline'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import type { OutcomePolarity, SolidifiedStrategy } from '@deepseek-ai/dsh-cognitive-pipeline'
import {
  DERIVED_TRIGGER_MIN,
  deriveTriggerWords,
  STATIC_TRIGGERS,
} from '@deepseek-ai/dsh-cognitive-pipeline/src/triggers.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics and message sources. */
export const name = 'cognitive-inject'

/** Services required before the plugin can mount. */
export const inject = ['agents', 'cognitivePipeline', 'llm', 'tools']

/** Plugin configuration (all fields optional; conservative defaults). */
export interface Config {
  /** How many related experiences to inject at most (default 1). */
  topK?: number
  /** Minimum situation-vector similarity to consider a memory related (default 0.4). */
  minSimilarity?: number
  /** After a failed step, multiply minSimilarity by this factor (default 0.6). */
  failureThresholdFactor?: number
  /** After a failed step, how many experiences to inject at most (default 3). */
  failureTopK?: number
  /** How many trailing message blocks feed the situation extraction (default 4). */
  contextDepth?: number
  /** False disables injection while keeping the listener mounted (default true). */
  enabled?: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  topK: z.number().step(1).min(1).max(10).default(1),
  minSimilarity: z.number().min(0).max(1).default(0.4),
  failureThresholdFactor: z.number().min(0).max(1).default(0.6),
  failureTopK: z.number().step(1).min(1).max(10).default(3),
  contextDepth: z.number().step(1).min(1).max(20).default(4),
  enabled: z.boolean().default(true),
})

/** Resolved configuration with every optional field materialized. */
export interface ResolvedConfig {
  readonly topK: number
  readonly minSimilarity: number
  readonly failureThresholdFactor: number
  readonly failureTopK: number
  readonly contextDepth: number
  readonly enabled: boolean
}

/** Resolve the plugin configuration.
 * @param config - partial configuration.
 * @returns the resolved immutable configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    topK: config.topK ?? 1,
    minSimilarity: config.minSimilarity ?? 0.4,
    failureThresholdFactor: config.failureThresholdFactor ?? 0.6,
    failureTopK: config.failureTopK ?? 3,
    contextDepth: config.contextDepth ?? 4,
    enabled: config.enabled ?? true,
  })
}

/** One retrieved experience hit for injection. */
export interface ExperienceHit {
  readonly expId: string
  readonly text: string
  readonly similarity: number
  /** True when the source experience records a self-reflexive operation (the
   * agent killed/restarted its own host): its action may be speculative and
   * must not be trusted as fact without external witnessing. */
  readonly selfReflexive?: boolean
}

/** Extract the last text block of one user message, if any. */
function textOf(message: UserMessage): string {
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

/** Collect the trailing text blocks of the messages entering this step. */
function situationText(messages: readonly UserMessage[], depth: number): string {
  const blocks = messages
    .flatMap(message => textOf(message) === '' ? [] : [textOf(message)])
  return blocks.slice(-depth).join(' ')
}

/** The per-agent most recent tool outcome: true when the last tool result was a failure. */
const lastFailed = new WeakMap<Agent, boolean>()

/** Rolling prewarm context per session: a bounded summary of what the session
 * has been DOING recently (tool calls, assistant output), used to enrich the
 * veto-gate situation so a short message's literal overlap with an unrelated
 * experience can be judged against the real ongoing context. */
const prewarmContext = new WeakMap<Session, string>()

/** How many prewarm entries a session keeps before trimming the oldest. */
const PREWARM_MAX_ENTRIES = 6
/** How long one prewarm entry may be (truncated to bound memory). */
const PREWARM_ENTRY_MAX = 120

/**
 * Fold one session event into the session's prewarm context: a tool call
 * appends "调用了 X", an assistant message appends its first text block
 * (truncated). The summary is bounded — oldest entries drop first — so it
 * stays a cheap rolling "what are we doing" window.
 * @param prewarm - the per-session map.
 * @param session - the session the event belongs to.
 * @param event - the event to fold.
 */
function updatePrewarm(
  prewarm: WeakMap<Session, string>,
  session: Session,
  event: SessionEvent,
): void {
  let entry: string | null = null
  const data = event as unknown as Record<string, unknown>
  switch (event.type) {
    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : '?'
      entry = `调用${name}`
      break
    }
    case 'assistant/message': {
      const message = data.message as { content?: readonly { type: string; text?: string }[] } | undefined
      const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
      if (text !== undefined && text.trim().length > 0) entry = text.trim().slice(0, PREWARM_ENTRY_MAX)
      break
    }
    default:
      return
  }
  if (entry === null) return
  const current = prewarm.get(session) ?? ''
  const entries = current.length === 0 ? [] : current.split('｜')
  entries.push(entry)
  const trimmed = entries.slice(-PREWARM_MAX_ENTRIES)
  prewarm.set(session, trimmed.join('｜'))
}

/**
 * How much a failure-signature overlap may add on top of the semantic cosine,
 * scaled by the semantic score itself: a literal "失败" match sharpens recall
 * only for experiences that are already semantically relevant, so an unrelated
 * experience (measured: semantic 0.11) can never be dragged across the
 * threshold by the marker alone.
 */
const SYMPTOM_BONUS = 0.3

/** Retrieve experiences related to the current situation on both axes. The
 * semantic axes (action/situation cosine) dominate; a failure-signature
 * overlap adds a capped bonus proportional to the semantic score, so the
 * current setback surfaces related past experience without letting literal
 * markers override relevance. */
/** One retrieved candidate with its outcome polarity (for viewpoint coverage). */
interface RankedHit extends ExperienceHit {
  readonly polarity: OutcomePolarity
}

/**
 * Retrieve experiences related to the current situation on both axes, then
 * guarantee **viewpoint coverage**: when both a failure and a success
 * experience clear the threshold, at least one of each is included — the
 * model sees both the cautionary tale (上次怎么栽的) and the workable
 * approach (成功时怎么做的), not just the single most similar memory. The
 * semantic axes (action/situation cosine) dominate; a failure-signature
 * overlap adds a capped bonus proportional to the semantic score, so the
 * current setback surfaces related past experience without letting literal
 * markers override relevance.
 */
function retrieve(
  service: CognitivePipelineService,
  situation: string,
  minSimilarity: number,
  topK: number,
): readonly RankedHit[] {
  const vector = actionVector(situation, [])
  const hits = service.store.experiencesSnapshot()
    .filter(exp => !isTaskRestatement(exp))
    .map((exp): RankedHit => {
      const text = `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
      const semantic = Math.max(
        cosine(vector, exp.actionVector),
        cosine(vector, actionVector(exp.sar.situation, [])),
      )
      return {
        expId: exp.expId,
        text,
        polarity: outcomePolarity(exp.sar.outcomeUtility),
        similarity: semantic + symptomOverlap(situation, text) * SYMPTOM_BONUS * semantic,
        ...exp.selfReflexive === true ? { selfReflexive: true } : {},
      }
    })
    .filter(hit => hit.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
  return coverViewpoints(hits, topK)
}

/**
 * Enforce viewpoint coverage over the ranked candidates: when the set holds
 * both a negative (failure) and a positive (success) experience, keep the
 * highest-scoring one of each plus the next best to fill `topK` (floor 2).
 * Otherwise the top-K ranking is returned unchanged — coverage only reshapes
 * when both viewpoints genuinely exist.
 * @param hits - ranked candidates, best first.
 * @param topK - how many experiences to inject at most.
 * @returns the covered selection, best first.
 */
function coverViewpoints(hits: readonly RankedHit[], topK: number): readonly RankedHit[] {
  const failure = hits.find(hit => hit.polarity === 'negative')
  const success = hits.find(hit => hit.polarity === 'positive')
  if (failure === undefined || success === undefined) return hits.slice(0, topK)
  const selected = new Map<string, RankedHit>()
  selected.set(failure.expId, failure)
  selected.set(success.expId, success)
  for (const hit of hits) {
    if (selected.size >= Math.max(topK, 2)) break
    if (!selected.has(hit.expId)) selected.set(hit.expId, hit)
  }
  return hits.filter(hit => selected.has(hit.expId))
}

/** Render one reference block from the retrieved hits. */
function referenceBlock(
  hits: readonly ExperienceHit[],
  afterFailure: boolean,
  rejectedNotes: readonly string[] = [],
): UserMessage {
  const lines = hits.map(hit =>
    `- [${hit.expId}] (相关度 ${hit.similarity.toFixed(2)})${hit.selfReflexive === true ? ' [自反操作：该经验ACTION未经外部见证，可能为推测]' : ''} ${hit.text}`)
  const preamble = afterFailure
    ? '【认知经验参考】上一步执行失败，以下历史经验可能与此相关，供排查借鉴（不要虚构为当前事实）：'
    : '【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：'
  const vetoNote = rejectedNotes.length > 0
    ? `\n（已否决 ${rejectedNotes.length} 条过阈值候选：${rejectedNotes.join('；')}）`
    : ''
  const text = `${preamble}\n${lines.join('\n')}${vetoNote}`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
  })
}

/** Whether the retrieved hits link to a solidified strategy for their goal
 * domain. A hit's experience carries a chainId; if that chain seeded a
 * solidified strategy, the strategy is the converged rule for this situation.
 * @param service - the pipeline service.
 * @param hits - the retrieved experiences.
 * @returns the solidified strategy, or undefined.
 */
function solidifiedStrategyForHits(
  service: CognitivePipelineService,
  hits: readonly ExperienceHit[],
  situation: string,
): SolidifiedStrategy | undefined {
  // Channel 1: a hit's experience carries a chainId; if that chain seeded a
  // solidified strategy, the strategy is the converged rule.
  const chainIds = new Set<string>()
  for (const hit of hits) {
    const exp = service.store.getExperience(hit.expId)
    if (exp?.chainId !== undefined) chainIds.add(exp.chainId)
  }
  if (chainIds.size > 0) {
    for (const strategy of service.solidifiedStrategies()) {
      if (strategy.sourceChainId !== '' && chainIds.has(strategy.sourceChainId)) return strategy
    }
  }
  // Channel 2: goal-domain matching. Legacy experiences (exp_100/101) were
  // accumulated BEFORE chain tagging, so they carry no chainId — but they are
  // the top hits for the task. When the situation text carries the strategy's
  // goal domain, the strategy still applies (the injection key is the domain,
  // not the chain link).
  for (const strategy of service.solidifiedStrategies()) {
    if (strategy.goalDomain.length > 0 && situation.includes(strategy.goalDomain)) return strategy
  }
  return undefined
}

/** Render a solidified strategy as a model-visible block: the converged rule
 * with its action, verification anchor (drift sensor), pre-checks, and the
 * current lifecycle state (so the executor knows whether it still holds). */
function strategyBlock(strategy: SolidifiedStrategy): UserMessage {
  const lines = [
    `【固化策略 ${strategy.goalDomain}】目标域的收敛路径（由 ${strategy.sourceChainId} 链反复成功固化）：`,
    `- 动作：${strategy.action}`,
    `- 验收锚点（环境漂移传感器）：${strategy.verificationAnchor}`,
    ...strategy.preChecks.length > 0 ? [`- 前置校验：${strategy.preChecks.join('；')}`] : [],
    `- 生命周期：已用 ${strategy.hitCount} 次 / 成功 ${strategy.positiveCount} / 失败 ${strategy.violatedCount}`,
    ...strategy.reworkNeeded ? ['- ⚠️ 偏离门已越过：该策略需重新学习，勿盲目沿用'] : [],
  ]
  const text = lines.join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
  })
}

/** Whether the agent's most recent tool result was a failure. */
function isAfterFailure(agent: Agent): boolean {
  return lastFailed.get(agent) === true
}

// ── trigger-gated injection ────────────────────────────────────────────────

/** Single static-trigger hit weight (a literal ask matches immediately). */
const STATIC_TRIGGER_WEIGHT = 1
/** Summed trigger weight (static, derived, or jump) needed to prime injection. */
const TRIGGER_MATCH_THRESHOLD = 0.6

/** One trigger verdict: whether the gate opened, the contributing trigger
 * source (for the injection record), and the jump words that contributed
 * (for citation-rate measurement). */
export interface TriggerVerdict {
  readonly fired: boolean
  readonly triggerSource: string
  readonly jumpWords: readonly string[]
}

/**
 * Whether the messages entering this step carry a trigger: a static behavior
 * word, a SAR-derived keyword from important experiences, or a learned jump
 * word (the associative layer — a message can open the gate through a
 * synonym variant of a trigger even when no literal trigger is present). The
 * trigger is the gate — retrieval only runs (and injects) when the current
 * situation is one where consulting past experience is actually useful.
 * Exported for tests and observability.
 * @param messages - the messages entering the step.
 * @param service - the pipeline service for the lexicons and jump table.
 * @param depth - how many trailing text blocks feed the check.
 * @returns the verdict with the fired trigger source and jump words.
 */
export function triggeredBy(
  messages: readonly UserMessage[],
  service: CognitivePipelineService,
  depth: number,
): TriggerVerdict {
  const text = situationText(messages, depth)
  if (text.trim().length === 0) return { fired: false, triggerSource: '', jumpWords: [] }
  let score = 0
  let source = ''
  // Static triggers are multi-character phrases; match them as substrings
  // (tokenize splits CJK per character, so token matching would never hit).
  for (const trigger of STATIC_TRIGGERS) {
    if (text.includes(trigger)) {
      score += STATIC_TRIGGER_WEIGHT
      if (source === '') source = `static:${trigger}`
      if (score >= TRIGGER_MATCH_THRESHOLD) return { fired: true, triggerSource: source, jumpWords: [] }
    }
  }
  const derived = deriveTriggerWords(service)
  for (const token of tokenize(text)) {
    const weight = derived.get(token)
    if (weight !== undefined && weight >= DERIVED_TRIGGER_MIN) {
      score += weight
      if (source === '') source = `derived:${token}`
      if (score >= TRIGGER_MATCH_THRESHOLD) return { fired: true, triggerSource: source, jumpWords: [] }
    }
  }
  // Jump route: associative words alone can open the gate. Jump words are
  // matched as substrings (single-char co-occurrence tokens and multi-char
  // LLM variants alike). Each jump's contribution is scaled
  // (triggerJumpWeightScale, default 0.5), so a single weak jump never opens
  // it alone — two jumps or a jump plus a direct hit do.
  const jumps = service.triggerJumps()
  const scale = service.resolved.triggerJumpWeightScale
  const hitJumps: string[] = []
  for (const jump of jumps) {
    if (!text.includes(jump.jumpWord)) continue
    hitJumps.push(jump.jumpWord)
    for (const entry of jump.triggers) {
      score += entry.weight * scale
      if (source === '') source = `jump:${jump.jumpWord}→${entry.trigger}`
      if (score >= TRIGGER_MATCH_THRESHOLD) return { fired: true, triggerSource: source, jumpWords: hitJumps }
    }
  }
  return { fired: false, triggerSource: '', jumpWords: [] }
}

/**
 * Mount the priming listener: retrieve at every pre-step, inject on hit,
 * recall more aggressively after a failed step.
 * @param ctx - context carrying agents, the pipeline service, and tools.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    if (exec.agent === undefined) return
    lastFailed.set(exec.agent, result.isError)
  })

  // Citation settlement: at turn end, the assistant text of the closed turn
  // decides whether the injection was actually used (an injected expId
  // referenced = cited). The outcome folds into the jump words that opened
  // the gate, feeding the jump-weight reinforcement loop.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // Prewarm context maintenance: keep a rolling summary of what this session
    // is actually DOING (recent tool calls, recent assistant output), so a
    // short message that triggers a literal-overlap false positive (the exp_67
    // case: "重启" matching exp_1 by surface words) can be judged by the LLM
    // veto route against the REAL ongoing context, not the isolated message.
    updatePrewarm(prewarmContext, session, event)
    if (event.type !== 'turn/end') return
    const episode = reconstructTurn(session, event)
    void ctx.cognitivePipeline.settleInjectionCitations(session.id, episode.outcome)
      .catch((error: unknown) => {
        ctx.logger.warn(`cognitive-inject: citation settlement failed: ${String(error)}`)
      })
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || messages.length === 0) return decision
    // Deferred settlement: a self-reflexive operation (e.g. restarting the
    // host) interrupts the turn, so the turn/end citation settlement never
    // fires — the injection stays pending (cited=null). Real memory settles
    // at later recall, not at the event: settle any still-pending injections
    // for this session against the CURRENT step's text (the "host recovered,
    // now I remember what I used" case — exp_190).
    const deferredText = situationText(decision.messages, resolved.contextDepth)
    if (deferredText.trim().length > 0) {
      void ctx.cognitivePipeline.settleInjectionCitations(agent.session.id, deferredText)
        .catch((error: unknown) => {
          ctx.logger.warn(`cognitive-inject: deferred citation settlement failed: ${String(error)}`)
        })
    }
    const afterFailure = isAfterFailure(agent)
    // Trigger gate: after a failed step always prime; otherwise only when the
    // current messages carry a trigger (static behavior word, a SAR-derived
    // keyword of important experiences, or a learned jump word). Routine
    // conversation never injects, even when retrieval would find a weak hit.
    const verdict = triggeredBy(decision.messages, ctx.cognitivePipeline, resolved.contextDepth)
    if (!afterFailure && !verdict.fired) return decision
    const threshold = afterFailure
      ? resolved.minSimilarity * resolved.failureThresholdFactor
      : resolved.minSimilarity
    const topK = afterFailure ? resolved.failureTopK : resolved.topK
    const situation = situationText(decision.messages, resolved.contextDepth)
    if (situation.trim().length === 0) return decision
    const hits = retrieve(ctx.cognitivePipeline, situation, threshold, topK)
    if (hits.length === 0) return decision
    // Prewarm enrichment for the veto gate: a short message ("重启") may match
    // an unrelated experience by surface words (exp_67's literal-overlap false
    // positive). The veto route judges applicability — so it must see what the
    // session is ACTUALLY doing, not the isolated message. The enriched
    // situation = [rolling prewarm] + current message.
    const prewarmed = prewarmContext.get(agent.session)
    const vetoSituation = prewarmed !== undefined && prewarmed.length > 0
      ? `【当前会话正在进行】${prewarmed}\n【当前消息】${situation}`
      : situation
    // Solidified-strategy priority: when the retrieved experiences link to a
    // chain that seeded a solidified strategy (the repeated-success promotion),
    // inject the STRATEGY — a short, machine-verifiable rule with a drift
    // sensor — instead of the scattered, unverified experiences. The strategy
    // is the converged form: it tells the executor exactly what to run and how
    // to check it worked, so the task converges instead of re-deriving each
    // time (the "restart DSH" case: exp_101's script, solidified).
    const strategy = solidifiedStrategyForHits(ctx.cognitivePipeline, hits, situation)
    if (strategy !== undefined) {
      const block = strategyBlock(strategy)
      ctx.cognitivePipeline.recordInjection({
        expIds: hits.map(hit => hit.expId),
        triggerSource: verdict.triggerSource,
        sessionId: agent.session.id,
        jumpWords: verdict.jumpWords,
        strategyId: strategy.strategyId,
      })
      return {
        kind: 'enter',
        messages: [...decision.messages, block],
      }
    }
    // Veto gate: retrieval may surface over-threshold candidates that do not
    // genuinely fit (a literal hit is not transferability). The template-7
    // refine route judges each candidate; every accepted one is injected
    // (viewpoint coverage survives), every rejection records a note, and
    // all-rejected suppresses injection. Without a route the route keeps the
    // candidates (deterministic degradation to the threshold-only behavior).
    const vetoed = await vetoTopCandidates(
      ctx, ctx.cognitivePipeline.resolved.route, vetoSituation, hits, signal,
    )
    if (vetoed.accepted.length === 0) return decision
    const block = referenceBlock(vetoed.accepted, afterFailure, vetoed.rejectedNotes)
    // Record the injection for citation-rate measurement: which expIds reached
    // the model, which trigger opened the gate, and which jump words (if any)
    // contributed — the durable trace behind the reinforcement loop.
    ctx.cognitivePipeline.recordInjection({
      expIds: vetoed.accepted.map(hit => hit.expId),
      triggerSource: verdict.triggerSource,
      sessionId: agent.session.id,
      jumpWords: verdict.jumpWords,
    })
    return {
      kind: 'enter',
      messages: [...decision.messages, block],
    }
  })
}

/**
 * How many over-threshold candidates may be vetoed before injection gives up.
 */
const INJECT_VETO_MAX = 2

/**
 * Run the template-7 refine route over the retrieved candidates and keep the
 * ones judged to genuinely apply. Each rejection records a note (visible in
 * the injected block for observability) and moves to the next candidate.
 * Viewpoint coverage survives the veto: ALL candidates the route accepts are
 * injected, not only the first — so a failure + success pair both reach the
 * model when both are judged transferable.
 * @param ctx - context carrying the llm service for the route call.
 * @param route - the pipeline's explicit LLM route (may be unset).
 * @param situation - the situation text to judge applicability against.
 * @param hits - the retrieved candidates, best first.
 * @param signal - cancellation signal for the route call.
 * @returns the accepted candidates plus the rejection notes (empty accepted
 * when every candidate was vetoed, or a route-free fallback keeps the ranking).
 */
async function vetoTopCandidates(
  ctx: Context,
  route: { provider?: string | undefined; model?: string | undefined },
  situation: string,
  hits: readonly ExperienceHit[],
  signal: AbortSignal | undefined,
): Promise<{ accepted: readonly ExperienceHit[]; rejectedNotes: string[] }> {
  const accepted: ExperienceHit[] = []
  const notes: string[] = []
  for (let index = 0; index < Math.min(hits.length, INJECT_VETO_MAX + 1); index += 1) {
    const hit = hits[index]
    if (hit === undefined) break
    const decision = await refineRetrieval(ctx, route, { situation, action: situation }, [{
      expId: hit.expId,
      text: hit.text,
      similarity: hit.similarity,
    }], { signal })
    if (decision.shouldKeep) {
      accepted.push(hit)
      continue
    }
    if (decision.reason !== null && decision.reason.length > 0) notes.push(decision.reason)
  }
  return { accepted, rejectedNotes: notes }
}
