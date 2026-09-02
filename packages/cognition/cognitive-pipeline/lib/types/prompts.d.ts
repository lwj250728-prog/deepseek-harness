/**
 * Prompt templates of the cognitive pipeline, adapted from the DCA-PED
 * production prompt library (03-提示词模板库.md). Four templates plus the
 * dynamic cognition prefix (附录B). Every template demands structured JSON
 * output; callers enforce the JSON contract and degrade deterministically.
 * @module @deepseek-ai/dsh-cognitive-pipeline/prompts
 */
import type { AcceptanceCheck, Experience, TaxonomyState } from './types.ts';
/** Template 1: SAR triplet extraction and utility scoring. */
export declare const SAR_SYSTEM_PROMPT: string;
/** Template 2: hot-loop OOD review / strangeness confirmation. */
export declare const OOD_REVIEW_SYSTEM_PROMPT: string;
/** Template 3: five-layer confidence calibration with adversarial challenge. */
export declare const CALIBRATION_SYSTEM_PROMPT: string;
/** Template 4: cold-loop causal-anchored taxonomy reconstruction. */
export declare const RECONSTRUCT_SYSTEM_PROMPT: string;
/** Frame template-1 input.
 * @param rawText - the raw experience text.
 * @returns the user message body.
 */
export declare function frameSarInput(rawText: string): string;
/** Frame template-2 input with the new action and the top-3 historical actions.
 * @param action - the proposed action.
 * @param topActions - historical actions with similarity.
 * @returns the user message body.
 */
export declare function frameOodInput(action: string, topActions: readonly {
    expId: string;
    action: string;
    similarity: number;
}[]): string;
/** Frame template-3 input with the situation/action and top-K sample stats.
 * @param situation - the current situation.
 * @param action - the proposed action.
 * @param context - optional extra context.
 * @param positiveCount - positive history hits.
 * @param negativeCount - negative history hits.
 * @param samples - compact sample summaries.
 * @returns the user message body.
 */
export declare function frameCalibrationInput(situation: string, action: string, context: string | undefined, positiveCount: number, negativeCount: number, samples: readonly {
    expId: string;
    actionKeywords: string;
    utility: string;
    meta?: boolean;
}[]): string;
/** Frame template-4 input with the sampled experiences.
 * @param samples - the sampled train experiences.
 * @returns the user message body.
 */
export declare function frameReconstructInput(samples: readonly Experience[]): string;
/** Template 8: structured variant generation for a strategy whose deviation
 * gate flagged rework (or a disequilibrated experience). The variant perturbs
 * one step or parameter while keeping the verification anchor's semantics
 * unchanged — the anchor is the test, the variant is the revised procedure. */
export declare const VARIANT_SYSTEM_PROMPT: string;
/** Frame template-8 input with the base strategy and the failure signal.
 * @param input - base action, verification anchor, pre-checks, and the reason.
 * @returns the user message body.
 */
export declare function frameVariantInput(input: {
    baseAction: string;
    verificationAnchor: string;
    preChecks: readonly string[];
    reason: string;
}): string;
/** Template 5: the accumulation gate — judge whether a completed turn is worth
 * becoming an experience, and extract the SAR triplet when it is. */
export declare const ACCUMULATE_SYSTEM_PROMPT: string;
/** Frame template-5 input with the completed episode and similar history.
 * @param episode - the completed turn's situation/action/outcome material.
 * @param similar - retrieved history hits for the novelty judgment.
 * @returns the framed prompt text.
 */
export declare function frameAccumulateInput(episode: {
    situation: string;
    action: string;
    outcome: string;
}, similar: readonly {
    expId: string;
    text: string;
    similarity: number;
}[]): string;
/** 附录B: the dynamic cognition prefix injected into the hot-loop system prompt.
 * @param taxonomy - the current taxonomy, or null before the first rebuild.
 * @returns the prefix text.
 */
export declare function cognitionPrefix(taxonomy: TaxonomyState | null): string;
/** Template 6: derive a reference experience from the commonalities of similar
 * history — an online generalization for cold start. */
export declare const DERIVE_REFERENCE_SYSTEM_PROMPT: string;
/** Frame template-6 input with the query and its similar history.
 * @param query - the current situation/action to anchor the derivation.
 * @param similar - the retrieved similar history hits.
 * @returns the framed prompt text.
 */
export declare function frameDeriveReferenceInput(query: {
    situation: string;
    action: string;
}, similar: readonly {
    expId: string;
    text: string;
    similarity: number;
}[]): string;
/** Template 7: refine retrieval when the deterministic routing is
 * low-confidence — the LLM route judges whether the fused top hit genuinely
 * applies, instead of the hot loop blindly trusting the cosine ranking. */
export declare const REFINE_RETRIEVAL_SYSTEM_PROMPT: string;
/** Frame template-7 input with the query and the fused candidates.
 * @param query - the current situation/action being predicted.
 * @param candidates - the fused candidates, best first.
 * @returns the framed prompt text.
 */
export declare function frameRefineRetrievalInput(query: {
    situation: string;
    action: string;
}, candidates: readonly {
    expId: string;
    text: string;
    similarity: number;
}[]): string;
/** Template 8: propose acceptance-criterion updates from evidence — the
 * pipeline amends its own verification norms only through the experience
 * gate (only failing criteria, only with rationale and concrete text). */
export declare const PROPOSE_ACCEPTANCE_SYSTEM_PROMPT: string;
/** Frame template-8 input with the failing criteria and the deviation evidence.
 * @param flagged - the failing active criteria (deviation gate already crossed).
 * @param deviationMeta - related deviation meta experiences.
 * @returns the framed prompt text.
 */
export declare function frameProposeAcceptanceInput(flagged: readonly AcceptanceCheck[], deviationMeta: readonly {
    expId: string;
    text: string;
}[]): string;
/** Template 9: propose synonym-variant trigger jumps from the LLM route — the
 * associative layer BEYOND co-occurrence. Co-occurrence can only learn words
 * that actually appear together in experience text; paraphrases (卡住↔卡壳)
 * never co-occur. Every variant must attach to a real trigger word and carry a
 * reason. LLM-sourced jumps enter with zero co-occurrence evidence and a
 * conservative weight — the citation loop is their evidence gate: they are
 * boosted only when injections they helped trigger are actually cited, and
 * pruned when they never pay off. */
export declare const PROPOSE_TRIGGER_JUMPS_SYSTEM_PROMPT: string;
/** Frame template-9 input with the trigger lexicons, each bound to the real
 * situations where it appeared in the experience store. The association task
 * then sees both the word AND its usage context — producing situation-grounded
 * variants (how a user would describe THAT kind of situation) instead of bare
 * synonym lists.
 * @param staticTriggers - the static behavior trigger words.
 * @param derived - the derived trigger words with weights.
 * @param samples - important experience samples for context.
 * @param situationsByWord - map of trigger word → situation snippets where it occurred.
 * @returns the framed prompt text.
 */
export declare function frameProposeTriggerJumpsInput(staticTriggers: readonly string[], derived: readonly {
    word: string;
    weight: number;
}[], samples: readonly {
    expId: string;
    text: string;
}[], situationsByWord?: ReadonlyMap<string, readonly string[]>): string;
/** Template 9: chain principle distillation — from experiences to ONE
 * reusable decision rule (the EvolveR experience-distillation analogue). */
export declare const DISTILL_SYSTEM_PROMPT: string;
/** Frame template-9 input with the chain's member experiences.
 * @param goal - the chain's goal anchor.
 * @param members - the member experiences (situation/action/outcome), failures first.
 * @returns the user message body.
 */
export declare function frameDistillInput(goal: string, members: readonly {
    expId: string;
    text: string;
    failed: boolean;
}[]): string;
/** Template 10: discriminant-axis extraction — from one over-broad cluster to
 * the axes that separate its members into behaviorally distinct sub-groups.
 * This is the L2 complement to embedding clustering (LLM 定轴): embedding
 * groups, the LLM names the discriminating dimension and its poles. */
export declare const PROPOSE_DISCRIMINANT_AXES_SYSTEM_PROMPT: string;
/** Frame template-10 input with one over-broad cluster's members.
 * @param clusterLabel - the cluster's current name/label.
 * @param members - the member experiences (situation/action/outcome text).
 * @returns the user message body.
 */
export declare function frameDiscriminantAxesInput(clusterLabel: string, members: readonly {
    expId: string;
    text: string;
}[]): string;
//# sourceMappingURL=prompts.d.ts.map