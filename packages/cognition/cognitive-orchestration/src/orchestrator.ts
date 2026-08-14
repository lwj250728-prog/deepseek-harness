/**
 * Task-level cognition orchestration. A wrapper {@link SubagentProvider} sits
 * in front of a delegate provider: before a child starts it retrieves related
 * SAR experiences from the cognitive pipeline and injects them into the child
 * prompt; when the child settles it predicts whether the outcome is worth
 * recording, stores it, and calibrates both the inject and the record
 * decisions as their own `policy:*` experiences — so "whether to inject" and
 * "whether to record" are themselves learned by prediction error.
 * @module @deepseek-ai/dsh-cognitive-orchestration/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import { actionVector, cosine } from '@deepseek-ai/dsh-cognitive-pipeline'
/** Orchestration configuration (all defaults conservative). */
export interface OrchestrationConfig {
  /** Delegate provider name to wrap (e.g. `spawn` or `fork`). */
  readonly delegate: string
  /** Registry name of the wrapper provider. */
  readonly providerName: string
  /** How many related experiences to inject at most. */
  readonly topK: number
  /** Minimum action-vector similarity to consider a memory related. */
  readonly minSimilarity: number
  /** Whether inject/record decisions are predicted and calibrated. */
  readonly policyEnabled: boolean
  /** Probability at/above which a policy prediction approves the action. */
  readonly policyDecisionThreshold: number
}

/**
 * Compose the default orchestration configuration.
 * @param config - partial overrides; every field optional.
 * @returns the resolved configuration with defaults materialized.
 */
export function resolveOrchestrationConfig(config: Partial<OrchestrationConfig>): OrchestrationConfig {
  return {
    delegate: config.delegate ?? 'spawn',
    providerName: config.providerName ?? 'cognitive',
    topK: config.topK ?? 3,
    minSimilarity: config.minSimilarity ?? 0.3,
    policyEnabled: config.policyEnabled ?? true,
    policyDecisionThreshold: config.policyDecisionThreshold ?? 0.55,
  }
}

/** One related experience hit for injection. */
export interface ExperienceHit {
  readonly expId: string
  readonly text: string
  readonly similarity: number
}

/**
 * Map a stop reason to an observed outcome quality used for calibration.
 * @param reason - the subagent stop reason.
 * @returns a quality score in 0–10.
 */
export function stopReasonQuality(reason: SubagentStopReason): number {
  switch (reason) {
    case 'completed':
      return 8
    case 'refusal':
    case 'error':
      return 2
    case 'max-tokens':
    case 'aborted':
      return 4
    default:
      return 5
  }
}

/**
 * Render the child prompt's first text block as a task summary.
 * @param prompt - the child prompt content blocks.
 * @param label - optional display label taking precedence over the prompt.
 * @returns the task summary text.
 */
export function taskSummary(prompt: readonly ContentBlock[], label?: string): string {
  if (label !== undefined && label.length > 0) return label
  for (const block of prompt) {
    if (block.type === 'text') {
      const text = block.text.trim()
      if (text.length > 0) return text.slice(0, 200)
    }
  }
  return '未命名子任务'
}

/**
 * Render child output blocks to one text string.
 * @param output - the child's terminal output blocks.
 * @returns the joined trimmed text.
 */
export function outputText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
}

/** Pre-delegation decision state threaded to the settle-time write-back. */
interface RunContext {
  readonly task: string
  readonly hits: readonly ExperienceHit[]
  readonly injectPredictionId: string | null
}

/**
 * The orchestrator: retrieval, injection, decision prediction, and outcome
 * write-back over one cognitive pipeline service.
 */
export class CognitiveOrchestrator {
  private readonly pipeline: CognitivePipelineService
  private readonly config: OrchestrationConfig

  /**
   * @param _ctx - context carrying the subagent runtime (unused by the engine).
   * @param pipeline - the cognitive pipeline service to read and write.
   * @param config - resolved orchestration configuration.
   */
  constructor(_ctx: Context, pipeline: CognitivePipelineService, config: OrchestrationConfig) {
    this.pipeline = pipeline
    this.config = config
  }

  /**
   * Retrieve experiences related to one task text.
   * @param task - the task summary text.
   * @returns the related experiences, best first, capped at topK.
   */
  retrieve(task: string): readonly ExperienceHit[] {
    const vector = actionVector(task, [])
    return this.pipeline.store.experiencesSnapshot()
      .map(exp => ({
        expId: exp.expId,
        text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
        similarity: cosine(vector, exp.actionVector),
      }))
      .filter(hit => hit.similarity >= this.config.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.config.topK)
  }

  /**
   * Build the wrapper provider over the delegate provider.
   * @param delegate - the delegate provider to wrap.
   * @returns a provider registered under `providerName` that injects and writes back.
   */
  wrap(delegate: SubagentProvider): SubagentProvider {
    return {
      name: this.config.providerName,
      capabilities: { ...delegate.capabilities },
      inheritsParentContext: delegate.inheritsParentContext,
      start: request => this.start(delegate, request),
    }
  }

  /** Run one wrapped child: decide, inject, delegate, then write back on settle. */
  private async start(delegate: SubagentProvider, request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const context = await this.decide(request)
    let prompt = request.prompt
    if (context.hits.length > 0) {
      const lines = context.hits.map(hit => `- [${hit.expId}] (相关度 ${hit.similarity.toFixed(2)}) ${hit.text}`)
      const block: ContentBlock = {
        type: 'text',
        text: `【认知经验参考】以下是与你当前任务相关的历史经验，供参考借鉴（不要虚构为当前事实）：\n${lines.join('\n')}`,
      }
      prompt = [block, ...request.prompt]
    }
    const run = await delegate.start({ ...request, prompt })
    return {
      ...run,
      result: run.result.then(result => this.settle(context, result).then(() => result)),
    }
  }

  /** Decide injection through the policy layer, or a conservative default. */
  private async decide(request: ResolvedSubagentStartRequest): Promise<RunContext> {
    const task = taskSummary(request.prompt, request.label)
    if (!this.config.policyEnabled) {
      return { task, hits: this.retrieve(task), injectPredictionId: null }
    }
    const prediction = await this.pipeline.predict({
      situation: `policy:inject 任务特征=${task.slice(0, 120)}`,
      action: '注入历史经验到子任务',
    })
    const approve = prediction.calibratedProbability >= this.config.policyDecisionThreshold
    return {
      task,
      hits: approve ? this.retrieve(task) : [],
      injectPredictionId: prediction.predictionId,
    }
  }

  /** Settle-time write-back: predict recording, store the outcome, calibrate. */
  private async settle(context: RunContext, result: SubagentResult): Promise<void> {
    const quality = stopReasonQuality(result.stopReason)
    const output = outputText(result.output)
    let recordPredictionId: string | null = null
    let recordDecision = true
    if (this.config.policyEnabled) {
      const prediction = await this.pipeline.predict({
        situation: `policy:update 结果特征=${result.stopReason} ${output.slice(0, 100)}`,
        action: '沉淀子任务结果为经验',
      })
      recordPredictionId = prediction.predictionId
      recordDecision = prediction.calibratedProbability >= this.config.policyDecisionThreshold
    }
    if (recordDecision && (output.length > 0 || context.hits.length > 0)) {
      await this.pipeline.remember({
        rawText: `任务调度：${context.task}\n子任务执行：${output.slice(0, 300) || '（无文本输出）'}\n结果：${result.stopReason}。`,
      })
    }
    if (context.injectPredictionId !== null) {
      await this.pipeline.report({
        predictionId: context.injectPredictionId,
        actualOutcome: `子任务 ${result.stopReason}，注入${context.hits.length}条经验`,
        outcomeQuality: quality,
      })
    }
    if (recordPredictionId !== null) {
      await this.pipeline.report({
        predictionId: recordPredictionId,
        actualOutcome: `记录决策，实际${recordDecision ? '入库' : '未入库'}`,
        outcomeQuality: quality,
      })
    }
  }
}
