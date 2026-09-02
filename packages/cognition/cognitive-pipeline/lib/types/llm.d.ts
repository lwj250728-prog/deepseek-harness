/**
 * Typed LLM helpers for the cognitive pipeline. Each model-assisted step is a
 * best-effort enhancement over a deterministic fallback: a missing adapter, an
 * unreachable route, or a malformed JSON reply never breaks the pipeline — it
 * degrades to the mathematically safe path (附录C of the design).
 * @module @deepseek-ai/dsh-cognitive-pipeline/llm
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { AcceptanceCheck, AcceptanceProposalDecision, AccumulationDecision, DeriveReferenceDecision, Experience, OutcomeUtility, RefineRetrievalDecision, SarTriplet } from './types.ts';
/** Explicit provider/model route; both or neither must be set. */
export interface CognitiveLlmRoute {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
}
/** Stable error taxonomy for pipeline-side failures. */
export declare class CognitivePipelineError extends Error {
    /** Stable machine-readable error code. */
    readonly code: string;
    /**
     * @param message - non-empty human-readable failure summary.
     * @param code - non-empty stable machine code.
     */
    constructor(message: string, code: string);
}
/** Structured template-2 OOD review result. */
export interface OodReview {
    readonly isKnown: boolean;
    readonly confidenceScore: number;
    readonly reasoningShort: string;
    readonly suggestedInitialRiskLevel: 'low' | 'medium' | 'high';
}
/** Structured template-3 calibration result. */
export interface CalibrationOutput {
    readonly baseSuccessRate: number;
    readonly riskFactors: readonly string[];
    readonly finalConfidenceIntervalLow: number;
    readonly finalConfidenceIntervalHigh: number;
    readonly finalCalibratedProbability: number;
    readonly advicePreview: string;
}
/** A cluster as returned by template 4, before backend evidence verification. */
export interface RawReconstructCluster {
    readonly clusterName: string;
    readonly decisionRule: string;
    readonly expectedUtilityRange: {
        low: number;
        high: number;
    };
    readonly supportingEvidenceIds: readonly string[];
    readonly fallbackAction: string;
}
/** Structured template-4 reconstruction result. */
export interface ReconstructOutput {
    readonly newClusters: readonly RawReconstructCluster[];
    readonly taxonomySummaryShort: string;
}
/** Whether an explicit route is configured at all.
 * @param route - the configured route pair.
 * @returns true when both provider and model are set.
 */
export declare function hasExplicitRoute(route: CognitiveLlmRoute): boolean;
/** Validate the route pair; both or neither must be present and non-empty.
 * @param route - the candidate route.
 * @returns a validated route, or an empty route.
 */
export declare function resolveRoute(route: CognitiveLlmRoute): CognitiveLlmRoute;
/** Extract the first balanced JSON object from model text.
 * @param text - the raw model output.
 * @returns the parsed JSON value.
 */
export declare function extractJson(text: string): unknown;
/** Options for one pipeline LLM call. */
interface CallOptions {
    readonly sessionId?: GenerateOptions['sessionId'] | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly maxTokens?: number;
}
/**
 * Template 1: extract the SAR triplet. Falls back to a deterministic split.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param rawText - the raw experience text.
 * @param options - call context (session/signal/maxTokens).
 * @returns the extracted triplet.
 */
export declare function extractSar(ctx: Context, route: CognitiveLlmRoute, rawText: string, options: CallOptions): Promise<SarTriplet>;
/** Deterministic template-2 fallback: trust the math-only OOD signal.
 * @param isKnown - the math-only decision.
 * @returns a review with 50% confidence.
 */
export declare function oodReviewFallback(isKnown: boolean): OodReview;
/**
 * Template 2: confirm or deny OOD. Falls back to the math-only decision.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param action - the proposed action text.
 * @param topActions - the top historical actions for review.
 * @param mathSaysKnown - the math-only OOD decision.
 * @param options - call context (session/signal/maxTokens).
 * @returns the review verdict.
 */
export declare function reviewOod(ctx: Context, route: CognitiveLlmRoute, action: string, topActions: readonly {
    expId: string;
    action: string;
    similarity: number;
}[], mathSaysKnown: boolean, options: CallOptions): Promise<OodReview>;
/** Deterministic template-3 fallback: pure frequency prior with a wide interval.
 * @param positiveCount - positive history hits.
 * @param negativeCount - negative history hits.
 * @returns a fallback calibration output.
 */
export declare function calibrationFallback(positiveCount: number, negativeCount: number): CalibrationOutput;
/**
 * Template 3: five-layer calibration (frequency prior, adversarial factors,
 * interval output). Backend shrinkage and bucket correction happen in the hot
 * engine; this helper only covers the LLM-facing layers.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - the situation/action plus history statistics.
 * @param options - call context (session/signal/maxTokens).
 * @returns the calibration output.
 */
export declare function calibrate(ctx: Context, route: CognitiveLlmRoute, input: {
    situation: string;
    action: string;
    context?: string | undefined;
    positiveCount: number;
    negativeCount: number;
    samples: readonly {
        expId: string;
        actionKeywords: string;
        utility: string;
    }[];
}, options: CallOptions): Promise<CalibrationOutput>;
/** Deterministic template-4 fallback: name clusters from utility means.
 * @param groups - the agglomerative groups with evidence and mean utility.
 * @param summaryShort - the fallback taxonomy summary.
 * @returns deterministic cluster output.
 */
export declare function reconstructFallback(groups: readonly {
    evidenceIds: readonly string[];
    meanUtility: OutcomeUtility;
}[], summaryShort: string): ReconstructOutput;
/**
 * Template 4: causal-anchored taxonomy reconstruction. Falls back to
 * deterministic cluster naming when the model path is unavailable.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param samples - the sampled train experiences.
 * @param groups - the agglomerative groups with evidence and mean utility.
 * @param summaryShort - fallback taxonomy summary.
 * @param options - call context (session/signal/maxTokens).
 * @returns the reconstruction output.
 */
export declare function reconstructTaxonomy(ctx: Context, route: CognitiveLlmRoute, samples: readonly Experience[], groups: readonly {
    evidenceIds: readonly string[];
    meanUtility: OutcomeUtility;
}[], summaryShort: string, options: CallOptions): Promise<ReconstructOutput>;
/** Deterministic template-5 fallback: reject accumulation (no route → no gate).
 * @returns the rejection decision.
 */
export declare function accumulationFallback(): AccumulationDecision;
/**
 * Template 5: the accumulation gate. The LLM route judges whether a completed
 * turn is worth becoming an experience and extracts the SAR triplet when it is.
 * Without an explicit route the gate deterministically rejects — automatic
 * accumulation never runs unjudged.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param episode - the completed turn's situation/action/outcome material.
 * @param similar - retrieved history hits for the novelty judgment.
 * @param options - call context (session/signal/maxTokens).
 * @returns the accumulation decision.
 */
export declare function evaluateAccumulation(ctx: Context, route: CognitiveLlmRoute, episode: {
    situation: string;
    action: string;
    outcome: string;
}, similar: readonly {
    expId: string;
    text: string;
    similarity: number;
}[], options: CallOptions): Promise<AccumulationDecision>;
/** Deterministic template-6 fallback: reject derivation (no route → no reference).
 * @returns the rejection decision.
 */
export declare function deriveReferenceFallback(): DeriveReferenceDecision;
/**
 * Template 6: derive a reference experience from the commonalities of similar
 * history — an online generalization for cold start. The LLM route extracts
 * the shared situation/action/outcome/utility pattern; without a route it
 * deterministically rejects.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param query - the current situation/action to anchor the derivation.
 * @param similar - the retrieved similar history hits.
 * @param options - call context (session/signal/maxTokens).
 * @returns the derivation decision with the reference SAR when derived.
 */
export declare function deriveReference(ctx: Context, route: CognitiveLlmRoute, query: {
    situation: string;
    action: string;
}, similar: readonly {
    expId: string;
    text: string;
    similarity: number;
}[], options: CallOptions): Promise<DeriveReferenceDecision>;
/** Deterministic template-7 fallback: keep the fused ranking untouched.
 * @returns the keep decision.
 */
export declare function refineRetrievalFallback(): RefineRetrievalDecision;
/**
 * Template 7: refine retrieval when the deterministic routing is
 * low-confidence. The LLM route reads the query and the fused candidates and
 * judges whether the fused top hit genuinely applies (cosine similarity does
 * not imply premise transferability); without a route it keeps the ranking.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param query - the current situation/action being predicted.
 * @param candidates - the fused candidates, best first.
 * @param options - call context (session/signal/maxTokens).
 * @returns the refinement decision.
 */
export declare function refineRetrieval(ctx: Context, route: CognitiveLlmRoute, query: {
    situation: string;
    action: string;
}, candidates: readonly {
    expId: string;
    text: string;
    similarity: number;
}[], options: CallOptions): Promise<RefineRetrievalDecision>;
/** One structured variant proposal from template 8. */
export interface VariantProposal {
    /** The perturbed action text (the variant to test). */
    readonly variantAction: string;
    /** Which step/parameter of the base action the perturbation touches. */
    readonly perturbedAspect: string;
    /** One-sentence rationale for the perturbation. */
    readonly rationale: string;
}
/**
 * Template 8: structured variant generation for a strategy whose deviation
 * gate flagged rework (or a disequilibrated experience). The variants perturb
 * one step or parameter of the base action while keeping the verification
 * anchor's semantics unchanged — the anchor is the test, the variant is the
 * revised procedure. Without an explicit route it deterministically proposes
 * nothing: no model, no invented variants.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - base action, verification anchor, pre-checks, and the reason.
 * @param options - call context (session/signal/maxTokens).
 * @returns the proposed variants (ungated, ≤ 3, schema-filtered).
 */
export declare function generateVariants(ctx: Context, route: CognitiveLlmRoute, input: {
    baseAction: string;
    verificationAnchor: string;
    preChecks: readonly string[];
    reason: string;
}, options: CallOptions): Promise<VariantProposal[]>;
/** Deterministic template-8 fallback: no proposals (no route → no self-legislation).
 * @returns the empty-proposal decision.
 */
export declare function proposeAcceptanceFallback(): AcceptanceProposalDecision;
/**
 * Template 8: the acceptance-criterion proposal route. The LLM route reads
 * the demonstrably failing criteria and their evidence ledgers and proposes
 * rewrites or retirements. The service still gates every proposal against the
 * evidence before applying — the route proposes, the experience gate disposes.
 * Without an explicit route it deterministically proposes nothing: the
 * pipeline never amends its own norms unjudged.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param flagged - the failing active criteria (deviation gate already crossed).
 * @param deviationMeta - related deviation meta experiences.
 * @param options - call context (session/signal/maxTokens).
 * @returns the proposed updates (ungated).
 */
export declare function proposeAcceptanceUpdates(ctx: Context, route: CognitiveLlmRoute, flagged: readonly AcceptanceCheck[], deviationMeta: readonly {
    expId: string;
    text: string;
}[], options: CallOptions): Promise<AcceptanceProposalDecision>;
/** One LLM-proposed synonym-variant trigger jump (template 9). */
export interface TriggerJumpProposal {
    /** A real trigger word from the provided lexicons. */
    readonly trigger: string;
    /** Paraphrase variants users might say instead. */
    readonly variants: readonly string[];
    /** Why each variant expresses the same situation. */
    readonly reason: string;
}
/** The LLM route's trigger-jump proposal judgment (template 9). */
export interface TriggerJumpProposalDecision {
    readonly jumps: readonly TriggerJumpProposal[];
}
/** Deterministic template-9 fallback: no proposals (no route → no LLM jumps).
 * @returns the empty-proposal decision.
 */
export declare function triggerJumpsFallback(): TriggerJumpProposalDecision;
/**
 * Template 9: propose synonym-variant trigger jumps — the associative layer
 * beyond co-occurrence. The route proposes paraphrase variants for real
 * trigger words; the pipeline still validates each variant (real trigger,
 * non-empty, not a stop word) and the citation loop measures whether it pays
 * off. Without an explicit route nothing is proposed.
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - the static triggers, derived triggers, and important samples.
 * @param options - call context (session/signal/maxTokens).
 * @returns the proposed jumps (ungated).
 */
export declare function proposeTriggerJumps(ctx: Context, route: CognitiveLlmRoute, input: {
    staticTriggers: readonly string[];
    derived: readonly {
        word: string;
        weight: number;
    }[];
    samples: readonly {
        expId: string;
        text: string;
    }[];
    /** Trigger word → real situation snippets where it appeared, so the LLM
     * associates from usage context, not bare word lists. */
    situationsByWord?: ReadonlyMap<string, readonly string[]>;
}, options: CallOptions): Promise<TriggerJumpProposalDecision>;
/** One chain-principle distillation result (template 9). */
export interface DistillResult {
    /** The distilled decision principle, or null when the members have no common pattern. */
    readonly principle: string | null;
    /** One sentence explaining the distillation basis. */
    readonly reasoning: string;
}
/** Deterministic template-9 fallback: no principle (no route → no distillation).
 * @returns a null-principle result.
 */
export declare function distillFallback(): DistillResult;
/**
 * Template 9: distill one reusable decision principle from a chain's member
 * experiences — the offline-consolidation analogue of EvolveR's
 * experience-to-principle learning. The route extracts a single ≤60-character
 * transferable rule, failures first; without an explicit route nothing is
 * distilled (宁缺毋滥: a chain without a distilled principle is a folded
 * summary, never a fabricated rule).
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - the chain goal and its member experiences.
 * @param options - call context (session/signal/maxTokens).
 * @returns the distillation result.
 */
export declare function distillChainPrinciple(ctx: Context, route: CognitiveLlmRoute, input: {
    goal: string;
    members: readonly {
        expId: string;
        text: string;
        failed: boolean;
    }[];
}, options: CallOptions): Promise<DistillResult>;
/** One discriminant axis extracted from an over-broad cluster (template 10). */
export interface DiscriminantAxis {
    /** Which member field the axis lives in: situation (premise) or action. */
    readonly dimension: 'situation' | 'action';
    /** Axis name, e.g. 用户熟练度. */
    readonly axisName: string;
    /** Polarity terms distinguishing the axis poles (2-4, most discriminating first). */
    readonly terms: readonly string[];
    /** One sentence on why this axis separates behavior. */
    readonly rationale: string;
}
/** Structured template-10 result: the axes found inside one cluster. */
export interface DiscriminantAxesOutput {
    readonly axes: readonly DiscriminantAxis[];
}
/** Deterministic template-10 fallback: no axes (no route → no extraction).
 * @returns an empty axes result.
 */
export declare function discriminantAxesFallback(): DiscriminantAxesOutput;
/**
 * Template 10: extract discriminant axes from one over-broad cluster — the
 * L2 complement to embedding clustering (LLM 定轴). Embedding groups surface
 * near-duplicate members; this step asks the LLM which dimension actually
 * drives behavior differences inside the cluster (e.g. 新手↔资深 within a
 * git-push cluster), producing polarity terms for query-side routing. Without
 * an explicit route nothing is extracted; one unlucky empty draw is retried
 * once (the association task is stochastic, measured finding #11).
 * @param ctx - plugin context for the LLM call.
 * @param route - explicit model route.
 * @param input - the over-broad cluster's label and member experiences.
 * @param options - call context (session/signal/maxTokens).
 * @returns the extracted axes, or an empty set.
 */
export declare function proposeDiscriminantAxes(ctx: Context, route: CognitiveLlmRoute, input: {
    clusterLabel: string;
    members: readonly {
        expId: string;
        text: string;
    }[];
}, options: CallOptions): Promise<DiscriminantAxesOutput>;
export {};
//# sourceMappingURL=llm.d.ts.map