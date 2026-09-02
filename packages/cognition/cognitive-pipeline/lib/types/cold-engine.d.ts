/**
 * Cold-loop engine: offline taxonomy reconstruction. Samples decay-weighted
 * high-error experiences, clusters them in utility space, anchors clusters
 * with LLM causal evidence (hard-constrained), backtests the proposal on the
 * newest slice, and atomically writes back only on a ≥15% error reduction.
 * @module @deepseek-ai/dsh-cognitive-pipeline/cold-engine
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { CognitiveLlmRoute } from './llm.ts';
import { CognitiveStore } from './store.ts';
import type { RebuildResult } from './types.ts';
/** Fully resolved cold-loop thresholds (no optional fields). */
export interface ColdEngineConfig {
    readonly decayLambda: number;
    readonly minDecayWeight: number;
    readonly predictionErrorThreshold: number;
    readonly successUtilityThreshold: number;
    readonly maxSampleRatio: number;
    readonly evidenceMinCount: number;
    readonly evidenceMaxDistance: number;
    readonly sandboxImprovement: number;
    readonly validationRatio: number;
    /** Minimum labeled (non-neutral) validation samples before a rebuild may be accepted. */
    readonly minValidationCount: number;
    /** Extra reconstruct draws when one stochastic LLM sample yields nothing verified (default 2). */
    readonly reconstructRetries: number;
    readonly clusterMergeCosine: number;
    readonly clusterMatchCosine: number;
    /** Clustering vector space: 'outcome' (legacy, utility space) or 'embedding'
     * (semantic space, roadmap R3). Experiences without a stored embedding fall
     * back to the outcome vector per-record, so a partially-embedded store still
     * clusters. */
    readonly clusterVectorSource: 'outcome' | 'embedding';
}
/** Calibrated agglomerative merge cosine for the embedding space
 * (colddomain-test/calibrate-merge.mjs): bge-m3 similarity on this corpus is
 * high (pairwise median 0.504), so the outcome-space default 0.4 would merge
 * everything into one giant cluster; 0.75 yields 118 clusters with a 53% giant
 * and semantically correct small clusters. */
export declare const EMBEDDING_MERGE_COSINE = 0.75;
/** Calibrated membership cosine for the embedding space
 * (colddomain-test/calibrate-match.mjs): ≥0.65 keeps 89% of true members while
 * cutting cross-cluster bleed from 145 to 68 per cluster at 0.60. */
export declare const EMBEDDING_MATCH_COSINE = 0.65;
/**
 * Cold-loop engine. `runRebuild` is the offline entry point; it never throws
 * for domain reasons — every outcome is a {@link RebuildResult}.
 */
export declare class ColdEngine {
    private readonly ctx;
    private readonly store;
    private readonly config;
    private readonly route;
    constructor(ctx: Context, store: CognitiveStore, config: ColdEngineConfig, route: CognitiveLlmRoute);
    /** Agglomerative merge cosine resolved for the configured clustering space.
     * Embedding mode uses the corpus-calibrated threshold (0.75) because bge-m3
     * similarity on this corpus is high; outcome mode keeps the configured value. */
    private mergeCosine;
    /** Membership cosine resolved for the configured clustering space
     * (embedding 0.65 calibrated against member recall vs cross-cluster bleed). */
    private matchCosine;
    /**
     * Run one rebuild. `local` restricts sampling to the highest-error cluster;
     * `global` samples the whole store.
     * @param scope - the rebuild scope.
     * @param sessionId - optional session identity for the reconstruction call.
     * @param signal - optional cancellation for the reconstruction call.
     * @returns the backtested rebuild outcome; never rejects for domain reasons.
     */
    runRebuild(scope: 'local' | 'global', sessionId?: GenerateOptions['sessionId'], signal?: AbortSignal): Promise<RebuildResult>;
    /** Short-circuit rejection result. */
    private rejected;
    /** Short-circuit deferral result: insufficient labeled validation samples. */
    private deferred;
    /** Decay-weighted, error-preferring sample selection (≤ maxSampleRatio).
     * A candidate joins when it is errorful (high prediction error or any
     * accumulated error) OR carries a clearly successful utility score — so the
     * cold loop learns from proven successes, not only from failures. Pipeline-own
     * meta experiences with a non-neutral utility also join (their error signal
     * has no user-feedback channel), so the cold loop can learn about the
     * pipeline's own failure modes (e.g. retrieval-routing ambiguity).
     */
    private sample;
    /**
     * Keep at most maxSampleRatio of the total population, error-first, with a
     * small-store floor so a rebuild stays possible before a store reaches
     * production scale (the ratio cap targets the 10万-record regime).
     */
    private cap;
    /** Deterministic candidate clusters from the agglomerative groups. */
    private fallbackCandidates;
    /** ≤30-char summary of the rebuild's logical change from group statistics. */
    private composeGroupSummary;
    /** Build normalized views for the stored cluster table. */
    private clusterViews;
    /** Predict the continuous material-gain label (normalized to [0,1]) for each
     * validation experience under a taxonomy. The prediction is the mean
     * material gain of the nearest cluster; unmatched experiences fall back to
     * the training base-rate gain. This aligns the acceptance metric with the
     * pipeline's first-principle error `|calibrated − observed|` — it measures
     * whether the taxonomy predicts utility, not just which polarity bucket an
     * experience lands in.
     */
    private predictionsFor;
    /** Mean absolute error of a taxonomy over the validation slice, on the
     * continuous material-gain axis. Every experience with a recorded gain
     * participates (resolved experiences carry a real label after the
     * feedback-backfill), so "predicted wrong but quality known" samples are no
     * longer excluded from the acceptance judgment.
     */
    private evaluateViews;
    /** Apply the accepted taxonomy: new clusters, assignments, summary, rules. */
    private writeBack;
    /** Index of the graduated strategy's nearest verified cluster, or -1. */
    private nearestClusterIndex;
    /** Compose the one-sentence taxonomy summary for the prompt prefix. */
    private composeVersionSummary;
}
//# sourceMappingURL=cold-engine.d.ts.map