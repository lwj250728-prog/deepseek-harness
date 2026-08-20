# Prediction-error-driven dynamic cognition (DCA-PED)

English | [中文](cognitive-pipeline.zh.md)

Types and service contract of the cognitive pipeline plugin [`@deepseek-ai/dsh-cognitive-pipeline`](../../packages/cognition/cognitive-pipeline/README.md). The package encodes experiences as Situation–Action–Result triplets, predicts with five-layer calibrated confidence intervals, corrects through feedback, and periodically rebuilds its taxonomy in utility space; this page records the exact domain types from [packages/cognition/cognitive-pipeline/src/types.ts](../../packages/cognition/cognitive-pipeline/src/types.ts).

## Experience memory

An experience is a SAR triplet with two deterministic vectors: the action vector drives retrieval, and the outcome vector (utility slots dominating hashed outcome text) drives utility-space clustering.

```ts type-equiv
/** The Situation–Action–Result triplet a raw experience is encoded into. */ interface SarTriplet {
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
```

```ts type-equiv
/** Quantified short/medium-term feedback of one experience (0–10 each). */ interface OutcomeUtility {
  /** Material or monetary gain/loss (5 = neutral). */
  readonly materialGain: number
  /** Emotional valence (5 = neutral). */
  readonly emotionalValence: number
  /** Energy / cognitive cost spent (5 = moderate). */
  readonly energyCost: number
}
```

```ts type-equiv
/** One stored experience (the main memory row). */ interface Experience {
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
```

## Predictions and feedback

One logged hot-loop prediction with its calibration and resolution fields.

```ts type-equiv
/** One logged hot-loop prediction (the prediction log row). */ interface Prediction {
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
```

## Scratchpad, calibration, and taxonomy

The scratchpad strategy, the lifetime calibration decile, the cold-loop cluster, and the compressed taxonomy summary.

```ts type-equiv
/** One OOD scratchpad row: a tentative strategy awaiting enough hits to graduate. */ interface TempStrategy {
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
```

```ts type-equiv
/** Lifetime calibration statistics for one confidence decile. */ interface CalibrationBucket {
  /** Decile index 0–9 covering [bucketIndex*10, (bucketIndex+1)*10) percent. */
  readonly bucketIndex: number
  readonly totalCount: number
  readonly hitCount: number
  /** hitCount / totalCount; null before any count. */
  readonly empiricalAccuracy: number | null
}
```

```ts type-equiv
/** One cold-loop cluster: a named strategy family with grounded evidence. */ interface Cluster {
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
```

```ts type-equiv
/** The compressed cognitive-framework summary injected into the hot loop. */ interface TaxonomyState {
  readonly version: number
  /** One-sentence summary of the current taxonomy (≤30 chars, zh). */
  readonly summaryShort: string
  /** Top decision rules, rendered in order. */
  readonly rules: readonly TaxonomyRule[]
  /** Epoch milliseconds of the last accepted rebuild. */
  readonly updatedAt: number
}
```

## Service I/O contracts

The online/offline service I/O contracts.

```ts type-equiv
/** One hot-loop predict request. */ interface PredictInput {
  readonly situation: string
  readonly action: string
  /** Optional context string folded into the calibration prompt. */
  readonly context?: string
}
```

```ts type-equiv
/** Outcome of one hot-loop predict call (the `/infer` contract). */ interface PredictResult {
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
```

```ts type-equiv
/** One feedback request binding an actual outcome. */ interface FeedbackInput {
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
```

```ts type-equiv
/** Outcome of one feedback call (the `/feedback` contract). */ interface FeedbackResult {
  readonly status: 'logged'
  readonly predictionError: number
  readonly triggerRebuild: boolean
  readonly rebuildReason: string | null
}
```

```ts type-equiv
/** Outcome of one cold-loop rebuild (the `/rebuild/trigger` contract). */ interface RebuildResult {
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
```

```ts type-equiv
/** Snapshot returned by the inspect tool / service. */ interface InspectResult {
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
```

`PipelineCallContext` (`{ sessionId?, signal? }`, defined in `src/service.ts`) is the optional call context every service method accepts for LLM-assisted steps.

## Service

`ctx.cognitivePipeline` (class `CognitivePipelineService`) owns the store and both engines. Its methods are the online (`remember`/`predict`/`report`), offline (`rebuild`), and observational (`inspect`) entry points; the generated service catalog below lists each method's exact signature.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcognitivepipeline--cognitivepipelineservice"></a>

### `ctx.cognitivePipeline` — `CognitivePipelineService`

The pipeline service.

```ts cordis-catalog
/** Resolve after the store finished loading (never rejects). */
async ready(): Promise<void>

/** Flush all pending persistence writes. */
async flush(): Promise<void>

/** Encode one raw experience into SAR, vectorize, and store it.
 * @param input - the raw experience text.
 * @param call - optional session/signal context.
 * @returns the new experience id and its SAR triplet.
 */
async remember(input: RememberInput, call?: PipelineCallContext): Promise<{ expId: string; sar: SarTriplet }>

/** Hot-loop prediction.
 * @param input - the situation/action to predict.
 * @param call - optional session/signal context.
 * @returns the calibrated prediction result.
 */
async predict(input: PredictInput, call?: PipelineCallContext): Promise<PredictResult>

/** Feedback loop: resolve a prediction, update calibration and scratchpad.
 * @param input - the prediction id and actual outcome.
 * @param call - optional session/signal context.
 * @returns the logged feedback result.
 */
async report(input: FeedbackInput, call?: PipelineCallContext): Promise<FeedbackResult>

/** Cold-loop rebuild.
 * @param scope - local or global.
 * @param call - optional session/signal context.
 * @returns the backtested rebuild outcome.
 */
async rebuild(scope: 'local' | 'global', call?: PipelineCallContext): Promise<RebuildResult>

/** Observational snapshot for the inspect tool.
 * @returns counts, clusters, calibration, taxonomy, and recent resolved predictions.
 */
inspect(): InspectResult

/** The dynamic cognition prefix for the system-prompt section.
 * @returns the 附录B prefix text.
 */
taxonomyPrefix(): string

/** All clusters (public for inspection).
 * @returns a detached cluster list.
 */
clusters(): readonly Cluster[]

/** All calibration buckets (public for inspection).
 * @returns a detached bucket table.
 */
calibrationBuckets(): readonly CalibrationBucket[]

/** Current taxonomy (public for inspection).
 * @returns the taxonomy, or null before the first rebuild.
 */
taxonomy(): TaxonomyState | null

/** Active + graduated scratchpad strategies (public for inspection).
 * @returns a detached strategy list.
 */
tempStrategies(): readonly TempStrategy[]
```

Source: [`packages/cognition/cognitive-pipeline/src/service.ts:192`](../../packages/cognition/cognitive-pipeline/src/service.ts)
<!-- END GENERATED cordis-surface -->
