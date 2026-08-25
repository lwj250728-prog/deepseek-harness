/**
 * Domain vocabulary of the cognitive pipeline: SAR experiences, predictions,
 * temp strategies, calibration buckets, clusters, and the taxonomy snapshot.
 * Plain value types — every object crossing the JSONL store boundary is a
 * plain, JSON-serializable record.
 * @module @deepseek-ai/dsh-cognitive-pipeline/types
 */

/** Quantified short/medium-term feedback of one experience (0–10 each). */
export interface OutcomeUtility {
  /** Material or monetary gain/loss (5 = neutral). */
  readonly materialGain: number
  /** Emotional valence (5 = neutral). */
  readonly emotionalValence: number
  /** Energy / cognitive cost spent (5 = moderate). */
  readonly energyCost: number
}

/** One real execution-result sample of an experience, appended at each
 * resolved prediction that carries an outcome quality. The settlement list is
 * the variance ledger: its distribution measures how uncertain the
 * experience's result actually is (the driver framework's variance
 * perception), in contrast to the single-point self-reported utility. */
export interface SettlementSample {
  /** Epoch milliseconds of the settlement. */
  readonly ts: number
  /** Raw outcome quality 0–10 (5 = neutral), the un-scaled signal. */
  readonly quality: number
}

/** A settled disequilibrium event: one settlement sample deviated from the
 * experience's prior sample distribution beyond the gate threshold (z ≥
 * `disequilibriumZThreshold` with ≥ `disequilibriumMinSamples` prior samples).
 * The result distribution has shifted, so the recorded strategy may need
 * re-evaluation (the driver framework's accommodation trigger) instead of
 * being assimilated as noise. Set once, retained as audit history. */
export interface DisequilibriumEvent {
  /** Epoch milliseconds of the deviating settlement. */
  readonly atTs: number
  /** The deviating sample's raw quality (0–10). */
  readonly sampleQuality: number
  /** The deviation magnitude (|q − μ|/σ over the prior distribution). */
  readonly zScore: number
}
/** Lifecycle state of one variant candidate: proposed after generation,
 * testing while real uses settle it, then adopted or rejected. */
export type VariantStatus = 'proposed' | 'testing' | 'adopted' | 'rejected'

/** One structured improvement candidate for a solidified strategy whose
 * deviation gate flagged rework (or a disequilibrated experience). The variant
 * perturbs one step or parameter of the base action while keeping the
 * verification anchor unchanged — the driver framework's accommodation: the
 * anchor is the test, the variant is the revised procedure. */
export interface VariantCandidate {
  /** Stable id, e.g. `variant-1`. */
  readonly variantId: string
  /** The strategy this variant revises, or null when seeded from an experience. */
  readonly sourceStrategyId: string | null
  /** The experience this variant revises, or null when seeded from a strategy. */
  readonly sourceExpId: string | null
  /** The original action text being revised. */
  readonly baseAction: string
  /** The perturbed action text (the variant to test). */
  readonly variantAction: string
  /** The verification anchor inherited unchanged from the source — how to
   * machine-check the variant succeeded. */
  readonly verificationAnchor: string
  /** Which step/parameter of the base action the perturbation touches. */
  readonly perturbedAspect: string
  /** One-sentence rationale for the perturbation. */
  readonly rationale: string
  /** Lifecycle state (proposed → testing → adopted | rejected). */
  readonly status: VariantStatus
  /** Settlement samples from real test uses (the iterative-convergence
   * ledger: a variant graduates only when its result distribution converges). */
  readonly settlements: readonly SettlementSample[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** The retrieval channels fused by the hot loop, mirroring the parallel
 * recall channels of human memory (类比/情境/症状/因果). */
export type ChannelKey = 'semantic' | 'situational' | 'symptom' | 'outcome'

/** Per-channel fusion weights, learned from feedback error (default 1 each). */
export interface ChannelWeights {
  /** Action-text similarity (the classic cosine axis). */
  readonly semantic: number
  /** Situation-structure similarity (premise differentiation lives here). */
  readonly situational: number
  /** Failure-signature substring overlap. */
  readonly symptom: number
  /** Outcome-polarity priority when the query itself carries failure markers. */
  readonly outcome: number
}

/** The Situation–Action–Result triplet a raw experience is encoded into. */
export interface SarTriplet {
  /** Objective situation constraints, without subjective emotion. */
  readonly situation: string
  /** The concrete behavior strategy the actor took. */
  readonly action: string
  /** Observable short+long term feedback, with quantified gain/cost. */
  readonly outcome: string
  /** Action verb keywords used by the lightweight action vectorizer. */
  readonly actionKeywords: readonly string[]
  /** Quantified utility of the outcome, the clustering axis. */
  readonly outcomeUtility: OutcomeUtility
}

/** Verification state of one experience, gate for cold-loop clustering eligibility. */
export type ExperienceVerification = 'unverified' | 'provisional' | 'verified'

/** One stored experience (the main memory row). */
export interface Experience {
  readonly expId: string
  readonly sar: SarTriplet
  /** Deterministic hashed action vector (the retrieval axis). */
  readonly actionVector: readonly number[]
  /** Deterministic hashed outcome vector (the clustering axis). */
  readonly outcomeVector: readonly number[]
  /** Real-embedding vector of the action text (roadmap R3), present only
   * when the embedding seam was enabled at write time. The semantic
   * retrieval channel prefers it over the hashed action vector; experiences
   * without one keep the hash fallback. */
  readonly embedding?: readonly number[]
  /** Current cluster assignment, null until the first cold-loop rebuild. */
  readonly clusterId: number | null
  /** Human strategy label of the assigned cluster. */
  readonly strategyLabel: string | null
  /** Epoch milliseconds at creation. */
  readonly timestamp: number
  /** Last observed absolute prediction error (0–1), null before any feedback. */
  readonly predictionError: number | null
  /** Rolling sum of absolute prediction errors (the rebuild trigger). */
  readonly cumulativeError: number
  /** Append-only execution-result samples (the variance ledger). Each resolved
   * prediction carrying an outcome quality appends one sample here, so the
   * distribution over samples measures how uncertain the experience's result
   * really is. Absent on legacy rows and on experiences with no resolved
   * prediction feedback. */
  readonly settlements?: readonly SettlementSample[]
  /** The most recent disequilibrium event, when the settlement distribution
   * shifted beyond the gate threshold: the recorded strategy may need
   * re-evaluation. Absent on legacy rows and on experiences never flagged. */
  readonly disequilibrium?: DisequilibriumEvent
  /** When the disequilibrium resolved: a later settlement returned toward the
   * distribution mean (closer to it than the deviating sample), so the shift
   * was transient and the memory is restored (constraint 3's rollback — the
   * anomaly revised the schema, and the schema came back). Absent while the
   * disequilibrium is still active. */
  readonly disequilibriumRecoveredAt?: number
  /** Times this experience's cluster matched a hot-loop prediction. */
  readonly hitCount: number
  /** Times a settled injection cited this experience (the machine-checkable
   * value signal of constraint 2: a decision actually adopted it). Absent on
   * legacy rows; readers treat absence as zero. */
  readonly citationCount?: number
  /** Times the predicted outcome matched the actual outcome. */
  readonly positiveCount: number
  /** True when this experience was generated by the LLM route as a
   * retrieval-only candidate awaiting real verification, never a first-hand
   * record. Ordinary `remember_experience` writes are false. */
  readonly simulated: boolean
  /** Clustering-eligibility gate: only `verified` experiences shape clusters;
   * `provisional` may be rolled back by contradictory feedback, and
   * `unverified` simulated samples never cluster. Ordinary experiences are
   * `verified` from birth. */
  readonly verification: ExperienceVerification
  /** Cumulative evidence score from real feedback; meaningful only for
   * simulated experiences (ordinary ones are verified by construction). */
  readonly evidenceScore: number
  /** True when this experience is a pipeline-own observation (e.g. a recorded
   * retrieval-routing failure) rather than a user-task experience. Meta
   * experiences with a non-neutral utility join the cold-loop sample so the
   * pipeline can learn about its own failure modes. Absent on legacy rows. */
  readonly meta?: boolean
  /** The goal-anchored chain this experience belongs to, when tagged by an
   * orchestrator goal or a delegation. The chain consolidates tagged members
   * into a causal skeleton. Absent on legacy rows. */
  readonly chainId?: string
  /** The chain node this experience derives from: the previous member
   * experience id, or a delegation receipt id (`<predictionId>@<target>`)
   * for a cross-agent node. Absent on legacy rows. */
  readonly parentNodeId?: string
  /** The chain-internal order of this node. Absent on legacy rows. */
  readonly sequence?: number
  /** True when this experience records a self-reflexive operation (the agent
   * terminated or restarted its own host process): the causal chain after the
   * kill is unobservable from the recording session, so the SAR action may be
   * speculative and must not be asserted as fact without external witnessing.
   * Consumers (injection, prediction) should surface this trust marker.
   * Absent on legacy rows. */
  readonly selfReflexive?: boolean
}

/** One logged hot-loop prediction (the prediction log row). */
export interface Prediction {
  readonly predictionId: string
  /** Optional experience this prediction is bound to via feedback. */
  readonly expId: string | null
  readonly situation: string
  readonly action: string
  readonly predictedOutcome: string
  /** Model-raw probability before shrinkage (0–1). */
  readonly rawProbability: number
  /** Calibrated probability after shrinkage and bucket correction (0–1). */
  readonly calibratedProbability: number
  /** Lower bound of the 80% confidence interval (0–1). */
  readonly confidenceLow: number
  /** Upper bound of the 80% confidence interval (0–1). */
  readonly confidenceHigh: number
  readonly isNovel: boolean
  readonly usedTempStrategy: boolean
  readonly clusterId: number | null
  /** Signature hash of the exploration scratchpad this prediction reused
   * (`usedTempStrategy`), so feedback can fold the real-world prediction error
   * back into the exploration entry's ROI ledger. Null for predictions that
   * did not reuse a scratchpad. */
  readonly exploredActionHash: string | null
  /** Epoch milliseconds at prediction. */
  readonly timestamp: number
  /** Actual outcome text once reported via feedback, null otherwise. */
  readonly actualOutcome: string | null
  /** Absolute prediction error after feedback (0–1), null before resolution. */
  readonly predictionError: number | null
  /** Epoch milliseconds at feedback, null before resolution. */
  readonly resolvedAt: number | null
  /** Per-channel contributions (w_c · s_c) of the fused top-1 hit at predict
   * time, in [semantic, situational, symptom, outcome] order. The feedback
   * loop uses the dominant channel for error-driven weight learning; absent
   * for novel predictions with no bound hit. */
  readonly fusion: {
    readonly scores: readonly number[]
  } | null
}

/** Lifecycle state of one scratchpad strategy. */
export type TempStrategyStatus = 'active' | 'graduated' | 'expired'

/** One OOD scratchpad row: a tentative strategy awaiting enough hits to graduate. */
export interface TempStrategy {
  readonly signatureHash: string
  /** The trial action text the strategy encodes. */
  readonly trialAction: string
  /** Result placeholder awaiting the first feedback. */
  readonly pendingResult: string | null
  /** Times this strategy was matched and reused by the hot loop. */
  readonly hitCount: number
  /** Times a matched reuse ended positively. */
  readonly positiveCount: number
  /** Epoch milliseconds at creation. */
  readonly createdAt: number
  /** Epoch milliseconds after which the strategy is no longer suggested. */
  readonly expiresAt: number
  readonly status: TempStrategyStatus
  /** Optional experience that seeded this strategy. */
  readonly sourceExpId: string | null
}

/**
 * A solidified strategy: a repeated successful operation (e.g. "restart DSH =
 * call scripts/dsh-web-autorestart.ps1") promoted from SAR memory to a
 * reusable, self-verifying rule. Four parts make it safe against environment
 * drift:
 * 1. ACTION — the concrete operation (the script/command that succeeded).
 * 2. VERIFICATION ANCHOR — a machine-checkable acceptance (e.g. the restart
 *    result's ok=true AND selfPerformed=true), the "drift sensor": every use
 *    re-checks whether the environment still matches what was solidified.
 * 3. LIFECYCLE — an invoked/violated ledger with a deviation gate: when the
 *    violation rate crosses the threshold, the strategy is flagged for
 *    rework/retirement instead of failing silently.
 * 4. PRE-CHECK — conditions verified BEFORE executing (e.g. port 3080 exists,
 *    script file exists), moving drift detection from after-the-fact to
 *    before-the-action.
 * Absent on legacy stores.
 */
export interface SolidifiedStrategy {
  /** Stable id, e.g. `solidified-1`. */
  readonly strategyId: string
  /** The goal domain this strategy serves (e.g. `重启`), the injection key. */
  readonly goalDomain: string
  /** The concrete action (script/command) that succeeded repeatedly. */
  readonly action: string
  /** The verification anchor: how to machine-check the action succeeded. */
  readonly verificationAnchor: string
  /** Pre-check conditions evaluated before executing (empty = none). */
  readonly preChecks: readonly string[]
  /** The chain that seeded this strategy (evidence link). */
  readonly sourceChainId: string
  /** Times this strategy was used. */
  readonly hitCount: number
  /** Times a use ended positively (the verification anchor held). */
  readonly positiveCount: number
  /** Times a use failed the verification anchor or a pre-check. */
  readonly violatedCount: number
  /** Whether the deviation gate has flagged this strategy for rework. */
  readonly reworkNeeded: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** One active-exploration attempt (scheme 2): a scratchpad created within the
 * curiosity budget. ROI is tracked from the strategy's terminal state, then
 * validated by the strategy's real-world reuse: when a later prediction reuses
 * the scratchpad and receives feedback, the prediction error folds back here
 * (EWMA), so "did this exploration actually reduce |calibrated − observed|"
 * is measured on the same ruler as every other prediction. */
export interface ExploreEntry {
  /** Epoch milliseconds at creation. */
  readonly ts: number
  /** The trial action that was explored. */
  readonly action: string
  /** The scratchpad signature hash this entry tracks. */
  readonly scratchpadHash: string
  /** Whether the action passed the reversibility safety gate. */
  readonly reversible: boolean
  /** Terminal outcome: 'graduated' | 'expired' | null while active. */
  readonly outcome: 'graduated' | 'expired' | null
  /** EWMA of the prediction errors from real-world reuse of this entry's
   * scratchpad, null until the first feedback on a reused prediction. */
  readonly validatedError: number | null
  /** Whether the exploration paid off in practice: the reused predictions'
   * EWMA error stayed below {@link exploreValidationErrorThreshold} (true),
   * crossed it (false), or no reuse feedback exists yet (null). */
  readonly validated: boolean | null
}

/** Persisted active-exploration state (one per pipeline store). */
export interface ExplorationState {
  /** Local date key (`YYYY-MM-DD`) of the current budget window. */
  readonly date: string
  /** How many entries the window has consumed. */
  readonly used: number
  /** Every exploration attempt, newest last. */
  readonly entries: readonly ExploreEntry[]
}

/** Lifecycle of one autonomous exploration task (scheme 2 execution). */
export type ExplorationTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/** One queued autonomous exploration: a cross-session goal a background
 * agent session picks up, executes silently, and writes back as experience. */
export interface ExplorationTask {
  readonly taskId: string
  /** The exploration goal the executing session is told to pursue. */
  readonly goal: string
  readonly status: ExplorationTaskStatus
  /** Epoch milliseconds at creation. */
  readonly createdAt: number
  /** Epoch milliseconds when a scheduler session picked it up, null while pending. */
  readonly pickedUpAt: number | null
  /** The executing session's outcome, null until settled. */
  readonly result: string | null
}

/** Lifetime calibration statistics for one confidence decile. */
export interface CalibrationBucket {
  /** Decile index 0–9 covering [bucketIndex*10, (bucketIndex+1)*10) percent. */
  readonly bucketIndex: number
  readonly totalCount: number
  readonly hitCount: number
  /** hitCount / totalCount; null before any count. */
  readonly empiricalAccuracy: number | null
}

/** Expected utility interval for one cluster. */
export interface UtilityRange {
  readonly low: number
  readonly high: number
}

/** One cold-loop cluster: a named strategy family with grounded evidence. */
export interface Cluster {
  readonly clusterId: number
  /** Naming format: "当【触发条件】出现，应【行动姿态】，预期获得【效用区间】". */
  readonly name: string
  /** Decision rule "if condition X then action Y". */
  readonly decisionRule: string
  readonly expectedUtilityRange: UtilityRange
  /** At least three distinct experience ids grounding this cluster. */
  readonly supportingEvidenceIds: readonly string[]
  /** Fallback strategy when match confidence < 60%. */
  readonly fallbackAction: string
  /** Epoch milliseconds at creation. */
  readonly createdAt: number
  readonly origin: 'cold-loop' | 'temp-graduation'
  readonly sampleCount: number
  /** Rolling sum of prediction errors of member experiences. */
  readonly cumPredictionError: number
  /** Whether this cluster is a proven success pattern or a risk pattern. */
  readonly polarity: 'success' | 'risk'
  /** Normalized centroid of member situation vectors (the reference axis). */
  readonly situationCentroid: readonly number[]
}

/** One decision rule rendered into the dynamic system-prompt summary. */
export interface TaxonomyRule {
  readonly condition: string
  readonly action: string
  readonly utilityRange: UtilityRange
  /** Whether the rule recommends a proven action or a risk-avoidance stance. */
  readonly polarity: 'success' | 'risk'
}

/** A matched success cluster returned as a strategy reference. */
export interface SuccessReference {
  readonly clusterId: number
  readonly clusterName: string
  readonly decisionRule: string
  readonly utilityRange: UtilityRange
}

/** The taxonomy consulted during one retrieval: which strategy region the query
 * falls in, how confidently it was routed, and whether SAR has coverage there. */
export interface TaxonomyContext {
  /** Matched cluster (any polarity) whose situation centroid clears the coverage threshold. */
  readonly cluster: {
    readonly clusterId: number
    readonly name: string
    readonly decisionRule: string
    readonly polarity: 'success' | 'risk'
  } | null
  /** Situation-centroid cosine to the matched cluster (0 when none matched). */
  readonly similarity: number
  /** Best-minus-second-best cluster cosine; small margins mean unreliable routing. */
  readonly margin: number
  /** Whether the query situation falls inside the taxonomy's covered region. */
  readonly coverage: 'covered' | 'gap' | 'no-taxonomy'
}

/** One completed agent turn reconstructed from the session log, as the candidate
 * raw material for automatic experience accumulation. */
export interface TurnEpisode {
  /** Situation material: the user request text(s) of the turn. */
  readonly situation: string
  /** Action material: the tool calls and assistant text of the turn. */
  readonly action: string
  /** Outcome material: the turn end reason and any error/final text. */
  readonly outcome: string
  /** How many tool calls the turn made (the deterministic cost pre-filter uses it). */
  readonly toolCallCount: number
  /** Whether any tool result in the turn failed. */
  readonly failed: boolean
  /** The turn sequence number. */
  readonly turnId: number
  /** Whether the turn performed a self-reflexive operation (e.g. killing its
   * own host process): the causal chain after the operation is unobservable
   * from this session's ledger, so any reconstructed action after it may be
   * speculative and needs external witnessing to be trusted. */
  readonly selfReflexive: boolean
}

/** The LLM route's accumulation judgment for one episode. */
export interface AccumulationDecision {
  /** Whether the episode is worth accumulating as a new experience. */
  readonly shouldAccumulate: boolean
  /** The SAR triplet to write when accumulating; absent when rejected. */
  readonly sar: {
    readonly situation: string
    readonly action: string
    readonly outcome: string
    readonly utility: OutcomeUtility
  } | null
}

/** The LLM route's reference-derivation judgment for one anchor set. */
export interface DeriveReferenceDecision {
  /** Whether the similar history yields a common pattern worth generalizing. */
  readonly shouldDerive: boolean
  /** The reference SAR extracted from the commonalities; absent when rejected. */
  readonly sar: {
    readonly situation: string
    readonly action: string
    readonly outcome: string
    readonly utility: OutcomeUtility
  } | null
}

/** The LLM route's retrieval-refinement judgment (template 7): does the fused
 * top hit genuinely apply to the current situation/action? */
export interface RefineRetrievalDecision {
  /** Whether the top candidate experience genuinely applies. */
  readonly shouldKeep: boolean
  /** The expId the LLM judged inapplicable when rejecting. */
  readonly rejectedExpId: string | null
  /** One-line reason, surfaced in the advice for observability. */
  readonly reason: string | null
}

/** One LLM-proposed acceptance-criterion update (template 8), before the
 * experience gate: a proposal only touches the ledger when it targets a
 * demonstrably failing criterion (deviation rate at/above the threshold with
 * enough invoked audits), carries a rationale, and carries concrete rewrite
 * text for `rewrite` — criteria are self-amended only through the data gate,
 * never by fiat. */
export interface AcceptanceProposal {
  /** The criterion to update; must be a currently failing active check. */
  readonly checkId: string
  readonly action: 'rewrite' | 'retire'
  /** New criterion statement for `rewrite` (required). */
  readonly criterion?: string
  /** New evidence hint for `rewrite` (required). */
  readonly evidenceHint?: string
  /** New trigger marker for `rewrite` (optional). */
  readonly trigger?: string
  /** Why the change is warranted, citing the criterion's ledger evidence. */
  readonly rationale: string
}

/** The LLM route's acceptance-update judgment (template 8). */
export interface AcceptanceProposalDecision {
  readonly proposals: readonly AcceptanceProposal[]
}

/** How one trigger-jump association was sourced. */
export type TriggerJumpSource = 'cooccurrence' | 'llm'

/** One trigger-jump association: a word whose presence activates
 * evidence-backed trigger words in the injection gate — the associative layer
 * over the static and derived trigger lexicons. Every jump carries its
 * evidence (distinct experiences, summed importance, or an LLM rationale),
 * its measured utility (citation rate from the injection loop), and its
 * source — nothing enters the lexicon without an accountable basis. */
export interface TriggerJump {
  /** The jump word (a token in experience text or an LLM-proposed variant). */
  readonly jumpWord: string
  /** The trigger words this jump activates, with evidence-backed weights. */
  readonly triggers: readonly {
    readonly trigger: string
    readonly weight: number
    readonly evidenceCount: number
  }[]
  /** Total distinct experiences backing this jump (0 for LLM-sourced jumps). */
  readonly evidenceCount: number
  readonly source: TriggerJumpSource
  /** Why an LLM-sourced jump exists; empty for co-occurrence jumps. */
  readonly rationale: string
  /** Times this jump was hit in the injection gate. */
  readonly hitCount: number
  /** Times a hit was followed by a cited injection (measured utility). */
  readonly citedCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One injection event, recorded for citation-rate measurement: did the model
 * actually use the injected experience? The answer folds back into the jump
 * words that contributed to the trigger, feeding the reinforcement loop. */
export interface InjectionRecord {
  readonly injectionId: string
  readonly createdAt: number
  /** The expIds injected. */
  readonly expIds: readonly string[]
  /** The trigger that fired, e.g. `static:怎么` / `jump:卡壳→卡住`. */
  readonly triggerSource: string
  /** The jump words (if any) that contributed to the trigger. */
  readonly jumpWords: readonly string[]
  /** The chain (if any) whose structured steps were injected. */
  readonly chainId: string | null
  /** The solidified strategy (if any) that was injected instead of scattered
   * experiences. Carried so the citation settlement can fold the usage
   * outcome into the strategy's lifecycle ledger (hit/positive/violated),
   * keeping its drift sensor alive. Absent on legacy rows. */
  readonly strategyId: string | null
  /** The session the injection happened in, when known. */
  readonly sessionId: string | null
  /** Whether a later assistant message referenced an injected expId (null until settled). */
  readonly cited: boolean | null
}

/** One step of a consolidated chain: a scene in the goal-anchored sequence —
 * the causal skeleton keeps failure steps and delegation nodes as structural
 * steps and collapses routine successes into the summary (memory organizes
 * around surprises, Schank). */
export interface ChainStep {
  /** The node this step derives from: a member experience id or a delegation receipt. */
  readonly nodeId: string
  /** The step's observable text (action/outcome of the scene). */
  readonly text: string
  readonly polarity: 'success' | 'failure'
  readonly sequence: number
}

/** Lifecycle of one goal-anchored chain. */
export type ChainStatus = 'active' | 'consolidated'

/** A consolidated goal-anchored chain: the aggregated projection of the
 * experiences tagged with one chainId, collapsed to its causal skeleton. This
 * is the fifth derived cognition object — the pipeline calibrates whether the
 * whole goal execution was worth remembering (chain-level citation rate), one
 * level above single experiences and one below decision loops. */
export interface ChainExperience {
  readonly chainId: string
  /** The goal that anchors the chain (the MOP goal, the binding glue). */
  readonly goal: string
  /** The session that anchored the chain, when known. */
  readonly anchorSessionId: string | null
  readonly status: ChainStatus
  /** The causal skeleton: failure steps and delegation nodes; routine successes collapse. */
  readonly steps: readonly ChainStep[]
  /** Distinct member experiences backing the chain. */
  readonly memberExpIds: readonly string[]
  /** Cross-agent delegation nodes included in the chain. */
  readonly delegationNodeIds: readonly string[]
  /** Child chains (delegated sub-goals): chains whose root node derives from
   * one of this chain's delegation receipts. The tree edge that enables
   * goal-structured diffusion — a hit on this chain can surface its
   * sub-goal outcomes. */
  readonly childChainIds: readonly string[]
  /** Collapsed routine: how many success scenes were summarized. */
  readonly collapsedCount: number
  /** The bounded summary of the collapsed routine. */
  readonly summary: string
  /** A distilled reusable principle: the LLM extracted ONE decision rule from
   * the chain's members (failures first, then successes) during offline
   * consolidation — the "from experiences to principle" step (EvolveR's
   * experience distillation analogue). Shorter than the summary and directly
   * reusable as guidance. Absent on legacy rows and when no route exists. */
  readonly distilledPrinciple?: string
  /** Whether any member experience records a self-reflexive operation (killed
   * the agent's own host): the chain's causal chain contains a break point
   * where the aftermath is unobservable from the recording session. This is
   * the "causal-break-point" axis for cross-domain pattern projection — the
   * self-reflexive-interruption theme recurs across unrelated goal domains.
   * Absent on legacy rows. */
  readonly selfReflexive?: boolean
  /** Times this chain was injected. */
  readonly hitCount: number
  /** Times an injection of this chain was cited by the model. */
  readonly citedCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One recurring goal-execution pattern: chains with the same structural
 * signature, aggregated from the chain table — the sixth derived cognition
 * object (the abstraction's first recursive consumer: patterns project from
 * chains the way chains project from experiences). The TOPS analogue: from
 * similar MOPs, extract the cross-situation thematic pattern. */
export interface ChainPattern {
  /** Stable identity: the structural signature (coarse goal domain + polarity
   * sequence), so a rebuild with the same signature keeps the same id. */
  readonly patternId: string
  /** The structural signature, e.g. `发布:失败,失败,成功`. */
  readonly signature: string
  /** The member chains. */
  readonly chainIds: readonly string[]
  /** The shared causal skeleton (union of member skeletons, bounded). */
  readonly skeleton: readonly ChainStep[]
  /** The modal goal prefix of the member chains. */
  readonly goalDomain: string
  /** Aggregated measured utility: sum of member chains' hit/cited counts. */
  readonly hitCount: number
  readonly citedCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** The compressed cognitive-framework summary injected into the hot loop. */
export interface TaxonomyState {
  readonly version: number
  /** One-sentence summary of the current taxonomy (≤30 chars, zh). */
  readonly summaryShort: string
  /** Top decision rules, rendered in order. */
  readonly rules: readonly TaxonomyRule[]
  /** Epoch milliseconds of the last accepted rebuild. */
  readonly updatedAt: number
}

/** Outcome of one hot-loop predict call (the `/infer` contract). */
export interface PredictResult {
  readonly predictionId: string
  readonly advice: string
  readonly rawProbability: number
  readonly calibratedProbability: number
  readonly confidenceLow: number
  readonly confidenceHigh: number
  readonly isNovel: boolean
  /** Which OOD math signal fired, or 'none'. */
  readonly oodSignal: 'none' | 'low-similarity' | 'flat-top' | 'high-strangeness'
  /** Matched history sample count feeding the calibration prior. */
  readonly topHitCount: number
  readonly usedTempStrategy: boolean
  readonly clusterId: number | null
  /** Closest proven success cluster matched by the situation, or null. */
  readonly successReference: SuccessReference | null
  /** Taxonomy consulted during retrieval: routed region, confidence, coverage. */
  readonly taxonomyContext: TaxonomyContext
}

/** Outcome of one feedback call (the `/feedback` contract). */
export interface FeedbackResult {
  readonly status: 'logged'
  readonly predictionError: number
  readonly triggerRebuild: boolean
  readonly rebuildReason: string | null
}

/** One registered meta-cognition loop (a named special-experience layer). */
export interface MetaLoopSpec {
  /** Stable loop identity; its predictions carry a `loop:<name>` situation
   * prefix so the loop's decision history forms its own retrievable layer. */
  readonly name: string
  /** One-line description surfaced in inspection. */
  readonly description: string
  /** Optional execution sinks: when a decision approves, an execution request
   * is submitted to each sink. The loop only APPLIES — the sink decides
   * whether and how to execute under its own discipline (budgets, safety
   * gates). This is what truly closes the loop: 意志提交申请，执行层按纪律受理. */
  readonly execution?: readonly LoopExecutionSink[]
}

/** A loop decision submitted to an execution sink. The loop never commands —
 * it requests, and the sink enforces its own discipline. */
export interface LoopExecutionRequest {
  readonly loopName: string
  /** The decision action text. */
  readonly decision: string
  /** The situation the decision was made in (with the loop: prefix). */
  readonly situation: string
  /** Whether the decision approved (calibrated probability ≥ threshold). */
  readonly approved: boolean
  readonly probability: number
  readonly confidenceLow: number
  readonly confidenceHigh: number
  /** The decision's prediction id, for later feedback. */
  readonly predictionId: string
}

/** One execution access point a loop can drive. */
export interface LoopExecutionSink {
  /** Execution-point identifier (e.g. `hot-engine.explore-create`) for diagnostics. */
  readonly target: string
  /**
   * Accept (or refuse) one execution request under the sink's own discipline.
   * @param request - the loop's approved/refused decision.
   * @returns a human-readable rejection reason (non-null refuses execution),
   *   null/undefined accepts.
   */
  readonly apply: (request: LoopExecutionRequest) => string | null | void | Promise<string | null | void>
}

/** Durable record of one loop decision's execution request. The receipt is the
 * audit link between a decision and its execution outcome: `decideAndExecute`
 * persists one receipt per declared sink (id = `<predictionId>@<target>`), and
 * `settleExecution` marks the terminal outcome (executed/failed) and feeds it
 * back through the same report path — the execution result calibrates the loop
 * decision on the SAME |calibrated − observed| ruler as every prediction. */
export interface LoopExecutionReceipt {
  /** Stable identity: `<predictionId>@<target>`, unique per decision/sink. */
  readonly receiptId: string
  readonly loopName: string
  /** The decision prediction this execution belongs to. */
  readonly predictionId: string
  /** The sink target that handled (or refused) the request. */
  readonly target: string
  /** The decision action text. */
  readonly decision: string
  /** The situation the decision was made in (with the loop: prefix). */
  readonly situation: string
  /** Whether the sink refused under its own discipline. */
  readonly rejected: boolean
  /** The sink's refusal reason; null when accepted. */
  readonly reason: string | null
  readonly createdAt: number
  /** Terminal execution outcome once settled; null while pending. */
  readonly status: 'executed' | 'failed' | null
  readonly settledAt: number | null
  readonly outcomeText: string | null
  readonly outcomeQuality: number | null
}

/** Per-loop aggregation for inspection: the loop's decision history under
 * the same |calibrated − observed| ruler as every other prediction, plus the
 * execution ledger (how many requests were executed, refused, or failed). */
export interface CognitiveLoopStats {
  readonly name: string
  readonly description: string
  readonly predictionCount: number
  readonly resolvedCount: number
  /** Mean |calibrated − observed| over resolved predictions, null when none. */
  readonly avgPredictionError: number | null
  /** Execution receipts settled as executed. */
  readonly executedCount: number
  /** Execution receipts refused by a sink under its discipline. */
  readonly refusedCount: number
  /** Execution receipts settled as failed. */
  readonly failedCount: number
}

/** Lifecycle of one acceptance criterion. Retired checks are frozen: their
 * evidence ledger is never reset and they are no longer applied by audits. */
export type AcceptanceStatus = 'active' | 'retired'

/** The file-state expectation a file anchor asserts about the workspace. */
export type FileExpect = 'exists' | 'missing' | 'matches-hash' | 'contains'

/** The exit-code expectation a command anchor asserts about a run command. */
export type CommandExpect = 'exit-zero' | 'exit-nonzero'

/** A mechanically-verified external-witness anchor for a claim audit. The
 * witness is never the model's memory: a session-ledger tool call, a
 * workspace file state, or a command's exit code read/run at audit time.
 * When a claim anchors to a witness, the witness decides — a missing or
 * mismatched anchor violates the claim regardless of self-reported evidence. */
export type ClaimAnchor =
  | {
    readonly kind: 'log'
    /** The tool name whose most recent settled call is the witness. */
    readonly toolName: string
    /** The matched `tool/call` event's call id ('' when not found). */
    readonly callId: string
    /** The success flag the claim asserted about the call. */
    readonly expectedSucceeded: boolean
    /** Whether the ledger matched the expectation. */
    readonly matched: boolean
  }
  | {
    readonly kind: 'file'
    /** The workspace path the claim asserted about. */
    readonly path: string
    /** The file-state expectation the claim asserted. */
    readonly expect: FileExpect
    /** The expected hash for `matches-hash`. */
    readonly hash?: string
    /** The searched substring for `contains`. */
    readonly text?: string
    /** Whether the file state matched the expectation (false on unreadable). */
    readonly matched: boolean
  }
  | {
    readonly kind: 'command'
    /** The command whose exit code is the witness. */
    readonly command: string
    /** The exit-code expectation the claim asserted. */
    readonly expect: CommandExpect
    /** The observed exit code, null when the command could not settle (spawn
     * error or timeout — fail-closed). */
    readonly exitCode: number | null
    /** Whether the exit code matched the expectation (false when un-settled). */
    readonly matched: boolean
  }

/** One acceptance criterion: a reusable verification norm learned from
 * experience. The pipeline judges evidence PRESENCE, never evidence truth —
 * it cannot verify its own claims; truth is adjudicated downstream by the
 * resolved outcome and the user. This is the same self-reference boundary as
 * every other pipeline observation. */
export interface AcceptanceCheck {
  readonly checkId: string
  /** The norm as a testable statement, e.g. "声称完成前必须给出证据来源". */
  readonly criterion: string
  /** Situation marker selecting this check: an audit applies it when the
   * marker appears in the claim or its situation text. */
  readonly trigger: string
  /** What evidence the claim must carry to satisfy the criterion. */
  readonly evidenceHint: string
  readonly status: AcceptanceStatus
  /** Audits that applied this check. */
  readonly invokedCount: number
  /** Audits where the claim carried evidence for this check. */
  readonly passedCount: number
  /** Audits where the claim was made without evidence for this check. */
  readonly violatedCount: number
  /** Passes backed by a mechanically-verified external-witness anchor (a
   * session-log tool call or a workspace file state) rather than self-reported
   * evidence alone — the non-self-referential subset of the passed ledger, so
   * the pipeline can see how much of its acceptance rests on witnesses other
   * than the model's own report. */
  readonly machineVerifiedCount: number
  /** Rolling sum of |calibrated − observed| of resolved predictions whose
   * audit violated this check — "claims made without verification correlate
   * with bad outcomes" is measured on the same ruler as every prediction. */
  readonly cumulativeError: number
  /** How many feedback folds contributed to cumulativeError. */
  readonly errorFoldCount: number
  /** Bumped on every edit and on retire; retired checks never bump again. */
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One claim audit: a claim checked against the active acceptance criteria. */
export interface ClaimAudit {
  readonly auditId: string
  readonly claim: string
  readonly situation: string
  readonly verdict: 'verified' | 'violated' | 'not-applicable'
  readonly appliedCheckIds: readonly string[]
  readonly satisfiedCheckIds: readonly string[]
  readonly violatedCheckIds: readonly string[]
  /** The verification statement the claim carried; empty means the claim was
   * made without evidence. */
  readonly evidence: string
  /** The mechanically-verified external-witness anchor the claim referenced,
   * when one was requested: a session-ledger tool call (`log`) or a workspace
   * file state (`file`), plus whether the witness matched the expectation.
   * The witness decides — a missing or mismatched anchor is a violation
   * regardless of self-reported evidence. Null when no anchor was requested. */
  readonly anchor: ClaimAnchor | null
  /** True when the audit's satisfied checks were backed by a matched
   * external-witness anchor (the non-self-referential witness), false when
   * they rested on self-reported evidence alone. */
  readonly anchorVerified: boolean
  /** Optional prediction the claim is about; its report feedback folds into
   * the violated checks' error ledger. */
  readonly predictionId: string | null
  /** True when any applied check crossed the deviation gate at audit time. */
  readonly reworkNeeded: boolean
  /** expId of the deviation meta experience recorded for this audit, null
   * when no check crossed the gate. */
  readonly deviationExpId: string | null
  readonly createdAt: number
}

/** Outcome of one cold-loop rebuild (the `/rebuild/trigger` contract). */
export interface RebuildResult {
  readonly scope: 'local' | 'global'
  /** Whether the proposed taxonomy was accepted and written back. */
  readonly accepted: boolean
  /** True when the rebuild was postponed for insufficient labeled validation
   * samples rather than rejected on merit; the store is left untouched. */
  readonly deferred: boolean
  /** Validation-set error under the old taxonomy. */
  readonly oldError: number | null
  /** Validation-set error under the proposed taxonomy. */
  readonly newError: number | null
  /** (new - old) / old; null when the old error is zero. */
  readonly deltaError: number | null
  readonly clusterCount: number
  /** Clusters rejected by the evidence hard-constraint check. */
  readonly rejectedClusters: number
  readonly sampleCount: number
  /** Human-readable accept/reject/defer reason. */
  readonly reason: string
  readonly taxonomyVersion: number
}

/** Snapshot returned by the inspect tool / service. */
export interface InspectResult {
  readonly experienceCount: number
  readonly predictionCount: number
  readonly resolvedPredictionCount: number
  /** Variance-ledger aggregate: coverage of the settlement distribution
   * (experiences with samples / with ≥2 samples), total sample count, and how
   * many experiences the disequilibrium gate has flagged. */
  readonly settlement: {
    readonly sampleCount: number
    readonly sampledExperienceCount: number
    /** Experiences with at least two samples — variance is computable. */
    readonly multiSampleExperienceCount: number
    /** Experiences flagged by the disequilibrium gate (result distribution
     * shifted beyond threshold — accommodation candidates). */
    readonly disequilibratedExperienceCount: number
    /** Flagged experiences whose shift resolved (a later settlement returned
     * toward the mean — constraint 3's rollback). */
    readonly recoveredDisequilibriumCount: number
  }
  /** Citation-ledger aggregate (constraint 2): how many experiences a decision
   * actually adopted, and how many were never cited (island candidates). */
  readonly citation: {
    readonly citedExperienceCount: number
    readonly zeroCitationExperienceCount: number
  }
  /** Variant-candidate lifecycle counts (the accommodation pipeline). */
  readonly variants: {
    readonly proposed: number
    readonly testing: number
    readonly adopted: number
    readonly rejected: number
  }
  readonly clusterCount: number
  readonly activeTempStrategyCount: number
  readonly calibrationBuckets: readonly CalibrationBucket[]
  readonly taxonomy: TaxonomyState
  /** Learned multi-channel retrieval weights (feedback-driven). */
  readonly channelWeights: ChannelWeights
  /** Active-exploration statistics (scheme 2): budget, usage, ROI. */
  readonly exploration: {
    readonly budget: number
    readonly used: number
    readonly total: number
    readonly graduated: number
    readonly expired: number
    /** Explored strategies that paid off in practice (validated true). */
    readonly validated: number
    /** Explored strategies that failed in practice (validated false). */
    readonly refuted: number
    /** Average EWMA reuse error over validated/refuted entries, null when none. */
    readonly avgValidationError: number | null
    /** Autonomous task queue counts by status. */
    readonly tasks: { readonly pending: number; readonly running: number; readonly completed: number; readonly failed: number }
  }
  /** Registered meta-cognition loops and their per-loop calibration history. */
  readonly loops: readonly CognitiveLoopStats[]
  /** Recent loop-execution receipts, newest first (the 决策→申请→受理/拒绝→结算 audit chain). */
  readonly loopExecutions: readonly LoopExecutionReceipt[]
  /** Acceptance-criteria statistics: the verification-norm ledger. */
  readonly acceptance: {
    readonly checkCount: number
    readonly activeCount: number
    readonly retiredCount: number
    readonly invokedCount: number
    readonly passedCount: number
    readonly violatedCount: number
    /** violated / invoked over all audits, null when nothing was invoked. */
    readonly deviationRate: number | null
    /** Active checks whose invoked count cleared the evidence minimum and
     * whose deviation rate crossed the threshold — rewrite/retire candidates. */
    readonly reworkCheckIds: readonly string[]
  }
  /** Recent claim audits, newest first. */
  readonly recentAudits: readonly ClaimAudit[]
  /** Recent resolved predictions, newest first. */
  readonly recentResolved: readonly Prediction[]
}

/** Raw experience text plus an optional explicit outcome for SAR extraction. */
export interface RememberInput {
  readonly rawText: string
  /** Optional goal-trace tag: remember this experience as a member of the
   * given chain (the goal-anchored chain the orchestrator or caller is
   * executing), so the offline consolidation can assemble it. */
  readonly chainId?: string
}

/** One simulated-experience request: a hypothetical situation and proposed action. */
export interface SimulateInput {
  /** The hypothetical situation to reason about. */
  readonly situation: string
  /** The proposed action whose outcome is to be simulated. */
  readonly action: string
}

/** One hot-loop predict request. */
export interface PredictInput {
  readonly situation: string
  readonly action: string
  /** Optional context string folded into the calibration prompt. */
  readonly context?: string
}

/** One feedback request binding an actual outcome. */
export interface FeedbackInput {
  /** The prediction whose outcome is being reported. */
  readonly predictionId: string
  readonly actualOutcome: string
  /**
   * Actual outcome quality 0–10, required so every resolved prediction
   * carries a real, non-neutral utility signal; a neutral baseline is no
   * longer inferred from the outcome text.
   */
  readonly outcomeQuality: number
}

/** The cognition activity of one completed turn, surfaced to the GUI as a
 * per-turn bubble. Pure UI/observability data: it never enters a model request
 * (non-surface event) and only fires when the turn actually produced cognition
 * activity, so quiet turns show nothing. */
export interface TurnCognitionSummary {
  /** The turn this summary describes. */
  readonly turn: number
  /** Experiences newly accumulated by this turn (empty when autoAccumulate is
   * off or the LLM gate rejected the episode). */
  readonly newExperiences: readonly { expId: string; topic: string }[]
  /** Injection citation settlement for this turn. */
  readonly citationSettlement: {
    readonly settled: number
    readonly cited: number
  }
  /** Predictions resolved during this turn. */
  readonly resolvedPredictions: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Completed-turn cognition summary (UI-only; see TurnCognitionSummary). */
    'cognition/turn-summary': TurnCognitionSummary
  }
}
