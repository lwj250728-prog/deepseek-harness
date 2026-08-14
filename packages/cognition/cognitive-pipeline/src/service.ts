/**
 * CognitivePipelineService: the pipeline's public service. It owns the store
 * and both engines, and exposes the online (`remember`/`predict`/`report`),
 * offline (`rebuild`), and observational (`inspect`) entry points the tools
 * and other plugins call. Extends Cordis `Service`, so loading the plugin
 * provides `ctx.cognitivePipeline`.
 * @module @deepseek-ai/dsh-cognitive-pipeline/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ColdEngine } from './cold-engine.ts'
import type { ColdEngineConfig } from './cold-engine.ts'
import { HotEngine } from './hot-engine.ts'
import type { HotEngineConfig } from './hot-engine.ts'
import { CognitivePipelineError, extractSar, resolveRoute } from './llm.ts'
import type { CognitiveLlmRoute } from './llm.ts'
import { cognitionPrefix } from './prompts.ts'
import { CognitiveStore } from './store.ts'
import type {
  CalibrationBucket,
  Cluster,
  Experience,
  FeedbackInput,
  FeedbackResult,
  InspectResult,
  OutcomeUtility,
  PredictInput,
  PredictResult,
  RebuildResult,
  RememberInput,
  SarTriplet,
  TaxonomyState,
  TempStrategy,
} from './types.ts'
import { actionVector, isPositiveOutcome, outcomeVector, utilityScore } from './vectorizer.ts'

/** Plugin configuration (all fields optional; engine defaults apply). */
export interface CognitivePipelineConfig {
  /** Store directory; default `<dshHome>/cognitive-pipeline`. */
  root?: string
  /** Explicit LLM provider route; must be paired with `model`. */
  provider?: string
  /** Explicit LLM model id; must be paired with `provider`. */
  model?: string
  /** False disables tool registration while keeping the service loadable. */
  enabled?: boolean
  /** Hot-loop retrieval depth (default 10). */
  topK?: number
  /** OOD low-similarity threshold (default 0.65). */
  oodSimThreshold?: number
  /** OOD flat-top spread threshold (default 0.1). */
  oodFlatThreshold?: number
  /** OOD strangeness-index threshold (default 1.5). */
  oodSiThreshold?: number
  /** Scratchpad TTL in milliseconds (default 24h). */
  tempStrategyTtlMs?: number
  /** Scratchpad graduation hit count (default 3). */
  tempStrategyHitThreshold?: number
  /** Scratchpad graduation positive ratio (default 0.667). */
  tempStrategyPositiveRatio?: number
  /** Scratchpad fuzzy-match cosine (default 0.5). */
  tempStrategyMatchThreshold?: number
  /** Layer-2 shrinkage alpha (default 50). */
  shrinkageAlpha?: number
  /** Minimum 80%-interval width (default 0.2). */
  minConfidenceIntervalWidth?: number
  /** Cold-loop time-decay lambda per day (default 0.01). */
  decayLambda?: number
  /** Cold-loop minimum decay weight (default 0.1). */
  minDecayWeight?: number
  /** Cold-loop prediction-error inclusion threshold (default 0.3). */
  predictionErrorThreshold?: number
  /** Cold-loop max sample ratio of the population (default 0.15). */
  maxSampleRatio?: number
  /** Evidence hard-constraint minimum count (default 3). */
  evidenceMinCount?: number
  /** Evidence hard-constraint max pairwise cosine distance (default 0.85). */
  evidenceMaxDistance?: number
  /** Sandbox acceptance: required error reduction ratio (default 0.15). */
  sandboxImprovement?: number
  /** Validation slice ratio of the sampled set (default 0.2). */
  validationRatio?: number
  /** Agglomerative merge cosine threshold (default 0.4). */
  clusterMergeCosine?: number
  /** Cluster-membership cosine threshold (default 0.3). */
  clusterMatchCosine?: number
  /** Feedback error at/above which an emergency local rebuild fires (default 0.8). */
  emergencyErrorThreshold?: number
}

/** Resolved configuration with every optional field materialized. */
export interface ResolvedCognitivePipelineConfig {
  readonly root: string
  readonly enabled: boolean
  readonly route: CognitiveLlmRoute
  readonly hot: HotEngineConfig
  readonly cold: ColdEngineConfig
  readonly tempStrategyHitThreshold: number
  readonly tempStrategyPositiveRatio: number
  readonly emergencyErrorThreshold: number
}

/** Config schema for Loader validation and defaulting. */
export const Config: z<CognitivePipelineConfig> = z.object({
  root: z.string(),
  provider: z.string(),
  model: z.string(),
  enabled: z.boolean().default(true),
  topK: z.number().step(1).min(1).max(50).default(10),
  oodSimThreshold: z.number().min(0).max(1).default(0.65),
  oodFlatThreshold: z.number().min(0).max(1).default(0.1),
  oodSiThreshold: z.number().min(0).default(1.5),
  tempStrategyTtlMs: z.number().step(1).min(60_000).default(24 * 60 * 60 * 1000),
  tempStrategyHitThreshold: z.number().step(1).min(1).default(3),
  tempStrategyPositiveRatio: z.number().min(0).max(1).default(0.667),
  tempStrategyMatchThreshold: z.number().min(0).max(1).default(0.5),
  shrinkageAlpha: z.number().min(0).default(50),
  minConfidenceIntervalWidth: z.number().min(0).max(1).default(0.2),
  decayLambda: z.number().min(0).default(0.01),
  minDecayWeight: z.number().min(0).max(1).default(0.1),
  predictionErrorThreshold: z.number().min(0).max(1).default(0.3),
  maxSampleRatio: z.number().min(0.01).max(1).default(0.15),
  evidenceMinCount: z.number().step(1).min(1).default(3),
  evidenceMaxDistance: z.number().min(0).max(1).default(0.85),
  sandboxImprovement: z.number().min(0).max(1).default(0.15),
  validationRatio: z.number().min(0.01).max(0.5).default(0.2),
  clusterMergeCosine: z.number().min(0).max(1).default(0.4),
  clusterMatchCosine: z.number().min(0).max(1).default(0.3),
  emergencyErrorThreshold: z.number().min(0).max(1).default(0.8),
})

/** Validate an untrusted config object without Loader normalization.
 * @param config - untrusted plugin configuration.
 * @returns the resolved immutable configuration.
 */
export function resolveConfig(config: CognitivePipelineConfig): ResolvedCognitivePipelineConfig {
  const route = resolveRoute({ provider: config.provider, model: config.model })
  const root = config.root ?? dshHomePath('cognitive-pipeline')
  return Object.freeze({
    root,
    enabled: config.enabled ?? true,
    route,
    hot: Object.freeze({
      topK: config.topK ?? 10,
      oodSimThreshold: config.oodSimThreshold ?? 0.65,
      oodFlatThreshold: config.oodFlatThreshold ?? 0.1,
      oodSiThreshold: config.oodSiThreshold ?? 1.5,
      shrinkageAlpha: config.shrinkageAlpha ?? 50,
      minConfidenceIntervalWidth: config.minConfidenceIntervalWidth ?? 0.2,
      tempStrategyTtlMs: config.tempStrategyTtlMs ?? 24 * 60 * 60 * 1000,
      tempStrategyMatchThreshold: config.tempStrategyMatchThreshold ?? 0.5,
    }),
    cold: Object.freeze({
      decayLambda: config.decayLambda ?? 0.01,
      minDecayWeight: config.minDecayWeight ?? 0.1,
      predictionErrorThreshold: config.predictionErrorThreshold ?? 0.3,
      maxSampleRatio: config.maxSampleRatio ?? 0.15,
      evidenceMinCount: config.evidenceMinCount ?? 3,
      evidenceMaxDistance: config.evidenceMaxDistance ?? 0.85,
      sandboxImprovement: config.sandboxImprovement ?? 0.15,
      validationRatio: config.validationRatio ?? 0.2,
      clusterMergeCosine: config.clusterMergeCosine ?? 0.4,
      clusterMatchCosine: config.clusterMatchCosine ?? 0.3,
    }),
    tempStrategyHitThreshold: config.tempStrategyHitThreshold ?? 3,
    tempStrategyPositiveRatio: config.tempStrategyPositiveRatio ?? 0.667,
    emergencyErrorThreshold: config.emergencyErrorThreshold ?? 0.8,
  })
}

/** Durable prediction/experience context for LLM-assisted calls. */
export interface PipelineCallContext {
  readonly sessionId?: GenerateOptions['sessionId']
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cognitivePipeline: CognitivePipelineService
  }
}

/** Neutral utility marker used to detect "no information" extraction. */
function isNeutralUtility(utility: OutcomeUtility): boolean {
  return utility.materialGain === 5 && utility.emotionalValence === 5 && utility.energyCost === 5
}

/** The pipeline service. */
export class CognitivePipelineService extends Service {
  static readonly Config = Config

  /** Resolved configuration. */
  readonly resolved: ResolvedCognitivePipelineConfig
  /** The file-backed store (public for inspection). */
  readonly store: CognitiveStore
  /** Hot-loop engine. */
  readonly hot: HotEngine
  /** Cold-loop engine. */
  readonly cold: ColdEngine

  private readonly readinessPromise: Promise<void>

  constructor(ctx: Context, config: CognitivePipelineConfig = {}) {
    super(ctx, 'cognitivePipeline')
    this.resolved = resolveConfig(config)
    this.store = new CognitiveStore(this.resolved.root)
    this.hot = new HotEngine(ctx, this.store, this.resolved.hot, this.resolved.route)
    this.cold = new ColdEngine(ctx, this.store, this.resolved.cold, this.resolved.route)
    this.readinessPromise = this.store.load().catch((error: unknown) => {
      this.ctx.logger.warn(`cognitive-pipeline: store load failed, continuing in-memory: ${String(error)}`)
    })
  }

  /** Resolve after the store finished loading (never rejects). */
  async ready(): Promise<void> {
    await this.readinessPromise
  }

  /** Flush all pending persistence writes. */
  async flush(): Promise<void> {
    await this.store.flush()
  }

  /** Encode one raw experience into SAR, vectorize, and store it.
   * @param input - the raw experience text.
   * @param call - optional session/signal context.
   * @returns the new experience id and its SAR triplet.
   */
  async remember(input: RememberInput, call?: PipelineCallContext): Promise<{ expId: string; sar: SarTriplet }> {
    if (input.rawText.trim().length === 0) {
      throw new CognitivePipelineError('cognitive-pipeline: rawText must not be empty', 'EMPTY_RAW_TEXT')
    }
    const sar = await extractSar(this.ctx, this.resolved.route, input.rawText, {
      sessionId: call?.sessionId,
      signal: call?.signal,
    })
    const expId = this.store.nextExpId()
    const exp: Experience = {
      expId,
      sar,
      actionVector: actionVector(sar.action, sar.actionKeywords),
      outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
      clusterId: null,
      strategyLabel: null,
      timestamp: Date.now(),
      predictionError: null,
      cumulativeError: 0,
      hitCount: 0,
      positiveCount: 0,
    }
    this.store.addExperience(exp)
    await this.store.flush()
    return { expId, sar }
  }

  /** Hot-loop prediction.
   * @param input - the situation/action to predict.
   * @param call - optional session/signal context.
   * @returns the calibrated prediction result.
   */
  async predict(input: PredictInput, call?: PipelineCallContext): Promise<PredictResult> {
    if (input.situation.trim().length === 0 || input.action.trim().length === 0) {
      throw new CognitivePipelineError('cognitive-pipeline: situation and action must not be empty', 'EMPTY_PREDICT_INPUT')
    }
    const result = await this.hot.predict(input, call?.sessionId, call?.signal)
    await this.store.flush()
    return result
  }

  /** Feedback loop: resolve a prediction, update calibration and scratchpad.
   * @param input - the prediction id and actual outcome.
   * @param call - optional session/signal context.
   * @returns the logged feedback result.
   */
  async report(input: FeedbackInput, call?: PipelineCallContext): Promise<FeedbackResult> {
    const prediction = this.store.getPrediction(input.predictionId)
    if (prediction === undefined) {
      throw new CognitivePipelineError(
        `cognitive-pipeline: prediction "${input.predictionId}" not found`,
        'PREDICTION_NOT_FOUND',
      )
    }
    if (prediction.resolvedAt !== null) {
      throw new CognitivePipelineError(
        `cognitive-pipeline: prediction "${input.predictionId}" is already resolved`,
        'PREDICTION_ALREADY_RESOLVED',
      )
    }
    const observed = await this.observedOutcome(input, call)
    const error = Math.abs(prediction.calibratedProbability - observed)
    this.store.resolvePrediction(input.predictionId, input.actualOutcome, error)
    this.store.recordCalibration(prediction.calibratedProbability, observed >= 0.5)

    let rebuildReason: string | null = null
    if (prediction.usedTempStrategy) {
      this.feedbackTempStrategy(prediction.action, observed)
    }

    let triggerRebuild = false
    if (error >= this.resolved.emergencyErrorThreshold) {
      triggerRebuild = true
      rebuildReason = `预测误差 ${error.toFixed(3)} 超过紧急阈值 ${this.resolved.emergencyErrorThreshold}，触发局部修补`
      await this.cold.runRebuild('local', call?.sessionId, call?.signal)
    }

    await this.store.flush()
    return { status: 'logged', predictionError: error, triggerRebuild, rebuildReason }
  }

  /** Cold-loop rebuild.
   * @param scope - local or global.
   * @param call - optional session/signal context.
   * @returns the backtested rebuild outcome.
   */
  async rebuild(scope: 'local' | 'global', call?: PipelineCallContext): Promise<RebuildResult> {
    const result = await this.cold.runRebuild(scope, call?.sessionId, call?.signal)
    await this.store.flush()
    return result
  }

  /** Observational snapshot for the inspect tool.
   * @returns counts, clusters, calibration, taxonomy, and recent resolved predictions.
   */
  inspect(): InspectResult {
    const stats = this.store.stats()
    const recentResolved = this.store.predictionsSnapshot()
      .filter(prediction => prediction.resolvedAt !== null)
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
      .slice(0, 10)
    return {
      experienceCount: stats.experienceCount,
      predictionCount: stats.predictionCount,
      resolvedPredictionCount: stats.resolvedPredictionCount,
      clusterCount: this.store.clustersSnapshot().length,
      activeTempStrategyCount: this.store.tempStrategiesSnapshot()
        .filter(strategy => strategy.status === 'active').length,
      calibrationBuckets: this.store.calibrationBucketsSnapshot(),
      taxonomy: this.store.taxonomySnapshot() ?? {
        version: 0,
        summaryShort: '（尚未完成首次重构）',
        rules: [],
        updatedAt: 0,
      },
      recentResolved,
    }
  }

  /** The dynamic cognition prefix for the system-prompt section.
   * @returns the 附录B prefix text.
   */
  taxonomyPrefix(): string {
    return cognitionPrefix(this.store.taxonomySnapshot())
  }

  /** All clusters (public for inspection).
   * @returns a detached cluster list.
   */
  clusters(): readonly Cluster[] {
    return this.store.clustersSnapshot()
  }

  /** All calibration buckets (public for inspection).
   * @returns a detached bucket table.
   */
  calibrationBuckets(): readonly CalibrationBucket[] {
    return this.store.calibrationBucketsSnapshot()
  }

  /** Current taxonomy (public for inspection).
   * @returns the taxonomy, or null before the first rebuild.
   */
  taxonomy(): TaxonomyState | null {
    return this.store.taxonomySnapshot()
  }

  /** Active + graduated scratchpad strategies (public for inspection).
   * @returns a detached strategy list.
   */
  tempStrategies(): readonly TempStrategy[] {
    return this.store.tempStrategiesSnapshot()
  }

  /** Map an actual outcome to a 0–1 observed value. */
  private async observedOutcome(input: FeedbackInput, call?: PipelineCallContext): Promise<number> {
    if (input.outcomeQuality !== undefined) {
      if (!Number.isFinite(input.outcomeQuality)) {
        throw new CognitivePipelineError('cognitive-pipeline: outcomeQuality must be a finite number', 'INVALID_OUTCOME_QUALITY')
      }
      return Math.min(1, Math.max(0, input.outcomeQuality / 10))
    }
    const sar = await extractSar(this.ctx, this.resolved.route, input.actualOutcome, {
      sessionId: call?.sessionId,
      signal: call?.signal,
    })
    if (isNeutralUtility(sar.outcomeUtility)) return 0.5
    return isPositiveOutcome(sar.outcomeUtility) ? 1 : 0
  }

  /** Record scratchpad feedback and graduate qualifying strategies. */
  private feedbackTempStrategy(action: string, observed: number): void {
    const strategies = this.store.tempStrategiesSnapshot().filter(strategy =>
      strategy.status === 'active' && strategy.trialAction === action)
    for (const strategy of strategies) {
      const positiveCount = strategy.positiveCount + (observed >= 0.5 ? 1 : 0)
      const hitCount = strategy.hitCount
      const ratio = hitCount === 0 ? 0 : positiveCount / hitCount
      const graduated = hitCount >= this.resolved.tempStrategyHitThreshold
        && ratio >= this.resolved.tempStrategyPositiveRatio
      this.store.updateTempStrategy(strategy.signatureHash, {
        positiveCount,
        pendingResult: observed >= 0.5 ? 'positive' : 'negative',
        ...graduated ? { status: 'graduated' as const } : {},
      })
      if (graduated) {
        this.ctx.logger.info(`cognitive-pipeline: 临时策略 ${strategy.signatureHash} 晋升为主库种子（命中${hitCount}次，正反馈率${(ratio * 100).toFixed(0)}%）`)
      }
    }
  }
}

/** Re-exported utility score for consumers.
 * @param utility - the outcome utility.
 * @returns the signed composite score.
 */
export function scoreUtility(utility: OutcomeUtility): number {
  return utilityScore(utility)
}
