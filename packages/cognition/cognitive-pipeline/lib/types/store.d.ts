/**
 * File-backed store of the cognitive pipeline. In-memory maps serve the hot
 * path; JSONL files under the configured root persist each table. Mutations
 * are synchronous in memory and enqueue an atomic (write-temp + rename)
 * persistence pass; `flush()` awaits all pending writes.
 * @module @deepseek-ai/dsh-cognitive-pipeline/store
 */
import type { AcceptanceCheck, CalibrationBucket, ChannelWeights, ChainExperience, ChainPattern, ClaimAudit, Cluster, DiscriminantAxisRecord, Experience, ExploreEntry, ExplorationState, ExplorationTask, ExplorationTaskStatus, InjectionRecord, LoopExecutionReceipt, Prediction, SolidifiedStrategy, TaxonomyState, TempStrategy, TriggerJump, VariantCandidate } from './types.ts';
/** How many calibration deciles the lifetime stats keep. */
export declare const CALIBRATION_BUCKETS = 10;
/** Local date key of the exploration budget window (`YYYY-MM-DD`).
 * @returns the local date key.
 */
export declare function todayKey(): string;
/**
 * Index a probability into its decile bucket.
 * @param probability - the probability in [0, 1].
 * @returns the decile index 0–9.
 */
export declare function bucketIndex(probability: number): number;
/** The complete persisted state of one pipeline store. */
export declare class CognitiveStore {
    private readonly root;
    private readonly queue;
    private experiences;
    private predictions;
    private tempStrategies;
    private clusterList;
    private calibration;
    private channelWeights;
    private explorationState;
    private explorationTasks;
    private loopExecutions;
    private acceptance;
    private claimAudits;
    private triggerJumps;
    private discriminantAxes;
    private injections;
    private chains;
    private chainPatterns;
    private solidifiedStrategies;
    private variants;
    private taxonomyState;
    private nextExpSeq;
    private nextPredictionSeq;
    private nextClusterSeq;
    private nextTaskSeq;
    private nextAcceptanceSeq;
    private nextAuditSeq;
    private nextStrategySeq;
    private nextInjectionSeq;
    private nextVariantSeq;
    /**
     * @param root - directory that will hold the JSONL/JSON state files.
     */
    constructor(root: string);
    private file;
    /** Create the root and load every table. Missing files start empty. */
    load(): Promise<void>;
    /** Await every pending persistence write. */
    flush(): Promise<void>;
    private enqueue;
    private enqueueLines;
    /**
     * Store one experience and enqueue its persistence.
     * @param exp - the experience to add.
     */
    addExperience(exp: Experience): void;
    /**
     * Read one experience by id.
     * @param expId - the experience id.
     * @returns the experience, or undefined.
     */
    getExperience(expId: string): Experience | undefined;
    /** Snapshot of every stored experience.
     * @returns experiences in insertion order.
     */
    experiencesSnapshot(): readonly Experience[];
    /** Remove one experience (lifecycle pruning: an experience with zero
     * citations past its retention age is forgotten, not kept forever).
     * @param expId - the experience to remove.
     * @returns true when it existed and was removed.
     */
    removeExperience(expId: string): boolean;
    /**
     * Apply a partial patch to one experience and enqueue its persistence.
     * @param expId - the experience id.
     * @param patch - the fields to replace.
     * @returns the updated experience.
     */
    updateExperience(expId: string, patch: Partial<Experience>): Experience;
    /**
     * Fold one real-feedback evidence weight into a simulated experience's
     * verification state (the evidence-replacement model): a single decisive
     * weight fast-tracks to provisional, cumulative evidence upgrades to
     * verified, and a contradictory provisional feedback rolls back. Ordinary
     * experiences are verified by construction and unaffected.
     * @param expId - the experience id.
     * @param weight - the feedback evidence weight in [0, 1].
     * @param contradictory - whether the feedback contradicts the simulation.
     * @param fastTrackThreshold - weight at/above which one feedback fast-tracks.
     * @param permanentThreshold - cumulative evidence needed for permanent verified.
     * @returns the updated experience.
     */
    applyFeedbackEvidence(expId: string, weight: number, contradictory: boolean, fastTrackThreshold: number, permanentThreshold: number): Experience;
    /**
     * Expire simulated experiences that never earned real feedback within the
     * fallback TTL. This is the backstop of the evidence-replacement model:
     * verification and density are primary, the timeout guards the
     * never-verified corner.
     * @param now - the reference timestamp.
     * @param ttlMs - the fallback TTL for unverified simulated experiences.
     * @returns the expIds removed.
     */
    expireUnverifiedSimulated(now: number, ttlMs: number): string[];
    /** Store one prediction and enqueue its persistence.
     * @param prediction - the prediction to add.
     */
    addPrediction(prediction: Prediction): void;
    /** Read one prediction by id.
     * @param predictionId - the prediction id.
     * @returns the prediction, or undefined.
     */
    getPrediction(predictionId: string): Prediction | undefined;
    /** Snapshot of every stored prediction.
     * @returns predictions in insertion order.
     */
    predictionsSnapshot(): readonly Prediction[];
    /**
     * Resolve one prediction with its actual outcome, propagating the absolute
     * prediction error to the bound experience's cumulative error. When the
     * feedback carries a result-quality label, it is folded back into the bound
     * experience's utility so "predicted wrong but quality known" experiences
     * carry a real tag instead of staying neutral.
     * @param predictionId - the prediction to resolve.
     * @param actualOutcome - the observed outcome text.
     * @param predictionError - absolute error in [0, 1].
     * @param outcomeQuality - optional result quality 0-10 to fold into the bound experience.
     * @param disequilibriumGate - optional gate parameters; when supplied, each
     * quality-carrying settlement is judged against the prior sample
     * distribution and a threshold-crossing deviation flags the experience.
     * @returns the resolved prediction.
     */
    resolvePrediction(predictionId: string, actualOutcome: string, predictionError: number, outcomeQuality?: number, disequilibriumGate?: {
        zThreshold: number;
        minSamples: number;
    }): Prediction;
    /** Read one scratchpad strategy by signature hash.
     * @param signatureHash - the strategy key.
     * @returns the strategy, or undefined.
     */
    getTempStrategy(signatureHash: string): TempStrategy | undefined;
    /** Store one scratchpad strategy and enqueue its persistence.
     * @param strategy - the strategy to add.
     */
    addTempStrategy(strategy: TempStrategy): void;
    /** Apply a partial patch to one scratchpad strategy.
     * @param signatureHash - the strategy key.
     * @param patch - the fields to replace.
     * @returns the updated strategy.
     */
    updateTempStrategy(signatureHash: string, patch: Partial<TempStrategy>): TempStrategy;
    /** Snapshot of every scratchpad strategy.
     * @returns strategies in insertion order.
     */
    tempStrategiesSnapshot(): readonly TempStrategy[];
    /**
     * Expire active strategies past their TTL.
     * @param now - the reference timestamp; defaults to the current time.
     * @returns the hashes that were expired.
     */
    expireTempStrategies(now?: number): string[];
    /** Record one resolved prediction in its confidence decile.
     * @param probability - the calibrated probability.
     * @param hit - whether the outcome was positive.
     */
    recordCalibration(probability: number, hit: boolean): void;
    /** Snapshot of every calibration bucket.
     * @returns a detached decile table.
     */
    calibrationBucketsSnapshot(): readonly CalibrationBucket[];
    /**
     * Lifetime empirical accuracy for one probability's decile bucket.
     * @param probability - the calibrated probability.
     * @returns the bucket accuracy, or null when the bucket has no count.
     */
    empiricalAccuracyFor(probability: number): number | null;
    /** Snapshot of the learned retrieval channel weights.
     * @returns a detached weight record.
     */
    channelWeightsSnapshot(): ChannelWeights;
    /** Apply one EWMA step to the learned retrieval channel weights.
     * @param weights - the new weights; each must already be clamped.
     */
    updateChannelWeights(weights: ChannelWeights): void;
    /** Snapshot of the exploration state with the current window's usage.
     * @returns the exploration state (used counts reset for a stale date).
     */
    explorationSnapshot(): ExplorationState;
    /** Record one exploration attempt within the current budget window.
     * @param entry - the exploration entry to append.
     */
    recordExploration(entry: ExploreEntry): void;
    /** Mark an exploration entry's scratchpad terminal outcome.
     * @param scratchpadHash - the tracked scratchpad signature hash.
     * @param outcome - 'graduated' or 'expired'.
     */
    resolveExploration(scratchpadHash: string, outcome: 'graduated' | 'expired'): void;
    /**
     * Fold one real-world prediction error back into an exploration entry's ROI
     * ledger. Called on every feedback for a prediction that reused the entry's
     * scratchpad: the error (|calibrated − observed| of that reuse) updates the
     * entry's EWMA, and the entry flips validated/refuted once its EWMA clears
     * or crosses the threshold. This is the feedback chain that closes the
     * meta-cognition loop — an exploration is not merely graduated (it became a
     * strategy) but measured (did reusing it actually reduce prediction error).
     * @param scratchpadHash - the scratchpad the resolved prediction reused.
     * @param predictionError - the reuse prediction's absolute error in [0, 1].
     * @param learningRate - EWMA step for the fold.
     * @param errorThreshold - error ceiling: below validates, at/above refutes.
     * @returns the updated entry, or undefined when the hash tracks no entry.
     */
    validateExploration(scratchpadHash: string, predictionError: number, learningRate: number, errorThreshold: number): ExploreEntry | undefined;
    /** Snapshot of every queued exploration task, insertion order.
     * @returns the task list.
     */
    explorationTasksSnapshot(): readonly ExplorationTask[];
    /** Queue one autonomous exploration task.
     * @param goal - the exploration goal a background session will pursue.
     * @returns the new task.
     */
    addExplorationTask(goal: string): ExplorationTask;
    /** Transition one task's status, recording pickup time and the result.
     * @param taskId - the task to update.
     * @param patch - the status/pickedUpAt/result fields to apply.
     * @returns the updated task, or undefined when unknown.
     */
    updateExplorationTask(taskId: string, patch: {
        status?: ExplorationTaskStatus;
        pickedUpAt?: number | null;
        result?: string | null;
    }): ExplorationTask | undefined;
    /** Store one loop-execution receipt and enqueue its persistence.
     * @param receipt - the receipt to add (id must be unique).
     */
    addLoopExecution(receipt: LoopExecutionReceipt): void;
    /** Read one loop-execution receipt by id.
     * @param receiptId - the receipt id (`<predictionId>@<target>`).
     * @returns the receipt, or undefined when unknown.
     */
    getLoopExecution(receiptId: string): LoopExecutionReceipt | undefined;
    /** Snapshot of every loop-execution receipt, insertion order.
     * @returns the receipt list.
     */
    loopExecutionsSnapshot(): readonly LoopExecutionReceipt[];
    /** Mark one accepted receipt's terminal execution outcome. Refused receipts
     * are terminal by construction and are never settled.
     * @param receiptId - the receipt to settle.
     * @param status - the terminal outcome ('executed' or 'failed').
     * @param outcomeText - what the execution actually produced.
     * @param outcomeQuality - the outcome quality 0–10.
     * @returns the updated receipt, or undefined when unknown.
     */
    settleLoopExecution(receiptId: string, status: 'executed' | 'failed', outcomeText: string, outcomeQuality: number): LoopExecutionReceipt | undefined;
    /** Allocate the next acceptance-check id.
     * @returns `check_<n>`.
     */
    nextAcceptanceCheckId(): string;
    /** Allocate the next claim-audit id.
     * @returns `audit_<n>`.
     */
    nextAuditId(): string;
    /** The next solidified-strategy id.
     * @returns `solidified-<n>`.
     */
    nextSolidifiedStrategyId(): string;
    /** Store one acceptance criterion and enqueue its persistence.
     * @param check - the criterion to add.
     */
    addAcceptanceCheck(check: AcceptanceCheck): void;
    /** Read one acceptance criterion by id.
     * @param checkId - the criterion id.
     * @returns the criterion, or undefined.
     */
    getAcceptanceCheck(checkId: string): AcceptanceCheck | undefined;
    /** Snapshot of every acceptance criterion, insertion order.
     * @returns the criterion list.
     */
    acceptanceSnapshot(): readonly AcceptanceCheck[];
    /** Apply a partial patch to one acceptance criterion. The domain freeze
     * (retired checks are immutable) is enforced by the service layer; the store
     * applies any patch it receives.
     * @param checkId - the criterion id.
     * @param patch - the fields to replace.
     * @returns the updated criterion.
     */
    updateAcceptanceCheck(checkId: string, patch: Partial<AcceptanceCheck>): AcceptanceCheck;
    /** Record one claim audit and enqueue its persistence.
     * @param audit - the audit to add (id must be unique).
     */
    recordClaimAudit(audit: ClaimAudit): void;
    /** Snapshot of every claim audit, insertion order.
     * @returns the audit list.
     */
    claimAuditsSnapshot(): readonly ClaimAudit[];
    /** Fold one audit's verdict into one criterion's evidence ledger: invoked
     * always increments, and the audit counts as passed (evidence present) or
     * violated (no evidence). Passes backed by a matched external-witness anchor
     * (a session-log tool call or a workspace file state) additionally increment
     * the machine-verified counter, so the ledger separates machine-witnessed
     * satisfaction from self-reported satisfaction.
     * @param checkId - the applied criterion.
     * @param passed - whether the claim carried evidence for it.
     * @param machineVerified - whether that evidence was a matched external anchor.
     * @returns the updated criterion.
     */
    applyAuditStats(checkId: string, passed: boolean, machineVerified?: boolean): AcceptanceCheck;
    /** Fold one resolved prediction's |calibrated − observed| error into a
     * criterion's deviation ledger. Only called for audits that violated the
     * criterion, so the ledger measures "claims made without verification
     * correlate with prediction error" on the same ruler as every prediction.
     * @param checkId - the violated criterion.
     * @param predictionError - the resolved prediction's absolute error in [0, 1].
     * @returns the updated criterion.
     */
    foldAcceptanceError(checkId: string, predictionError: number): AcceptanceCheck;
    /** Upsert one trigger-jump association (keyed by jump word).
     * @param jump - the jump to add or replace.
     */
    upsertTriggerJump(jump: TriggerJump): void;
    /** Read one trigger jump by jump word.
     * @param jumpWord - the jump word.
     * @returns the jump, or undefined.
     */
    getTriggerJump(jumpWord: string): TriggerJump | undefined;
    /** Snapshot of every trigger jump, insertion order.
     * @returns the jump list.
     */
    triggerJumpsSnapshot(): readonly TriggerJump[];
    /** Replace the whole trigger-jump table (a rebuild replaces the structure;
     * the service carries citation stats across the rebuild).
     * @param jumps - the new table.
     */
    replaceTriggerJumps(jumps: readonly TriggerJump[]): void;
    /** Snapshot of every discriminant axis, insertion order.
     * @returns the axis list.
     */
    discriminantAxesSnapshot(): readonly DiscriminantAxisRecord[];
    /** Replace the whole discriminant-axis table (a rebuild replaces the axes
     * together with the clusters they were extracted from).
     * @param axes - the new table.
     */
    replaceDiscriminantAxes(axes: readonly DiscriminantAxisRecord[]): void;
    /** Allocate the next injection-record id.
     * @returns `inject_<n>`.
     */
    nextInjectionId(): string;
    /** Record one injection event.
     * @param record - the injection to add (id must be unique).
     */
    recordInjection(record: InjectionRecord): void;
    /** Snapshot of every injection record, insertion order.
     * @returns the injection list.
     */
    injectionsSnapshot(): readonly InjectionRecord[];
    /** Settle one injection's citation outcome.
     * @param injectionId - the injection to settle.
     * @param cited - whether a later assistant message referenced an injected expId.
     */
    settleInjection(injectionId: string, cited: boolean): void;
    /** Fold one settled injection's citation outcome into the contributing jump
     * words' measured-utility ledger (hitCount always, citedCount when cited).
     * @param jumpWords - the jump words that contributed to the trigger.
     * @param cited - whether the injection was cited.
     */
    foldJumpCitation(jumpWords: readonly string[], cited: boolean): void;
    /** Upsert one chain (keyed by chain id).
     * @param chain - the chain to add or replace.
     */
    upsertChain(chain: ChainExperience): void;
    /** Read one chain by id.
     * @param chainId - the chain id.
     * @returns the chain, or undefined.
     */
    getChain(chainId: string): ChainExperience | undefined;
    /** Snapshot of every chain, insertion order.
     * @returns the chain list.
     */
    chainsSnapshot(): readonly ChainExperience[];
    /** Replace the whole chain table (a rebuild re-projects chains from tagged
     * experiences; the service carries citation stats across the rebuild).
     * @param chains - the new table.
     */
    replaceChains(chains: readonly ChainExperience[]): void;
    /** Fold one settled chain injection's citation outcome into the chain's
     * measured-utility ledger (hitCount always, citedCount when cited).
     * @param chainId - the chain that was injected.
     * @param cited - whether the injection was cited.
     */
    foldChainCitation(chainId: string, cited: boolean): void;
    /** Read one chain pattern by id (its structural signature).
     * @param patternId - the signature-based pattern id.
     * @returns the pattern, or undefined.
     */
    getChainPattern(patternId: string): ChainPattern | undefined;
    /** Snapshot of every chain pattern, insertion order.
     * @returns the pattern list.
     */
    chainPatternsSnapshot(): readonly ChainPattern[];
    /** Replace the whole chain-pattern table (a rebuild re-projects patterns
     * from chains).
     * @param patterns - the new table.
     */
    replaceChainPatterns(patterns: readonly ChainPattern[]): void;
    /** Recompute one pattern's measured utility from its member chains' current
     * citation stats (called by the pattern kind's measure, so a chain citation
     * settlement refreshes the pattern aggregate).
     * @param patternId - the signature-based pattern id.
     */
    recomputeChainPatternStats(patternId: string): void;
    /** Read one solidified strategy by id.
     * @param strategyId - the strategy id.
     * @returns the strategy, or undefined.
     */
    getSolidifiedStrategy(strategyId: string): SolidifiedStrategy | undefined;
    /** Read the solidified strategy serving one goal domain, if any.
     * @param goalDomain - the goal domain key (e.g. `重启`).
     * @returns the strategy, or undefined.
     */
    getSolidifiedStrategyByDomain(goalDomain: string): SolidifiedStrategy | undefined;
    /** Snapshot of every solidified strategy, insertion order.
     * @returns the strategy list.
     */
    solidifiedStrategiesSnapshot(): readonly SolidifiedStrategy[];
    /** Add or replace one solidified strategy.
     * @param strategy - the strategy to persist.
     */
    upsertSolidifiedStrategy(strategy: SolidifiedStrategy): void;
    /** Fold one usage outcome into a strategy's lifecycle ledger: every use
     * increments hitCount; a positive outcome (verification anchor held) also
     * increments positiveCount; a failure (anchor failed or a pre-check tripped)
     * increments violatedCount and flags rework when the deviation gate crosses
     * (≥3 invoked, ≥50% violated — the acceptance-criteria gate shape).
     * @param strategyId - the strategy id.
     * @param positive - whether the use ended with the anchor holding.
     */
    foldSolidifiedStrategyUsage(strategyId: string, positive: boolean): void;
    /** Allocate the next variant id.
     * @returns `variant-<n>`.
     */
    nextVariantId(): string;
    /** Snapshot of every variant candidate, insertion order.
     * @returns the candidate list.
     */
    variantsSnapshot(): readonly VariantCandidate[];
    /** Add one variant candidate.
     * @param candidate - the candidate to persist.
     */
    addVariantCandidate(candidate: VariantCandidate): void;
    /** Replace one variant candidate (lifecycle transition or settlement append).
     * @param candidate - the updated candidate.
     */
    updateVariantCandidate(candidate: VariantCandidate): void;
    /** Snapshot of the cluster table.
     * @returns clusters with detached fields.
     */
    clustersSnapshot(): readonly Cluster[];
    /** Snapshot of the current taxonomy.
     * @returns the taxonomy, or null before the first rebuild.
     */
    taxonomySnapshot(): TaxonomyState | null;
    /** Allocate the next cluster id.
     * @returns a fresh monotonically increasing id.
     */
    nextClusterId(): number;
    /**
     * Atomically replace the cluster table and taxonomy, and reassign member
     * experiences to their new clusters. One enqueued flush per table keeps the
     * files consistent with each other.
     * @param clusters - the new cluster table.
     * @param taxonomy - the new taxonomy snapshot.
     * @param assignments - per-experience cluster membership to write back.
     */
    applyTaxonomy(clusters: readonly Cluster[], taxonomy: TaxonomyState, assignments: ReadonlyMap<string, {
        clusterId: number;
        strategyLabel: string;
    }>): void;
    /** Simple in-memory + disk counts for inspection.
     * @returns experience, prediction, resolved, and settlement-ledger counts.
     */
    stats(): {
        experienceCount: number;
        predictionCount: number;
        resolvedPredictionCount: number;
        settlement: {
            sampleCount: number;
            sampledExperienceCount: number;
            multiSampleExperienceCount: number;
            disequilibratedExperienceCount: number;
            recoveredDisequilibriumCount: number;
        };
        citation: {
            citedExperienceCount: number;
            zeroCitationExperienceCount: number;
        };
    };
    /** Allocate the next experience id.
     * @returns `exp_<n>`.
     */
    nextExpId(): string;
    /** Allocate the next prediction id.
     * @returns `pred_<n>`.
     */
    nextPredictionId(): string;
    /** Derive a normalized cluster view when the on-disk row predates the new
     * polarity / situationCentroid fields: polarity from the expected utility
     * range, centroid from the supporting experiences' situations.
     * @param raw - the loaded, still-untrusted cluster row.
     * @returns the cluster with both new fields present.
     */
    private normalizeCluster;
}
//# sourceMappingURL=store.d.ts.map