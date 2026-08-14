/**
 * Hot-loop engine: online prediction with OOD detection, branch routing
 * (familiar path vs novel path), and the five-layer confidence calibration.
 * All math is synchronous and fast; the only awaits are the best-effort LLM
 * assists (SAR-independent: OOD review and calibration).
 * @module @deepseek-ai/dsh-cognitive-pipeline/hot-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { calibrate, reviewOod } from './llm.ts'
import type { CognitiveLlmRoute } from './llm.ts'
import { CognitiveStore } from './store.ts'
import type { Experience, PredictInput, PredictResult, TempStrategy } from './types.ts'
import { actionVector, cosine, isPositiveOutcome, signatureHash } from './vectorizer.ts'

/** Fully resolved engine thresholds (no optional fields). */
export interface HotEngineConfig {
  readonly topK: number
  readonly oodSimThreshold: number
  readonly oodFlatThreshold: number
  readonly oodSiThreshold: number
  readonly shrinkageAlpha: number
  readonly minConfidenceIntervalWidth: number
  readonly tempStrategyTtlMs: number
  readonly tempStrategyMatchThreshold: number
}

/** One ranked history hit. */
interface RankedHit {
  readonly exp: Experience
  readonly similarity: number
}

/** Mean and variance of the top-K similarity set. */
function similarityStats(scores: readonly number[]): { mean: number; variance: number } {
  if (scores.length === 0) return { mean: 0, variance: 0 }
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length
  const variance = scores.reduce((sum, score) => sum + (score - mean) * (score - mean), 0) / scores.length
  return { mean, variance }
}

/** Clamp a probability into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Widen an interval symmetrically until it reaches the minimum width. This is
 * computed arithmetically (no loop) so floating-point underflow can never
 * stall it: when one side is pinned by the [0,1] clamp, the free side takes
 * all remaining slack.
 */
function widenInterval(low: number, high: number, minWidth: number): { low: number; high: number } {
  const lo = low
  const hi = high
  const width = hi - lo
  if (width >= minWidth) return { low: lo, high: hi }
  const missing = minWidth - width
  const lower = clamp01(lo - missing / 2)
  const upper = clamp01(hi + missing / 2)
  const gained = (lo - lower) + (upper - hi)
  if (gained >= missing - 1e-12) return { low: lower, high: upper }
  if (lower === 0 && upper < 1) return { low: 0, high: Math.min(1, minWidth) }
  if (upper === 1 && lower > 0) return { low: Math.max(0, 1 - minWidth), high: 1 }
  return { low: 0, high: 1 }
}

/**
 * Hot-loop engine. Constructed once per service; `predict` is the online
 * entry point.
 */
export class HotEngine {
  private readonly ctx: Context
  private readonly store: CognitiveStore
  private readonly config: HotEngineConfig
  private readonly route: CognitiveLlmRoute

  constructor(ctx: Context, store: CognitiveStore, config: HotEngineConfig, route: CognitiveLlmRoute) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.route = route
  }

  /** Retrieve the top-K experiences by action-vector cosine similarity.
   * @param action - the proposed action text.
   * @param k - how many hits to return.
   * @returns ranked hits, best first.
   */
  retrieveTopK(action: string, k: number): RankedHit[] {
    const vector = actionVector(action, [])
    return this.store.experiencesSnapshot()
      .map(exp => ({ exp, similarity: cosine(vector, exp.actionVector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
  }

  /** Detect OOD signals from the top-K similarity set.
   * @param ranked - the retrieved hits, best first.
   * @returns the strongest signal and the top-1 similarity.
   */
  detectOod(ranked: readonly RankedHit[]): { signal: PredictResult['oodSignal']; top1: number } {
    const top1 = ranked[0]?.similarity ?? 0
    if (ranked.length === 0) return { signal: 'low-similarity', top1 }
    const scores = ranked.map(hit => hit.similarity)
    const spread = scores.length >= 3 ? (scores[0] ?? 0) - (scores[2] ?? 0) : 0
    const { mean, variance } = similarityStats(scores)
    const strangeness = variance / (mean + 1e-9)
    if (top1 < this.config.oodSimThreshold) return { signal: 'low-similarity', top1 }
    // Flat-top flags ambiguous retrieval: indistinguishable top scores below a
    // near-exact match. A perfect match (top1 ≈ 1) is clearly known.
    if (spread < this.config.oodFlatThreshold && top1 < 0.85) return { signal: 'flat-top', top1 }
    if (strangeness > this.config.oodSiThreshold) return { signal: 'high-strangeness', top1 }
    return { signal: 'none', top1 }
  }

  /**
   * Run one hot-loop prediction.
   * @param input - the situation/action to predict.
   * @param sessionId - optional session identity for LLM-assisted calls.
   * @param signal - optional cancellation for LLM-assisted calls.
   * @returns the calibrated prediction result.
   */
  async predict(input: PredictInput, sessionId?: GenerateOptions['sessionId'], signal?: AbortSignal): Promise<PredictResult> {
    const ranked = this.retrieveTopK(input.action, this.config.topK)
    const { signal: oodSignal, top1 } = this.detectOod(ranked)
    const samples = ranked.map(hit => hit.exp)

    // Math-only OOD suspicion: any signal means the LLM (or its fallback)
    // confirms novelty unless the review overrides it.
    let isNovel = oodSignal !== 'none'
    if (oodSignal !== 'none' && ranked.length > 0) {
      const review = await reviewOod(
        this.ctx,
        this.route,
        input.action,
        ranked.slice(0, 3).map(hit => ({ expId: hit.exp.expId, action: hit.exp.sar.action, similarity: hit.similarity })),
        !isNovel,
        { sessionId, signal },
      )
      isNovel = !review.isKnown
    }

    if (isNovel) {
      return this.predictNovel(input, sessionId, signal, oodSignal, top1)
    }
    return this.predictKnown(input, samples, sessionId, signal, oodSignal, top1)
  }

  /** Novel branch: scratchpad lookup or creation, conservative calibration. */
  private async predictNovel(
    input: PredictInput,
    sessionId: GenerateOptions['sessionId'] | undefined,
    signal: AbortSignal | undefined,
    oodSignal: PredictResult['oodSignal'],
    top1: number,
  ): Promise<PredictResult> {
    const hash = String(signatureHash(input.action))
    this.store.expireTempStrategies()
    let strategy = this.store.getTempStrategy(hash)
    let usedTempStrategy = false

    if (strategy !== undefined && strategy.status === 'active') {
      usedTempStrategy = true
      strategy = this.store.updateTempStrategy(hash, {
        hitCount: strategy.hitCount + 1,
        pendingResult: null,
      })
    }

    // Model-assisted experimental plan; zero-sample calibration produces a
    // deliberately wide interval. Fallback keeps the 0.5 baseline.
    const calibration = await calibrate(this.ctx, this.route, {
      situation: input.situation,
      action: input.action,
      context: input.context,
      positiveCount: 0,
      negativeCount: 0,
      samples: [],
    }, { sessionId, signal })

    const raw = calibration.finalCalibratedProbability
    const shrunk = this.shrink(raw, 0)
    const widened = widenInterval(
      clamp01(calibration.finalConfidenceIntervalLow),
      clamp01(calibration.finalConfidenceIntervalHigh),
      this.config.minConfidenceIntervalWidth,
    )

    let advice: string
    if (usedTempStrategy && strategy !== undefined) {
      advice = `⚠️ 全新现象（命中临时试行方案）：${strategy.trialAction}。此为临时试行方案，尚未晋升为主记忆。`
    } else {
      advice = `⚠️ 全新现象：历史库无匹配（Top1相似度 ${top1.toFixed(3)}，信号 ${oodSignal}）。建议小步试探：${calibration.advicePreview}`
      this.store.addTempStrategy({
        signatureHash: hash,
        trialAction: input.action,
        pendingResult: null,
        hitCount: 1,
        positiveCount: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.tempStrategyTtlMs,
        status: 'active',
        sourceExpId: null,
      })
    }

    const predictionId = this.store.nextPredictionId()
    this.store.addPrediction({
      predictionId,
      expId: null,
      situation: input.situation,
      action: input.action,
      predictedOutcome: advice,
      rawProbability: raw,
      calibratedProbability: shrunk,
      confidenceLow: widened.low,
      confidenceHigh: widened.high,
      isNovel: true,
      usedTempStrategy,
      clusterId: null,
      timestamp: Date.now(),
      actualOutcome: null,
      predictionError: null,
      resolvedAt: null,
    })

    return {
      predictionId,
      advice,
      rawProbability: raw,
      calibratedProbability: shrunk,
      confidenceLow: widened.low,
      confidenceHigh: widened.high,
      isNovel: true,
      oodSignal,
      topHitCount: 0,
      usedTempStrategy,
      clusterId: null,
    }
  }

  /** Familiar branch: five-layer calibration over the top-K samples. */
  private async predictKnown(
    input: PredictInput,
    samples: readonly Experience[],
    sessionId: GenerateOptions['sessionId'] | undefined,
    signal: AbortSignal | undefined,
    oodSignal: PredictResult['oodSignal'],
    _top1: number,
  ): Promise<PredictResult> {
    const positive = samples.filter(exp => isPositiveOutcome(exp.sar.outcomeUtility)).length
    const negative = samples.length - positive
    const k = samples.length

    // Layer 1 (frequency prior injection) + Layer 4 (adversarial factors) live
    // inside the template-3 prompt; this call returns the model's raw output.
    const calibration = await calibrate(this.ctx, this.route, {
      situation: input.situation,
      action: input.action,
      context: input.context,
      positiveCount: positive,
      negativeCount: negative,
      samples: samples.slice(0, Math.min(samples.length, 10)).map(exp => ({
        expId: exp.expId,
        actionKeywords: exp.sar.actionKeywords.join(','),
        utility: `${exp.sar.outcomeUtility.materialGain}/${exp.sar.outcomeUtility.emotionalValence}/${exp.sar.outcomeUtility.energyCost}`,
      })),
    }, { sessionId, signal })

    const raw = clamp01(calibration.finalCalibratedProbability)
    // Layer 2: sample-size shrinkage toward the 0.5 ignorance line.
    const shrunk = this.shrink(raw, k)
    // Layer 3: enforce the minimum interval width.
    const widened = widenInterval(
      clamp01(calibration.finalConfidenceIntervalLow),
      clamp01(calibration.finalConfidenceIntervalHigh),
      this.config.minConfidenceIntervalWidth,
    )
    // Layer 5: lifetime bucket correction, smoothed against the shrunk value.
    const empirical = this.store.empiricalAccuracyFor(shrunk)
    const finalProbability = empirical === null ? shrunk : clamp01(0.7 * shrunk + 0.3 * empirical)

    const nearest = samples[0]
    const clusterId = nearest === undefined ? null : nearest.clusterId
    const clusterLabel = nearest === undefined || nearest.strategyLabel === null
      ? null
      : nearest.strategyLabel

    let advice = calibration.advicePreview
    if (calibration.riskFactors.length > 0) {
      advice += ` | 风险因素：${calibration.riskFactors.slice(0, 3).join('；')}`
    }
    if (clusterLabel !== null) {
      advice = `[簇:${clusterLabel}] ${advice}`
    }

    const predictionId = this.store.nextPredictionId()
    this.store.addPrediction({
      predictionId,
      expId: nearest === undefined ? null : nearest.expId,
      situation: input.situation,
      action: input.action,
      predictedOutcome: advice,
      rawProbability: raw,
      calibratedProbability: finalProbability,
      confidenceLow: widened.low,
      confidenceHigh: widened.high,
      isNovel: false,
      usedTempStrategy: false,
      clusterId,
      timestamp: Date.now(),
      actualOutcome: null,
      predictionError: null,
      resolvedAt: null,
    })

    return {
      predictionId,
      advice,
      rawProbability: raw,
      calibratedProbability: finalProbability,
      confidenceLow: widened.low,
      confidenceHigh: widened.high,
      isNovel: false,
      oodSignal,
      topHitCount: k,
      usedTempStrategy: false,
      clusterId,
    }
  }

  /** Layer-2 shrinkage: P_cal = (k/(k+α))·P_raw + (α/(k+α))·0.5. */
  private shrink(raw: number, k: number): number {
    const alpha = this.config.shrinkageAlpha
    return clamp01((k / (k + alpha)) * raw + (alpha / (k + alpha)) * 0.5)
  }

  /** Find an active scratchpad strategy loosely matching one action.
   * @param action - the action text to match.
   * @returns the matching active strategy, or undefined.
   */
  findMatchingTempStrategy(action: string): TempStrategy | undefined {
    const hash = String(signatureHash(action))
    this.store.expireTempStrategies()
    return this.store.tempStrategiesSnapshot().find(strategy =>
      strategy.status === 'active'
      && (strategy.signatureHash === hash
        || cosine(actionVector(action, []), actionVector(strategy.trialAction, [])) >= this.config.tempStrategyMatchThreshold))
  }
}
