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
/** One real execution-result sample of an experience, appended at each
 * resolved prediction that carries an outcome quality. The settlement list is
 * the variance ledger: its distribution measures how uncertain the
 * experience's result actually is (the driver framework's variance
 * perception), in contrast to the single-point self-reported utility. */ interface SettlementSample {
  /** Epoch milliseconds of the settlement. */
  readonly ts: number
  /** Raw outcome quality 0–10 (5 = neutral), the un-scaled signal. */
  readonly quality: number
}
```

```ts type-equiv
/** A settled disequilibrium event: one settlement sample deviated from the
 * experience's prior sample distribution beyond the gate threshold (z ≥
 * `disequilibriumZThreshold` with ≥ `disequilibriumMinSamples` prior samples).
 * The result distribution has shifted, so the recorded strategy may need
 * re-evaluation (the driver framework's accommodation trigger) instead of
 * being assimilated as noise. Set once, retained as audit history. */ interface DisequilibriumEvent {
  /** Epoch milliseconds of the deviating settlement. */
  readonly atTs: number
  /** The deviating sample's raw quality (0–10). */
  readonly sampleQuality: number
  /** The deviation magnitude (|q − μ|/σ over the prior distribution). */
  readonly zScore: number
}
```

```ts type-equiv
/** Lifecycle state of one variant candidate: proposed after generation,
 * testing while real uses settle it, then adopted or rejected. */ type VariantStatus = 'proposed' | 'testing' | 'adopted' | 'rejected'
```

```ts type-equiv
/** One structured improvement candidate for a solidified strategy whose
 * deviation gate flagged rework (or a disequilibrated experience). The variant
 * perturbs one step or parameter of the base action while keeping the
 * verification anchor unchanged — the driver framework's accommodation: the
 * anchor is the test, the variant is the revised procedure. */ interface VariantCandidate {
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
```

```ts type-equiv
/** One stored experience (the main memory row). */ interface Experience {
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
  /** Times this experience's cluster matched a hot-loop prediction. */
  readonly hitCount: number
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
interface SolidifiedStrategy {
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

## Acceptance criteria and claim audits

Acceptance criteria are reusable verification norms the agent audits claims against before treating them as settled. The pipeline records evidence **presence**, never evidence truth — it cannot verify its own claims; truth is adjudicated by the resolved outcome and the user. When a claim anchors to an external witness (`log_anchor` for the session ledger, `file_anchor` for the workspace disk, `command_anchor` for a command's actual exit code), the witness mechanically decides instead: a matched anchor satisfies, a missing or mismatched one violates regardless of self-report — the witness is non-self-referential, so an anchored claim cannot be validated by self-report alone. Criteria also self-amend through experience: `propose_acceptance_update` asks the LLM route to propose rewrites or retirements of demonstrably failing criteria, and the experience gate applies only proposals that target a failing criterion, carry a rationale, and carry concrete rewrite text. Retired criteria are frozen: their evidence ledger is never reset and audits no longer apply them.

```ts type-equiv
/** One acceptance criterion: a reusable verification norm learned from
 * experience. The pipeline judges evidence PRESENCE, never evidence truth —
 * it cannot verify its own claims; truth is adjudicated downstream by the
 * resolved outcome and the user. This is the same self-reference boundary as
 * every other pipeline observation. */
interface AcceptanceCheck {
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
```

```ts type-equiv
/** A mechanically-verified external-witness anchor for a claim audit. The
 * witness is never the model's memory: a session-ledger tool call, a
 * workspace file state, or a command's exit code read/run at audit time.
 * When a claim anchors to a witness, the witness decides — a missing or
 * mismatched anchor violates the claim regardless of self-reported evidence. */
type ClaimAnchor =
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
```

```ts type-equiv
/** One LLM-proposed acceptance-criterion update (template 8), before the
 * experience gate: a proposal only touches the ledger when it targets a
 * demonstrably failing criterion (deviation rate at/above the threshold with
 * enough invoked audits), carries a rationale, and carries concrete rewrite
 * text for `rewrite` — criteria are self-amended only through the data gate,
 * never by fiat. */
interface AcceptanceProposal {
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
```

```ts type-equiv
/** One claim audit: a claim checked against the active acceptance criteria. */
interface ClaimAudit {
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
```

## Trigger-jump lexicon and injection records

The associative layer over the injection trigger words and the durable trace of every injection, feeding the citation-rate reinforcement loop.

```ts type-equiv
/** One trigger-jump association: a word whose presence activates
 * evidence-backed trigger words in the injection gate — the associative layer
 * over the static and derived trigger lexicons. Every jump carries its
 * evidence (distinct experiences, summed importance, or an LLM rationale),
 * its measured utility (citation rate from the injection loop), and its
 * source — nothing enters the lexicon without an accountable basis. */
interface TriggerJump {
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
```

```ts type-equiv
/** One injection event, recorded for citation-rate measurement: did the model
 * actually use the injected experience? The answer folds back into the jump
 * words that contributed to the trigger, feeding the reinforcement loop. */
interface InjectionRecord {
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
```

```ts type-equiv
/** One step of a consolidated chain: a scene in the goal-anchored sequence —
 * the causal skeleton keeps failure steps and delegation nodes as structural
 * steps and collapses routine successes into the summary (memory organizes
 * around surprises, Schank). */
interface ChainStep {
  /** The node this step derives from: a member experience id or a delegation receipt. */
  readonly nodeId: string
  /** The step's observable text (action/outcome of the scene). */
  readonly text: string
  readonly polarity: 'success' | 'failure'
  readonly sequence: number
}
```

```ts type-equiv
/** A consolidated goal-anchored chain: the aggregated projection of the
 * experiences tagged with one chainId, collapsed to its causal skeleton. This
 * is the fifth derived cognition object — the pipeline calibrates whether the
 * whole goal execution was worth remembering (chain-level citation rate), one
 * level above single experiences and one below decision loops. */
interface ChainExperience {
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
```

```ts type-equiv
/** One recurring goal-execution pattern: chains with the same structural
 * signature, aggregated from the chain table — the sixth derived cognition
 * object (the abstraction's first recursive consumer: patterns project from
 * chains the way chains project from experiences). The TOPS analogue: from
 * similar MOPs, extract the cross-situation thematic pattern. */
interface ChainPattern {
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
```

```ts type-equiv
/** The lifecycle a derived cognition object declares. */
interface CognitionObjectKind<T> {
  /** Stable kind identity (e.g. `chain`). */
  readonly name: string
  /** One line describing what this kind derives and measures. */
  readonly description: string
  /** Project the store into a candidate build; the kind applies its evidence
   * gate. Synchronous kinds return the build directly; kinds with an LLM
   * step return a promise. */
  project(store: CognitiveStore, config: CognitionObjectConfig): readonly T[] | Promise<readonly T[]>
  /** Persist a gated build, carrying identity + evidence. */
  persist(store: CognitiveStore, build: readonly T[]): void
  /** Fold one piece of feedback into an object's measured ruler. */
  measure(store: CognitiveStore, objectId: string, feedback: unknown): void
  /** Reinforce on rebuild: carry measured stats across the projection, apply gates. */
  reinforce(store: CognitiveStore, config: CognitionObjectConfig, build: readonly T[]): readonly T[]
  /** The current objects (the model-visible source). */
  current(store: CognitiveStore): readonly T[]
}
```

## Meta-cognition loops, exploration, and turn accumulation

The named-loop layer, its execution receipts, the autonomous-exploration task queue, and the turn-reconstruction material feeding automatic accumulation.

```ts type-equiv
/** One completed agent turn reconstructed from the session log, as the candidate
 * raw material for automatic experience accumulation. */
interface TurnEpisode {
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
```

```ts type-equiv
/** One queued autonomous exploration: a cross-session goal a background
 * agent session picks up, executes silently, and writes back as experience. */
interface ExplorationTask {
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
```

```ts type-equiv
/** One registered meta-cognition loop (a named special-experience layer). */
interface MetaLoopSpec {
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
```

```ts type-equiv
/** One execution access point a loop can drive. */
interface LoopExecutionSink {
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
```

```ts type-equiv
/** Durable record of one loop decision's execution request. The receipt is the
 * audit link between a decision and its execution outcome: `decideAndExecute`
 * persists one receipt per declared sink (id = `<predictionId>@<target>`), and
 * `settleExecution` marks the terminal outcome (executed/failed) and feeds it
 * back through the same report path — the execution result calibrates the loop
 * decision on the SAME |calibrated − observed| ruler as every prediction. */
interface LoopExecutionReceipt {
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

/**
 * Generate a simulated experience via the LLM route: a retrieval-only,
 * unverified candidate for "if I take this action in this situation, what
 * would happen". It shapes no cluster until real feedback verifies it.
 * @param input - the hypothetical situation and proposed action.
 * @param call - optional session/signal context.
 * @returns the new simulated experience id and its SAR triplet.
 */
async simulate( input: SimulateInput, call?: PipelineCallContext, ): Promise<{ expId: string; sar: SarTriplet }>

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
async deriveReference( input: { situation: string; action: string }, call?: PipelineCallContext, ): Promise<{ expId: string; sar: SarTriplet } | null>

/** Hot-loop prediction.
 * @param input - the situation/action to predict.
 * @param call - optional session/signal context.
 * @returns the calibrated prediction result.
 */
async predict(input: PredictInput, call?: PipelineCallContext): Promise<PredictResult>

/**
 * Directly record a pipeline-own (meta) observation without LLM extraction —
 * the structured path for automatic retrieval-failure SAR-ization. Meta
 * experiences with a non-neutral utility join the cold-loop sample, so the
 * pipeline can cluster and learn from its own failure modes.
 * @param input - the structured SAR fields for the observation.
 * @returns the new experience id.
 */
rememberMeta(input: { situation: string; action: string; outcome: string; utility: OutcomeUtility }): string

/**
 * Automatic accumulation: judge one completed turn through the LLM gate and
 * write it as an experience when the route deems it worth it. A deterministic
 * pre-filter (pure chat: no tool calls, no failure, short output) never
 * reaches the per-turn LLM call. Without an explicit route the gate rejects.
 * @param episode - the reconstructed turn material.
 * @param call - optional session/signal context.
 * @returns the new experience id when accumulated, or null.
 */
async accumulateTurn(episode: TurnEpisode, call?: PipelineCallContext): Promise<string | null>

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

/** Queue an autonomous exploration task for a background session to execute
 * silently (scheme 2 cross-session dispatch). The goal text becomes the
 * executing session's task; the result is written back as an experience.
 * @param goal - the exploration goal.
 * @returns the queued task.
 */
async explore(goal: string): Promise<ExplorationTask>

/** Snapshot of the queued exploration tasks (public for inspection).
 * @returns the task list, insertion order.
 */
explorationTasks(): readonly ExplorationTask[]

/** Register a meta-cognition loop (declarative "造新环路").
 * @param spec - the loop's identity and description.
 * @returns the service, for chaining.
 */
registerLoop(spec: MetaLoopSpec): this

/** Registered meta-cognition loops, in registration order.
 * @returns the loop specs.
 */
loopList(): readonly MetaLoopSpec[]

/**
 * Build a ready-made execution sink that drives the ACTIVE-EXPLORATION
 * execution layer under its own discipline (reversibility safety gate +
 * daily budget). A loop that attaches this sink truly closes the loop: an
 * approved decision creates a scratchpad and (when configured) queues an
 * autonomous exploration task — 意志批准，执行层按纪律受理.
 * @returns a sink targetable as `hot-engine.explore-create`.
 */
createExplorationSink(): LoopExecutionSink

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
async decideLoop( name: string, decision: string, situation: string, call?: PipelineCallContext, ): Promise<PredictResult>

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
async feedbackLoop( name: string, predictionId: string, actualOutcome: string, outcomeQuality: number, call?: PipelineCallContext, ): Promise<FeedbackResult>

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
async decideAndExecute( name: string, decision: string, situation: string, threshold: number = 0.55, call?: PipelineCallContext, ): Promise<{ decision: PredictResult approved: boolean executions: readonly LoopExecutionReceipt[] }>

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
async settleExecution( receiptId: string, outcomeText: string, outcomeQuality: number, status: 'executed' | 'failed' = 'executed', call?: PipelineCallContext, ): Promise<{ receipt: LoopExecutionReceipt; feedback: FeedbackResult }>

/** The dynamic cognition prefix for the system-prompt section.
 * @returns the 附录B prefix text.
 */
taxonomyPrefix(): string

/**
 * Define one acceptance criterion: a reusable verification norm the agent
 * audits claims against before treating them as settled. The pipeline
 * records evidence PRESENCE, never evidence truth — it cannot verify its own
 * claims; truth is adjudicated by the resolved outcome and the user.
 * @param input - the criterion statement, its trigger marker, and the
 *   evidence hint that satisfies it.
 * @returns the new criterion, active with an empty evidence ledger.
 */
async defineAcceptanceCheck(input: { criterion: string trigger: string evidenceHint: string }): Promise<AcceptanceCheck>

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
async auditClaim(input: { claim: string situation: string evidence?: string predictionId?: string anchor?: ClaimAnchor | null }): Promise<ClaimAudit>

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
async updateAcceptanceCheck(input: { checkId: string criterion?: string evidenceHint?: string trigger?: string retire?: boolean }): Promise<AcceptanceCheck>

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
async proposeAcceptanceUpdate(call?: PipelineCallContext): Promise<{ flagged: readonly AcceptanceCheck[] proposals: readonly AcceptanceProposal[] applied: readonly AcceptanceCheck[] }>

/** All acceptance criteria (public for inspection).
 * @returns a detached criterion list, insertion order.
 */
acceptanceChecks(): readonly AcceptanceCheck[]

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
async runCommandExitCode(command: string, timeoutMs: number): Promise<number | null>

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
async learnTriggerJumps(call?: PipelineCallContext): Promise<{ jumpCount: number cooccurrenceCount: number llmAdded: number pruned: number }>

/** The trigger-jump lexicon (public for the inject plugin's gate).
 * @returns a detached jump list, insertion order.
 */
triggerJumps(): readonly TriggerJump[]

/**
 * Record one injection event for citation-rate measurement. The inject
 * plugin calls this after folding the reference block into the step; the
 * jump words that contributed to the trigger are carried so their measured
 * utility can be folded when the citation settles.
 * @param input - the injected expIds, the fired trigger source, the
 *   contributing jump words, and the session id when known.
 * @returns the recorded injection.
 */
recordInjection(input: { expIds: readonly string[] triggerSource: string sessionId?: string | null jumpWords?: readonly string[] chainId?: string | null strategyId?: string | null }): InjectionRecord

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
async settleInjectionCitations(sessionId: string, turnText: string): Promise<{ settled: number; cited: number }>

/**
 * Register a derived cognition object kind: a declaration of one
 * special-experience layer (project/persist/measure/reinforce/expose) that
 * the generic driver can rebuild. Re-registering the same name replaces the
 * kind.
 * @param kind - the kind to register.
 * @returns the service, for chaining.
 */
registerCognitionObject<T>(kind: CognitionObjectKind<T>): this

/** Registered derived cognition object kinds, in registration order.
 * @returns the kind metadata.
 */
cognitionObjects(): readonly { name: string; description: string }[]

/**
 * Drive one derived cognition object through its lifecycle: project the
 * store into a candidate build, reinforce (carry measured stats, apply the
 * kind's gates), and persist. This is the declarative payoff — a new object
 * kind costs a declaration, and this one driver serves every kind.
 * @param name - the registered kind name.
 * @returns the build summary.
 */
async rebuildCognitionObject(name: string): Promise<{ kind: string; built: number; pruned: number }>

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
async consolidateChain(chainId: string, goal?: string): Promise<ChainExperience | null>

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
solidifyStrategy(input: { goalDomain: string action: string verificationAnchor: string preChecks?: readonly string[] sourceChainId?: string }): SolidifiedStrategy

/** The solidified strategy serving one goal domain, if any.
 * @param goalDomain - the goal domain key (e.g. `重启`).
 * @returns the strategy, or undefined.
 */
solidifiedStrategyFor(goalDomain: string): SolidifiedStrategy | undefined

/** All solidified strategies (public for inspection).
 * @returns the strategy list.
 */
solidifiedStrategies(): readonly SolidifiedStrategy[]

/**
 * Record one use of a solidified strategy and fold its outcome into the
 * lifecycle ledger. Every use re-checks the environment through the
 * verification anchor — the drift sensor — so a strategy that no longer
 * matches the environment accumulates violations and is flagged for rework
 * instead of failing silently.
 * @param strategyId - the strategy id.
 * @param positive - whether the verification anchor held on this use.
 */
recordSolidifiedStrategyUsage(strategyId: string, positive: boolean): void

/** All chains (public for inspection and consumers).
 * @returns a detached chain list, insertion order.
 */
chains(): readonly ChainExperience[]

/**
 * Render one chain as structured, model-visible steps — the causal skeleton
 * the injection path would present (goal anchor, failure steps marked, the
 * routine summary collapsed).
 * @param chainId - the chain to render.
 * @returns the structured text, or null when the chain is unknown.
 */
chainExpose(chainId: string): string | null

/**
 * The child chains of one chain (tree edges derived at consolidation: a
 * delegated sub-goal's chain hangs under the delegating chain's receipt).
 * @param chainId - the parent chain.
 * @returns the child chain ids, or [] when the chain is unknown.
 */
chainChildren(chainId: string): readonly string[]

/**
 * Render one chain and its goal-structure subtree as structured,
 * model-visible text: each node's causal skeleton, children indented. This
 * is the goal-structured-diffusion surface — a hit on the parent can walk
 * down to sub-goal outcomes.
 * @param chainId - the root chain.
 * @param depth - how many levels below the root to include (default 3).
 * @returns the tree text, or null when the root chain is unknown.
 */
chainTreeExpose(chainId: string, depth: number = 3): string | null

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
exploreChainNeighbors( expId: string, minCosine: number = 0.3, limit: number = 5, ): { anchor: string upstream: readonly { expId: string; cosine: number; text: string }[] downstream: readonly { expId: string; cosine: number; text: string }[] } | null

/** Recent claim audits (public for inspection).
 * @param limit - how many audits, newest first (default 10).
 * @returns the most recent audits.
 */
claimAudits(limit: number = 10): readonly ClaimAudit[]

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

Source: [`packages/cognition/cognitive-pipeline/src/service.ts:583`](../../packages/cognition/cognitive-pipeline/src/service.ts)
<!-- END GENERATED cordis-surface -->
