/**
 * Prediction-error-driven dynamic cognition (DCA-PED) as a harness plugin:
 * SAR experience memory, a hot-loop online predictor with OOD detection and
 * five-layer confidence calibration, a temp-strategy scratchpad, and a
 * cold-loop taxonomy rebuild gated by sandbox backtesting. The plugin exposes
 * five model-facing tools, the `ctx.cognitivePipeline` service, and a dynamic
 * `cognition:taxonomy` system-prompt section.
 *
 * @module @deepseek-ai/dsh-cognitive-pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  CognitivePipelineService,
  Config,
} from './service.ts'
import type { CognitivePipelineConfig } from './service.ts'
import { registerPipelineTools } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = 'cognitive-pipeline'

/** Services required before the pipeline can mount. */
export const inject = ['llm', 'tools', 'systemPrompt']

/** Re-export the service and config schema for consumers and Loader validation. */
export { CognitivePipelineService, Config }
export type { CognitivePipelineConfig } from './service.ts'
export * from './types.ts'
export * from './vectorizer.ts'

/**
 * Mount the pipeline: construct the service (its `Service` base registers
 * `ctx.cognitivePipeline` on this fiber's context), wait for the store, then
 * register the dynamic taxonomy prompt section and (unless disabled) the
 * model tools.
 * @param ctx - plugin context carrying llm/tools/systemPrompt.
 * @param config - pipeline configuration; every field optional.
 */
export async function apply(ctx: Context, config: CognitivePipelineConfig = {}): Promise<void> {
  const service = new CognitivePipelineService(ctx, config)
  await service.ready()

  ctx.systemPrompt.section({
    name: 'cognition:taxonomy',
    order: 300,
    text: () => service.taxonomyPrefix(),
  })

  if (service.resolved.enabled) {
    registerPipelineTools(ctx, service)
  }
}
