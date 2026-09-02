/**
 * Prediction-error-driven dynamic cognition (DCA-PED) as a harness plugin:
 * SAR experience memory, a hot-loop online predictor with OOD detection and
 * five-layer confidence calibration, a temp-strategy scratchpad, simulated
 * experience generation, a cold-loop taxonomy rebuild gated by sandbox
 * backtesting, meta-cognition loops, acceptance-criteria claim audits, and
 * derived cognition objects (goal-anchored chains).
 * The plugin exposes fifteen model-facing tools, the
 * `ctx.cognitivePipeline` service, and a dynamic `cognition:taxonomy`
 * system-prompt section.
 *
 * @module @deepseek-ai/dsh-cognitive-pipeline
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { CognitiveLoopRegistry, CognitivePipelineService, Config } from './service.ts';
import type { CognitivePipelineConfig } from './service.ts';
import type { TurnEpisode } from './types.ts';
/** Stable Cordis plugin name. */
export declare const name = "cognitive-pipeline";
/** Services required before the pipeline can mount. */
export declare const inject: string[];
/** Re-export the service and config schema for consumers and Loader validation. */
export { CognitiveLoopRegistry, CognitivePipelineService, Config };
export type { CognitivePipelineConfig } from './service.ts';
export * from './types.ts';
export * from './vectorizer.ts';
/** Task-restatement detection, shared by the accumulation gate (reject new
 * records) and the injection retrieval (skip existing ones). */
export { isTaskRestatement } from './task-restatement.ts';
/** Template-7 retrieval refinement, reused by consumers (cognitive-inject)
 * as the pre-injection veto gate. */
export { refineRetrieval, refineRetrievalFallback } from './llm.ts';
export type { CognitiveLlmRoute } from './llm.ts';
/** Session-ledger tool-call evidence: the non-self-referential witness used
 * by log-anchored claim audits. */
export { findToolCallEvidence } from './log-evidence.ts';
export type { ToolCallEvidence } from './log-evidence.ts';
/** Reconstruct one completed turn into candidate accumulation material.
 * Reads the turn's events back from the session ledger: the genuine user
 * request (source kind 'user') becomes the situation, tool calls become the
 * action, the final assistant text and the end reason become the outcome.
 * @param session - the session whose ledger holds the turn's events.
 * @param endEvent - the turn/end event that closes the turn.
 * @returns the reconstructed episode.
 */
export declare function reconstructTurn(session: Session, endEvent: SessionEvent<'turn/end'>): TurnEpisode;
/**
 * Mount the pipeline: construct the service (its `Service` base registers
 * `ctx.cognitivePipeline` on this fiber's context), wait for the store, then
 * register the dynamic taxonomy prompt section and (unless disabled) the
 * model tools. When `autoAccumulate` is enabled, also listen for completed
 * turns and run each through the accumulation gate.
 * @param ctx - plugin context carrying llm/tools/systemPrompt.
 * @param config - pipeline configuration; every field optional.
 */
export declare function apply(ctx: Context, config?: CognitivePipelineConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map