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
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { CognitivePipelineService } from '@deepseek-ai/dsh-cognitive-pipeline'
import { actionVector, cosine, symptomOverlap } from '@deepseek-ai/dsh-cognitive-pipeline'
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
  /**
   * Tool names whose calls are captured as tool-level delegations. These are
   * subagent tools that bypass the wrapped provider (their `settle()` never
   * runs), so the orchestrator captures the delegation itself: a
   * `policy:delegate` prediction is calibrated against the outcome and a
   * "委派决策" experience is written back. The cognitive-wrapped tool (the
   * provider under `providerName`) is excluded by default because its children
   * already write back through `settle()`.
   */
  readonly delegationToolNames: string[]
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
    delegationToolNames: config.delegationToolNames ?? ['subagent'],
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

/**
 * Sum the token accounting of every assistant step in a session (each
 * `assistant/message` event carries the adapter-reported `usage`, including
 * the cache-read/cache-write split). Null when the session has no steps or
 * the adapter reported none.
 * @param session - the child session to sum over.
 * @returns the totals, or null when nothing was reported.
 */
export function usageOf(session: Session | undefined): TokenUsage | null {
  if (session === undefined) return null
  const totals: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    totals.inputTokens += usage.inputTokens
    totals.outputTokens += usage.outputTokens
    totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    totals.reasoningTokens = (totals.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
  }
  if (totals.inputTokens === 0 && totals.outputTokens === 0) return null
  return totals
}

/** One-line token accounting for an experience's outcome text. */
export function usageLine(usage: TokenUsage): string {
  const parts = [`token：输入 ${usage.inputTokens}`, `输出 ${usage.outputTokens}`]
  if ((usage.cacheReadTokens ?? 0) > 0) parts.push(`缓存命中 ${usage.cacheReadTokens}`)
  if ((usage.cacheWriteTokens ?? 0) > 0) parts.push(`缓存写入 ${usage.cacheWriteTokens}`)
  if ((usage.reasoningTokens ?? 0) > 0) parts.push(`推理 ${usage.reasoningTokens}`)
  return parts.join(' / ')
}

/** Pre-delegation decision state threaded to the settle-time write-back. */
interface RunContext {
  readonly task: string
  readonly hits: readonly ExperienceHit[]
  readonly injectPredictionId: string | null
}

/** One tool-level delegation execution observed at `tools/result`. */
export interface ToolDelegationExec {
  readonly callId: string
  readonly name: string
  readonly arguments?: Readonly<Record<string, unknown>>
}

/** The outcome of one tool-level delegation. */
export interface ToolDelegationResult {
  readonly isError: boolean
  readonly content?: readonly { type?: string; text?: string }[]
}

/** Extract the delegation task summary from the tool arguments. */
export function delegationTask(arguments_: Readonly<Record<string, unknown>> | undefined): string {
  const prompt = arguments_?.prompt
  if (typeof prompt === 'string' && prompt.trim().length > 0) return prompt.trim().slice(0, 200)
  const description = arguments_?.description
  if (typeof description === 'string' && description.trim().length > 0) return description.trim().slice(0, 200)
  return ''
}

/** Join the delegation result text blocks. */
export function delegationOutput(result: ToolDelegationResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
}

/**
 * The orchestrator: retrieval, injection, decision prediction, and outcome
 * write-back over one cognitive pipeline service.
 */
export class CognitiveOrchestrator {
  private readonly pipeline: CognitivePipelineService
  private readonly sessions: { list(): readonly Session[] }
  private readonly config: OrchestrationConfig

  /**
   * @param _ctx - context carrying the subagent runtime (unused by the engine).
   * @param pipeline - the cognitive pipeline service to read and write.
   * @param sessions - the session store, used to locate child sessions by parent.
   * @param config - resolved orchestration configuration.
   */
  constructor(
    _ctx: Context,
    pipeline: CognitivePipelineService,
    sessions: { list(): readonly Session[] },
    config: OrchestrationConfig,
  ) {
    this.pipeline = pipeline
    this.sessions = sessions
    this.config = config
  }

  /**
   * Retrieve experiences related to one task text. The task is matched on
   * BOTH axes and the higher similarity wins: action-vector overlap (the task
   * says the same thing the past action did) and situation-vector overlap (the
   * task's symptoms resemble the situation where an experience happened). The
   * situation axis is what lets a task like "fix the hanging test" recall the
   * bug experience that started with "tests suddenly hang", even when the
   * repair wording differs. A third, exact-substring channel scores the task's
   * failure-symptom markers against the experience text — the recall that
   * survives when the short symptom query dilutes in the hashed vectors.
   * @param task - the task summary text.
   * @returns the related experiences, best first, capped at topK.
   */
  retrieve(task: string): readonly ExperienceHit[] {
    const taskVector = actionVector(task, [])
    return this.pipeline.store.experiencesSnapshot()
      .map((exp) => {
        const text = `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
        return {
          expId: exp.expId,
          text,
          similarity: Math.max(
            cosine(taskVector, exp.actionVector),
            cosine(taskVector, actionVector(exp.sar.situation, [])),
            symptomOverlap(task, text),
          ),
        }
      })
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
      result: run.result.then(result => this.settle(context, result, run.localAgent?.session).then(() => result)),
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
  private async settle(context: RunContext, result: SubagentResult, childSession: Session | undefined): Promise<void> {
    const quality = stopReasonQuality(result.stopReason)
    const output = outputText(result.output)
    const usage = usageOf(childSession)
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
      const usageSuffix = usage === null ? '' : `\n${usageLine(usage)}`
      await this.pipeline.remember({
        rawText: `任务调度：${context.task}\n子任务执行：${output.slice(0, 300) || '（无文本输出）'}\n结果：${result.stopReason}。${usageSuffix}`,
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

  /**
   * Capture a tool-level delegation (a subagent tool call that bypassed the
   * wrapped provider, so `settle()` never ran). Two things happen:
   * 1. A `policy:delegate` prediction — "is delegating this task to a
   *    subagent worth it" — is calibrated against the actual outcome, so
   *    "when to delegate" becomes a learned strategy like `policy:inject`.
   * 2. A "委派决策" experience (task, execution summary, outcome) is written
   *    back, recording the delegation pattern itself as training data for
   *    that strategy.
   * @param exec - the tool execution facts (callId/name/arguments).
   * @param result - the tool outcome facts.
   * @param parentSession - the parent agent's session, used to locate the
   * child session (its `parentSession` points here) for token accounting.
   */
  async captureDelegation(
    exec: ToolDelegationExec,
    result: ToolDelegationResult,
    parentSession: Session | undefined,
  ): Promise<void> {
    const task = delegationTask(exec.arguments)
    const output = delegationOutput(result)
    if (this.config.policyEnabled && task.trim().length > 0) {
      const prediction = await this.pipeline.predict({
        situation: `policy:delegate 任务特征=${task.slice(0, 120)}`,
        action: '将任务委派给子代理执行',
      })
      await this.pipeline.report({
        predictionId: prediction.predictionId,
        actualOutcome: `委派${result.isError ? '失败' : '完成'}`,
        outcomeQuality: result.isError ? 2 : 8,
      })
    }
    if (task.trim().length > 0) {
      const usage = usageOf(this.childSessionOf(parentSession))
      const usageSuffix = usage === null ? '' : `\n${usageLine(usage)}`
      await this.pipeline.remember({
        rawText: `委派决策：${task}\n子代理执行：${output.slice(0, 300) || '（无文本输出）'}\n结果：${result.isError ? '失败' : '完成'}。${usageSuffix}`,
      })
    }
  }

  /**
   * Locate the child session of a parent session: the first session whose
   * `parentSession` points at the parent. Null when the parent is unknown or
   * no child was found (e.g. a remote or non-session parent).
   * @param parent - the parent session, or undefined.
   * @returns a child session, or undefined.
   */
  private childSessionOf(parent: Session | undefined): Session | undefined {
    if (parent === undefined) return undefined
    return this.sessions.list().find(session => session.header.parentSession === parent.id)
  }
}
