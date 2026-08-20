/**
 * Step-level SAR experience priming for the cognitive pipeline. At every
 * agent pre-step it extracts the current situation from the messages about to
 * enter the model request, retrieves situation-related experiences from the
 * pipeline store, and injects the closest hits as reference context. After a
 * failed step it recalls more aggressively — the "memory chaining" analogue:
 * a failure is the strongest situation cue, so the previous setback surfaces
 * related past experience for faster matching on the retry step.
 *
 * Injection rides the same mechanism as other pre-step context plugins: the
 * reference block is folded into the step's `decision.messages`, so the agent
 * loop appends it as a durable `user/message` event — model-visible and logged
 * together, per the "model-visible ⟺ logged" invariant.
 *
 * @module @deepseek-ai/dsh-cognitive-inject
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { actionVector, cosine, symptomOverlap } from '@deepseek-ai/dsh-cognitive-pipeline'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics and message sources. */
export const name = 'cognitive-inject'

/** Services required before the plugin can mount. */
export const inject = ['agents', 'cognitivePipeline', 'tools']

/** Plugin configuration (all fields optional; conservative defaults). */
export interface Config {
  /** How many related experiences to inject at most (default 1). */
  topK?: number
  /** Minimum situation-vector similarity to consider a memory related (default 0.4). */
  minSimilarity?: number
  /** After a failed step, multiply minSimilarity by this factor (default 0.6). */
  failureThresholdFactor?: number
  /** After a failed step, how many experiences to inject at most (default 3). */
  failureTopK?: number
  /** How many trailing message blocks feed the situation extraction (default 4). */
  contextDepth?: number
  /** False disables injection while keeping the listener mounted (default true). */
  enabled?: boolean
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  topK: z.number().step(1).min(1).max(10).default(1),
  minSimilarity: z.number().min(0).max(1).default(0.4),
  failureThresholdFactor: z.number().min(0).max(1).default(0.6),
  failureTopK: z.number().step(1).min(1).max(10).default(3),
  contextDepth: z.number().step(1).min(1).max(20).default(4),
  enabled: z.boolean().default(true),
})

/** Resolved configuration with every optional field materialized. */
export interface ResolvedConfig {
  readonly topK: number
  readonly minSimilarity: number
  readonly failureThresholdFactor: number
  readonly failureTopK: number
  readonly contextDepth: number
  readonly enabled: boolean
}

/** Resolve the plugin configuration.
 * @param config - partial configuration.
 * @returns the resolved immutable configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    topK: config.topK ?? 1,
    minSimilarity: config.minSimilarity ?? 0.4,
    failureThresholdFactor: config.failureThresholdFactor ?? 0.6,
    failureTopK: config.failureTopK ?? 3,
    contextDepth: config.contextDepth ?? 4,
    enabled: config.enabled ?? true,
  })
}

/** One retrieved experience hit for injection. */
export interface ExperienceHit {
  readonly expId: string
  readonly text: string
  readonly similarity: number
}

/** Extract the last text block of one user message, if any. */
function textOf(message: UserMessage): string {
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  return ''
}

/** Collect the trailing text blocks of the messages entering this step. */
function situationText(messages: readonly UserMessage[], depth: number): string {
  const blocks = messages
    .flatMap(message => textOf(message) === '' ? [] : [textOf(message)])
  return blocks.slice(-depth).join(' ')
}

/** The per-agent most recent tool outcome: true when the last tool result was a failure. */
const lastFailed = new WeakMap<Agent, boolean>()

/** Retrieve experiences related to the current situation on both axes. */
function retrieve(
  service: CognitivePipelineService,
  situation: string,
  minSimilarity: number,
  topK: number,
): readonly ExperienceHit[] {
  const vector = actionVector(situation, [])
  return service.store.experiencesSnapshot()
    .map((exp) => {
      const text = `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
      return {
        expId: exp.expId,
        text,
        similarity: Math.max(
          cosine(vector, exp.actionVector),
          cosine(vector, actionVector(exp.sar.situation, [])),
          symptomOverlap(situation, text),
        ),
      }
    })
    .filter(hit => hit.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
}

/** Render one reference block from the retrieved hits. */
function referenceBlock(hits: readonly ExperienceHit[], afterFailure: boolean): UserMessage {
  const lines = hits.map(hit => `- [${hit.expId}] (相关度 ${hit.similarity.toFixed(2)}) ${hit.text}`)
  const preamble = afterFailure
    ? '【认知经验参考】上一步执行失败，以下历史经验可能与此相关，供排查借鉴（不要虚构为当前事实）：'
    : '【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：'
  const text = `${preamble}\n${lines.join('\n')}`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
  })
}

/** Whether the agent's most recent tool result was a failure. */
function isAfterFailure(agent: Agent): boolean {
  return lastFailed.get(agent) === true
}

/**
 * Mount the priming listener: retrieve at every pre-step, inject on hit,
 * recall more aggressively after a failed step.
 * @param ctx - context carrying agents, the pipeline service, and tools.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    if (exec.agent === undefined) return
    lastFailed.set(exec.agent, result.isError)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || messages.length === 0) return decision
    const afterFailure = isAfterFailure(agent)
    const threshold = afterFailure
      ? resolved.minSimilarity * resolved.failureThresholdFactor
      : resolved.minSimilarity
    const topK = afterFailure ? resolved.failureTopK : resolved.topK
    const situation = situationText(decision.messages, resolved.contextDepth)
    if (situation.trim().length === 0) return decision
    const hits = retrieve(ctx.cognitivePipeline, situation, threshold, topK)
    if (hits.length === 0) return decision
    const block = referenceBlock(hits, afterFailure)
    return {
      kind: 'enter',
      messages: [...decision.messages, block],
    }
  })
}
