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
import { EmbeddingScorer } from './embedding.ts'
import type { ResolvedEmbeddingConfig } from './embedding.ts'
import { HotEngine } from './hot-engine.ts'
import type { HotEngineConfig } from './hot-engine.ts'
import { CognitivePipelineError, deriveReference, evaluateAccumulation, extractSar, resolveRoute } from './llm.ts'
import type { CognitiveLlmRoute } from './llm.ts'
import { cognitionPrefix } from './prompts.ts'
import { CognitiveStore } from './store.ts'
import type {
  CalibrationBucket,
  Cluster,
  CognitiveLoopStats,
  Experience,
  ExplorationTask,
  FeedbackInput,
  FeedbackResult,
  InspectResult,
  MetaLoopSpec,
  OutcomeUtility,
  PredictInput,
  PredictResult,
  RebuildResult,
  RememberInput,
  SarTriplet,
  SimulateInput,
  TaxonomyState,
  TempStrategy,
  TurnEpisode,
} from './types.ts'
import { actionVector, cosine, outcomeVector, tokenize, utilityScore } from './vectorizer.ts'

/** Meta-experience deduplication: skip recording a routing-failure when an
 * action-vector-identical meta experience already exists (default 0.8). */
const META_DEDUP_COSINE = 0.8

/** Pure-chat pre-filter: a turn with no tool calls, no failure, and short
 * output never reaches the accumulation gate (the per-turn LLM cost guard). */
const ACCUMULATE_MIN_ACTION_CHARS = 160

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
  /** Active-exploration daily budget (scheme 2): how many reversible novel
   * attempts count as exploration per day (default 3). */
  exploreDailyBudget?: number
  /** Words marking an action as irreversible; such actions are never counted
   * as active exploration (default: 删除/清空/覆盖/发布/推送/rm/移除/迁移/重置/格式化…). */
  exploreRiskWords?: string[]
  /** Whether reversible novel attempts also queue an autonomous exploration
   * task for a background session to execute silently (default false). */
  exploreAutoDispatch?: boolean
  /** EWMA step for folding real-world reuse errors into an exploration
   * entry's validatedError (default 0.3). */
  exploreValidationLearningRate?: number
  /** Prediction-error ceiling below which an explored strategy counts as
   * validated (paid off in practice); at/above it counts as refuted
   * (default 0.3, the same threshold as predictionErrorThreshold). */
  exploreValidationErrorThreshold?: number
  /** Layer-2 shrinkage alpha (default 50). */
  shrinkageAlpha?: number
  /** Minimum 80%-interval width (default 0.2). */
  minConfidenceIntervalWidth?: number
  /** Situation-cosine threshold for matching a success-cluster reference (default 0.4). */
  successReferenceThreshold?: number
  /** Situation-centroid cosine below which the taxonomy is considered uncovered (default 0.3). */
  coverageThreshold?: number
  /** Routing margin below which a known-path prediction is SAR-ized as a retrieval failure (default 0.1). */
  retrievalFailureMargin?: number
  /** EWMA step for the feedback-driven multi-channel retrieval weights (default 0.2). */
  channelLearningRate?: number
  /** Feedback error below which the dominant retrieval channel is rewarded, at/above penalized (default 0.3). */
  channelErrorThreshold?: number
  /** Bounded LLM-refine drops in one low-confidence prediction (default 2). */
  refineMaxDrops?: number
  /** Cold-loop time-decay lambda per day (default 0.01). */
  decayLambda?: number
  /** Cold-loop minimum decay weight (default 0.1). */
  minDecayWeight?: number
  /** Cold-loop prediction-error inclusion threshold (default 0.3). */
  predictionErrorThreshold?: number
  /** Cold-loop utility-score threshold for including success experiences (default 3). */
  successUtilityThreshold?: number
  /** Minimum labeled validation samples before a rebuild may be accepted (default 3). */
  minValidationCount?: number
  /** Evidence weight at/above which one feedback fast-tracks a simulation to provisional verified (default 0.8). */
  simulationFastTrackThreshold?: number
  /** Cumulative evidence score needed for permanent verified (default 2). */
  simulationPermanentThreshold?: number
  /** Fallback TTL in ms after which an unverified simulation expires (default 30 days). */
  simulationTtlMs?: number
  /** Automatically accumulate completed turns as experiences when the LLM
   * route judges them worth it (default false; pure chat never reaches the gate). */
  autoAccumulate?: boolean
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
  /** Extra reconstruct draws when one stochastic LLM sample yields nothing verified (default 2). */
  reconstructRetries?: number
  /** Agglomerative merge cosine threshold (default 0.4). */
  clusterMergeCosine?: number
  /** Cluster-membership cosine threshold (default 0.3). */
  clusterMatchCosine?: number
  /** Feedback error at/above which an emergency local rebuild fires (default 0.8). */
  emergencyErrorThreshold?: number
  /** Real-embedding seam (roadmap R3): when set, the semantic retrieval
   * channel uses an OpenAI-compatible `/embeddings` endpoint and experiences
   * store their action embedding at write time; the hash-bag cosine remains
   * the fallback for queries/experiences without a vector. */
  embedding?: {
    /** API base URL (default `https://api.deepseek.com`). */
    baseUrl?: string
    /** Embedding model id (default `deepseek-embedding`). */
    model?: string
    /** Env name holding the API key (default `DEEPSEEK_API_KEY`). */
    apiKeyEnv?: string
    /** Explicit API key, overriding env and credentials. */
    apiKey?: string
  }
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
  readonly simulationFastTrackThreshold: number
  readonly simulationPermanentThreshold: number
  readonly simulationTtlMs: number
  /** Whether completed turns are automatically accumulated via the LLM gate. */
  readonly autoAccumulate: boolean
  /** Real-embedding configuration, or null when the seam is disabled. */
  readonly embedding: ResolvedEmbeddingConfig | null
  /** Active-exploration budget (scheme 2). */
  readonly exploreDailyBudget: number
  /** Irreversible-action markers that exclude an attempt from the budget. */
  readonly exploreRiskWords: readonly string[]
  /** Whether reversible novel attempts queue autonomous exploration tasks. */
  readonly exploreAutoDispatch: boolean
  /** EWMA step for folding real-world reuse errors into an exploration entry. */
  readonly exploreValidationLearningRate: number
  /** Prediction-error ceiling: below it an explored strategy validates, at/above refutes. */
  readonly exploreValidationErrorThreshold: number
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
  exploreDailyBudget: z.number().step(1).min(0).max(100).default(3),
  exploreRiskWords: z.array(z.string()).default(['删除', '清空', '覆盖', '发布', '推送', 'rm', '移除', '迁移', '重置', '格式化']),
  exploreAutoDispatch: z.boolean().default(false),
  exploreValidationLearningRate: z.number().min(0).max(1).default(0.3),
  exploreValidationErrorThreshold: z.number().min(0).max(1).default(0.3),
  shrinkageAlpha: z.number().min(0).default(50),
  minConfidenceIntervalWidth: z.number().min(0).max(1).default(0.2),
  successReferenceThreshold: z.number().min(0).max(1).default(0.4),
  coverageThreshold: z.number().min(0).max(1).default(0.3),
  retrievalFailureMargin: z.number().min(0).max(1).default(0.1),
  channelLearningRate: z.number().min(0).max(1).default(0.2),
  channelErrorThreshold: z.number().min(0).max(1).default(0.3),
  refineMaxDrops: z.number().step(1).min(0).max(5).default(2),
  decayLambda: z.number().min(0).default(0.01),
  minDecayWeight: z.number().min(0).max(1).default(0.1),
  predictionErrorThreshold: z.number().min(0).max(1).default(0.3),
  successUtilityThreshold: z.number().min(0).max(15).default(3),
  minValidationCount: z.number().step(1).min(1).default(3),
  simulationFastTrackThreshold: z.number().min(0).max(1).default(0.8),
  simulationPermanentThreshold: z.number().min(0).default(2),
  simulationTtlMs: z.number().step(1).min(60_000).default(30 * 24 * 60 * 60 * 1000),
  autoAccumulate: z.boolean().default(false),
  maxSampleRatio: z.number().min(0.01).max(1).default(0.15),
  evidenceMinCount: z.number().step(1).min(1).default(3),
  evidenceMaxDistance: z.number().min(0).max(1).default(0.85),
  sandboxImprovement: z.number().min(0).max(1).default(0.15),
  validationRatio: z.number().min(0.01).max(0.5).default(0.2),
  reconstructRetries: z.number().step(1).min(0).max(5).default(2),
  clusterMergeCosine: z.number().min(0).max(1).default(0.4),
  clusterMatchCosine: z.number().min(0).max(1).default(0.3),
  emergencyErrorThreshold: z.number().min(0).max(1).default(0.8),
  embedding: z.object({
    baseUrl: z.string().default('https://api.deepseek.com'),
    model: z.string().default('deepseek-embedding'),
    apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
    apiKey: z.string(),
  }),
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
      successReferenceThreshold: config.successReferenceThreshold ?? 0.4,
      coverageThreshold: config.coverageThreshold ?? 0.3,
      retrievalFailureMargin: config.retrievalFailureMargin ?? 0.1,
      channelLearningRate: config.channelLearningRate ?? 0.2,
      channelErrorThreshold: config.channelErrorThreshold ?? 0.3,
      refineMaxDrops: config.refineMaxDrops ?? 2,
      exploreDailyBudget: config.exploreDailyBudget ?? 3,
      exploreRiskWords: Object.freeze(config.exploreRiskWords ?? ['删除', '清空', '覆盖', '发布', '推送', 'rm', '移除', '迁移', '重置', '格式化']),
      exploreAutoDispatch: config.exploreAutoDispatch ?? false,
      exploreValidationLearningRate: config.exploreValidationLearningRate ?? 0.3,
      exploreValidationErrorThreshold: config.exploreValidationErrorThreshold ?? 0.3,
      tempStrategyTtlMs: config.tempStrategyTtlMs ?? 24 * 60 * 60 * 1000,
      tempStrategyMatchThreshold: config.tempStrategyMatchThreshold ?? 0.5,
    }),
    cold: Object.freeze({
      decayLambda: config.decayLambda ?? 0.01,
      minDecayWeight: config.minDecayWeight ?? 0.1,
      predictionErrorThreshold: config.predictionErrorThreshold ?? 0.3,
      successUtilityThreshold: config.successUtilityThreshold ?? 3,
      minValidationCount: config.minValidationCount ?? 3,
      maxSampleRatio: config.maxSampleRatio ?? 0.15,
      evidenceMinCount: config.evidenceMinCount ?? 3,
      evidenceMaxDistance: config.evidenceMaxDistance ?? 0.85,
      sandboxImprovement: config.sandboxImprovement ?? 0.15,
      validationRatio: config.validationRatio ?? 0.2,
      reconstructRetries: config.reconstructRetries ?? 2,
      clusterMergeCosine: config.clusterMergeCosine ?? 0.4,
      clusterMatchCosine: config.clusterMatchCosine ?? 0.3,
    }),
    tempStrategyHitThreshold: config.tempStrategyHitThreshold ?? 3,
    tempStrategyPositiveRatio: config.tempStrategyPositiveRatio ?? 0.667,
    emergencyErrorThreshold: config.emergencyErrorThreshold ?? 0.8,
    simulationFastTrackThreshold: config.simulationFastTrackThreshold ?? 0.8,
    simulationPermanentThreshold: config.simulationPermanentThreshold ?? 2,
    simulationTtlMs: config.simulationTtlMs ?? 30 * 24 * 60 * 60 * 1000,
    autoAccumulate: config.autoAccumulate ?? false,
    embedding: config.embedding === undefined
      ? null
      : Object.freeze({
        baseUrl: config.embedding.baseUrl ?? 'https://api.deepseek.com',
        model: config.embedding.model ?? 'deepseek-embedding',
        apiKeyEnv: config.embedding.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
        ...config.embedding.apiKey === undefined ? {} : { apiKey: config.embedding.apiKey },
      }),
    exploreDailyBudget: config.exploreDailyBudget ?? 3,
    exploreRiskWords: Object.freeze(config.exploreRiskWords ?? ['删除', '清空', '覆盖', '发布', '推送', 'rm', '移除', '迁移', '重置', '格式化']),
    exploreAutoDispatch: config.exploreAutoDispatch ?? false,
    exploreValidationLearningRate: config.exploreValidationLearningRate ?? 0.3,
    exploreValidationErrorThreshold: config.exploreValidationErrorThreshold ?? 0.3,
  })
}

/** Durable prediction/experience context for LLM-assisted calls. */
export interface PipelineCallContext {
  readonly sessionId?: GenerateOptions['sessionId']
  readonly signal?: AbortSignal
}

/**
 * Registry of named meta-cognition loops ("造新环路"): each loop is a
 * special-experience layer over the base SAR memory, exactly like the
 * `policy:*` decisions the orchestrator learns. Registering a loop gives it a
 * stable identity whose decisions flow through the SAME predict/report
 * calibration ruler as every other prediction — the loop's situation carries
 * a `loop:<name>` prefix, so its decision history forms its own retrievable
 * layer and inspection can aggregate per-loop error. This is the reusable
 * abstraction behind the three prior upgrades (policy:* delegation, active
 * exploration, exploration validation): declare a decision stream, get the
 * calibrated-意志 loop for free.
 */
export class CognitiveLoopRegistry {
  private readonly loops = new Map<string, MetaLoopSpec>()

  /**
   * Register one meta-cognition loop. Re-registering the same name replaces
   * the description (identity is the name).
   * @param spec - the loop's identity and description.
   * @returns the registry, for chaining.
   */
  register(spec: MetaLoopSpec): this {
    if (spec.name.trim().length === 0) {
      throw new CognitivePipelineError('cognitive-pipeline: loop name must not be empty', 'EMPTY_LOOP_NAME')
    }
    if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) {
      throw new CognitivePipelineError(
        'cognitive-pipeline: loop name must match ^[a-z][a-z0-9-]*$ (lowercase, hyphen-separated)',
        'INVALID_LOOP_NAME',
      )
    }
    this.loops.set(spec.name, { name: spec.name, description: spec.description })
    return this
  }

  /** Whether a loop with this name is registered. */
  has(name: string): boolean {
    return this.loops.has(name)
  }

  /** Every registered loop, in registration order. */
  list(): readonly MetaLoopSpec[] {
    return [...this.loops.values()]
  }

  /** Per-loop calibration statistics, aggregated from the prediction log.
   * @param predictions - the full prediction snapshot.
   * @returns one stats row per registered loop, in registration order.
   */
  stats(
    predictions: readonly { situation: string; resolvedAt: number | null; predictionError: number | null }[],
  ): readonly CognitiveLoopStats[] {
    return [...this.loops.values()].map((spec) => {
      const prefix = `loop:${spec.name} `
      const own = predictions.filter(prediction => prediction.situation.startsWith(prefix))
      const resolved = own.filter(prediction => prediction.resolvedAt !== null && prediction.predictionError !== null)
      const errorSum = resolved.reduce((sum, prediction) => sum + (prediction.predictionError ?? 0), 0)
      return {
        name: spec.name,
        description: spec.description,
        predictionCount: own.length,
        resolvedCount: resolved.length,
        avgPredictionError: resolved.length === 0 ? null : errorSum / resolved.length,
      }
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cognitivePipeline: CognitivePipelineService
  }
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
  /** Real-embedding scorer, or null when the seam is disabled. */
  readonly embedder: EmbeddingScorer | null
  /** Meta-cognition loop registry (the "造新环路" surface). */
  readonly loops: CognitiveLoopRegistry

  private readonly readinessPromise: Promise<void>

  constructor(ctx: Context, config: CognitivePipelineConfig = {}) {
    super(ctx, 'cognitivePipeline')
    this.resolved = resolveConfig(config)
    this.store = new CognitiveStore(this.resolved.root)
    this.embedder = this.resolved.embedding === null
      ? null
      : new EmbeddingScorer(ctx, this.resolved.embedding)
    this.hot = new HotEngine(ctx, this.store, this.resolved.hot, this.resolved.route, undefined, this.embedder)
    this.cold = new ColdEngine(ctx, this.store, this.resolved.cold, this.resolved.route)
    this.loops = new CognitiveLoopRegistry()
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
    const embedding = await this.maybeEmbed(sar.action)
    const exp: Experience = {
      expId,
      sar,
      actionVector: actionVector(sar.action, sar.actionKeywords),
      outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
      ...embedding === undefined ? {} : { embedding },
      clusterId: null,
      strategyLabel: null,
      timestamp: Date.now(),
      predictionError: null,
      cumulativeError: 0,
      hitCount: 0,
      positiveCount: 0,
      simulated: false,
      verification: 'verified',
      evidenceScore: 0,
    }
    this.store.addExperience(exp)
    await this.store.flush()
    return { expId, sar }
  }

  /** Embed an action text when the seam is enabled; undefined otherwise.
   * @param action - the action text to embed.
   * @returns the vector, or undefined when disabled or the call failed.
   */
  private async maybeEmbed(action: string): Promise<readonly number[] | undefined> {
    if (this.embedder === null) return undefined
    return (await this.embedder.embed(action)) ?? undefined
  }

  /**
   * Generate a simulated experience via the LLM route: a retrieval-only,
   * unverified candidate for "if I take this action in this situation, what
   * would happen". It shapes no cluster until real feedback verifies it.
   * @param input - the hypothetical situation and proposed action.
   * @param call - optional session/signal context.
   * @returns the new simulated experience id and its SAR triplet.
   */
  async simulate(
    input: SimulateInput,
    call?: PipelineCallContext,
  ): Promise<{ expId: string; sar: SarTriplet }> {
    if (input.situation.trim().length === 0 || input.action.trim().length === 0) {
      throw new CognitivePipelineError('cognitive-pipeline: situation and action must not be empty', 'EMPTY_SIMULATE_INPUT')
    }
    const rawText = `假设情境：${input.situation}。拟采取行动：${input.action}。推演可能的短期与长期结果。`
    const sar = await extractSar(this.ctx, this.resolved.route, rawText, {
      sessionId: call?.sessionId,
      signal: call?.signal,
    })
    const expId = this.store.nextExpId()
    const embedding = await this.maybeEmbed(sar.action)
    const exp: Experience = {
      expId,
      sar,
      actionVector: actionVector(sar.action, sar.actionKeywords),
      outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
      ...embedding === undefined ? {} : { embedding },
      clusterId: null,
      strategyLabel: null,
      timestamp: Date.now(),
      predictionError: null,
      cumulativeError: 0,
      hitCount: 0,
      positiveCount: 0,
      simulated: true,
      verification: 'unverified',
      evidenceScore: 0,
    }
    this.store.addExperience(exp)
    await this.store.flush()
    return { expId, sar }
  }

  /** How many similar history hits anchor one reference derivation. */
  private readonly referenceTopK = 5

  /** Minimum dual-axis similarity for a history hit to anchor a reference. */
  private readonly referenceMinSimilarity = 0.3

  /**
   * Derive a reference experience from the commonalities of similar history
   * (cold-start online generalization). Retrieves the top similar experiences
   * for the query, asks the LLM route to extract their shared pattern, and
   * writes the result as a retrieval-only simulated candidate that the
   * evidence-replacement lifecycle verifies against real feedback — the same
   * lifecycle as {@link simulate}.
   * @param input - the current situation/action to anchor the derivation.
   * @param call - optional session/signal context.
   * @returns the reference experience id and SAR when derived, or null.
   */
  async deriveReference(
    input: { situation: string; action: string },
    call?: PipelineCallContext,
  ): Promise<{ expId: string; sar: SarTriplet } | null> {
    if (input.situation.trim().length === 0 || input.action.trim().length === 0) {
      throw new CognitivePipelineError(
        'cognitive-pipeline: situation and action must not be empty',
        'EMPTY_DERIVE_REFERENCE_INPUT',
      )
    }
    const queryVector = actionVector(input.action, [])
    const similar = this.store.experiencesSnapshot()
      .filter(exp => !exp.simulated)
      .map(exp => ({
        expId: exp.expId,
        text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
        similarity: Math.max(
          cosine(queryVector, exp.actionVector),
          cosine(queryVector, actionVector(exp.sar.situation, [])),
        ),
      }))
      .filter(hit => hit.similarity >= this.referenceMinSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.referenceTopK)
    // No anchors, no generalization: a reference must come from the
    // commonalities of existing history, so an empty hit list rejects
    // deterministically without spending an LLM call (同 accumulateTurn 预过滤).
    if (similar.length === 0) return null
    const decision = await deriveReference(this.ctx, this.resolved.route, input, similar, {
      sessionId: call?.sessionId,
      signal: call?.signal,
    })
    if (!decision.shouldDerive || decision.sar === null) return null
    const sar: SarTriplet = {
      situation: decision.sar.situation,
      action: decision.sar.action,
      outcome: decision.sar.outcome,
      actionKeywords: [...new Set(tokenize(decision.sar.action))].slice(0, 8),
      outcomeUtility: { ...decision.sar.utility },
    }
    const expId = this.store.nextExpId()
    const embedding = await this.maybeEmbed(sar.action)
    this.store.addExperience({
      expId,
      sar,
      actionVector: actionVector(sar.action, sar.actionKeywords),
      outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
      ...embedding === undefined ? {} : { embedding },
      clusterId: null,
      strategyLabel: null,
      timestamp: Date.now(),
      predictionError: null,
      cumulativeError: 0,
      hitCount: 0,
      positiveCount: 0,
      simulated: true,
      verification: 'unverified',
      evidenceScore: 0,
    })
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
    // Fallback-TTL sweep for unverified simulations, mirroring the scratchpad
    // expiry at the same lifecycle point.
    this.store.expireUnverifiedSimulated(Date.now(), this.resolved.simulationTtlMs)
    const result = await this.hot.predict(input, call?.sessionId, call?.signal)
    this.maybeSynthesizeRetrievalFailure(input, result)
    await this.store.flush()
    return result
  }

  /**
   * Directly record a pipeline-own (meta) observation without LLM extraction —
   * the structured path for automatic retrieval-failure SAR-ization. Meta
   * experiences with a non-neutral utility join the cold-loop sample, so the
   * pipeline can cluster and learn from its own failure modes.
   * @param input - the structured SAR fields for the observation.
   * @returns the new experience id.
   */
  rememberMeta(input: { situation: string; action: string; outcome: string; utility: OutcomeUtility }): string {
    const sar: SarTriplet = {
      situation: input.situation,
      action: input.action,
      outcome: input.outcome,
      actionKeywords: [...new Set(tokenize(input.action))].slice(0, 8),
      outcomeUtility: { ...input.utility },
    }
    const expId = this.store.nextExpId()
    this.store.addExperience({
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
      simulated: false,
      verification: 'verified',
      evidenceScore: 0,
      meta: true,
    })
    return expId
  }

  /**
   * SAR-ize one detected retrieval-routing failure: when the taxonomy routed a
   * known-path query to a cluster with a thin margin (best-minus-second-best
   * cosine below `retrievalFailureMargin`), record a meta experience so the
   * calibration layer can reference "this action had an unreliable routing"
   * and the cold loop can cluster the failure pattern. Deduplicated by action
   * similarity so repeated queries do not spam the store.
   * @param input - the query that produced the prediction.
   * @param result - the prediction result carrying the taxonomy context.
   */
  private maybeSynthesizeRetrievalFailure(input: PredictInput, result: PredictResult): void {
    const ctx = result.taxonomyContext
    if (result.isNovel || ctx.coverage !== 'covered' || ctx.cluster === null) return
    if (ctx.margin >= this.resolved.hot.retrievalFailureMargin) return
    const queryVector = actionVector(input.action, [])
    const alreadyRecorded = this.store.experiencesSnapshot().some(exp =>
      exp.meta === true && cosine(queryVector, exp.actionVector) >= META_DEDUP_COSINE)
    if (alreadyRecorded) return
    this.rememberMeta({
      situation: `检索路由歧义：情境「${input.situation}」与簇「${ctx.cluster.name}」的余弦余量仅 ${ctx.margin.toFixed(3)}，确定性路由置信低`,
      action: input.action,
      outcome: `同样行动的路由余量低于 ${this.resolved.hot.retrievalFailureMargin}，确定性路由不可靠，应改用 LLM 路由或强化前提判别词`,
      utility: { materialGain: 3, emotionalValence: 4, energyCost: 5 },
    })
  }

  /**
   * Automatic accumulation: judge one completed turn through the LLM gate and
   * write it as an experience when the route deems it worth it. A deterministic
   * pre-filter (pure chat: no tool calls, no failure, short output) never
   * reaches the per-turn LLM call. Without an explicit route the gate rejects.
   * @param episode - the reconstructed turn material.
   * @param call - optional session/signal context.
   * @returns the new experience id when accumulated, or null.
   */
  async accumulateTurn(episode: TurnEpisode, call?: PipelineCallContext): Promise<string | null> {
    const actionText = episode.action.trim()
    const outcomeText = episode.outcome.trim()
    const substantial = episode.toolCallCount > 0 || episode.failed
      || actionText.length >= ACCUMULATE_MIN_ACTION_CHARS || outcomeText.length >= ACCUMULATE_MIN_ACTION_CHARS
    if (!substantial) return null
    const queryVector = actionVector(episode.action, [])
    const similar = this.store.experiencesSnapshot()
      .map(exp => ({
        expId: exp.expId,
        text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
        similarity: Math.max(cosine(queryVector, exp.actionVector), cosine(queryVector, actionVector(exp.sar.situation, []))),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .filter(hit => hit.similarity >= 0.3)
    const decision = await evaluateAccumulation(this.ctx, this.resolved.route, {
      situation: episode.situation,
      action: episode.action,
      outcome: episode.outcome,
    }, similar, {
      sessionId: call?.sessionId,
      signal: call?.signal,
    })
    if (!decision.shouldAccumulate || decision.sar === null) return null
    const expId = this.store.nextExpId()
    const sar: SarTriplet = {
      situation: decision.sar.situation,
      action: decision.sar.action,
      outcome: decision.sar.outcome,
      actionKeywords: [...new Set(tokenize(decision.sar.action))].slice(0, 8),
      outcomeUtility: { ...decision.sar.utility },
    }
    const embedding = await this.maybeEmbed(sar.action)
    this.store.addExperience({
      expId,
      sar,
      actionVector: actionVector(sar.action, sar.actionKeywords),
      outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
      ...embedding === undefined ? {} : { embedding },
      clusterId: null,
      strategyLabel: null,
      timestamp: Date.now(),
      predictionError: null,
      cumulativeError: 0,
      hitCount: 0,
      positiveCount: 0,
      simulated: false,
      verification: 'verified',
      evidenceScore: 0,
    })
    return expId
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
    const observed = this.observedOutcome(input)
    const error = Math.abs(prediction.calibratedProbability - observed)
    // Feedback-driven channel-weight learning (第一性原理 |calibrated−observed|):
    // the channel that dominated the fused top-1 is rewarded on small error,
    // penalized on large error — "什么样的相似才可迁移" grows from feedback.
    this.hot.learnFromFeedback(prediction, error)
    // Fold the feedback quality back into the bound experience's utility so
    // resolved experiences carry a real label, not just an error.
    this.store.resolvePrediction(input.predictionId, input.actualOutcome, error, input.outcomeQuality)
    this.store.recordCalibration(prediction.calibratedProbability, observed >= 0.5)

    // Evidence replacement for a simulated bound experience: one feedback
    // contributes a weight derived from how decisive the quality is, and
    // fast-tracks or upgrades the simulation's verification state.
    if (prediction.expId !== null) {
      const bound = this.store.getExperience(prediction.expId)
      if (bound !== undefined && bound.simulated) {
        const decisiveness = Math.abs(input.outcomeQuality - 5) / 5
        const contradictory = bound.verification === 'provisional'
          && (observed >= 0.5) !== (bound.sar.outcomeUtility.materialGain > 5)
        this.store.applyFeedbackEvidence(
          prediction.expId,
          decisiveness,
          contradictory,
          this.resolved.simulationFastTrackThreshold,
          this.resolved.simulationPermanentThreshold,
        )
      }
    }

    let rebuildReason: string | null = null
    if (prediction.usedTempStrategy) {
      this.feedbackTempStrategy(prediction.action, observed)
    }
    // Close the meta-cognition loop: when this prediction reused (or created)
    // an exploration scratchpad, its real-world error folds back into that
    // exploration entry's ROI ledger — an exploration is validated only when
    // reusing it actually reduced |calibrated − observed|, not merely when its
    // strategy graduated. Null when the prediction never touched a scratchpad.
    if (prediction.exploredActionHash !== null) {
      this.store.validateExploration(
        prediction.exploredActionHash,
        error,
        this.resolved.exploreValidationLearningRate,
        this.resolved.exploreValidationErrorThreshold,
      )
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
      channelWeights: this.store.channelWeightsSnapshot(),
      exploration: this.explorationStats(),
      loops: this.loops.stats(this.store.predictionsSnapshot()),
      taxonomy: this.store.taxonomySnapshot() ?? {
        version: 0,
        summaryShort: '（尚未完成首次重构）',
        rules: [],
        updatedAt: 0,
      },
      recentResolved,
    }
  }

  /** Queue an autonomous exploration task for a background session to execute
   * silently (scheme 2 cross-session dispatch). The goal text becomes the
   * executing session's task; the result is written back as an experience.
   * @param goal - the exploration goal.
   * @returns the queued task.
   */
  async explore(goal: string): Promise<ExplorationTask> {
    if (goal.trim().length === 0) {
      throw new CognitivePipelineError('cognitive-pipeline: exploration goal must not be empty', 'EMPTY_EXPLORE_GOAL')
    }
    const task = this.store.addExplorationTask(goal.trim())
    await this.store.flush()
    return task
  }

  /** Snapshot of the queued exploration tasks (public for inspection).
   * @returns the task list, insertion order.
   */
  explorationTasks(): readonly ExplorationTask[] {
    return this.store.explorationTasksSnapshot()
  }

  /** Register a meta-cognition loop (declarative "造新环路").
   * @param spec - the loop's identity and description.
   * @returns the service, for chaining.
   */
  registerLoop(spec: MetaLoopSpec): this {
    this.loops.register(spec)
    return this
  }

  /** Registered meta-cognition loops, in registration order.
   * @returns the loop specs.
   */
  loopList(): readonly MetaLoopSpec[] {
    return this.loops.list()
  }

  /**
   * Run one meta-cognition loop decision through the SAME calibration ruler as
   * every prediction. The loop's identity prefixes the situation
   * (`loop:<name> 决策=…`), so the decision's history forms that loop's own
   * special-experience layer — retrievable, aggregable, and calibrated.
   * @param name - the registered loop name.
   * @param decision - what the loop is deciding (becomes the action text).
   * @param situation - the context the decision is made in.
   * @param call - optional session/signal context.
   * @returns the predict result; rejects with INVALID_LOOP_NAME when unregistered.
   */
  async decideLoop(
    name: string,
    decision: string,
    situation: string,
    call?: PipelineCallContext,
  ): Promise<PredictResult> {
    if (!this.loops.has(name)) {
      throw new CognitivePipelineError(
        `cognitive-pipeline: loop "${name}" is not registered (register it first)`,
        'INVALID_LOOP_NAME',
      )
    }
    return this.predict({
      situation: `loop:${name} 情境=${situation}`,
      action: decision,
    }, call)
  }

  /**
   * Feed the actual outcome of a loop decision back for calibration. Same
   * report path as ordinary predictions.
   * @param name - the registered loop name (used for validation only).
   * @param predictionId - the decision's prediction id.
   * @param actualOutcome - the observed outcome text.
   * @param outcomeQuality - the outcome quality 0–10.
   * @param call - optional session/signal context.
   * @returns the feedback result.
   */
  async feedbackLoop(
    name: string,
    predictionId: string,
    actualOutcome: string,
    outcomeQuality: number,
    call?: PipelineCallContext,
  ): Promise<FeedbackResult> {
    if (!this.loops.has(name)) {
      throw new CognitivePipelineError(
        `cognitive-pipeline: loop "${name}" is not registered (register it first)`,
        'INVALID_LOOP_NAME',
      )
    }
    return this.report({ predictionId, actualOutcome, outcomeQuality }, call)
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
  private observedOutcome(input: FeedbackInput): number {
    if (!Number.isFinite(input.outcomeQuality)) {
      throw new CognitivePipelineError('cognitive-pipeline: outcomeQuality must be a finite number', 'INVALID_OUTCOME_QUALITY')
    }
    return Math.min(1, Math.max(0, input.outcomeQuality / 10))
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
        // ROI tracking: a graduated scratchpad is a successful exploration.
        this.store.resolveExploration(strategy.signatureHash, 'graduated')
      }
    }
  }

  /** Active-exploration statistics for inspection.
   * @returns budget window usage, terminal-outcome counts, and validation ROI.
   */
  private explorationStats(): InspectResult['exploration'] {
    const state = this.store.explorationSnapshot()
    const graduated = state.entries.filter(entry => entry.outcome === 'graduated').length
    const expired = state.entries.filter(entry => entry.outcome === 'expired').length
    const validated = state.entries.filter(entry => entry.validated === true).length
    const refuted = state.entries.filter(entry => entry.validated === false).length
    const measured = state.entries.filter(entry => entry.validatedError !== null)
    const errorSum = measured.reduce((sum, entry) => sum + (entry.validatedError ?? 0), 0)
    const tasks = this.store.explorationTasksSnapshot()
    return {
      budget: this.resolved.exploreDailyBudget,
      used: state.used,
      total: state.entries.length,
      graduated,
      expired,
      validated,
      refuted,
      avgValidationError: measured.length === 0 ? null : errorSum / measured.length,
      tasks: {
        pending: tasks.filter(task => task.status === 'pending').length,
        running: tasks.filter(task => task.status === 'running').length,
        completed: tasks.filter(task => task.status === 'completed').length,
        failed: tasks.filter(task => task.status === 'failed').length,
      },
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
