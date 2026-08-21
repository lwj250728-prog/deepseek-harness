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
import { actionVector, cosine, refineRetrieval, symptomOverlap, tokenize } from '@deepseek-ai/dsh-cognitive-pipeline'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import type { Experience } from '@deepseek-ai/dsh-cognitive-pipeline'
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
function retrieve(
  service: CognitivePipelineService,
  situation: string,
  minSimilarity: number,
  topK: number,
): readonly ExperienceHit[] {
  const vector = actionVector(situation, [])
  return service.store.experiencesSnapshot()
    .map((exp) => {
      const text = `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
      const semantic = Math.max(
        cosine(vector, exp.actionVector),
        cosine(vector, actionVector(exp.sar.situation, [])),
      )
      return {
        expId: exp.expId,
        text,
        similarity: semantic + symptomOverlap(situation, text) * SYMPTOM_BONUS * semantic,
      }
    })
    .filter(hit => hit.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
}

/** Render one reference block from the retrieved hits. */
function referenceBlock(
  hits: readonly ExperienceHit[],
  afterFailure: boolean,
  rejectedNotes: readonly string[] = [],
): UserMessage {
  const lines = hits.map(hit => `- [${hit.expId}] (相关度 ${hit.similarity.toFixed(2)}) ${hit.text}`)
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

/** Whether the agent's most recent tool result was a failure. */
function isAfterFailure(agent: Agent): boolean {
  return lastFailed.get(agent) === true
}

// ── trigger-gated injection ────────────────────────────────────────────────

/**
 * Static behavior triggers: words whose presence means the current message is
 * asking for help, exploring, or deciding — the situations where humans
 * actually consult past experience. A single static hit triggers injection.
 */
const STATIC_TRIGGERS = new Set([
  '失败', '报错', '错误', '卡住', '挂起', '超时', '崩溃', '异常', '排查', '修复', '恢复',
  '怎么', '如何', '怎样', '为什么', '试试', '尝试', '测试', '验证', '确认',
  '风险', '危险', '慎重', '谨慎', '建议', '推荐', '帮助', '求助',
  '以前', '之前', '曾经', '上次', '遇到过', '经验', '参考', '回忆', '记得',
  '发布', '部署', '上线', '推送', '提交', '合并', '迁移', '升级', '安装', '配置',
  '计划', '打算', '准备', '决定', '方案', '步骤', '流程', '检查', '诊断',
])

/** CJK stop words: tokens too common to carry trigger signal. */
const STOP_WORDS = new Set([
  '的', '了', '在', '和', '我', '你', '他', '她', '它', '是', '一', '个', '这', '那',
  '到', '就', '都', '也', '要', '会', '能', '与', '及', '或', '有', '对', '从', '被',
  '把', '让', '用', '以', '为', '上', '下', '中', '不', '没', '很', '太', '再', '又',
  '吗', '呢', '吧', '啊', '的', '地', '得', '等', '并', '而', '但', '如果', '然后',
])

/** Single static-trigger hit weight (a literal ask matches immediately). */
const STATIC_TRIGGER_WEIGHT = 1
/** Summed trigger weight (static or derived) needed to prime injection. */
const TRIGGER_MATCH_THRESHOLD = 0.6
/** How many SAR-derived trigger words to keep (by accumulated importance). */
const DERIVED_TRIGGER_COUNT = 60
/** Minimum derived-trigger weight to count as a hit. */
const DERIVED_TRIGGER_MIN = 0.3

/**
 * Importance of one experience for trigger learning: outcome extremity
 * (|utilityScore|/15) plus a high-risk bonus for negative outcomes and a
 * frequency bonus for experiences the hot loop has hit before. Experiences
 * with no signal (neutral utility, never hit) contribute nothing.
 * @param exp - the experience.
 * @returns the importance in [0, 1.2].
 */
function importanceOf(exp: Experience): number {
  const { materialGain: gain, emotionalValence: valence, energyCost: cost } = exp.sar.outcomeUtility
  const utility = Math.abs((gain - 5) + (valence - 5) - (cost - 5)) / 15
  if (utility < 0.01 && exp.hitCount === 0 && (gain >= 5 && valence >= 5 && cost <= 5)) return 0
  const risk = gain < 5 ? 0.3 : 0
  const frequency = exp.hitCount > 0 ? Math.min(exp.hitCount, 5) * 0.1 : 0
  return utility + risk + frequency
}

/**
 * Derive the trigger lexicon from the experience store: tokens of the
 * situation/action of important experiences (high utility, high-risk, or
 * frequently hit) accumulate their importance into per-token weights, the
 * top-N survive, normalized to [DERIVED_TRIGGER_MIN, 1].
 * @param service - the pipeline service whose store feeds the lexicon.
 * @returns the derived trigger map (token → weight).
 */
function deriveTriggerWords(service: CognitivePipelineService): Map<string, number> {
  const weights = new Map<string, number>()
  for (const exp of service.store.experiencesSnapshot()) {
    const importance = importanceOf(exp)
    if (importance <= 0) continue
    const tokens = new Set([
      ...tokenize(exp.sar.situation),
      ...tokenize(exp.sar.action),
    ])
    for (const token of tokens) {
      if (STOP_WORDS.has(token) || STATIC_TRIGGERS.has(token)) continue
      weights.set(token, (weights.get(token) ?? 0) + importance)
    }
  }
  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DERIVED_TRIGGER_COUNT)
  const max = ranked[0]?.[1] ?? 0
  if (max <= 0) return new Map()
  const span = 1 - DERIVED_TRIGGER_MIN
  return new Map(ranked.map(([token, weight]) => [token, DERIVED_TRIGGER_MIN + (weight / max) * span]))
}

/**
 * Whether the messages entering this step carry a trigger: a static behavior
 * word or a SAR-derived keyword from important experiences. The trigger is
 * the gate — retrieval only runs (and injects) when the current situation is
 * one where consulting past experience is actually useful.
 * @param messages - the messages entering the step.
 * @param service - the pipeline service for the derived lexicon.
 * @param depth - how many trailing text blocks feed the check.
 * @returns true when the trigger weight sum clears the threshold.
 */
function triggeredBy(
  messages: readonly UserMessage[],
  service: CognitivePipelineService,
  depth: number,
): boolean {
  const text = situationText(messages, depth)
  if (text.trim().length === 0) return false
  let score = 0
  // Static triggers are multi-character phrases; match them as substrings
  // (tokenize splits CJK per character, so token matching would never hit).
  for (const trigger of STATIC_TRIGGERS) {
    if (text.includes(trigger)) {
      score += STATIC_TRIGGER_WEIGHT
      if (score >= TRIGGER_MATCH_THRESHOLD) return true
    }
  }
  const derived = deriveTriggerWords(service)
  for (const token of tokenize(text)) {
    const weight = derived.get(token)
    if (weight !== undefined && weight >= DERIVED_TRIGGER_MIN) {
      score += weight
      if (score >= TRIGGER_MATCH_THRESHOLD) return true
    }
  }
  return false
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

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || messages.length === 0) return decision
    const afterFailure = isAfterFailure(agent)
    // Trigger gate: after a failed step always prime; otherwise only when the
    // current messages carry a trigger (static behavior word or a SAR-derived
    // keyword of important experiences). Routine conversation never injects,
    // even when retrieval would find a literal (weak) hit.
    if (!afterFailure && !triggeredBy(decision.messages, ctx.cognitivePipeline, resolved.contextDepth)) {
      return decision
    }
    const threshold = afterFailure
      ? resolved.minSimilarity * resolved.failureThresholdFactor
      : resolved.minSimilarity
    const topK = afterFailure ? resolved.failureTopK : resolved.topK
    const situation = situationText(decision.messages, resolved.contextDepth)
    if (situation.trim().length === 0) return decision
    const hits = retrieve(ctx.cognitivePipeline, situation, threshold, topK)
    if (hits.length === 0) return decision
    // Veto gate: retrieval may surface an over-threshold candidate that does
    // not genuinely fit (a literal hit is not transferability). The template-7
    // refine route judges whether the top candidate truly applies; each
    // rejection moves to the next candidate (bounded), and all-rejected
    // suppresses injection. Without a route the route keeps the candidate
    // (deterministic degradation to the threshold-only behavior).
    const vetoed = await vetoTopCandidates(
      ctx, ctx.cognitivePipeline.resolved.route, situation, hits, signal,
    )
    if (vetoed.accepted === null) return decision
    const block = referenceBlock([vetoed.accepted], afterFailure, vetoed.rejectedNotes)
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
 * Run the template-7 refine route over the retrieved candidates and pick the
 * first one judged to genuinely apply. Each rejection records a note (visible
 * in the injected block for observability) and moves to the next candidate.
 * @param ctx - context carrying the llm service for the route call.
 * @param route - the pipeline's explicit LLM route (may be unset).
 * @param situation - the situation text to judge applicability against.
 * @param hits - the retrieved candidates, best first.
 * @returns the accepted candidate plus the rejection notes, or accepted null
 * when every candidate was vetoed (or a route-free fallback keeps the first).
 */
async function vetoTopCandidates(
  ctx: Context,
  route: { provider?: string | undefined; model?: string | undefined },
  situation: string,
  hits: readonly ExperienceHit[],
  signal: AbortSignal | undefined,
): Promise<{ accepted: ExperienceHit | null; rejectedNotes: string[] }> {
  const notes: string[] = []
  for (let index = 0; index < Math.min(hits.length, INJECT_VETO_MAX + 1); index += 1) {
    const hit = hits[index]
    if (hit === undefined) break
    const decision = await refineRetrieval(ctx, route, { situation, action: situation }, [{
      expId: hit.expId,
      text: hit.text,
      similarity: hit.similarity,
    }], { signal })
    if (decision.shouldKeep) return { accepted: hit, rejectedNotes: notes }
    if (decision.reason !== null && decision.reason.length > 0) notes.push(decision.reason)
  }
  return { accepted: null, rejectedNotes: notes }
}
