/**
 * CognitivePipelineService: the pipeline's public service. It owns the store
 * and both engines, and exposes the online (`remember`/`predict`/`report`),
 * offline (`rebuild`), and observational (`inspect`) entry points the tools
 * and other plugins call. Extends Cordis `Service`, so loading the plugin
 * provides `ctx.cognitivePipeline`.
 * @module @deepseek-ai/dsh-cognitive-pipeline/service
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { ColdEngine } from './cold-engine.ts';
import type { ColdEngineConfig } from './cold-engine.ts';
import { EmbeddingScorer } from './embedding.ts';
import type { ResolvedEmbeddingConfig } from './embedding.ts';
import { HotEngine } from './hot-engine.ts';
import type { HotEngineConfig } from './hot-engine.ts';
import type { CognitiveLlmRoute } from './llm.ts';
import { CognitiveStore } from './store.ts';
import type { AcceptanceCheck, AcceptanceProposal, CalibrationBucket, ChainExperience, ClaimAnchor, ClaimAudit, Cluster, CognitiveLoopStats, DiscriminantAxisRecord, ExplorationTask, FeedbackInput, FeedbackResult, InjectionRecord, InspectResult, LoopExecutionReceipt, LoopExecutionRequest, LoopExecutionSink, MetaLoopSpec, OutcomeUtility, PredictInput, PredictResult, RebuildResult, RememberInput, SarTriplet, SimulateInput, SolidifiedStrategy, TaxonomyState, TempStrategy, TriggerJump, TurnEpisode, TurnCognitionSummary, VariantCandidate } from './types.ts';
import type { CognitionObjectKind } from './cognition-objects.ts';
/** Plugin configuration (all fields optional; engine defaults apply). */
export interface CognitivePipelineConfig {
    /** Store directory; default `<dshHome>/cognitive-pipeline`. */
    root?: string;
    /** Explicit LLM provider route; must be paired with `model`. */
    provider?: string;
    /** Explicit LLM model id; must be paired with `provider`. */
    model?: string;
    /** False disables tool registration while keeping the service loadable. */
    enabled?: boolean;
    /** Hot-loop retrieval depth (default 10). */
    topK?: number;
    /** OOD low-similarity threshold (default 0.65). */
    oodSimThreshold?: number;
    /** OOD flat-top spread threshold (default 0.1). */
    oodFlatThreshold?: number;
    /** OOD strangeness-index threshold (default 1.5). */
    oodSiThreshold?: number;
    /** Scratchpad TTL in milliseconds (default 24h). */
    tempStrategyTtlMs?: number;
    /** Scratchpad graduation hit count (default 3). */
    tempStrategyHitThreshold?: number;
    /** Scratchpad graduation positive ratio (default 0.667). */
    tempStrategyPositiveRatio?: number;
    /** Scratchpad fuzzy-match cosine (default 0.5). */
    tempStrategyMatchThreshold?: number;
    /** Active-exploration daily budget (scheme 2): how many reversible novel
     * attempts count as exploration per day (default 3). */
    exploreDailyBudget?: number;
    /** Words marking an action as irreversible; such actions are never counted
     * as active exploration (default: 删除/清空/覆盖/发布/推送/rm/移除/迁移/重置/格式化…). */
    exploreRiskWords?: string[];
    /** Whether reversible novel attempts also queue an autonomous exploration
     * task for a background session to execute silently (default false). */
    exploreAutoDispatch?: boolean;
    /** EWMA step for folding real-world reuse errors into an exploration
     * entry's validatedError (default 0.3). */
    exploreValidationLearningRate?: number;
    /** Prediction-error ceiling below which an explored strategy counts as
     * validated (paid off in practice); at/above it counts as refuted
     * (default 0.3, the same threshold as predictionErrorThreshold). */
    exploreValidationErrorThreshold?: number;
    /** z-score threshold of the disequilibrium gate: a settlement sample
     * deviating from the prior distribution by at least this many standard
     * deviations flags the experience as an accommodation candidate
     * (default 2, μ±2σ). */
    disequilibriumZThreshold?: number;
    /** Minimum prior settlement samples before the disequilibrium gate judges a
     * deviation; a thinner prior carries no variance signal (default 3). */
    disequilibriumMinSamples?: number;
    /** Per-citation retrieval bonus: an experience a decision actually adopted
     * ranks above an equally similar unused one (default 0.05, small so
     * similarity channels keep dominating). */
    citationRetrievalWeight?: number;
    /** Offline consolidation throttle: minimum gap between sleep-phase
     * consolidations (chain assembly + jump-lexicon refresh), so repeated idle
     * ticks stay cheap (default 1 hour). */
    offlineConsolidationIntervalMs?: number;
    /** Layer-2 shrinkage alpha (default 50). */
    shrinkageAlpha?: number;
    /** Minimum 80%-interval width (default 0.2). */
    minConfidenceIntervalWidth?: number;
    /** Situation-cosine threshold for matching a success-cluster reference (default 0.4). */
    successReferenceThreshold?: number;
    /** Situation-centroid cosine below which the taxonomy is considered uncovered (default 0.3). */
    coverageThreshold?: number;
    /** Routing margin below which a known-path prediction is SAR-ized as a retrieval failure (default 0.1). */
    retrievalFailureMargin?: number;
    /** EWMA step for the feedback-driven multi-channel retrieval weights (default 0.2). */
    channelLearningRate?: number;
    /** Feedback error below which the dominant retrieval channel is rewarded, at/above penalized (default 0.3). */
    channelErrorThreshold?: number;
    /** Bounded LLM-refine drops in one low-confidence prediction (default 2). */
    refineMaxDrops?: number;
    /** Cold-loop time-decay lambda per day (default 0.01). */
    decayLambda?: number;
    /** Cold-loop minimum decay weight (default 0.1). */
    minDecayWeight?: number;
    /** Cold-loop prediction-error inclusion threshold (default 0.3). */
    predictionErrorThreshold?: number;
    /** Cold-loop utility-score threshold for including success experiences (default 3). */
    successUtilityThreshold?: number;
    /** Minimum labeled validation samples before a rebuild may be accepted (default 3). */
    minValidationCount?: number;
    /** Evidence weight at/above which one feedback fast-tracks a simulation to provisional verified (default 0.8). */
    simulationFastTrackThreshold?: number;
    /** Cumulative evidence score needed for permanent verified (default 2). */
    simulationPermanentThreshold?: number;
    /** Fallback TTL in ms after which an unverified simulation expires (default 30 days). */
    simulationTtlMs?: number;
    /** Automatically accumulate completed turns as experiences when the LLM
     * route judges them worth it (default false; pure chat never reaches the gate). */
    autoAccumulate?: boolean;
    /** Minimum invoked audits before a criterion's deviation rate can flag
     * rework and record a deviation meta experience (default 3). */
    acceptanceMinEvidenceCount?: number;
    /** Violation ratio (violated/invoked) at/above which an applied criterion
     * flags rework on an audit (default 0.5). */
    acceptanceDeviationThreshold?: number;
    /** Whether `verify_claim` command anchors may actually run the supplied
     * command and settle on its exit code. A model-supplied command is a
     * real execution surface, so this is OFF by default (default false). */
    acceptanceCommandExecution?: boolean;
    /** Hard timeout for one command anchor, in milliseconds (default 30000);
     * a command that does not settle fails closed. */
    acceptanceCommandTimeoutMs?: number;
    /** Minimum distinct experiences backing a co-occurrence trigger jump before
     * it enters the lexicon (default 3). */
    triggerJumpEvidenceMin?: number;
    /** How many jumps one trigger word may keep (default 20). */
    triggerJumpMaxPerTrigger?: number;
    /** Total cap on the jump table (default 400); the lowest-weight jumps drop. */
    triggerJumpTotalCap?: number;
    /** Reserved slots for LLM-proposed (source 'llm') jumps when the table
     * overflows — the deliberate synonym network must not be crowded out by
     * co-occurrence jumps (default 30). */
    triggerJumpLlmFloor?: number;
    /** Gate-time scaling of a jump's contribution to the trigger score; a single
     * jump never opens the gate alone when `scale × 1 < 0.6` (default 0.5). */
    triggerJumpWeightScale?: number;
    /** Citation-rate boost added to a jump's weight during reinforcement
     * (default 0.2). */
    triggerJumpCitationBoost?: number;
    /** Citation rate at/below which a measured jump is pruned (default 0.1). */
    triggerJumpPruneRate?: number;
    /** Minimum hits before a jump is eligible for pruning (default 5). */
    triggerJumpPruneHits?: number;
    /** Minimum distinct member experiences before a goal-anchored chain is
     * consolidated (default 3). */
    chainMinMembers?: number;
    /** Minimum member chains before a structural chain pattern is projected
     * (default 2). */
    chainPatternMinMembers?: number;
    /** Cold-loop max sample ratio of the population (default 0.15). */
    maxSampleRatio?: number;
    /** Evidence hard-constraint minimum count (default 3). */
    evidenceMinCount?: number;
    /** Evidence hard-constraint max pairwise cosine distance (default 0.85). */
    evidenceMaxDistance?: number;
    /** Sandbox acceptance: required error reduction ratio (default 0.15). */
    sandboxImprovement?: number;
    /** Validation slice ratio of the sampled set (default 0.2). */
    validationRatio?: number;
    /** Extra reconstruct draws when one stochastic LLM sample yields nothing verified (default 2). */
    reconstructRetries?: number;
    /** Agglomerative merge cosine threshold (default 0.4). */
    clusterMergeCosine?: number;
    /** Cluster-membership cosine threshold (default 0.3). */
    clusterMatchCosine?: number;
    /** Clustering vector space: 'outcome' (default, legacy utility space) or
     * 'embedding' (semantic space; records without a stored embedding fall back
     * to the outcome vector per-record). */
    clusterVectorSource?: 'outcome' | 'embedding';
    /** Feedback error at/above which an emergency local rebuild fires (default 0.8). */
    emergencyErrorThreshold?: number;
    /** Real-embedding seam (roadmap R3): when set, the semantic retrieval
     * channel uses an OpenAI-compatible `/embeddings` endpoint and experiences
     * store their action embedding at write time; the hash-bag cosine remains
     * the fallback for queries/experiences without a vector. */
    embedding?: {
        /** API base URL (default `https://api.deepseek.com`). */
        baseUrl?: string;
        /** Embedding model id (default `deepseek-embedding`). */
        model?: string;
        /** Env name holding the API key (default `DEEPSEEK_API_KEY`). */
        apiKeyEnv?: string;
        /** Explicit API key, overriding env and credentials. */
        apiKey?: string;
    };
}
/** Resolved configuration with every optional field materialized. */
export interface ResolvedCognitivePipelineConfig {
    readonly root: string;
    readonly enabled: boolean;
    readonly route: CognitiveLlmRoute;
    readonly hot: HotEngineConfig;
    readonly cold: ColdEngineConfig;
    readonly tempStrategyHitThreshold: number;
    readonly tempStrategyPositiveRatio: number;
    readonly emergencyErrorThreshold: number;
    readonly simulationFastTrackThreshold: number;
    readonly simulationPermanentThreshold: number;
    readonly simulationTtlMs: number;
    /** Whether completed turns are automatically accumulated via the LLM gate. */
    readonly autoAccumulate: boolean;
    /** Minimum gap between offline consolidations (chain assembly + jump
     * refresh), so repeated idle ticks stay cheap. */
    readonly offlineConsolidationIntervalMs: number;
    /** Minimum invoked audits before a criterion's deviation rate can flag rework. */
    readonly acceptanceMinEvidenceCount: number;
    /** Violation ratio at/above which an applied criterion flags rework. */
    readonly acceptanceDeviationThreshold: number;
    /** Whether command anchors may actually run model-supplied commands. */
    readonly acceptanceCommandExecution: boolean;
    /** Hard timeout for one command anchor, in milliseconds. */
    readonly acceptanceCommandTimeoutMs: number;
    /** Minimum distinct experiences backing a co-occurrence trigger jump. */
    readonly triggerJumpEvidenceMin: number;
    /** How many jumps one trigger word may keep. */
    readonly triggerJumpMaxPerTrigger: number;
    /** Total cap on the jump table. */
    readonly triggerJumpTotalCap: number;
    /** Reserved slots for LLM-proposed jumps when the table overflows. */
    readonly triggerJumpLlmFloor: number;
    /** Gate-time scaling of a jump's contribution to the trigger score. */
    readonly triggerJumpWeightScale: number;
    /** Citation-rate boost added to a jump's weight during reinforcement. */
    readonly triggerJumpCitationBoost: number;
    /** Citation rate at/below which a measured jump is pruned. */
    readonly triggerJumpPruneRate: number;
    /** Minimum hits before a jump is eligible for pruning. */
    readonly triggerJumpPruneHits: number;
    /** Minimum distinct member experiences before a chain is consolidated. */
    readonly chainMinMembers: number;
    /** Minimum member chains before a structural chain pattern is projected. */
    readonly chainPatternMinMembers: number;
    /** Real-embedding configuration, or null when the seam is disabled. */
    readonly embedding: ResolvedEmbeddingConfig | null;
    /** Active-exploration budget (scheme 2). */
    readonly exploreDailyBudget: number;
    /** Irreversible-action markers that exclude an attempt from the budget. */
    readonly exploreRiskWords: readonly string[];
    /** Whether reversible novel attempts queue autonomous exploration tasks. */
    readonly exploreAutoDispatch: boolean;
    /** EWMA step for folding real-world reuse errors into an exploration entry. */
    readonly exploreValidationLearningRate: number;
    /** Prediction-error ceiling: below it an explored strategy validates, at/above refutes. */
    readonly exploreValidationErrorThreshold: number;
}
/** Config schema for Loader validation and defaulting. */
export declare const Config: z<CognitivePipelineConfig>;
/** Validate an untrusted config object without Loader normalization.
 * @param config - untrusted plugin configuration.
 * @returns the resolved immutable configuration.
 */
export declare function resolveConfig(config: CognitivePipelineConfig): ResolvedCognitivePipelineConfig;
/** Durable prediction/experience context for LLM-assisted calls. */
export interface PipelineCallContext {
    readonly sessionId?: GenerateOptions['sessionId'];
    readonly signal?: AbortSignal;
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
export declare class CognitiveLoopRegistry {
    private readonly loops;
    /**
     * Register one meta-cognition loop. Re-registering the same name replaces
     * the description (identity is the name).
     * @param spec - the loop's identity, description, and optional execution sinks.
     * @returns the registry, for chaining.
     */
    register(spec: MetaLoopSpec): this;
    /** Whether a loop with this name is registered.
     * @param name - the loop name.
     * @returns true when registered.
     */
    has(name: string): boolean;
    /** The registered loop spec, or undefined.
     * @param name - the loop name.
     * @returns the spec, or undefined.
     */
    get(name: string): MetaLoopSpec | undefined;
    /** Every registered loop, in registration order.
     * @returns the loop specs.
     */
    list(): readonly MetaLoopSpec[];
    /**
     * Submit one decision as an execution request to the loop's sinks (only
     * when the decision approved and the loop declared sinks). Each sink
     * applies its own discipline; a non-null return refuses that sink. Every
     * attempt — accepted or refused — yields one durable receipt whose id
     * (`<predictionId>@<target>`) links the decision to its execution outcome.
     * @param request - the decision to submit.
     * @returns one receipt per declared sink, in declaration order.
     */
    requestExecution(request: LoopExecutionRequest): Promise<readonly LoopExecutionReceipt[]>;
    /** Per-loop calibration statistics, aggregated from the prediction log.
     * @param predictions - the full prediction snapshot.
     * @param executions - the full loop-execution receipt snapshot.
     * @returns one stats row per registered loop, in registration order.
     */
    stats(predictions: readonly {
        situation: string;
        resolvedAt: number | null;
        predictionError: number | null;
    }[], executions: readonly LoopExecutionReceipt[]): readonly CognitiveLoopStats[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        cognitivePipeline: CognitivePipelineService;
    }
}
/** The pipeline service. */
export declare class CognitivePipelineService extends Service {
    static readonly Config: z<CognitivePipelineConfig>;
    /** Resolved configuration. */
    readonly resolved: ResolvedCognitivePipelineConfig;
    /** The file-backed store (public for inspection). */
    readonly store: CognitiveStore;
    /** Hot-loop engine. */
    readonly hot: HotEngine;
    /** Cold-loop engine. */
    readonly cold: ColdEngine;
    /** Real-embedding scorer, or null when the seam is disabled. */
    readonly embedder: EmbeddingScorer | null;
    /** Meta-cognition loop registry (the "造新环路" surface). */
    readonly loops: CognitiveLoopRegistry;
    /** Derived cognition objects (the special-experience layer registry). */
    private readonly objectKinds;
    /** Per-session count of resolved predictions at the last summarizeTurn call,
     * so a turn's resolvedPredictions delta is accurate across sessions. */
    private readonly resolvedAtSummarize;
    /** Epoch of the last offline consolidation, or null before the first run.
     * In-memory throttle: repeated idle ticks stay cheap; a restart simply
     * allows the next consolidation to run. */
    private lastOfflineConsolidation;
    private readonly readinessPromise;
    constructor(ctx: Context, config?: CognitivePipelineConfig);
    /** Resolve after the store finished loading (never rejects). */
    ready(): Promise<void>;
    /** Flush all pending persistence writes. */
    flush(): Promise<void>;
    /** Encode one raw experience into SAR, vectorize, and store it.
     * @param input - the raw experience text.
     * @param call - optional session/signal context.
     * @returns the new experience id and its SAR triplet.
     */
    remember(input: RememberInput, call?: PipelineCallContext): Promise<{
        expId: string;
        sar: SarTriplet;
    }>;
    /** Embed an action text when the seam is enabled; undefined otherwise.
     * @param action - the action text to embed.
     * @returns the vector, or undefined when disabled or the call failed.
     */
    private maybeEmbed;
    /**
     * Generate a simulated experience via the LLM route: a retrieval-only,
     * unverified candidate for "if I take this action in this situation, what
     * would happen". It shapes no cluster until real feedback verifies it.
     * @param input - the hypothetical situation and proposed action.
     * @param call - optional session/signal context.
     * @returns the new simulated experience id and its SAR triplet.
     */
    simulate(input: SimulateInput, call?: PipelineCallContext): Promise<{
        expId: string;
        sar: SarTriplet;
    }>;
    /** How many similar history hits anchor one reference derivation. */
    private readonly referenceTopK;
    /** Minimum dual-axis similarity for a history hit to anchor a reference. */
    private readonly referenceMinSimilarity;
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
    deriveReference(input: {
        situation: string;
        action: string;
    }, call?: PipelineCallContext): Promise<{
        expId: string;
        sar: SarTriplet;
    } | null>;
    /** Hot-loop prediction.
     * @param input - the situation/action to predict.
     * @param call - optional session/signal context.
     * @returns the calibrated prediction result.
     */
    predict(input: PredictInput, call?: PipelineCallContext): Promise<PredictResult>;
    /**
     * Directly record a pipeline-own (meta) observation without LLM extraction —
     * the structured path for automatic retrieval-failure SAR-ization. Meta
     * experiences with a non-neutral utility join the cold-loop sample, so the
     * pipeline can cluster and learn from its own failure modes.
     * @param input - the structured SAR fields for the observation.
     * @returns the new experience id.
     */
    rememberMeta(input: {
        situation: string;
        action: string;
        outcome: string;
        utility: OutcomeUtility;
    }): string;
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
    private maybeSynthesizeRetrievalFailure;
    /**
     * Automatic accumulation: judge one completed turn through the LLM gate and
     * write it as an experience when the route deems it worth it. A deterministic
     * pre-filter (pure chat: no tool calls, no failure, short output) never
     * reaches the per-turn LLM call. Without an explicit route the gate rejects.
     * @param episode - the reconstructed turn material.
     * @param call - optional session/signal context.
     * @returns the new experience id when accumulated, or null.
     */
    accumulateTurn(episode: TurnEpisode, call?: PipelineCallContext): Promise<string | null>;
    /**
     * Aggregate one completed turn's cognition activity into a summary for the
     * GUI bubble: settle the turn's injection citations, accumulate the episode
     * when autoAccumulate is on, and count predictions resolved since the last
     * summarize call for this session. Returns null when the turn produced no
     * activity, so a quiet turn shows no bubble.
     * @param sessionId - the session owning the turn.
     * @param episode - the reconstructed turn material.
     * @returns the summary, or null when nothing happened.
     */
    summarizeTurn(sessionId: string, episode: TurnEpisode): Promise<TurnCognitionSummary | null>;
    /** Feedback loop: resolve a prediction, update calibration and scratchpad.
     * @param input - the prediction id and actual outcome.
     * @param call - optional session/signal context.
     * @returns the logged feedback result.
     */
    report(input: FeedbackInput, call?: PipelineCallContext): Promise<FeedbackResult>;
    /** Cold-loop rebuild.
     * @param scope - local or global.
     * @param call - optional session/signal context.
     * @returns the backtested rebuild outcome.
     */
    rebuild(scope: 'local' | 'global', call?: PipelineCallContext): Promise<RebuildResult>;
    /** Observational snapshot for the inspect tool.
     * @returns counts, clusters, calibration, taxonomy, and recent resolved predictions.
     */
    inspect(): InspectResult;
    /** Queue an autonomous exploration task for a background session to execute
     * silently (scheme 2 cross-session dispatch). The goal text becomes the
     * executing session's task; the result is written back as an experience.
     * @param goal - the exploration goal.
     * @returns the queued task.
     */
    explore(goal: string): Promise<ExplorationTask>;
    /** Snapshot of the queued exploration tasks (public for inspection).
     * @returns the task list, insertion order.
     */
    explorationTasks(): readonly ExplorationTask[];
    /** Register a meta-cognition loop (declarative "造新环路").
     * @param spec - the loop's identity and description.
     * @returns the service, for chaining.
     */
    registerLoop(spec: MetaLoopSpec): this;
    /** Registered meta-cognition loops, in registration order.
     * @returns the loop specs.
     */
    loopList(): readonly MetaLoopSpec[];
    /**
     * Build a ready-made execution sink that drives the ACTIVE-EXPLORATION
     * execution layer under its own discipline (reversibility safety gate +
     * daily budget). A loop that attaches this sink truly closes the loop: an
     * approved decision creates a scratchpad and (when configured) queues an
     * autonomous exploration task — 意志批准，执行层按纪律受理.
     * @returns a sink targetable as `hot-engine.explore-create`.
     */
    createExplorationSink(): LoopExecutionSink;
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
    decideLoop(name: string, decision: string, situation: string, call?: PipelineCallContext): Promise<PredictResult>;
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
    feedbackLoop(name: string, predictionId: string, actualOutcome: string, outcomeQuality: number, call?: PipelineCallContext): Promise<FeedbackResult>;
    /**
     * Decide through a loop and — when the decision approves and the loop
     * declared execution sinks — submit the decision as an execution request
     * to each sink and persist one durable receipt per sink. This is the
     * closing of the loop: 意志决策，执行层按纪律受理，回执可结算回流.
     * @param name - the registered loop name.
     * @param decision - what the loop is deciding (becomes the action text).
     * @param situation - the context the decision is made in.
     * @param threshold - approval threshold on calibrated probability (default 0.55).
     * @param call - optional session/signal context.
     * @returns the decision result plus one persisted execution receipt per
     *   declared sink (id `<predictionId>@<target>`), which `settleExecution`
     *   later resolves with the actual execution outcome.
     */
    decideAndExecute(name: string, decision: string, situation: string, threshold?: number, call?: PipelineCallContext): Promise<{
        decision: PredictResult;
        approved: boolean;
        executions: readonly LoopExecutionReceipt[];
    }>;
    /**
     * Settle one loop-execution receipt with its actual execution outcome. The
     * receipt must exist and must have been accepted (refused receipts are
     * terminal by construction — the sink declined, nothing executed). The
     * outcome feeds back through the SAME report path as every prediction: it
     * resolves the decision's prediction on the |calibrated − observed| ruler,
     * so what the execution actually did calibrates the loop that requested it —
     * 执行结果回流，意志与执行共用同一把尺子.
     * @param receiptId - the receipt id (`<predictionId>@<target>`).
     * @param outcomeText - what the execution actually produced.
     * @param outcomeQuality - the outcome quality 0–10.
     * @param status - the terminal outcome ('executed' or 'failed'; default executed).
     * @param call - optional session/signal context.
     * @returns the settled receipt and the feedback result.
     */
    settleExecution(receiptId: string, outcomeText: string, outcomeQuality: number, status?: 'executed' | 'failed', call?: PipelineCallContext): Promise<{
        receipt: LoopExecutionReceipt;
        feedback: FeedbackResult;
    }>;
    /** The dynamic cognition prefix for the system-prompt section.
     * @returns the 附录B prefix text.
     */
    taxonomyPrefix(): string;
    /**
     * Define one acceptance criterion: a reusable verification norm the agent
     * audits claims against before treating them as settled. The pipeline
     * records evidence PRESENCE, never evidence truth — it cannot verify its own
     * claims; truth is adjudicated by the resolved outcome and the user.
     * @param input - the criterion statement, its trigger marker, and the
     *   evidence hint that satisfies it.
     * @returns the new criterion, active with an empty evidence ledger.
     */
    defineAcceptanceCheck(input: {
        criterion: string;
        trigger: string;
        evidenceHint: string;
    }): Promise<AcceptanceCheck>;
    /**
     * Audit one claim against the active acceptance criteria. Applicable checks
     * are those whose trigger marker appears in the claim or its situation; a
     * claim with no applicable check audits as `not-applicable` and touches no
     * ledger. An applicable check is satisfied when the claim carries evidence
     * (non-empty), violated when it does not — presence, not truth. When the
     * claim carries an external-witness `anchor` (a session-ledger tool call or
     * a workspace file state, mechanically verified by the tool layer), the
     * witness decides instead: a matched anchor satisfies, a missing or
     * mismatched anchor violates regardless of self-reported evidence — the
     * witness is non-self-referential, so an anchored claim cannot be validated
     * by self-report alone. Violated checks accumulate in the criterion's
     * ledger, and a criterion whose invoked count clears the evidence minimum
     * while its deviation rate crosses the threshold flags `reworkNeeded` and
     * records one deviation meta experience so the cold loop can cluster the
     * pipeline's own acceptance-failure patterns.
     * @param input - the claim, its situation, the verification statement (empty
     *   when the claim is made without evidence), an optional prediction the
     *   claim is about, and an optional mechanically-verified external-witness
     *   anchor (computed by the tool layer from the executing session's ledger
     *   or the workspace disk).
     * @returns the recorded audit.
     */
    auditClaim(input: {
        claim: string;
        situation: string;
        evidence?: string;
        predictionId?: string;
        anchor?: ClaimAnchor | null;
    }): Promise<ClaimAudit>;
    /**
     * Rewrite an active criterion's statement/evidence hint, or retire it. A
     * retired criterion is frozen: its evidence ledger is never reset and audits
     * no longer apply it. The criterion's invoked/passed/violated/error counts
     * cannot be edited by any path — criteria are revisable, their track record
     * is not (the evidence gate of acceptance-criterion change).
     * @param input - the criterion id, optional new statement/evidence hint, and
     *   optional retire flag.
     * @returns the updated criterion.
     */
    updateAcceptanceCheck(input: {
        checkId: string;
        criterion?: string;
        evidenceHint?: string;
        trigger?: string;
        retire?: boolean;
    }): Promise<AcceptanceCheck>;
    /**
     * Run the acceptance-criterion proposal route: gather the demonstrably
     * failing active criteria (deviation gate crossed) and their evidence
     * ledgers, ask the LLM route to propose rewrites or retirements, and apply
     * only the proposals that pass the experience gate — a proposal must target
     * a failing criterion, carry a rationale, and carry concrete rewrite text.
     * This is how the pipeline amends its own verification norms from
     * experience: the route proposes, the evidence gate disposes. Without a
     * failing criterion or an explicit route, nothing is proposed or applied.
     * @param call - optional session/signal context.
     * @returns the flagged criteria, the route's (ungated) proposals, and the
     *   criteria the gate actually applied.
     */
    proposeAcceptanceUpdate(call?: PipelineCallContext): Promise<{
        flagged: readonly AcceptanceCheck[];
        proposals: readonly AcceptanceProposal[];
        applied: readonly AcceptanceCheck[];
    }>;
    /** All acceptance criteria (public for inspection).
     * @returns a detached criterion list, insertion order.
     */
    acceptanceChecks(): readonly AcceptanceCheck[];
    /**
     * Run one command through the shell capability seam and settle on its exit
     * code — the exit-code witness for command anchors. The pipeline never
     * spawns processes itself: the composed shell executor owns execution,
     * sandbox policy, and output handling, and the pipeline observes only the
     * exit code (output is discarded). Fail-closed: a timeout or a signal death
     * resolves to null (cannot verify is a violation, never a pass). When no
     * shell executor is mounted the call fails loud rather than silently
     * degrading — a composed deployment without `ctx.shell` cannot run command
     * anchors at all.
     * @param command - the command line to run via the shell executor.
     * @param timeoutMs - hard timeout; on expiry the executor kills the command
     *   and this resolves to null.
     * @returns the exit code, or null when the command could not settle.
     */
    runCommandExitCode(command: string, timeoutMs: number): Promise<number | null>;
    /**
     * Learn the trigger-jump lexicon from the experience store: the associative
     * layer over the static and derived trigger words. Co-occurrence jumps are
     * built deterministically (a token co-occurring with a trigger across enough
     * distinct important experiences becomes a jump toward that trigger, gated
     * by `triggerJumpEvidenceMin`, capped per trigger and in total, normalized
     * to [0.3, 1]); when an explicit LLM route exists, template 9 additionally
     * proposes synonym-variant jumps (words that never co-occur, like 卡住↔卡壳)
     * which enter with zero evidence and a conservative weight — the citation
     * loop is their evidence gate. The rebuild carries each surviving jump's
     * measured utility (hit/cited counts) and applies reinforcement: a jump
     * whose citation rate clears `triggerJumpPruneHits` hits is boosted toward 1
     * by its rate, and one at/below `triggerJumpPruneRate` is pruned.
     * @param call - optional session/signal context for the LLM enhancement.
     * @returns the build summary.
     */
    learnTriggerJumps(call?: PipelineCallContext): Promise<{
        jumpCount: number;
        cooccurrenceCount: number;
        llmAdded: number;
        pruned: number;
    }>;
    /** The trigger-jump lexicon (public for the inject plugin's gate).
     * @returns a detached jump list, insertion order.
     */
    triggerJumps(): readonly TriggerJump[];
    /** The discriminant-axis table (public for the inject plugin's C-form
     * routing): embedding clusters, LLM names the discriminating poles.
     * @returns a detached axis list, insertion order.
     */
    discriminantAxes(): readonly DiscriminantAxisRecord[];
    /**
     * Record one injection event for citation-rate measurement. The inject
     * plugin calls this after folding the reference block into the step; the
     * jump words that contributed to the trigger are carried so their measured
     * utility can be folded when the citation settles.
     * @param input - the injected expIds, the fired trigger source, the
     *   contributing jump words, and the session id when known.
     * @returns the recorded injection.
     */
    recordInjection(input: {
        expIds: readonly string[];
        triggerSource: string;
        sessionId?: string | null;
        jumpWords?: readonly string[];
        chainId?: string | null;
        strategyId?: string | null;
    }): InjectionRecord;
    /**
     * Settle every unresolved injection of one session against the turn's
     * assistant text: an injection is cited when the text references any of its
     * expIds, otherwise not. Each settled outcome folds into the contributing
     * jump words' hit/cited ledger — the measured utility that the next
     * {@link learnTriggerJumps} reinforcement uses — and into the chain's
     * citation ledger when the injection carried a chain. Flushes the pending
     * writes so the settlement is durable.
     * @param sessionId - the session whose injections to settle.
     * @param turnText - the turn's assistant/outcome text.
     * @returns how many injections were settled and how many were cited.
     */
    settleInjectionCitations(sessionId: string, turnText: string): Promise<{
        settled: number;
        cited: number;
    }>;
    /**
     * Fold one piece of feedback into a registered object kind's measured
     * ruler, through the kind's own measure step (the generic feedback
     * dispatch behind the derived-object lifecycle).
     * @param name - the registered kind name.
     * @param objectId - the feedback subject (e.g. a chain id).
     * @param feedback - the kind-specific feedback payload.
     */
    private foldObjectFeedback;
    /**
     * Register a derived cognition object kind: a declaration of one
     * special-experience layer (project/persist/measure/reinforce/expose) that
     * the generic driver can rebuild. Re-registering the same name replaces the
     * kind.
     * @param kind - the kind to register.
     * @returns the service, for chaining.
     */
    registerCognitionObject<T>(kind: CognitionObjectKind<T>): this;
    /** Registered derived cognition object kinds, in registration order.
     * @returns the kind metadata.
     */
    cognitionObjects(): readonly {
        name: string;
        description: string;
    }[];
    /**
     * Drive one derived cognition object through its lifecycle: project the
     * store into a candidate build, reinforce (carry measured stats, apply the
     * kind's gates), and persist. This is the declarative payoff — a new object
     * kind costs a declaration, and this one driver serves every kind.
     * @param name - the registered kind name.
     * @returns the build summary.
     */
    rebuildCognitionObject(name: string): Promise<{
        kind: string;
        built: number;
        pruned: number;
    }>;
    /**
     * Consolidate one goal-anchored chain from its tagged experiences: assemble
     * the causal skeleton (failure steps and delegation nodes structural,
     * routine successes collapsed), carry the previous chain's citation stats,
     * and persist. This is the offline-consolidation analogue: atoms accumulate
     * online, chains form when consolidated.
     * @param chainId - the goal trace id.
     * @param goal - the goal anchoring the chain; falls back to the previous
     *   chain's goal or the first member's situation.
     * @returns the consolidated chain, or null when the evidence gate
     *   (`chainMinMembers`) is not met.
     */
    consolidateChain(chainId: string, goal?: string): Promise<ChainExperience | null>;
    /**
     * Extract discriminant axes from over-broad clusters (template 10, LLM 定轴):
     * for each cluster whose members are semantically near-duplicates but may
     * split behaviorally, ask the LLM which dimension actually drives the
     * difference (e.g. 新手↔资深 inside a git-push cluster). The axes persist as
     * the C-form routing table — embedding clusters, LLM names the discriminating
     * poles. Clusters with < 8 members are skipped (too small to split); the
     * over-broad cluster is the target, not the whole taxonomy.
     * @param call - optional session/signal context.
     * @returns how many axes were extracted and persisted.
     */
    extractDiscriminantAxes(call?: PipelineCallContext): Promise<{
        axesCount: number;
        clustersExamined: number;
    }>;
    /**
     * Solidify a repeated successful operation into a reusable, self-verifying
     * strategy. A chain that repeatedly converged on the same concrete action
     * with a machine-checkable acceptance (the restart chain's selfPerformed
     * script is the canonical case) is promoted from SAR memory to a strategy:
     * action + verification anchor (the drift sensor) + invoked/violated
     * lifecycle + pre-checks. The goal domain becomes the injection key, so a
     * later executor facing the same goal gets the STRATEGY (short, verifiable)
     * instead of scattered experiences (long, unverified).
     * @param input - the strategy definition.
     * @returns the created strategy.
     */
    solidifyStrategy(input: {
        goalDomain: string;
        action: string;
        verificationAnchor: string;
        preChecks?: readonly string[];
        sourceChainId?: string;
    }): SolidifiedStrategy;
    /** The solidified strategy serving one goal domain, if any.
     * @param goalDomain - the goal domain key (e.g. `重启`).
     * @returns the strategy, or undefined.
     */
    solidifiedStrategyFor(goalDomain: string): SolidifiedStrategy | undefined;
    /** All solidified strategies (public for inspection).
     * @returns the strategy list.
     */
    solidifiedStrategies(): readonly SolidifiedStrategy[];
    /**
     * Record one use of a solidified strategy and fold its outcome into the
     * lifecycle ledger. Every use re-checks the environment through the
     * verification anchor — the drift sensor — so a strategy that no longer
     * matches the environment accumulates violations and is flagged for rework
     * instead of failing silently.
     * @param strategyId - the strategy id.
     * @param positive - whether the verification anchor held on this use.
     */
    recordSolidifiedStrategyUsage(strategyId: string, positive: boolean): void;
    /** All chains (public for inspection and consumers).
     * @returns a detached chain list, insertion order.
     */
    chains(): readonly ChainExperience[];
    /**
     * Generate variant candidates for a solidified strategy whose deviation gate
     * flagged rework: the LLM route perturbs one step or parameter of the action
     * while keeping the verification anchor unchanged, and each proposal becomes
     * a `proposed` candidate in the variant table (the driver framework's
     * accommodation: the anchor is the test, the variant is the revised
     * procedure). Without an explicit route no candidates are generated — no
     * model, no invented variants.
     * @param strategyId - the strategy to revise.
     * @returns the created candidates (empty when the route is absent or the
     * generation degrades).
     */
    generateStrategyVariants(strategyId: string): Promise<VariantCandidate[]>;
    /** All variant candidates (public for inspection and consumers).
     * @returns the candidate list, insertion order.
     */
    variantCandidates(): readonly VariantCandidate[];
    /**
     * Forget experiences the evidence gate deems worthless: zero citations and
     * older than the retention age. The machine-checkable value signal
     * (constraint 2) gates retention (constraint 4's pruning) — an experience
     * never adopted by any decision and past its age is forgotten, not kept
     * forever. Conservative: anything with a citation, or younger than the
     * retention window, is never pruned.
     * @param zeroCitationRetentionMs - age beyond which a zero-citation
     * experience is prunable (default 30 days).
     * @returns the removed experience ids.
     */
    pruneExperiences(zeroCitationRetentionMs?: number): Promise<string[]>;
    /**
     * Offline consolidation (the sleep-phase integration of the self-sustaining
     * design): consolidate every goal-anchored chain whose tagged members have
     * reached the threshold, then refresh the trigger-jump lexicon. Throttled by
     * `offlineConsolidationIntervalMs` (in-memory), so repeated idle ticks from
     * the orchestrator stay cheap. Runs at an idle cadence — the online loop
     * accumulates, this pass turns the accumulation into structure.
     * @returns the consolidation outcome (throttled runs return null).
     */
    offlineConsolidation(): Promise<{
        consolidatedChains: string[];
        jump: {
            added: number;
            pruned: number;
            total: number;
        };
    } | null>;
    /**
     * Settle one real-use result of a variant candidate (driver framework,
     * mechanism 4 — iterative convergence): append the quality sample, move the
     * candidate into `testing`, and run the convergence gate. A terminal
     * candidate (adopted/rejected) is immutable and ignores further settles.
     * @param variantId - the candidate to settle.
     * @param outcomeQuality - the real-use result quality 0–10.
     * @returns the updated candidate, or null when unknown.
     */
    settleVariant(variantId: string, outcomeQuality: number): Promise<VariantCandidate | null>;
    /**
     * Best-effort automatic variant feedback: when a reported action matches a
     * non-terminal variant candidate's action (hash-bag cosine at/above the
     * temp-strategy match threshold), the report's quality settles that
     * candidate — a variant is tested by being actually executed, not by fiat.
     * Only the BEST-matching candidate is settled: same-family variants share
     * their base action text, so settling every candidate above the threshold
     * would stamp one real execution's quality onto siblings that were never
     * run (real-data lesson from the restart-domain candidates).
     * @param action - the reported action text.
     * @param outcomeQuality - the report's result quality.
     */
    private foldVariantFeedback;
    /**
     * Render one chain as structured, model-visible steps — the causal skeleton
     * the injection path would present (goal anchor, failure steps marked, the
     * routine summary collapsed).
     * @param chainId - the chain to render.
     * @returns the structured text, or null when the chain is unknown.
     */
    chainExpose(chainId: string): string | null;
    /**
     * The child chains of one chain (tree edges derived at consolidation: a
     * delegated sub-goal's chain hangs under the delegating chain's receipt).
     * @param chainId - the parent chain.
     * @returns the child chain ids, or [] when the chain is unknown.
     */
    chainChildren(chainId: string): readonly string[];
    /**
     * Render one chain and its goal-structure subtree as structured,
     * model-visible text: each node's causal skeleton, children indented. This
     * is the goal-structured-diffusion surface — a hit on the parent can walk
     * down to sub-goal outcomes.
     * @param chainId - the root chain.
     * @param depth - how many levels below the root to include (default 3).
     * @returns the tree text, or null when the root chain is unknown.
     */
    chainTreeExpose(chainId: string, depth?: number): string | null;
    /**
     * Explore the upstream/downstream neighbors of one experience across the
     * scattered store — the inferred-chain discovery that complements explicit
     * chain_id tagging (exp_73's other half: when atoms were never tagged, the
     * causal承接 structure can still be recovered from text). A neighbor is an
     * experience whose OUTCOME semantically continues into this experience's
     * SITUATION (upstream: the previous step's result opened this step's
     * situation) or whose SITUATION is continued by this experience's OUTCOME
     * (downstream: this step's result opened the next step's situation). The
     * hash-bag cosine over outcome/situation text is the承接 signal; the
     * candidates are suggestions for the caller to tag and consolidate into a
     * chain — exploration, never silent labeling.
     * @param expId - the anchor experience.
     * @param minCosine - the承接-cosine threshold (default 0.3; below it a
     *   "neighbor" is too semantically distant to suggest a causal edge).
     * @param limit - how many candidates per direction (default 5).
     * @returns the anchor plus its upstream/downstream candidates with their
     *  承接 cosines, or null when the anchor is unknown.
     */
    exploreChainNeighbors(expId: string, minCosine?: number, limit?: number): {
        anchor: string;
        upstream: readonly {
            expId: string;
            cosine: number;
            text: string;
        }[];
        downstream: readonly {
            expId: string;
            cosine: number;
            text: string;
        }[];
    } | null;
    /** Recent claim audits (public for inspection).
     * @param limit - how many audits, newest first (default 10).
     * @returns the most recent audits.
     */
    claimAudits(limit?: number): readonly ClaimAudit[];
    /** Acceptance-criteria statistics for inspection.
     * @returns the verification-norm ledger and rewrite/retire candidates.
     */
    private acceptanceStats;
    /** All clusters (public for inspection).
     * @returns a detached cluster list.
     */
    clusters(): readonly Cluster[];
    /** All calibration buckets (public for inspection).
     * @returns a detached bucket table.
     */
    calibrationBuckets(): readonly CalibrationBucket[];
    /** Current taxonomy (public for inspection).
     * @returns the taxonomy, or null before the first rebuild.
     */
    taxonomy(): TaxonomyState | null;
    /** Active + graduated scratchpad strategies (public for inspection).
     * @returns a detached strategy list.
     */
    tempStrategies(): readonly TempStrategy[];
    /** Map an actual outcome to a 0–1 observed value. */
    private observedOutcome;
    /** Record scratchpad feedback and graduate qualifying strategies. */
    private feedbackTempStrategy;
    /** Active-exploration statistics for inspection.
     * @returns budget window usage, terminal-outcome counts, and validation ROI.
     */
    private explorationStats;
}
/** Re-exported utility score for consumers.
 * @param utility - the outcome utility.
 * @returns the signed composite score.
 */
export declare function scoreUtility(utility: OutcomeUtility): number;
//# sourceMappingURL=service.d.ts.map