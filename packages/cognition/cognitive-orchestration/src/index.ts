/**
 * Task-level cognition orchestration as a harness plugin. Registers a wrapper
 * {@link SubagentProvider} (default name `cognitive`) over a delegate provider
 * (default `spawn`): related SAR experiences from the cognitive pipeline are
 * injected into each child prompt, and each settled child outcome is written
 * back as a new experience. With the policy layer enabled, the inject and
 * record decisions themselves are predicted and calibrated through the
 * pipeline as `policy:*` experiences.
 *
 * @module @deepseek-ai/dsh-cognitive-orchestration
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-cognitive-pipeline'
import {
  CognitiveOrchestrator,
  resolveOrchestrationConfig,
} from './orchestrator.ts'
import type { OrchestrationConfig } from './orchestrator.ts'

/** Stable Cordis plugin name. */
export const name = 'cognitive-orchestration'

/** Services required before the orchestration layer can mount. */
export const inject = ['subagents', 'cognitivePipeline', 'tools']

/** Plugin configuration mirrors the orchestrator configuration. */
export type Config = Partial<OrchestrationConfig>

/** Schemastery config with conservative defaults. */
export const Config: z<Config> = z.object({
  delegate: z.string().default('spawn'),
  providerName: z.string().default('cognitive'),
  topK: z.number().step(1).min(1).max(20).default(3),
  minSimilarity: z.number().min(0).max(1).default(0.3),
  policyEnabled: z.boolean().default(true),
  policyDecisionThreshold: z.number().min(0).max(1).default(0.55),
  delegationToolNames: z.array(z.string()).default(['subagent']),
})

/**
 * Mount the orchestration layer: resolve the delegate provider (it must
 * already be registered — place this row after the delegate provider's row),
 * wrap it, register the wrapper under its own name, and capture tool-level
 * delegations (subagent tool calls that bypass the wrapper) at `tools/result`.
 * @param ctx - plugin context carrying subagents and cognitivePipeline.
 * @param config - orchestration configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveOrchestrationConfig(config)
  const delegate = ctx.subagents.getProvider(resolved.delegate)
  if (delegate === undefined) {
    throw new Error(
      `cognitive-orchestration: delegate provider "${resolved.delegate}" is not registered; `
      + 'place the delegate provider row before this plugin in the composition',
    )
  }
  const orchestrator = new CognitiveOrchestrator(ctx, ctx.cognitivePipeline, resolved)
  ctx.subagents.registerProvider(orchestrator.wrap(delegate))
  const delegationTools = new Set(resolved.delegationToolNames)
  if (delegationTools.size > 0) {
    ctx.on('tools/result', (
      exec: { callId: string; name: string; arguments?: unknown },
      result: { isError: boolean; content?: readonly { type?: string; text?: string }[] },
    ) => {
      if (!delegationTools.has(exec.name)) return
      const delegationExec: { callId: string; name: string; arguments?: Readonly<Record<string, unknown>> } = {
        callId: exec.callId,
        name: exec.name,
        ...(typeof exec.arguments === 'object' && exec.arguments !== null
          ? { arguments: exec.arguments as Readonly<Record<string, unknown>> }
          : {}),
      }
      void orchestrator.captureDelegation(delegationExec, result).catch((error: unknown) => {
        ctx.logger.warn(`cognitive-orchestration: delegation capture failed: ${String(error)}`)
      })
    })
  }
}

/** Re-export the orchestrator and its helpers for programmatic use. */
export { CognitiveOrchestrator, resolveOrchestrationConfig } from './orchestrator.ts'
export type { OrchestrationConfig, ExperienceHit } from './orchestrator.ts'
export type { ToolDelegationExec, ToolDelegationResult } from './orchestrator.ts'
