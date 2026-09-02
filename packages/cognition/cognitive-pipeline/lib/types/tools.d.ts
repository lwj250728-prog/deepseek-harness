/**
 * Model-facing tools over the cognitive pipeline: `remember_experience`,
 * `simulate_experience`, `reference_experience`, `predict_outcome`,
 * `report_outcome`, `rebuild_taxonomy`, `inspect_memory`, `register_loop`,
 * `define_acceptance_check`, `verify_claim`, and `update_acceptance_check`.
 * Every tool returns one canonical JSON value; `output.render` mirrors it into
 * model-facing text.
 * @module @deepseek-ai/dsh-cognitive-pipeline/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CognitivePipelineService } from './service.ts';
/** Register the fifteen pipeline tools.
 * @param ctx - context with the tool registry.
 * @param service - the pipeline service backing the tools.
 */
export declare function registerPipelineTools(ctx: Context, service: CognitivePipelineService): void;
//# sourceMappingURL=tools.d.ts.map