/**
 * Hot-loop engine: online prediction with OOD detection, branch routing
 * (familiar path vs novel path), and the five-layer confidence calibration.
 * All math is synchronous and fast; the only awaits are the best-effort LLM
 * assists (SAR-independent: OOD review and calibration).
 * @module @deepseek-ai/dsh-cognitive-pipeline/hot-engine
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { CognitiveLlmRoute } from './llm.ts';
import type { EmbeddingScorer } from './embedding.ts';
import { CognitiveStore } from './store.ts';
import type { Experience, Prediction, PredictInput, PredictResult, TempStrategy } from './types.ts';
/** Fully resolved engine thresholds (no optional fields). */
export interface HotEngineConfig {
    readonly topK: number;
    readonly oodSimThreshold: number;
    readonly oodFlatThreshold: number;
    readonly oodSiThreshold: number;
    readonly shrinkageAlpha: number;
    readonly minConfidenceIntervalWidth: number;
    /** Situation-centroid cosine at/above which a success cluster is returned as a reference strategy (default 0.4). */
    readonly successReferenceThreshold: number;
    /** Situation-centroid cosine below which the taxonomy is considered uncovered (default 0.3). */
    readonly coverageThreshold: number;
    /** Routing margin (best-minus-second-best cluster cosine) below which a
     * known-path prediction is treated as a retrieval failure and SAR-ized (default 0.1). */
    readonly retrievalFailureMargin: number;
    /** EWMA step for the feedback-driven multi-channel retrieval weights (default 0.2). */
    readonly channelLearningRate: number;
    /** Feedback error below which the dominant retrieval channel is rewarded,
     * at/above which it is penalized (default 0.3). */
    readonly channelErrorThreshold: number;
    /** Bounded LLM-refine drops: how many inapplicable top candidates may be
     * removed in one prediction (default 2). */
    readonly refineMaxDrops: number;
    /** Active-exploration daily budget (scheme 2, default 3). */
    readonly exploreDailyBudget: number;
    /** Irreversible-action markers that exclude a novel attempt from the
     * exploration budget (scheme 2 safety gate). */
    readonly exploreRiskWords: readonly string[];
    /** Whether a reversible budgeted novel attempt also queues an autonomous
     * exploration task for a background session (default false). */
    readonly exploreAutoDispatch: boolean;
    readonly tempStrategyTtlMs: number;
    readonly tempStrategyMatchThreshold: number;
    /** z-score threshold of the disequilibrium gate (default 2, μ±2σ). */
    readonly disequilibriumZThreshold: number;
    /** Minimum prior settlement samples before the disequilibrium gate judges a
     * deviation (default 3; a thinner prior carries no variance signal). */
    readonly disequilibriumMinSamples: number;
    /** Per-citation retrieval bonus (constraint 4's strengthen): an experience
     * a decision actually adopted ranks above an equally similar unused one.
     * Small so similarity channels keep dominating (default 0.05). */
    readonly citationRetrievalWeight: number;
}
/** The semantic retrieval channel's scoring seam. The default implementation
 * is the deterministic hash-bag cosine (the all-MiniLM-L6-v2 stand-in); a real
 * embedding provider can implement the same interface without touching the
 * fusion logic (see docs/v3 TR §3.7, roadmap R3). */
export interface SemanticScorer {
    /** Score how similar a query text is to one experience's action, [0,1]. */
    score(queryText: string, exp: Experience): number;
}
/** Default semantic scorer: hashed bag-of-words cosine over the action text. */
export declare class HashSemanticScorer implements SemanticScorer {
    score(queryText: string, exp: Experience): number;
}
/** One ranked history hit: `fused` orders the list, `similarity` keeps the
 * classic semantic cosine for OOD/advice consumers, `channelMax` is the
 * strongest raw channel score (the OOD novelty judgment — any channel strong
 * enough means history is relevant even when the semantic cosine is diluted),
 * and `channels` records the per-channel contributions (w_c · s_c) for
 * feedback learning. */
interface RankedHit {
    readonly exp: Experience;
    /** Semantic-channel cosine (the classic similarity). */
    readonly similarity: number;
    /** Strongest raw channel score of this hit, in [0, 1]. */
    readonly channelMax: number;
    /** Fused multi-channel score; the ranking axis. */
    readonly fused: number;
    /** Per-channel contributions in [semantic, situational, symptom, outcome] order. */
    readonly channels: readonly number[];
}
/**
 * Hot-loop engine. Constructed once per service; `predict` is the online
 * entry point.
 */
export declare class HotEngine {
    private readonly ctx;
    private readonly store;
    private readonly config;
    private readonly route;
    private readonly scorer;
    private readonly embedder;
    constructor(ctx: Context, store: CognitiveStore, config: HotEngineConfig, route: CognitiveLlmRoute, scorer?: SemanticScorer, embedder?: EmbeddingScorer | null);
    /** Embed the query action once per prediction when the seam is enabled;
     * null on failure or when disabled (the hash-bag scorer then serves). */
    private embedQuery;
    /** Whether the query text itself carries any failure symptom marker. */
    private queryHasFailureMarker;
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
    private channelScores;
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
    retrieveTopK(action: string, k: number, situation?: string, queryEmbedding?: readonly number[] | null): RankedHit[];
    /** Detect OOD signals from the top-K similarity set. Novelty is judged on
     * each hit's strongest channel (`channelMax`): a diluted semantic cosine
     * must not declare history irrelevant when a situational or symptom channel
     * strongly matches the same experience.
     * @param ranked - the retrieved hits, best first.
     * @returns the strongest signal and the top-1 strength.
     */
    detectOod(ranked: readonly RankedHit[]): {
        signal: PredictResult['oodSignal'];
        top1: number;
    };
    /**
     * Run one hot-loop prediction.
     * @param input - the situation/action to predict.
     * @param sessionId - optional session identity for LLM-assisted calls.
     * @param signal - optional cancellation for LLM-assisted calls.
     * @returns the calibrated prediction result.
     */
    predict(input: PredictInput, sessionId?: GenerateOptions['sessionId'], signal?: AbortSignal): Promise<PredictResult>;
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
    private refineRetrieval;
    /**
     * Feedback-driven channel-weight learning (第一性原理 |calibrated−observed|):
     * the channel that dominated the fused top-1 at predict time is rewarded
     * when the prediction error is small and penalized when it is large, via an
     * EWMA step clamped to [0.2, 3]. Channels that keep surfacing the
     * actually-relevant experience grow; channels that pull in noise shrink.
     * @param prediction - the resolved prediction carrying its fusion record.
     * @param error - the absolute prediction error |calibrated − observed|.
     */
    learnFromFeedback(prediction: Prediction, error: number): void;
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
    private taxonomyContext;
    /** Compact retrieval-advice line appended to the advice text. */
    private taxonomyAdviceLine;
    /** Match the current situation against proven success clusters. Returns the
     * closest success cluster whose situation centroid clears the threshold, so
     * the model can reference a proven strategy even when the action itself is
     * novel.
     * @param situation - the current situation text.
     * @returns the matched success reference, or null.
     */
    private matchSuccessReference;
    /** Novel branch: scratchpad lookup or creation, conservative calibration. */
    private predictNovel;
    /** Familiar branch: five-layer calibration over the top-K samples. */
    private predictKnown;
    /** Layer-2 shrinkage: P_cal = (k/(k+α))·P_raw + (α/(k+α))·0.5. */
    private shrink;
    /** Find an active scratchpad strategy loosely matching one action.
     * Exact hash first; then a semantic match at the STRATEGY layer — the
     * query is abstracted the same way scratchpads were (触类旁通), so a
     * structurally similar situation in another domain matches the abstracted
     * principle ("调整深海推进器参数+巡检" → "策略：调整（先小步试…）" matches
     * the 离心泵 query's identical strategy), not the raw action. Legacy rows
     * without a strategyText fall back to raw-action matching.
     * @param action - the action text to match.
     * @param situation - the situation text, used for the strategy abstraction.
     * @returns the matching active strategy, or undefined.
     */
    findMatchingTempStrategy(action: string, situation?: string): TempStrategy | undefined;
}
export {};
//# sourceMappingURL=hot-engine.d.ts.map