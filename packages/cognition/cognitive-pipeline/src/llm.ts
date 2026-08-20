/**
 * Typed LLM helpers for the cognitive pipeline. Each model-assisted step is a
 * best-effort enhancement over a deterministic fallback: a missing adapter, an
 * unreachable route, or a malformed JSON reply never breaks the pipeline — it
 * degrades to the mathematically safe path (附录C of the design).
 * @module @deepseek-ai/dsh-cognitive-pipeline/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
} from '@deepseek-ai/dsh-llm'
import type { AccumulationDecision, Experience, OutcomeUtility, SarTriplet } from './types.ts'
import {
  ACCUMULATE_SYSTEM_PROMPT,
  CALIBRATION_SYSTEM_PROMPT,
  frameAccumulateInput,
  frameCalibrationInput,
  frameOodInput,
  frameReconstructInput,
  frameSarInput,
  OOD_REVIEW_SYSTEM_PROMPT,
  RECONSTRUCT_SYSTEM_PROMPT,
  SAR_SYSTEM_PROMPT,
} from './prompts.ts'
import { SYMPTOM_MARKERS, tokenize } from './vectorizer.ts'

/** Explicit provider/model route; both or neither must be set. */
export interface CognitiveLlmRoute {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** Stable error taxonomy for pipeline-side failures. */
export class CognitivePipelineError extends Error {
  /** Stable machine-readable error code. */
  readonly code: string
  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable machine code.
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CognitivePipelineError'
    this.code = code
  }
}

/** Structured template-2 OOD review result. */
export interface OodReview {
  readonly isKnown: boolean
  readonly confidenceScore: number
  readonly reasoningShort: string
  readonly suggestedInitialRiskLevel: 'low' | 'medium' | 'high'
}

/** Structured template-3 calibration result. */
export interface CalibrationOutput {
  readonly baseSuccessRate: number
  readonly riskFactors: readonly string[]
  readonly finalConfidenceIntervalLow: number
  readonly finalConfidenceIntervalHigh: number
  readonly finalCalibratedProbability: number
  readonly advicePreview: string
}

/** A cluster as returned by template 4, before backend evidence verification. */
export interface RawReconstructCluster {
  readonly clusterName: string
  readonly decisionRule: string
  readonly expectedUtilityRange: { low: number; high: number }
  readonly supportingEvidenceIds: readonly string[]
  readonly fallbackAction: string
}

/** Structured template-4 reconstruction result. */
export interface ReconstructOutput {
  readonly newClusters: readonly RawReconstructCluster[]
  readonly taxonomySummaryShort: string
}

/** Whether an explicit route is configured at all.
 * @param route - the configured route pair.
 * @returns true when both provider and model are set.
 */
export function hasExplicitRoute(route: CognitiveLlmRoute): boolean {
  return route.provider !== undefined && route.model !== undefined
}

/** Validate the route pair; both or neither must be present and non-empty.
 * @param route - the candidate route.
 * @returns a validated route, or an empty route.
 */
export function resolveRoute(route: CognitiveLlmRoute): CognitiveLlmRoute {
  const provider = route.provider
  const model = route.model
  if (provider === undefined && model === undefined) return {}
  if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
    throw new CognitivePipelineError(
      'cognitive-pipeline: provider and model must be supplied together as non-empty strings',
      'INVALID_LLM_ROUTE',
    )
  }
  return { provider, model }
}

/** Extract the first balanced JSON object from model text.
 * @param text - the raw model output.
 * @returns the parsed JSON value.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new CognitivePipelineError('cognitive-pipeline: model produced empty output', 'EMPTY_LLM_OUTPUT')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    // Regex fallback: locate the first {...} block spanning braces.
    const start = trimmed.indexOf('{')
    if (start < 0) {
      throw new CognitivePipelineError('cognitive-pipeline: model output contains no JSON object', 'LLM_JSON_PARSE_FAILED')
    }
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index] ?? ''
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
    throw new CognitivePipelineError('cognitive-pipeline: model output is not valid JSON', 'LLM_JSON_PARSE_FAILED')
  }
}

/** Map LLM text blocks to one string. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

/** Ensure the parsed JSON is a non-null object before field access. */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new CognitivePipelineError(
      `cognitive-pipeline: ${label} output must be a JSON object`,
      'LLM_SCHEMA_FAILED',
    )
  }
  return value as Record<string, unknown>
}

/** Translate a terminal finish reason into an error, or undefined on stop. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return new CognitivePipelineError(
        `cognitive-pipeline: model call failed: ${finish.failure.message}`,
        finish.failure.code,
      )
    case 'max-tokens':
      return new CognitivePipelineError('cognitive-pipeline: model output reached maxTokens', 'LLM_MAX_TOKENS')
    case 'tool-calls':
      return new CognitivePipelineError('cognitive-pipeline: model unexpectedly requested a tool', 'LLM_UNEXPECTED_TOOL')
    default:
      return new CognitivePipelineError('cognitive-pipeline: unsupported finish reason', 'LLM_FINISH_FAILED')
  }
}

/** Terminate a stream and return the assembled text; throws on failure. */
async function drainText(
  ctx: Context,
  options: GenerateOptions,
  maxTokens: number,
): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    options.signal?.throwIfAborted()
    assembler.push(chunk)
  }
  options.signal?.throwIfAborted()
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  if (assembler.blocks().some(block => block.type === 'tool-call')) {
    throw new CognitivePipelineError('cognitive-pipeline: model output must contain text only', 'LLM_UNEXPECTED_TOOL')
  }
  const text = textOf(assembler.blocks())
  if (text.trim().length === 0) {
    throw new CognitivePipelineError(
      `cognitive-pipeline: model produced no text (maxTokens=${maxTokens})`,
      'EMPTY_LLM_OUTPUT',
    )
  }
  return text
}

/** Options for one pipeline LLM call. */
interface CallOptions {
  readonly sessionId?: GenerateOptions['sessionId'] | undefined
  readonly signal?: AbortSignal | undefined
  readonly maxTokens?: number
}

/** Call one template and parse its JSON output. */
async function callJson(
  ctx: Context,
  route: CognitiveLlmRoute,
  system: string,
  user: string,
  options: CallOptions,
): Promise<unknown> {
  const maxTokens = options.maxTokens ?? 800
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'cognitive-pipeline' },
  })]
  const request: GenerateOptions = deepFreeze({
    provider: route.provider as string,
    model: route.model as string,
    messages,
    system,
    maxTokens,
    // Structured template calls are budget-constrained JSON extraction
    // (500-4096 tokens). Chain-of-thought reasoning would consume the whole
    // budget and starve the answer (finish=max-tokens with zero text), so these
    // calls explicitly request reasoning off; the main agent loop keeps its
    // own provider default.
    reasoningEffort: ReasoningEffortId('off'),
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  const text = await drainText(ctx, request, maxTokens)
  return extractJson(text)
}

/** Clamp a number into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Clamp an integer into [0, 10]. */
function clampUtility(value: number): number {
  if (!Number.isFinite(value)) return 5
  return Math.min(10, Math.max(0, Math.round(value)))
}

/** Whether a sentence carries an observable failure symptom. */
function hasSymptom(sentence: string): boolean {
  const lower = sentence.toLowerCase()
  return SYMPTOM_MARKERS.some(marker => lower.includes(marker))
}

/** Deterministic template-1 fallback: split sentences, neutral utility. */
function sarFallback(rawText: string): SarTriplet {
  const sentences = rawText.split(/(?<=[。！？!?.])\s*/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 0)
  const situation = sentences[0] ?? rawText.slice(0, 80)
  const action = sentences[1] ?? rawText.slice(0, 80)
  const outcome = sentences.slice(2).join(' ') || rawText.slice(0, 120)
  // Symptom fusion: append any symptom-carrying sentence to the situation so
  // the situation vector — the retrieval axis for similar failures — actually
  // contains the failure signature, not just "something went wrong".
  const symptomSentences = sentences.filter(hasSymptom)
  const fusedSituation = symptomSentences.length === 0
    ? situation
    : [...new Set([situation, ...symptomSentences])].join(' ')
  const keywords = [...new Set(tokenize(action))].slice(0, 8)
  return {
    situation: fusedSituation,
    action,
    outcome,
    actionKeywords: keywords,
    outcomeUtility: { materialGain: 5, emotionalValence: 5, energyCost: 5 },
  }
}

/**
 * Template 1: extract the SAR triplet. Falls back to a deterministic split.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param rawText - the raw experience text.
 * @param options - call context (session/signal/maxTokens).
 * @returns the extracted triplet.
 */
export async function extractSar(
  ctx: Context,
  route: CognitiveLlmRoute,
  rawText: string,
  options: CallOptions,
): Promise<SarTriplet> {
  if (!hasExplicitRoute(route)) return sarFallback(rawText)
  try {
    const parsed = asObject(await callJson(ctx, route, SAR_SYSTEM_PROMPT, frameSarInput(rawText), {
      ...options,
      maxTokens: 500,
    }), 'SAR')
    if (typeof parsed.situation !== 'string' || typeof parsed.action !== 'string' || typeof parsed.outcome !== 'string') {
      throw new CognitivePipelineError('cognitive-pipeline: SAR output missing string fields', 'SAR_SCHEMA_FAILED')
    }
    const utility = parsed.outcome_utility_score as {
      material_gain?: unknown
      emotional_valence?: unknown
      energy_cost?: unknown
    } | undefined
    const keywords = Array.isArray(parsed.action_keywords)
      ? parsed.action_keywords.filter((keyword): keyword is string => typeof keyword === 'string').slice(0, 16)
      : []
    // All three utility fields must be present and finite; a partial or
    // missing score is an extraction failure, not a neutral outcome — it
    // degrades to the fallback instead of silently diluting the clustering
    // axis with a fake 5/5/5.
    const materialGain = Number(utility?.material_gain)
    const emotionalValence = Number(utility?.emotional_valence)
    const energyCost = Number(utility?.energy_cost)
    if (!Number.isFinite(materialGain) || !Number.isFinite(emotionalValence) || !Number.isFinite(energyCost)) {
      throw new CognitivePipelineError('cognitive-pipeline: SAR output missing utility fields', 'SAR_UTILITY_FAILED')
    }
    return {
      situation: parsed.situation,
      action: parsed.action,
      outcome: parsed.outcome,
      actionKeywords: keywords.length > 0 ? keywords : [...new Set(tokenize(parsed.action))].slice(0, 8),
      outcomeUtility: {
        materialGain: clampUtility(materialGain),
        emotionalValence: clampUtility(emotionalValence),
        energyCost: clampUtility(energyCost),
      },
    }
  } catch (error) {
    ctx.logger.warn(`cognitive-pipeline: SAR extraction degraded to fallback: ${String(error)}`)
    return sarFallback(rawText)
  }
}

/** Deterministic template-2 fallback: trust the math-only OOD signal.
 * @param isKnown - the math-only decision.
 * @returns a review with 50% confidence.
 */
export function oodReviewFallback(isKnown: boolean): OodReview {
  return {
    isKnown,
    confidenceScore: 50,
    reasoningShort: '无模型复核（降级模式），仅依据数学相似度判定',
    suggestedInitialRiskLevel: isKnown ? 'low' : 'high',
  }
}

/**
 * Template 2: confirm or deny OOD. Falls back to the math-only decision.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param action - the proposed action text.
 * @param topActions - the top historical actions for review.
 * @param mathSaysKnown - the math-only OOD decision.
 * @param options - call context (session/signal/maxTokens).
 * @returns the review verdict.
 */
export async function reviewOod(
  ctx: Context,
  route: CognitiveLlmRoute,
  action: string,
  topActions: readonly { expId: string; action: string; similarity: number }[],
  mathSaysKnown: boolean,
  options: CallOptions,
): Promise<OodReview> {
  if (!hasExplicitRoute(route)) return oodReviewFallback(mathSaysKnown)
  try {
    const parsed = asObject(await callJson(ctx, route, OOD_REVIEW_SYSTEM_PROMPT, frameOodInput(action, topActions), {
      ...options,
      maxTokens: 300,
    }), 'OOD review')
    const isKnown = parsed.is_known === true || parsed.is_known === 'known'
    const confidence = Number(parsed.confidence_score)
    const risk = parsed.suggested_initial_risk_level
    return {
      isKnown,
      confidenceScore: Number.isFinite(confidence) ? Math.min(100, Math.max(0, Math.round(confidence))) : 50,
      reasoningShort: typeof parsed.reasoning_short === 'string' ? parsed.reasoning_short : '',
      suggestedInitialRiskLevel: risk === 'medium' || risk === 'high' ? risk : 'low',
    }
  } catch (error) {
    ctx.logger.warn(`cognitive-pipeline: OOD review degraded to fallback: ${String(error)}`)
    return oodReviewFallback(mathSaysKnown)
  }
}

/** Deterministic template-3 fallback: pure frequency prior with a wide interval.
 * @param positiveCount - positive history hits.
 * @param negativeCount - negative history hits.
 * @returns a fallback calibration output.
 */
export function calibrationFallback(
  positiveCount: number,
  negativeCount: number,
): CalibrationOutput {
  const total = positiveCount + negativeCount
  const base = total === 0 ? 0.5 : positiveCount / total
  const low = Math.max(0, base - 0.2)
  const high = Math.min(1, base + 0.2)
  return {
    baseSuccessRate: base,
    riskFactors: [],
    finalConfidenceIntervalLow: low,
    finalConfidenceIntervalHigh: high,
    finalCalibratedProbability: base,
    advicePreview: total === 0 ? '无历史样本，谨慎行动' : `历史成功率${Math.round(base * 100)}%`,
  }
}

/**
 * Template 3: five-layer calibration (frequency prior, adversarial factors,
 * interval output). Backend shrinkage and bucket correction happen in the hot
 * engine; this helper only covers the LLM-facing layers.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - the situation/action plus history statistics.
 * @param options - call context (session/signal/maxTokens).
 * @returns the calibration output.
 */
export async function calibrate(
  ctx: Context,
  route: CognitiveLlmRoute,
  input: {
    situation: string
    action: string
    context?: string | undefined
    positiveCount: number
    negativeCount: number
    samples: readonly { expId: string; actionKeywords: string; utility: string }[]
  },
  options: CallOptions,
): Promise<CalibrationOutput> {
  if (!hasExplicitRoute(route)) {
    return calibrationFallback(input.positiveCount, input.negativeCount)
  }
  try {
    const parsed = asObject(await callJson(ctx, route, CALIBRATION_SYSTEM_PROMPT, frameCalibrationInput(
      input.situation,
      input.action,
      input.context,
      input.positiveCount,
      input.negativeCount,
      input.samples,
    ), {
      ...options,
      maxTokens: 600,
    }), 'calibration')
    const base = Number(parsed.base_success_rate)
    const raw = Number(parsed.final_calibrated_probability)
    const low = Number(parsed.final_confidence_interval_low)
    const high = Number(parsed.final_confidence_interval_high)
    const advice = parsed.advice_preview
    const factors = Array.isArray(parsed.risk_factors)
      ? parsed.risk_factors.filter((factor): factor is string => typeof factor === 'string').slice(0, 5)
      : []
    const fallbackBase = input.positiveCount / Math.max(1, input.positiveCount + input.negativeCount)
    return {
      baseSuccessRate: clamp01(Number.isFinite(base) ? base / 100 : fallbackBase),
      riskFactors: factors,
      finalConfidenceIntervalLow: clamp01(Number.isFinite(low) ? low / 100 : 0.3),
      finalConfidenceIntervalHigh: clamp01(Number.isFinite(high) ? high / 100 : 0.7),
      finalCalibratedProbability: clamp01(Number.isFinite(raw) ? raw / 100 : 0.5),
      advicePreview: typeof advice === 'string' && advice.length > 0 ? advice.slice(0, 40) : '参考历史经验谨慎行动',
    }
  } catch (error) {
    ctx.logger.warn(`cognitive-pipeline: calibration degraded to fallback: ${String(error)}`)
    return calibrationFallback(input.positiveCount, input.negativeCount)
  }
}

/** Deterministic template-4 fallback: name clusters from utility means.
 * @param groups - the agglomerative groups with evidence and mean utility.
 * @param summaryShort - the fallback taxonomy summary.
 * @returns deterministic cluster output.
 */
export function reconstructFallback(
  groups: readonly { evidenceIds: readonly string[]; meanUtility: OutcomeUtility }[],
  summaryShort: string,
): ReconstructOutput {
  const newClusters: RawReconstructCluster[] = groups.map((group, index) => {
    const mean = group.meanUtility
    return {
      clusterName: `策略簇#${index + 1}（收益${mean.materialGain.toFixed(1)}/情绪${mean.emotionalValence.toFixed(1)}/代价${mean.energyCost.toFixed(1)}）`,
      decisionRule: `if 情境特征与簇${index + 1}相似 then 沿用簇内已验证行动`,
      expectedUtilityRange: {
        low: Math.max(0, mean.materialGain - 2),
        high: Math.min(10, mean.materialGain + 2),
      },
      supportingEvidenceIds: group.evidenceIds,
      fallbackAction: '降低行动强度并观察反馈',
    }
  })
  return { newClusters, taxonomySummaryShort: summaryShort }
}

/**
 * Template 4: causal-anchored taxonomy reconstruction. Falls back to
 * deterministic cluster naming when the model path is unavailable.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param samples - the sampled train experiences.
 * @param groups - the agglomerative groups with evidence and mean utility.
 * @param summaryShort - fallback taxonomy summary.
 * @param options - call context (session/signal/maxTokens).
 * @returns the reconstruction output.
 */
export async function reconstructTaxonomy(
  ctx: Context,
  route: CognitiveLlmRoute,
  samples: readonly Experience[],
  groups: readonly { evidenceIds: readonly string[]; meanUtility: OutcomeUtility }[],
  summaryShort: string,
  options: CallOptions,
): Promise<ReconstructOutput> {
  if (!hasExplicitRoute(route)) return reconstructFallback(groups, summaryShort)
  try {
    const parsed = asObject(await callJson(ctx, route, RECONSTRUCT_SYSTEM_PROMPT, frameReconstructInput(samples), {
      ...options,
      maxTokens: 4096,
    }), 'reconstruction')
    const rawClusters = Array.isArray(parsed.new_clusters) ? parsed.new_clusters : []
    const newClusters: RawReconstructCluster[] = []
    for (const raw of rawClusters) {
      if (typeof raw !== 'object' || raw === null) continue
      const cluster = raw as {
        cluster_name?: unknown
        decision_rule?: unknown
        expected_utility_range?: unknown
        supporting_evidence_ids?: unknown
        fallback_action?: unknown
      }
      if (typeof cluster.cluster_name !== 'string' || typeof cluster.decision_rule !== 'string') continue
      const range = cluster.expected_utility_range as { low?: unknown; high?: unknown } | undefined
      const evidence = Array.isArray(cluster.supporting_evidence_ids)
        ? cluster.supporting_evidence_ids.filter((id): id is string => typeof id === 'string')
        : []
      const low = Number(range?.low)
      const high = Number(range?.high)
      newClusters.push({
        clusterName: cluster.cluster_name,
        decisionRule: cluster.decision_rule,
        expectedUtilityRange: {
          low: Number.isFinite(low) ? Math.min(10, Math.max(0, low)) : 0,
          high: Number.isFinite(high) ? Math.min(10, Math.max(0, high)) : 10,
        },
        supportingEvidenceIds: evidence,
        fallbackAction: typeof cluster.fallback_action === 'string' ? cluster.fallback_action : '降低行动强度并观察反馈',
      })
    }
    const summary = parsed.taxonomy_summary_short
    return {
      newClusters,
      taxonomySummaryShort: typeof summary === 'string' && summary.length > 0 ? summary.slice(0, 60) : summaryShort,
    }
  } catch (error) {
    ctx.logger.warn(`cognitive-pipeline: taxonomy reconstruction degraded to fallback: ${String(error)}`)
    return reconstructFallback(groups, summaryShort)
  }
}

/** Deterministic template-5 fallback: reject accumulation (no route → no gate). */
export function accumulationFallback(): AccumulationDecision {
  return { shouldAccumulate: false, sar: null }
}

/**
 * Template 5: the accumulation gate. The LLM route judges whether a completed
 * turn is worth becoming an experience and extracts the SAR triplet when it is.
 * Without an explicit route the gate deterministically rejects — automatic
 * accumulation never runs unjudged.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param episode - the completed turn's situation/action/outcome material.
 * @param similar - retrieved history hits for the novelty judgment.
 * @param options - call context (session/signal/maxTokens).
 * @returns the accumulation decision.
 */
export async function evaluateAccumulation(
  ctx: Context,
  route: CognitiveLlmRoute,
  episode: { situation: string; action: string; outcome: string },
  similar: readonly { expId: string; text: string; similarity: number }[],
  options: CallOptions,
): Promise<AccumulationDecision> {
  if (!hasExplicitRoute(route)) return accumulationFallback()
  try {
    const parsed = asObject(await callJson(ctx, route, ACCUMULATE_SYSTEM_PROMPT, frameAccumulateInput(episode, similar), {
      ...options,
      maxTokens: 500,
    }), 'accumulation')
    const shouldAccumulate = parsed.should_accumulate === true
    if (!shouldAccumulate) return { shouldAccumulate: false, sar: null }
    const situation = parsed.situation
    const action = parsed.action
    const outcome = parsed.outcome
    const materialGain = Number(parsed.material_gain)
    const emotionalValence = Number(parsed.emotional_valence)
    const energyCost = Number(parsed.energy_cost)
    if (typeof situation !== 'string' || typeof action !== 'string' || typeof outcome !== 'string'
      || !Number.isFinite(materialGain) || !Number.isFinite(emotionalValence) || !Number.isFinite(energyCost)) {
      throw new CognitivePipelineError('cognitive-pipeline: accumulation output missing SAR fields', 'ACCUMULATE_SCHEMA_FAILED')
    }
    return {
      shouldAccumulate: true,
      sar: {
        situation,
        action,
        outcome,
        utility: {
          materialGain: clampUtility(materialGain),
          emotionalValence: clampUtility(emotionalValence),
          energyCost: clampUtility(energyCost),
        },
      },
    }
  } catch (error) {
    ctx.logger.warn(`cognitive-pipeline: accumulation gate degraded to fallback: ${String(error)}`)
    return accumulationFallback()
  }
}
