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

/** One stored experience (the main memory row). */
export interface Experience {
  readonly expId: string
  readonly sar: SarTriplet
  /** Deterministic hashed action vector (the retrieval axis). */
  readonly actionVector: readonly number[]
  /** Deterministic hashed outcome vector (the clustering axis). */
  readonly outcomeVector: readonly number[]
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
  /** Times this experience's cluster matched a hot-loop prediction. */
  readonly hitCount: number
  /** Times the predicted outcome matched the actual outcome. */
  readonly positiveCount: number
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
  /** Epoch milliseconds at prediction. */
  readonly timestamp: number
  /** Actual outcome text once reported via feedback, null otherwise. */
  readonly actualOutcome: string | null
  /** Absolute prediction error after feedback (0–1), null before resolution. */
  readonly predictionError: number | null
  /** Epoch milliseconds at feedback, null before resolution. */
  readonly resolvedAt: number | null
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
}

/** One decision rule rendered into the dynamic system-prompt summary. */
export interface TaxonomyRule {
  readonly condition: string
  readonly action: string
  readonly utilityRange: UtilityRange
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
}

/** Outcome of one feedback call (the `/feedback` contract). */
export interface FeedbackResult {
  readonly status: 'logged'
  readonly predictionError: number
  readonly triggerRebuild: boolean
  readonly rebuildReason: string | null
}

/** Outcome of one cold-loop rebuild (the `/rebuild/trigger` contract). */
export interface RebuildResult {
  readonly scope: 'local' | 'global'
  readonly accepted: boolean
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
  /** Human-readable accept/reject reason. */
  readonly reason: string
  readonly taxonomyVersion: number
}

/** Snapshot returned by the inspect tool / service. */
export interface InspectResult {
  readonly experienceCount: number
  readonly predictionCount: number
  readonly resolvedPredictionCount: number
  readonly clusterCount: number
  readonly activeTempStrategyCount: number
  readonly calibrationBuckets: readonly CalibrationBucket[]
  readonly taxonomy: TaxonomyState
  /** Recent resolved predictions, newest first. */
  readonly recentResolved: readonly Prediction[]
}

/** Raw experience text plus an optional explicit outcome for SAR extraction. */
export interface RememberInput {
  readonly rawText: string
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
   * Optional model-supplied outcome quality 0–10. When provided it is used
   * directly as the observed utility; otherwise the pipeline LLM-extracts the
   * SAR utility from the outcome text, and 0.5 is the no-information baseline.
   */
  readonly outcomeQuality?: number
}
