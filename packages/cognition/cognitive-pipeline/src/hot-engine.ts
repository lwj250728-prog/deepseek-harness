/**
 * Hot-loop engine: online prediction with OOD detection, branch routing
 * (familiar path vs novel path), and the five-layer confidence calibration.
 * All math is synchronous and fast; the only awaits are the best-effort LLM
 * assists (SAR-independent: OOD review and calibration).
 * @module @deepseek-ai/dsh-cognitive-pipeline/hot-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { calibrate, refineRetrieval, reviewOod } from './llm.ts'
import type { CognitiveLlmRoute } from './llm.ts'
import type { EmbeddingScorer } from './embedding.ts'
import { CognitiveStore } from './store.ts'
import type { ChannelWeights, Experience, Prediction, PredictInput, PredictResult, SuccessReference, TaxonomyContext, TempStrategy } from './types.ts'
import {
  ACTION_VECTOR_DIM,
  SYMPTOM_MARKERS,
  actionVector,
  cosine,
  outcomePolarity,
  signatureHash,
  symptomOverlap,
} from './vectorizer.ts'

/** Fully resolved engine thresholds (no optional fields). */
export interface HotEngineConfig {
  readonly topK: number
  readonly oodSimThreshold: number
  readonly oodFlatThreshold: number
  readonly oodSiThreshold: number
  readonly shrinkageAlpha: number
  readonly minConfidenceIntervalWidth: number
  /** Situation-centroid cosine at/above which a success cluster is returned as a reference strategy (default 0.4). */
  readonly successReferenceThreshold: number
  /** Situation-centroid cosine below which the taxonomy is considered uncovered (default 0.3). */
  readonly coverageThreshold: number
  /** Routing margin (best-minus-second-best cluster cosine) below which a
   * known-path prediction is treated as a retrieval failure and SAR-ized (default 0.1). */
  readonly retrievalFailureMargin: number
  /** EWMA step for the feedback-driven multi-channel retrieval weights (default 0.2). */
  readonly channelLearningRate: number
  /** Feedback error below which the dominant retrieval channel is rewarded,
   * at/above which it is penalized (default 0.3). */
  readonly channelErrorThreshold: number
  /** Bounded LLM-refine drops: how many inapplicable top candidates may be
   * removed in one prediction (default 2). */
  readonly refineMaxDrops: number
  /** Active-exploration daily budget (scheme 2, default 3). */
  readonly exploreDailyBudget: number
  /** Irreversible-action markers that exclude a novel attempt from the
   * exploration budget (scheme 2 safety gate). */
  readonly exploreRiskWords: readonly string[]
  /** Whether a reversible budgeted novel attempt also queues an autonomous
   * exploration task for a background session (default false). */
  readonly exploreAutoDispatch: boolean
  readonly tempStrategyTtlMs: number
  readonly tempStrategyMatchThreshold: number
}

/** The semantic retrieval channel's scoring seam. The default implementation
 * is the deterministic hash-bag cosine (the all-MiniLM-L6-v2 stand-in); a real
 * embedding provider can implement the same interface without touching the
 * fusion logic (see docs/v3 TR §3.7, roadmap R3). */
export interface SemanticScorer {
  /** Score how similar a query text is to one experience's action, [0,1]. */
  score(queryText: string, exp: Experience): number
}

/** Default semantic scorer: hashed bag-of-words cosine over the action text. */
export class HashSemanticScorer implements SemanticScorer {
  score(queryText: string, exp: Experience): number {
    return cosine(actionVector(queryText, []), exp.actionVector)
  }
}

/** One ranked history hit: `fused` orders the list, `similarity` keeps the
 * classic semantic cosine for OOD/advice consumers, `channelMax` is the
 * strongest raw channel score (the OOD novelty judgment — any channel strong
 * enough means history is relevant even when the semantic cosine is diluted),
 * and `channels` records the per-channel contributions (w_c · s_c) for
 * feedback learning. */
interface RankedHit {
  readonly exp: Experience
  /** Semantic-channel cosine (the classic similarity). */
  readonly similarity: number
  /** Strongest raw channel score of this hit, in [0, 1]. */
  readonly channelMax: number
  /** Fused multi-channel score; the ranking axis. */
  readonly fused: number
  /** Per-channel contributions in [semantic, situational, symptom, outcome] order. */
  readonly channels: readonly number[]
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
  private readonly scorer: SemanticScorer
  private readonly embedder: EmbeddingScorer | null

  constructor(
    ctx: Context,
    store: CognitiveStore,
    config: HotEngineConfig,
    route: CognitiveLlmRoute,
    scorer: SemanticScorer = new HashSemanticScorer(),
    embedder: EmbeddingScorer | null = null,
  ) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.route = route
    this.scorer = scorer
    this.embedder = embedder
  }

  /** Embed the query action once per prediction when the seam is enabled;
   * null on failure or when disabled (the hash-bag scorer then serves). */
  private async embedQuery(action: string): Promise<readonly number[] | null> {
    if (this.embedder === null) return null
    return this.embedder.embed(action)
  }

  /** Whether the query text itself carries any failure symptom marker. */
  private queryHasFailureMarker(queryText: string): boolean {
    const lower = queryText.toLowerCase()
    return SYMPTOM_MARKERS.some(marker => lower.includes(marker))
  }

  /** Raw per-channel scores (w-independent) of one experience for one query,
   * in [semantic, situational, symptom, outcome] order. The semantic channel
   * prefers the real-embedding cosine when the query embedding and the
   * experience's stored embedding both exist; otherwise it falls back to the
   * configured scorer (the hash-bag cosine by default).
   * @param exp - the candidate experience.
   * @param queryAction - the query action text.
   * @param situationVector - the precomputed query situation vector (null when the situation is empty).
   * @param queryText - action + situation, used for symptom/outcome channels.
   * @param queryEmbedding - the real-embedding vector of the query action, or null.
   * @returns the four raw channel scores.
   */
  private channelScores(
    exp: Experience,
    queryAction: string,
    situationVector: number[] | null,
    queryText: string,
    queryEmbedding: readonly number[] | null,
  ): readonly number[] {
    const semantic = queryEmbedding !== null && exp.embedding !== undefined
      ? cosine(queryEmbedding, exp.embedding)
      : this.scorer.score(queryAction, exp)
    const situational = situationVector === null
      ? 0
      : cosine(situationVector, actionVector(exp.sar.situation, []))
    const symptom = symptomOverlap(queryText, `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`)
    const outcome = this.queryHasFailureMarker(queryText) && outcomePolarity(exp.sar.outcomeUtility) === 'negative' ? 1 : 0
    return [semantic, situational, symptom, outcome]
  }

  /** Retrieve the top-K experiences by fused multi-channel similarity. The
   * semantic channel alone decides the classic similarity reported downstream;
   * the situational/symptom/outcome channels participate in the ranking, and
   * `channelMax` (the strongest raw channel score) feeds the OOD novelty
   * judgment so a strong situational/symptom hit is not drowned by a diluted
   * semantic cosine.
   * @param action - the proposed action text.
   * @param k - how many hits to return.
   * @param situation - the situation text, feeding the situational channel.
   * @param queryEmbedding - the real-embedding vector of the query action
   * (pre-fetched by the caller), or null to use the hash-bag scorer.
   * @returns ranked hits, best first.
   */
  retrieveTopK(action: string, k: number, situation = '', queryEmbedding: readonly number[] | null = null): RankedHit[] {
    const weights = this.store.channelWeightsSnapshot()
    const situationVector = situation.trim().length > 0 ? actionVector(situation, []) : null
    const queryText = `${action} ${situation}`.trim()
    const keys: readonly (keyof ChannelWeights)[] = ['semantic', 'situational', 'symptom', 'outcome']
    const scored = this.store.experiencesSnapshot()
      .map((exp) => {
        const raws = this.channelScores(exp, action, situationVector, queryText, queryEmbedding)
        const channels = raws.map((raw, index) => raw * weights[keys[index] ?? 'semantic'])
        return {
          exp,
          similarity: raws[0] ?? 0,
          channelMax: Math.max(...raws),
          fused: channels.reduce((sum, value) => sum + value, 0),
          channels,
        }
      })
    return scored
      .sort((a, b) => b.fused - a.fused)
      .slice(0, k)
      .map(hit => ({
        exp: hit.exp,
        similarity: hit.similarity,
        channelMax: hit.channelMax,
        fused: hit.fused,
        channels: hit.channels,
      }))
  }

  /** Detect OOD signals from the top-K similarity set. Novelty is judged on
   * each hit's strongest channel (`channelMax`): a diluted semantic cosine
   * must not declare history irrelevant when a situational or symptom channel
   * strongly matches the same experience.
   * @param ranked - the retrieved hits, best first.
   * @returns the strongest signal and the top-1 strength.
   */
  detectOod(ranked: readonly RankedHit[]): { signal: PredictResult['oodSignal']; top1: number } {
    const top1 = ranked[0]?.channelMax ?? 0
    if (ranked.length === 0) return { signal: 'low-similarity', top1 }
    const scores = ranked.map(hit => hit.channelMax)
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
    const queryEmbedding = await this.embedQuery(input.action)
    const ranked = this.retrieveTopK(input.action, this.config.topK, input.situation, queryEmbedding)
    const { signal: oodSignal, top1 } = this.detectOod(ranked)
    const taxonomyContext = this.taxonomyContext(input.situation)
    // Low-confidence deterministic routing triggers the LLM refine pass: the
    // route reads the fused candidates and may drop genuinely inapplicable
    // top hits (cosine similarity does not imply premise transferability).
    const { note: refineNote, ranked: refined } = await this.refineRetrieval(
      input, ranked, oodSignal, taxonomyContext, sessionId, signal,
    )
    const samples = refined.map(hit => hit.exp)
    const topChannels = refined[0] === undefined ? null : refined[0].channels

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

    const successReference = this.matchSuccessReference(input.situation)
    const adviceSuffix = this.taxonomyAdviceLine(taxonomyContext)
    if (isNovel) {
      return this.predictNovel(
        input, topChannels, sessionId, signal, oodSignal, top1, successReference, taxonomyContext, adviceSuffix, refineNote,
      )
    }
    return this.predictKnown(
      input, samples, topChannels, sessionId, signal, oodSignal, top1, successReference, taxonomyContext, adviceSuffix, refineNote,
    )
  }

  /**
   * LLM-refine the fused ranking when the deterministic routing is
   * low-confidence (thin taxonomy margin or flat-top OOD). The template-7
   * route judges whether the fused top hit genuinely applies; each rejection
   * removes that experience and re-ranks the survivors, bounded by
   * `refineMaxDrops`. Without a route (or when the route keeps the ranking)
   * the original ranking is returned untouched.
   * @param input - the query situation/action.
   * @param ranked - the fused ranking, best first.
   * @param oodSignal - the OOD signal from the original ranking.
   * @param taxonomyContext - the query's taxonomy routing.
   * @param sessionId - optional session identity for the LLM call.
   * @param signal - optional cancellation.
   * @returns the refinement note (null when nothing was dropped) and the refined ranking.
   */
  private async refineRetrieval(
    input: PredictInput,
    ranked: readonly RankedHit[],
    oodSignal: PredictResult['oodSignal'],
    taxonomyContext: TaxonomyContext,
    sessionId: GenerateOptions['sessionId'] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ note: string | null; ranked: RankedHit[] }> {
    const lowConfidence = (taxonomyContext.coverage === 'covered' && taxonomyContext.margin < this.config.retrievalFailureMargin)
      || oodSignal === 'flat-top'
    if (!lowConfidence || ranked.length === 0) return { note: null, ranked: [...ranked] }
    const remaining = new Set(ranked.map(hit => hit.exp.expId))
    const reasons: string[] = []
    let dropped = 0
    for (let attempt = 0; attempt < this.config.refineMaxDrops; attempt += 1) {
      const candidates = ranked.filter(hit => remaining.has(hit.exp.expId)).slice(0, 3)
      if (candidates.length === 0) break
      const decision = await refineRetrieval(this.ctx, this.route, {
        situation: input.situation,
        action: input.action,
      }, candidates.map(hit => ({
        expId: hit.exp.expId,
        text: `${hit.exp.sar.situation}。${hit.exp.sar.action}。${hit.exp.sar.outcome}`,
        similarity: hit.similarity,
      })), { sessionId, signal })
      if (decision.shouldKeep || decision.rejectedExpId === null) break
      if (!remaining.has(decision.rejectedExpId)) break
      remaining.delete(decision.rejectedExpId)
      dropped += 1
      if (decision.reason !== null && decision.reason.length > 0) reasons.push(decision.reason)
    }
    if (dropped === 0) return { note: null, ranked: [...ranked] }
    const note = ` | 检索复核：LLM 判定 Top1 不适用，已剔除 ${dropped} 条候选（${reasons.join('；') || '前提或情境不可迁移'}）`
    return { note, ranked: ranked.filter(hit => remaining.has(hit.exp.expId)) }
  }

  /**
   * Feedback-driven channel-weight learning (第一性原理 |calibrated−observed|):
   * the channel that dominated the fused top-1 at predict time is rewarded
   * when the prediction error is small and penalized when it is large, via an
   * EWMA step clamped to [0.2, 3]. Channels that keep surfacing the
   * actually-relevant experience grow; channels that pull in noise shrink.
   * @param prediction - the resolved prediction carrying its fusion record.
   * @param error - the absolute prediction error |calibrated − observed|.
   */
  learnFromFeedback(prediction: Prediction, error: number): void {
    const fusion = prediction.fusion
    if (fusion === null || fusion.scores.length !== 4) return
    const weights = this.store.channelWeightsSnapshot()
    let dominant = 0
    for (let index = 1; index < fusion.scores.length; index += 1) {
      const score = fusion.scores[index] ?? 0
      if (score > (fusion.scores[dominant] ?? 0)) dominant = index
    }
    const lr = this.config.channelLearningRate
    const target = error < this.config.channelErrorThreshold ? 1.6 : 0.5
    const updated: Record<keyof ChannelWeights, number> = {
      semantic: weights.semantic,
      situational: weights.situational,
      symptom: weights.symptom,
      outcome: weights.outcome,
    }
    const keys: readonly (keyof ChannelWeights)[] = ['semantic', 'situational', 'symptom', 'outcome']
    const key = keys[dominant]
    if (key === undefined) return
    updated[key] = Math.min(3, Math.max(0.2, weights[key] + lr * (target - weights[key])))
    this.store.updateChannelWeights(updated)
  }

  /**
   * Consult the taxonomy during retrieval: match the query situation against
   * every cluster's situation centroid (any polarity), report the routed
   * region, the routing confidence (best-minus-second-best margin), and
   * whether SAR has coverage there. This is the structural layer of the
   * pipeline's self-knowledge — retrieval knows what SAR contains before it
   * scans the experience store.
   * @param situation - the query situation text.
   * @returns the taxonomy context for this query.
   */
  private taxonomyContext(situation: string): TaxonomyContext {
    const clusters = this.store.clustersSnapshot().filter(cluster => cluster.situationCentroid.length === ACTION_VECTOR_DIM)
    if (clusters.length === 0) {
      return { cluster: null, similarity: 0, margin: 0, coverage: 'no-taxonomy' }
    }
    const vector = actionVector(situation, [])
    const scored = clusters
      .map(cluster => ({ cluster, score: cosine(vector, cluster.situationCentroid) }))
      .sort((a, b) => b.score - a.score)
    const best = scored[0]
    if (best === undefined || best.score < this.config.coverageThreshold) {
      return {
        cluster: null,
        similarity: best?.score ?? 0,
        margin: 0,
        coverage: 'gap',
      }
    }
    const runner = scored[1]
    return {
      cluster: {
        clusterId: best.cluster.clusterId,
        name: best.cluster.name,
        decisionRule: best.cluster.decisionRule,
        polarity: best.cluster.polarity,
      },
      similarity: best.score,
      margin: best.score - (runner?.score ?? 0),
      coverage: 'covered',
    }
  }

  /** Compact retrieval-advice line appended to the advice text. */
  private taxonomyAdviceLine(context: TaxonomyContext): string {
    if (context.coverage === 'no-taxonomy') return ' | 检索建议：分类体系尚未建立，按全新现象处理'
    if (context.coverage === 'gap') {
      return ` | 检索建议：情境落在分类覆盖缺口（最高相似度 ${context.similarity.toFixed(3)} < ${this.config.coverageThreshold}），SAR 无相关经验`
    }
    const confidence = context.margin < this.config.retrievalFailureMargin ? '，路由置信低' : ''
    return ` | 检索建议：命中簇「${context.cluster?.name.slice(0, 24) ?? '?'}」（相似度 ${context.similarity.toFixed(3)}，路由余量 ${context.margin.toFixed(3)}${confidence}）`
  }

  /** Match the current situation against proven success clusters. Returns the
   * closest success cluster whose situation centroid clears the threshold, so
   * the model can reference a proven strategy even when the action itself is
   * novel.
   * @param situation - the current situation text.
   * @returns the matched success reference, or null.
   */
  private matchSuccessReference(situation: string): SuccessReference | null {
    const vector = actionVector(situation, [])
    let best: SuccessReference | null = null
    let bestScore = this.config.successReferenceThreshold
    for (const cluster of this.store.clustersSnapshot()) {
      if (cluster.polarity !== 'success') continue
      if (cluster.situationCentroid.length !== ACTION_VECTOR_DIM) continue
      const score = cosine(vector, cluster.situationCentroid)
      if (score >= bestScore) {
        bestScore = score
        best = {
          clusterId: cluster.clusterId,
          clusterName: cluster.name,
          decisionRule: cluster.decisionRule,
          utilityRange: { ...cluster.expectedUtilityRange },
        }
      }
    }
    return best
  }

  /** Novel branch: scratchpad lookup or creation, conservative calibration. */
  private async predictNovel(
    input: PredictInput,
    topChannels: readonly number[] | null,
    sessionId: GenerateOptions['sessionId'] | undefined,
    signal: AbortSignal | undefined,
    oodSignal: PredictResult['oodSignal'],
    top1: number,
    successReference: SuccessReference | null,
    taxonomyContext: TaxonomyContext,
    adviceSuffix: string,
    refineNote: string | null,
  ): Promise<PredictResult> {
    const hash = String(signatureHash(input.action))
    const expired = this.store.expireTempStrategies()
    // ROI tracking: strategies that expired never graduated — a failed
    // exploration attempt.
    for (const expiredHash of expired) this.store.resolveExploration(expiredHash, 'expired')
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
      // Active exploration (scheme 2): a novel scratchpad creation counts
      // against the daily curiosity budget ONLY when the action is reversible
      // (safety gate) and the window has budget left. Irreversible actions
      // still get a scratchpad but are never flagged as exploration.
      const reversible = !this.config.exploreRiskWords.some(word => input.action.includes(word))
      const exploration = this.store.explorationSnapshot()
      const budgetLeft = exploration.used < this.config.exploreDailyBudget
      if (reversible && budgetLeft) {
        this.store.recordExploration({
          ts: Date.now(),
          action: input.action,
          scratchpadHash: hash,
          reversible: true,
          outcome: null,
        })
        // Autonomous dispatch: queue a background exploration task so a
        // scheduler session can silently execute the attempt and write the
        // result back as experience.
        if (this.config.exploreAutoDispatch) {
          this.store.addExplorationTask(`探索行动：${input.action}\n情境：${input.situation}`)
        }
      }
      const budgetNote = reversible
        ? (budgetLeft
          ? `主动探索（今日预算 ${exploration.used + 1}/${this.config.exploreDailyBudget}）`
          : '探索预算已耗尽，本次谨慎试探')
        : '动作不可逆，不纳入主动探索预算'
      advice = `⚠️ 全新现象：历史库无匹配（Top1相似度 ${top1.toFixed(3)}，信号 ${oodSignal}）。建议小步试探：${calibration.advicePreview} | ${budgetNote}`
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
    if (successReference !== null) {
      advice += ` | 参照成功策略（簇「${successReference.clusterName}」）：${successReference.decisionRule}`
    }
    if (refineNote !== null) advice += refineNote
    advice += adviceSuffix

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
      // A novel prediction with a fused top hit still records its channel
      // contributions, so the feedback loop can reward/penalize the channel
      // that surfaced the (possibly useful) near-miss.
      fusion: topChannels === null ? null : { scores: [...topChannels] },
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
      successReference,
      taxonomyContext,
    }
  }

  /** Familiar branch: five-layer calibration over the top-K samples. */
  private async predictKnown(
    input: PredictInput,
    samples: readonly Experience[],
    topChannels: readonly number[] | null,
    sessionId: GenerateOptions['sessionId'] | undefined,
    signal: AbortSignal | undefined,
    oodSignal: PredictResult['oodSignal'],
    _top1: number,
    successReference: SuccessReference | null,
    taxonomyContext: TaxonomyContext,
    adviceSuffix: string,
    refineNote: string | null,
  ): Promise<PredictResult> {
    const positive = samples.filter(exp => outcomePolarity(exp.sar.outcomeUtility) === 'positive').length
    // Neutral experiences carry no net utility signal; they must not be
    // counted as failures when they merely lack a distinguishable score.
    const negative = samples.filter(exp => outcomePolarity(exp.sar.outcomeUtility) === 'negative').length
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
        ...exp.meta === true ? { meta: true } : {},
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
    if (successReference !== null) {
      advice += ` | 参照成功策略（簇「${successReference.clusterName}」）：${successReference.decisionRule}`
    }
    if (refineNote !== null) advice += refineNote
    advice += adviceSuffix

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
      fusion: nearest === undefined || topChannels === null ? null : { scores: [...topChannels] },
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
      successReference,
      taxonomyContext,
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
