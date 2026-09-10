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

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  actionVector,
  cosine,
  isSelfFrameExperience,
  isTaskRestatement,
  outcomePolarity,
  refineRetrieval,
  situationVector,
  symptomOverlap,
} from '@deepseek-ai/dsh-cognitive-pipeline'
import { admitLeastBackedOff, backoffState } from './inject-backoff.ts'
import type { PriorInjection } from './inject-backoff.ts'
import { classifyTurnKind, decideInjection } from './turn-kind.ts'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import type { Experience, OutcomePolarity, SolidifiedStrategy } from '@deepseek-ai/dsh-cognitive-pipeline'
import {
  DERIVED_TRIGGER_MIN,
  deriveTriggerWords,
  jumpVocabulary,
  STATIC_TRIGGERS,
  STRONG_STATIC_TRIGGERS,
  STRONG_STATIC_WEIGHT,
  WEAK_STATIC_WEIGHT,
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
  /** Same-session cooldown: an experience injected into this session within
   * the last `injectCooldownMs` is not injected again (default 10 min). Repeats
   * of the same memory in one session are noise, not recall — the measured
   * adoption collapse came with exp_1 injected 13×, exp_303 9× (cold-domain
   * finding #3). 0 disables the cooldown. */
  injectCooldownMs?: number
  /** Situation-driven gate: a retrieval hit whose top similarity clears this
   * threshold opens the gate WITHOUT any trigger word — the situation itself
   * is the recall cue. Calibrated per retrieval space (finding #13):
   * hash-bag cosine → 0.45 (business med 0.419, chitchat p75 0.362);
   * embedding cosine (bge-m3) → 0.5 (business med 0.651, chitchat med 0.470,
   * business min 0.455). Lower than minSimilarity is meaningless. */
  directSimilarityThreshold?: number
  /** cl-121: 覆盖选择的新颖性 margin——分数差在此范围内的候选, 优先选本会话注入次数
   *  更少的那个(保持"失败+成功"对照结构但轮换成员)。0 = 关闭(退回纯分数选择)。 */
  noveltyMargin?: number
  /** cl-118: 经验退避的冷却上限(默认 2h; 6h 实测会把通道整体静默)。未引用连击越多冷却越长(×2^k), 到此封顶;
   *  观察期若发现"绝对采纳数归零", 需要回调的就是这个值——所以它必须是配置而非硬编码。 */
  backoffMaxMs?: number
  /** cl-116: 回合类型闸门总开关(默认 false)。 */
  enableTurnGating?: boolean
  /** cl-114: 会话回合数达到此值即视为"已建立"(上下文已稀释)——反思类帧不再注入。
   *  注意: cl-116 证伪了它的立项依据, 故总开关默认关闭。默认 20。 */
  establishedSessionTurns?: number
  /** cl-114: 行动帧(已建立会话内)的额外相似度余量——该类别采纳率 2.0%, 不该按
   *  用户回合的宽松度放行。默认 0.08。 */
  actionFrameMarginBoost?: number
  /** Soft trigger boost: when a trigger word (static/derived/jump) fires, the
   * top similarity is boosted by this amount before the gate check. Calibrated
   * with the embedding space: 0.15 lifts a near-miss business hit (e.g. 0.455
   * → 0.605) while a chitchat + trigger stays below a boosted threshold.
   * In the hash space 0.3 was used; the embedding space needs less because
   * scores sit higher. */
  triggerBoost?: number
  /** Opt-in main-session pre-input review: before the main model answers a
   * genuine user input, a review subagent analyzes the retrieved past
   * experience and the synthesized analysis is injected into the main
   * conversation instead of (on top of nothing else) the raw experience
   * blocks. When the review is skipped or fails, the raw blocks inject as
   * today. See {@link ReviewConfig}. */
  review?: ReviewConfig
}

/** Pre-input review sub-configuration. */
export interface ReviewConfig {
  /** True enables the review path (default false). */
  enabled?: boolean
  /** Subagent provider to run the review child through (default 'spawn' —
   * the plain in-process spawn; the child prompt itself carries the
   * retrieved experiences, so no SAR wrapper is required). */
  provider?: string
  /** Genuine user text shorter than this skips the review (default 60). */
  minTextChars?: number
  /** Milliseconds after one review before the next may run for the same
   * session (default 120_000). */
  cooldownMs?: number
  /** Hard cap for one review run; the review is abandoned on expiry and the
   * raw blocks inject (default 45_000). */
  timeoutMs?: number
  /** How many retrieved experiences the review prompt may cite (default 3). */
  maxHits?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  topK: z.number().step(1).min(1).max(10).default(1),
  minSimilarity: z.number().min(0).max(1).default(0.4),
  failureThresholdFactor: z.number().min(0).max(1).default(0.6),
  failureTopK: z.number().step(1).min(1).max(10).default(3),
  contextDepth: z.number().step(1).min(1).max(20).default(4),
  enabled: z.boolean().default(true),
  injectCooldownMs: z.number().min(0).default(10 * 60 * 1000),
  directSimilarityThreshold: z.number().min(0).max(1).default(0.5),
  /** cl-116: 回合类型闸门总开关。默认**关闭**——cl-114 的立项依据(反思类帧 0/501)
   *  出自 cl-100 修复(04:58)之前的结算账本, 而那段时间帧回合的引用从未被结算(全部
   *  记为 false); 用修复后的干净窗口重测: 反思类帧 18 条注入 / 1 采纳 = 5.6%, 与用户
   *  回合 5.2% 同级 => "关掉死重"的前提不成立, 闸门只会削减绝对采纳数。重新启用需要:
   *  修复后窗口样本 >=100 且反思类帧采纳率显著低于其它类别。 */
  noveltyMargin: z.number().min(0).max(1).default(0.05),
  backoffMaxMs: z.number().min(0).default(2 * 60 * 60 * 1000),
  enableTurnGating: z.boolean().default(false),
  /** cl-114: 会话回合数达到此值即视为"已建立"(上下文稀释): 反思类帧不再注入。 */
  establishedSessionTurns: z.number().step(1).min(1).default(20),
  /** cl-114: 行动帧(已建立会话内)的额外相似度余量, 只有更贴的经验才注入。 */
  actionFrameMarginBoost: z.number().min(0).max(1).default(0.08),
  triggerBoost: z.number().min(0).max(1).default(0.15),
  review: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default('spawn'),
    minTextChars: z.number().step(1).min(1).default(60),
    cooldownMs: z.number().min(0).default(120_000),
    timeoutMs: z.number().min(1000).default(45_000),
    maxHits: z.number().step(1).min(1).max(10).default(3),
  }),
})

/** Resolved configuration with every optional field materialized. */
export interface ResolvedConfig {
  readonly topK: number
  readonly minSimilarity: number
  readonly failureThresholdFactor: number
  readonly failureTopK: number
  readonly contextDepth: number
  readonly enabled: boolean
  readonly injectCooldownMs: number
  readonly directSimilarityThreshold: number
  /** cl-121: 覆盖选择的新颖性 margin。 */
  readonly noveltyMargin: number
  /** cl-118: 经验退避的冷却上限。 */
  readonly backoffMaxMs: number
  /** cl-116: 回合类型闸门总开关(默认关闭, 详见 Config 注释)。 */
  readonly enableTurnGating: boolean
  /** cl-114: 会话回合数达到此值即视为已建立(反思类帧不再注入)。 */
  readonly establishedSessionTurns: number
  /** cl-114: 行动帧的额外相似度余量。 */
  readonly actionFrameMarginBoost: number
  readonly triggerBoost: number
  readonly review: ResolvedReviewConfig
}

/** Resolved pre-input review configuration. */
export interface ResolvedReviewConfig {
  readonly enabled: boolean
  readonly provider: string
  readonly minTextChars: number
  readonly cooldownMs: number
  readonly timeoutMs: number
  readonly maxHits: number
}

/** Resolve the plugin configuration.
 * @param config - partial configuration.
 * @returns the resolved immutable configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const review = config.review ?? {}
  return Object.freeze({
    topK: config.topK ?? 1,
    minSimilarity: config.minSimilarity ?? 0.4,
    failureThresholdFactor: config.failureThresholdFactor ?? 0.6,
    failureTopK: config.failureTopK ?? 3,
    contextDepth: config.contextDepth ?? 4,
    enabled: config.enabled ?? true,
    injectCooldownMs: config.injectCooldownMs ?? 10 * 60 * 1000,
    directSimilarityThreshold: config.directSimilarityThreshold ?? 0.5,
    noveltyMargin: config.noveltyMargin ?? 0.05,
    backoffMaxMs: config.backoffMaxMs ?? 2 * 60 * 60 * 1000,
    enableTurnGating: config.enableTurnGating ?? false,
    establishedSessionTurns: config.establishedSessionTurns ?? 20,
    actionFrameMarginBoost: config.actionFrameMarginBoost ?? 0.08,
    triggerBoost: config.triggerBoost ?? 0.15,
    review: Object.freeze({
      enabled: review.enabled ?? false,
      provider: review.provider ?? 'spawn',
      minTextChars: review.minTextChars ?? 60,
      cooldownMs: review.cooldownMs ?? 120_000,
      timeoutMs: review.timeoutMs ?? 45_000,
      maxHits: review.maxHits ?? 3,
    }),
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
 * C-form discriminant-axis boost (LLM 定轴 → 权重表参数化在线扫描):
 * when the query hits one pole of a persisted discriminant axis and the
 * candidate experience belongs to that axis's cluster, its similarity is
 * nudged toward the matching pole. This restores premise discrimination that
 * embedding cosine alone flattens (exp_56/57: 新手/资深 within one git-push
 * cluster) — the axis terms are LLM-extracted polarity words, consumed as a
 * static lookup so the online scan stays as cheap as the plain embedding scan.
 * @param service - the pipeline service (for the axis table).
 * @param query - the current situation text.
 * @param exp - the candidate experience.
 * @param clusterId - the experience's cluster assignment, if any.
 * @returns the added boost in [-0.1, 0.1], or 0 when no axis applies.
 */
function axisBoost(
  service: CognitivePipelineService,
  query: string,
  exp: Experience,
  clusterId: number | null,
): number {
  if (clusterId === null) return 0
  let boost = 0
  for (const axis of service.discriminantAxes()) {
    if (axis.clusterId !== clusterId) continue
    // Query must actually speak the axis's language to route along it.
    const hitTerm = axis.terms.find(term => query.includes(term))
    if (hitTerm === undefined) continue
    // Candidate matches the pole when its own text carries the same term;
    // the boost is capped so a single axis never overrides the semantic rank.
    const matches = axis.terms.some(term => exp.sar.situation.includes(term) || exp.sar.action.includes(term))
    boost += matches ? AXIS_BOOST_GAIN : -AXIS_BOOST_GAIN
  }
  return Math.max(-0.1, Math.min(0.1, boost))
}

/** Cap for one discriminant-axis contribution to similarity (C-form routing
 * nudge, not override). */
const AXIS_BOOST_GAIN = 0.05

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
 *
 * Embedding-aware (roadmap R3 + finding #13): when the pipeline has a real
 * embedding scorer (e.g. SiliconFlow bge-m3), the query is embedded once and
 * the semantic channel uses embedding cosine against experiences that carry a
 * stored embedding; experiences without one fall back to the hash-bag cosine
 * against the SAME query — the two axes are mixed per-experience, so a
 * partially-embedded store still retrieves correctly (cold-store legacy rows
 * and newly embedded rows coexist). No embedder → pure hash, unchanged.
 *
 * C-form (design 13): the persisted discriminant-axis table adds a small
 * pole-matching nudge per candidate (see {@link axisBoost}), so premise
 * discrimination (新手↔资深) survives the flattened embedding ranking.
 */
async function retrieve(
  service: CognitivePipelineService,
  situation: string,
  minSimilarity: number,
  topK: number,
  novelty?: (expId: string) => number,
  noveltyMargin = 0,
): Promise<{ hits: readonly RankedHit[], rotated: boolean, rawHits: number,
  topHits: readonly number[], textChars: number }> {
  const vector = actionVector(situation, [])
  const situationVec = situationVector(situation)
  const embedder = service.embedder
  const queryEmbedding = embedder === null ? null : await embedder.embed(situation)
  const hits = service.store.experiencesSnapshot()
    .filter(exp => !isTaskRestatement(exp))
    // cl-102: 帧生记录不回注帧——自我回声(帧→关于帧的经验→再注入帧)是实测
    // 注入集最大的噪声源(最近 200 条注入 21.5% 含帧生经验, 历史 13 条被引用
    // 的注入里 0 条含)。记录仍留在库里作为历史, 只是不再进入上下文。
    .filter(exp => !isSelfFrameExperience(exp))
    .map((exp): RankedHit => {
      const text = `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
      const semantic = queryEmbedding !== null && exp.embedding !== undefined
        ? cosine(queryEmbedding, exp.embedding)
        : Math.max(
          cosine(vector, exp.actionVector),
          cosine(situationVec, situationVector(exp.sar.situation)),
        )
      return {
        expId: exp.expId,
        text,
        polarity: outcomePolarity(exp.sar.outcomeUtility),
        similarity: semantic
          + symptomOverlap(situation, text) * SYMPTOM_BONUS * semantic
          + axisBoost(service, situation, exp, exp.clusterId),
        ...exp.selfReflexive === true ? { selfReflexive: true } : {},
      }
    })
    .filter(hit => hit.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
  // cl-122: 记录**过阈后的原始候选数**与头部相似度——三个调度杠杆接连被"候选供给"卡住,
  // 但这条供给从来没被记过: 审计里的 candidates 是 coverViewpoints 之后的结果(恒为 2),
  // 看不到"到底有几条过阈可选"。没有这个数, topK/轮换/退避的空间都只能靠猜。
  const rawHits = hits.length
  const topHits = hits.slice(0, 5).map(hit => Number(hit.similarity.toFixed(3)))
  // cl-120 A/B: topK 加宽会增加上下文成本, 所以每次注入的文本长度必须可测——
  // 判据是"采纳率/不同经验数上升"与"成本上升"的对照, 不能只看前者。
  const textChars = (subset: readonly RankedHit[]): number =>
    subset.reduce((sum, hit) => sum + hit.text.length, 0)
  const covered = coverViewpoints(hits, topK, novelty, noveltyMargin)
  // cl-121 可用性见证: 与"纯分数选择"比对, 记录本轮轮换是否真的换了人。
  // 三个调度杠杆先后被判惰性(闸门/退避/轮换), 所以"是否真的开火"必须落盘可见——
  // 否则又是一个"机制在、条件已死"的假绿。
  const baseline = noveltyMargin > 0 ? coverViewpoints(hits, topK) : covered
  const rotated = covered.length !== baseline.length
    || covered.some(hit => !baseline.some(base => base.expId === hit.expId))
  return { hits: covered, rotated, rawHits, topHits, textChars: textChars(covered) }
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
export function coverViewpoints(
  hits: readonly RankedHit[],
  topK: number,
  novelty?: (expId: string) => number,
  noveltyMargin = 0,
): readonly RankedHit[] {
  const failure = hits.find(hit => hit.polarity === 'negative')
  const success = hits.find(hit => hit.polarity === 'positive')
  if (failure === undefined || success === undefined) return hits.slice(0, topK)
  // cl-121: 分数在 margin 内时改选"本会话注入次数更少"的那条——保持"失败对照组"
  // 的结构, 但轮换成员。实测(干净窗口 19/25 双条注入恰为一负一正)表明: 面世的不是
  // top-1 记忆, 而是 coverViewpoints 选出的失败/成功对照对; 浓度=同一对反复被选中。
  const pick = (best: RankedHit): RankedHit => {
    if (novelty === undefined || noveltyMargin <= 0) return best
    const pool = hits.filter(hit => hit.polarity === best.polarity
      && hit.similarity >= best.similarity - noveltyMargin)
    let chosen = best
    for (const candidate of pool) {
      if (novelty(candidate.expId) < novelty(chosen.expId)) chosen = candidate
      else if (novelty(candidate.expId) === novelty(chosen.expId)
        && candidate.similarity > chosen.similarity) chosen = candidate
    }
    return chosen
  }
  const selected = new Map<string, RankedHit>()
  const chosenFailure = pick(failure)
  const chosenSuccess = pick(success)
  selected.set(chosenFailure.expId, chosenFailure)
  selected.set(chosenSuccess.expId, chosenSuccess)
  for (const hit of hits) {
    if (selected.size >= Math.max(topK, 2)) break
    if (!selected.has(hit.expId)) selected.set(hit.expId, hit)
  }
  return hits.filter(hit => selected.has(hit.expId))
}

/**
 * Drop candidates whose experience was already injected into this session
 * within the cooldown window. Repeated injection of the same memory inside
 * one session is noise, not recall — the measured adoption collapse came
 * with the same expIds injected over and over (exp_1 13×, exp_303 9×;
 * cold-domain finding #3). The cooldown is per-session so the same memory
 * still surfaces in a later session where it is genuinely new.
 * @param service - the pipeline service (for the durable injection ledger).
 * @param sessionId - the session the current step runs in.
 * @param hits - the candidates before the cooldown filter.
 * @param cooldownMs - the cooldown window; 0 disables the filter.
 * @returns the candidates not injected recently in this session.
 */
function coolDownInjected(
  service: CognitivePipelineService,
  sessionId: string,
  hits: readonly ExperienceHit[],
  cooldownMs: number,
  backoffMaxMs = 2 * 60 * 60 * 1000,
): { kept: readonly ExperienceHit[], backoffDropped: number,
  details: readonly { expId: string, uncitedStreak: number, effectiveCooldownMs: number }[],
  admitted?: string | null } {
  if (cooldownMs <= 0 || hits.length === 0) return { kept: hits, backoffDropped: 0, details: [], admitted: null }
  // cl-118 修订版: 按经验退避——同一经验在本会话里未引用 k 次, 冷却 ×2^k(上限 6h)。
  // 硬抑制会掐掉"第 68 次终于落地"的那次采纳(实测 exp_126 #68 / exp_264 #6), 退避不会。
  const prior: PriorInjection[] = []
  for (const record of service.store.injectionsSnapshot()) {
    if (record.sessionId !== sessionId) continue
    for (const expId of record.expIds) {
      prior.push({ expId, injectedAt: record.createdAt, cited: record.cited })
    }
  }
  const state = backoffState(prior, Date.now(), cooldownMs, backoffMaxMs)
  if (state.size === 0) return { kept: hits, backoffDropped: 0, details: [], admitted: null }
  const now = Date.now()
  let dropped = 0
  const details: { expId: string, uncitedStreak: number, effectiveCooldownMs: number }[] = []
  const blocked: { expId: string, lastInjectedAt: number, effectiveCooldownMs: number }[] = []
  const kept = hits.filter(hit => {
    const entry = state.get(hit.expId)
    if (entry === undefined) return true
    if (now - entry.lastInjectedAt < entry.effectiveCooldownMs) {
      dropped += 1
      // 退避挡下时把"为什么"一并记下: 哪个经验、连击多少、当时有效冷却多长。
      details.push({ expId: hit.expId, uncitedStreak: entry.uncitedStreak,
        effectiveCooldownMs: entry.effectiveCooldownMs })
      blocked.push({ expId: hit.expId, lastInjectedAt: entry.lastInjectedAt,
        effectiveCooldownMs: entry.effectiveCooldownMs })
      return false
    }
    return true
  })
  // cl-118 通道保活: 全部候选都被挡下时, 放行最接近到期的那个(基础冷却须已过),
  // 否则退避会把整条注入通道静默掉(实测 40 分钟零注入)。
  let admitted: string | null = null
  if (kept.length === 0 && blocked.length > 0) {
    admitted = admitLeastBackedOff(blocked, now, cooldownMs)
    if (admitted !== null) {
      dropped -= 1
      const hit = hits.find(h => h.expId === admitted)
      if (hit !== undefined) (kept as ExperienceHit[]).push(hit)
      details.push({ expId: admitted, uncitedStreak: -1, effectiveCooldownMs: -1 })
    }
  }
  return { kept, backoffDropped: dropped, details, admitted }
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
  // 2026-09-08 23:5x cl-044: 引用结算只认"回复文本字面包含 expId"。模型改用语态叙述后,
  // 引用率从 09-02 的 50% 掉到 09-07/08 的 0.5%(最后一次引用停在 09-08 06:47)——通道权重
  // 与触发跳转的学习信号就此停摆。修法不是放宽判据(关键词重叠会造假阳性), 而是把"引用契约"
  // 写进注入块: 采用了哪条, 就在回复里写出它的 expId。
  const citationContract = '\n（引用契约：若本轮确实采用了其中某条经验，请在回复中写出它的 expId——'
    + '这是引用结算的唯一依据，用于学习哪些注入真正有用；没采用就不必写。）'
  const text = `${preamble}\n${lines.join('\n')}${vetoNote}${citationContract}`
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
  // solidified strategy, the strategy is the converged rule. Chain membership
  // alone is NOT transferability: a hit that merely RECORDS the chain's past
  // verification (its situation is about the strategy, not the task) must not
  // promote the strategy out of context. The goal domain must also match the
  // situation — the same gate Channel 2 applies — so promotion requires BOTH
  // the chain link AND task relevance.
  const chainIds = new Set<string>()
  for (const hit of hits) {
    const exp = service.store.getExperience(hit.expId)
    if (exp?.chainId !== undefined) chainIds.add(exp.chainId)
  }
  if (chainIds.size > 0) {
    for (const strategy of service.solidifiedStrategies()) {
      if (strategy.sourceChainId !== '' && chainIds.has(strategy.sourceChainId)
        && strategy.goalDomain.length > 0 && situation.includes(strategy.goalDomain)) {
        return strategy
      }
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

/** Summed trigger weight (static, derived, or jump) needed to prime injection. */
const TRIGGER_MATCH_THRESHOLD = 0.6

/** One matched trigger word and how much it contributed. */
export interface TriggerContribution {
  readonly word: string
  readonly kind: 'static' | 'derived' | 'jump'
  readonly weight: number
}

/** One trigger verdict: whether the gate opened, the contributing trigger
 * source (for the injection record), and the jump words that contributed
 * (for citation-rate measurement).
 *
 * `matched`/`score` exist because `triggerSource` only names the FIRST matched
 * word — measured: `static:异常` appeared on 239 injections with 0 adoptions,
 * but that label does not mean 异常 alone opened the gate (weak words
 * accumulate to the 0.6 threshold). Attributing outcomes to the first-matched
 * word would indict the wrong word, so the full contribution list is carried
 * for real attribution. */
export interface TriggerVerdict {
  readonly fired: boolean
  readonly triggerSource: string
  readonly jumpWords: readonly string[]
  readonly matched: readonly TriggerContribution[]
  readonly score: number
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
  if (text.trim().length === 0) return { fired: false, triggerSource: '', jumpWords: [], matched: [], score: 0 }
  let score = 0
  let source = ''
  const matched: TriggerContribution[] = []
  // Static triggers are multi-character phrases; match them as substrings
  // (tokenize splits CJK per character, so token matching would never hit).
  // 2026-09-08 分级(cl-008 数据实证): 强词(失败/崩溃——66%/50%引用)单独触发;
  // 弱词(怎么/异常——0.7%/0%引用)只加 0.4, 单弱词不过 0.6 阈值, 需第二个信号累积。
  for (const trigger of STATIC_TRIGGERS) {
    if (text.includes(trigger)) {
      const weight = STRONG_STATIC_TRIGGERS.has(trigger) ? STRONG_STATIC_WEIGHT : WEAK_STATIC_WEIGHT
      score += weight
      matched.push({ word: trigger, kind: 'static', weight })
      if (source === '') source = `static:${trigger}`
      if (score >= TRIGGER_MATCH_THRESHOLD) {
        return { fired: true, triggerSource: source, jumpWords: [], matched, score }
      }
    }
  }
  const derived = deriveTriggerWords(service)
  // Derived words are multi-char (CJK bigrams + latin tokens, matching the
  // lexicon build — finding #10: single-char derived words were noise that
  // let any message cross the gate). Match the message with the same
  // vocabulary so a multi-char derived word actually hits.
  for (const word of jumpVocabulary(text)) {
    const weight = derived.get(word)
    if (weight !== undefined && weight >= DERIVED_TRIGGER_MIN) {
      score += weight
      matched.push({ word, kind: 'derived', weight })
      if (source === '') source = `derived:${word}`
      if (score >= TRIGGER_MATCH_THRESHOLD) {
        return { fired: true, triggerSource: source, jumpWords: [], matched, score }
      }
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
      const contribution = entry.weight * scale
      score += contribution
      matched.push({ word: jump.jumpWord, kind: 'jump', weight: contribution })
      if (source === '') source = `jump:${jump.jumpWord}→${entry.trigger}`
      if (score >= TRIGGER_MATCH_THRESHOLD) {
        return { fired: true, triggerSource: source, jumpWords: hitJumps, matched, score }
      }
    }
  }
  return { fired: false, triggerSource: '', jumpWords: [], matched, score }
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

  // Prewarm context maintenance: keep a rolling summary of what this session
  // is actually DOING (recent tool calls, recent assistant output), so a
  // short message that triggers a literal-overlap false positive (the exp_67
  // case: "重启" matching exp_1 by surface words) can be judged by the LLM
  // veto route against the REAL ongoing context, not the isolated message.
  // Citation settlement at turn end moved to the pipeline's summarizeTurn
  // (unconditionally registered), so one owner aggregates the turn's activity
  // for the GUI bubble without a cross-plugin race; the deferred settlement
  // below still covers self-reflexive interruptions.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    updatePrewarm(prewarmContext, session, event)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
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
    const situation = situationText(decision.messages, resolved.contextDepth)
    if (situation.trim().length === 0) return decision
    // ── cl-114 回合类型闸门 + 四级漏斗审计 ────────────────────────────────
    // 实测(主会话 852 条已结算注入按回合类别): 用户回合 13/252=5.2%,
    // 行动帧 2/99=2.0%, 反思类帧 0/501=0.0% 却占 59% 体积; 但同样的反思帧在
    // 1-3 回合的新会话(子代理/旁路)里采纳率 ~17%。=> 只在"上下文已稀释的
    // 长会话"里对反思类帧静默; 行动帧收紧余量; 用户回合不变。
    const turnKind = classifyTurnKind(messages)
    const sessionTurns = agent.session.events.filter(ev => ev.type === 'turn/start').length
    // cl-116: 总开关默认关闭——立项依据被证伪, 先回到"照旧注入", 等干净窗口重测。
    const gate = resolved.enableTurnGating
      ? decideInjection({
        kind: turnKind,
        sessionTurns,
        establishedSessionTurns: resolved.establishedSessionTurns,
      })
      : 'inject'
    const auditPath = join(ctx.cognitivePipeline.resolved.root, 'retrieval-audit.jsonl')
    const audit = (payload: Record<string, unknown>): void => {
      void appendFile(auditPath, JSON.stringify({
        t: Date.now(), sessionId: String(agent.session.id), turnKind, sessionTurns,
        decision: gate, ...payload,
      }) + '\n').catch(() => undefined)
    }
    if (gate === 'skip') {
      audit({ stage: 'skipped-reflective-frame' })
      return decision
    }
    // ── Situation-driven gate (architecture change, finding #12) ──────────
    // Retrieval runs FIRST (hash-bag cosine is millisecond-cheap); the gate is
    // decided AFTER retrieval by significance, not before by trigger words:
    //   · top similarity ≥ directSimilarityThreshold (0.45)  → direct recall,
    //     the situation itself is the cue (measured: business med 0.419,
    //     chitchat p75 0.362 — 0.45 admits ~40% business, keeps chitchat out)
    //   · OR a trigger fired → top similarity + triggerBoost (0.3)  → 求助信号
    //     soft-lifts a mid-similarity hit across the gate, never opens alone
    //   · after a failed step → lower threshold (minSimilarity × factor)
    // The trigger gate is therefore a SOFT signal now, not the hard switch it
    // was: routine chat with a weak hit stays silent, a business situation
    // opens without any trigger word. Cold start still relies on triggers when
    // the store is empty (retrieval finds nothing).
    const verdict = triggeredBy(decision.messages, ctx.cognitivePipeline, resolved.contextDepth)
    const threshold = afterFailure
      ? resolved.minSimilarity * resolved.failureThresholdFactor
      : resolved.minSimilarity
    const topK = afterFailure ? resolved.failureTopK : resolved.topK
    const sessionCounts = new Map<string, number>()
    for (const record of ctx.cognitivePipeline.store.injectionsSnapshot()) {
      if (record.sessionId !== agent.session.id) continue
      for (const expId of record.expIds) sessionCounts.set(expId, (sessionCounts.get(expId) ?? 0) + 1)
    }
    const { hits, rotated, rawHits, topHits, textChars } = await retrieve(ctx.cognitivePipeline, situation, threshold, topK,
      expId => sessionCounts.get(expId) ?? 0, resolved.noveltyMargin)
    if (hits.length === 0) {
      audit({ stage: 'no-candidates', threshold, rotated, rawHits })
      return decision
    }
    const topHit = hits[0]?.similarity ?? 0
    const gateScore = verdict.fired ? topHit + resolved.triggerBoost : topHit
    const gateThreshold = (afterFailure
      ? resolved.minSimilarity * resolved.failureThresholdFactor
      : resolved.directSimilarityThreshold)
      // 行动帧: 只有比常规更贴的经验才注入(2.0% 采纳率, 不该按用户回合的宽松度放行)
      + (gate === 'inject-strict' ? resolved.actionFrameMarginBoost : 0)
    if (gateScore < gateThreshold) {
      audit({ stage: 'below-gate', candidates: hits.length, topHit, gateScore, gateThreshold, rotated, rawHits, topHits, textChars,
        triggerSource: verdict.triggerSource, triggerScore: verdict.score, matched: verdict.matched })
      return decision
    }
    // Cooldown filter: a memory injected into THIS session within the window
    // is not injected again — same-session repeats are noise (finding #3:
    // exp_1 13×, exp_303 9×). All recent → nothing new to say, stay silent.
    const { kept: cooled, backoffDropped, details: backoffDetails, admitted: backoffAdmitted } = coolDownInjected(
      ctx.cognitivePipeline, agent.session.id, hits, resolved.injectCooldownMs, resolved.backoffMaxMs)
    if (cooled.length === 0) {
      audit({ stage: 'cooldown', candidates: hits.length, topHit, backoffDropped, rotated, rawHits, topHits, textChars,
        backoffDetails, backoffAdmitted, triggerSource: verdict.triggerSource })
      return decision
    }
    // Prewarm enrichment for the veto gate: a short message ("重启") may match
    // an unrelated experience by surface words (exp_67's literal-overlap false
    // positive). The veto route judges applicability — so it must see what the
    // session is ACTUALLY doing, not the isolated message. The enriched
    // situation = [rolling prewarm] + current message.
    const prewarmed = prewarmContext.get(agent.session)
    const vetoSituation = prewarmed !== undefined && prewarmed.length > 0
      ? `【当前会话正在进行】${prewarmed}\n【当前消息】${situation}`
      : situation
    // Veto gate: retrieval may surface over-threshold candidates that do not
    // genuinely fit (a literal hit is not transferability). The template-7
    // refine route judges each candidate; every accepted one is injected
    // (viewpoint coverage survives), every rejection records a note, and
    // all-rejected suppresses injection. Without a route the route keeps the
    // candidates (deterministic degradation to the threshold-only behavior).
    // The veto runs BEFORE solidified-strategy promotion: a chain link alone
    // must not bypass the applicability judgement (a hit that merely RECORDS
    // the chain's verification is not a request to run its strategy).
    const vetoed = await vetoTopCandidates(
      ctx, ctx.cognitivePipeline.resolved.route, vetoSituation, cooled, signal,
    )
    if (vetoed.accepted.length === 0) {
      audit({ stage: 'veto-rejected', candidates: hits.length, overThreshold: cooled.length, rotated, rawHits, topHits, textChars,
        vetoJudged: vetoed.judged, vetoSilent: vetoed.rejectedWithoutReason,
        vetoRejected: vetoed.rejectedNotes.length, topHit, triggerSource: verdict.triggerSource })
      return decision
    }
    // Solidified-strategy priority, AFTER the veto: when the ACCEPTED
    // experiences link to a chain that seeded a solidified strategy (the
    // repeated-success promotion), inject the STRATEGY — a short,
    // machine-verifiable rule with a drift sensor — instead of the scattered,
    // unverified experiences. The strategy is the converged form: it tells the
    // executor exactly what to run and how to check it worked, so the task
    // converges instead of re-deriving each time (the "restart DSH" case:
    // exp_101's script, solidified).
    const strategy = solidifiedStrategyForHits(ctx.cognitivePipeline, vetoed.accepted, situation)
    if (strategy !== undefined) {
      const block = strategyBlock(strategy)
      ctx.cognitivePipeline.recordInjection({
        expIds: vetoed.accepted.map(hit => hit.expId),
        triggerSource: verdict.triggerSource,
        sessionId: agent.session.id,
        jumpWords: verdict.jumpWords,
        strategyId: strategy.strategyId,
      })
      audit({ stage: 'injected', path: 'strategy', backoffDropped, backoffDetails, backoffAdmitted, rotated, rawHits, topHits, textChars,
        vetoJudged: vetoed.judged, vetoSilent: vetoed.rejectedWithoutReason,
        injectedChars: vetoed.accepted.reduce((sum, hit) => sum + hit.text.length, 0), candidates: hits.length, overThreshold: cooled.length,
        vetoAccepted: vetoed.accepted.length, vetoRejected: vetoed.rejectedNotes.length,
        expIds: vetoed.accepted.map(hit => hit.expId), triggerSource: verdict.triggerSource,
        triggerScore: verdict.score, matched: verdict.matched })
      return {
        kind: 'enter',
        messages: [...decision.messages, block],
      }
    }
    // ── Pre-input review (opt-in) ─────────────────────────────────────────
    // Before the raw experience blocks inject, a review subagent may
    // synthesize the ACCEPTED experiences for the main conversation. Only on
    // the first step of a turn (step 1), for a root conversation session
    // (no parentSession — subagent children never review, which would
    // recurse), when the input is substantive and the session is out of its
    // review cooldown. The review block REPLACES the raw blocks for this
    // step; on any skip, timeout, or failure the raw path below runs.
    const review = resolved.review
    if (review.enabled && (step === 1 || step === undefined) && agent.session.header.parentSession === undefined
      && situation.trim().length >= review.minTextChars
      && !reviewInCooldown(agent.session.id, review.cooldownMs)) {
      const reviewText = await runPreInputReview(ctx, agent, signal, situation, {
        hits: vetoed.accepted,
        maxHits: review.maxHits,
        timeoutMs: review.timeoutMs,
        provider: review.provider,
      })
      if (reviewText !== null) {
        reviewLastRun.set(agent.session.id, Date.now())
        ctx.cognitivePipeline.recordInjection({
          expIds: vetoed.accepted.map(hit => hit.expId),
          triggerSource: `pre-input-review:${verdict.triggerSource || 'situation'}`,
          sessionId: agent.session.id,
          jumpWords: verdict.jumpWords,
        })
        markHitsReviewed(ctx.cognitivePipeline, vetoed.accepted)
        const text = `【过往经验回顾】以下是对当前输入基于过往经验的回顾分析，由回顾子代理生成后反代回主对话（不要虚构为当前事实）：\n${reviewText}`
        const block = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        })
        return { kind: 'enter', messages: [...decision.messages, block] }
      }
      // Review skipped/failed/empty → fall through to the raw blocks below.
    }
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
    markHitsReviewed(ctx.cognitivePipeline, vetoed.accepted)
    audit({ stage: 'injected', path: 'raw', backoffDropped, backoffDetails, backoffAdmitted, rotated, rawHits, topHits, textChars,
      vetoJudged: vetoed.judged, vetoSilent: vetoed.rejectedWithoutReason,
      // 成本判据必须看"真正进了上下文的那几条"(veto 之后), 而不是候选池大小
      injectedChars: vetoed.accepted.reduce((sum, hit) => sum + hit.text.length, 0), candidates: hits.length, overThreshold: cooled.length,
      vetoAccepted: vetoed.accepted.length, vetoRejected: vetoed.rejectedNotes.length,
      expIds: vetoed.accepted.map(hit => hit.expId), triggerSource: verdict.triggerSource,
      triggerScore: verdict.score, matched: verdict.matched })
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


/** Record a real recall as a review/use event on the activation clock: every
 * experience actually injected into the model (raw or pre-input-review path)
 * was genuinely retrieved and surfaced, which is what "use" means in the
 * activation model — refreshing its lastReviewedAt/reviewCount keeps the
 * review scheduler from re-scheduling items the context still uses. */
function markHitsReviewed(
  pipeline: { store: { recordExperienceReview(expId: string): unknown } },
  hits: readonly ExperienceHit[],
): void {
  for (const hit of hits) {
    try {
      pipeline.store.recordExperienceReview(hit.expId)
    } catch (_error) {
      // Unknown/legacy id: activation bookkeeping is best-effort.
    }
  }
}

// ── pre-input review (main-session experience analysis via a subagent) ─────

/** Last review run time per session id, for the review cooldown. */
const reviewLastRun = new Map<string, number>()

/** Whether the session reviewed within the cooldown window. */
function reviewInCooldown(sessionId: string, cooldownMs: number): boolean {
  if (cooldownMs <= 0) return false
  const last = reviewLastRun.get(sessionId)
  return last !== undefined && Date.now() - last < cooldownMs
}

/** One experience the review may cite. */
export interface ReviewHit {
  readonly expId: string
  readonly text: string
}

/** Build the review-subagent prompt: the input plus the retrieved experience
 * material the review must synthesize from. Exported for tests.
 * @param input - the genuine user input entering the main conversation.
 * @param opts - optional current situational head and retrieved hits.
 * @returns the review prompt text.
 */
export function buildReviewPrompt(
  input: string,
  opts: { head?: string; hits: readonly ReviewHit[] } = { hits: [] },
): string {
  const headSection = opts.head !== undefined && opts.head.length > 0
    ? `【最近提交的情景状态】\n${opts.head}\n`
    : ''
  const hitsSection = opts.hits.length > 0
    ? opts.hits.map(hit => `- [${hit.expId}] ${hit.text}`).join('\n')
    : '（无相关过往经验）'
  return [
    '你是主会话的"经验回顾"子代理。主对话收到一条用户输入；认知管线检索出若干相关过往经验。请基于这些经验对当前输入做回顾分析，产出主会话可直接使用的分析文本。',
    '',
    '【当前用户输入】',
    input,
    headSection.length > 0 ? headSection : '',
    '【检索到的相关过往经验】',
    hitsSection,
    '',
    '【要求】',
    '1. 指出与当前输入最相关的过往经验要点（引用 expId）；',
    '2. 指出需要注意或避免的坑（如有失败经验）；',
    '3. 给出建议的推进方式。',
    '输出 ≤400 字中文分析；直接给结论与建议，不要复述经验原文。',
  ].filter(line => line.length > 0).join('\n')
}

/** Structural shape of the `ctx.subagents` service this plugin reads through
 * (the seam lives in @deepseek-ai/dsh-subagent, which is not a dependency). */
interface ReviewSubagentsSeam {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: string; text: string }[]
    parent: Agent
    signal?: AbortSignal
  }): Promise<{
    result: Promise<{ output: readonly { type?: string; text?: string }[]; stopReason: string }>
    dispose(): Promise<void>
  }>
}

/** The chain head's situation text, when the situational-state plugin is
 * mounted (soft read — no dependency). */
async function situationalHeadText(ctx: Context): Promise<string | undefined> {
  const service = ctx.get('situationalState') as { head(): Promise<{ situation: string } | undefined> } | undefined
  if (service === undefined) return undefined
  try {
    const head = await service.head()
    return head?.situation
  } catch (_error) {
    return undefined
  }
}

/** Run one review subagent and return its output text, or null when the
 * review cannot run (no subagents seam, spawn failure, timeout, empty
 * output). Every failure path returns null so the caller falls back to the
 * raw experience blocks.
 * @param ctx - plugin context (reads the subagents seam lazily).
 * @param agent - the main-conversation agent (the child's parent).
 * @param signal - step cancellation signal forwarded to the child.
 * @param situation - the genuine user input.
 * @param opts - provider, hit cap, and timeout.
 * @returns the review text, or null.
 */
async function runPreInputReview(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal | undefined,
  situation: string,
  opts: { hits: readonly ExperienceHit[]; maxHits: number; timeoutMs: number; provider: string },
): Promise<string | null> {
  const subagents = ctx.get('subagents') as unknown as ReviewSubagentsSeam | undefined
  if (subagents === undefined) return null
  const head = await situationalHeadText(ctx)
  const prompt = buildReviewPrompt(situation, {
    ...head === undefined ? {} : { head },
    hits: opts.hits.slice(0, opts.maxHits).map(hit => ({ expId: hit.expId, text: hit.text })),
  })
  try {
    const run = await subagents.start(opts.provider, {
      label: `经验回顾：${situation.slice(0, 24)}`,
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      ...signal === undefined ? {} : { signal },
    })
    let result: { output: readonly { type?: string; text?: string }[]; stopReason: string }
    try {
      result = await Promise.race([
        run.result,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('review timeout')), opts.timeoutMs)
          timer.unref?.()
        }),
      ])
    } catch (_timeout) {
      // The child may still settle in the background; the raw blocks inject.
      return null
    } finally {
      await run.dispose().catch(() => {})
    }
    const text = result.output
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join(' ')
      .trim()
    return text.length > 0 ? text.slice(0, 1200) : null
  } catch (error: unknown) {
    ctx.logger.warn(`cognitive-inject: pre-input review failed, falling back to raw blocks: ${String(error)}`)
    return null
  }
}

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
): Promise<{ accepted: readonly ExperienceHit[]; rejectedNotes: string[];
  judged: number; rejectedWithoutReason: number }> {
  const accepted: ExperienceHit[] = []
  const notes: string[] = []
  let judged = 0
  let rejectedWithoutReason = 0
  for (let index = 0; index < Math.min(hits.length, INJECT_VETO_MAX + 1); index += 1) {
    const hit = hits[index]
    if (hit === undefined) break
    const decision = await refineRetrieval(ctx, route, { situation, action: situation }, [{
      expId: hit.expId,
      text: hit.text,
      similarity: hit.similarity,
    }], { signal })
    judged += 1
    if (decision.shouldKeep) {
      accepted.push(hit)
      continue
    }
    // cl-124: 否决常常没有理由(reason 为空) => 无法审计"为什么这次没让模型看到"。
    // 无理由的否决也计数, 让"静默否决"这条量可见。
    if (decision.reason !== null && decision.reason.length > 0) notes.push(decision.reason)
    else rejectedWithoutReason += 1
  }
  return { accepted, rejectedNotes: notes, judged, rejectedWithoutReason }
}
