/**
 * Shared test harness for the orchestration plugin: a scripted delegate
 * provider, a pipeline context builder, and helpers to run one wrapped child.
 * @module @deepseek-ai/dsh-cognitive-orchestration/tests/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import * as cognitivePipeline from '@deepseek-ai/dsh-cognitive-pipeline'
import {
  CognitiveOrchestrator,
  resolveOrchestrationConfig,
} from '../src/orchestrator.ts'
import * as cognitiveOrchestration from '../src/index.ts'

/** A scripted delegate provider capturing every prompt it received. */
export class FakeDelegate implements SubagentProvider {
  readonly name = 'delegate'
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = true
  /** Every prompt passed to start(), in call order. */
  readonly prompts: ContentBlock[][] = []
  private stopReason: SubagentStopReason = 'completed'
  private output: string = '子任务完成了任务并给出了结果'

  /** Configure the settle outcome of the next started run. */
  script(stopReason: SubagentStopReason, output: string): void {
    this.stopReason = stopReason
    this.output = output
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.prompts.push(request.prompt)
    const result: SubagentResult = {
      output: [{ type: 'text', text: this.output }],
      stopReason: this.stopReason,
    }
    const run: SubagentRun = {
      id: SessionId(`child-${this.prompts.length}`),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: async () => {},
    }
    return Promise.resolve(run)
  }
}

/** Build a context with the pipeline, the fake delegate, and the orchestrator. */
export async function harness(
  config: Partial<Parameters<typeof cognitiveOrchestration.apply>[1]> = {},
): Promise<{
  ctx: Context
  delegate: FakeDelegate
  parent: Agent
  orchestrator: CognitiveOrchestrator
  teardown: () => Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'cognition-orch-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Timer)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(cognitivePipeline, { root })
  const delegate = new FakeDelegate()
  ctx.subagents.registerProvider(delegate)
  const orchestrator = new CognitiveOrchestrator(
    ctx,
    ctx.cognitivePipeline,
    ctx.sessions,
    resolveOrchestrationConfig({ delegate: 'delegate', providerName: 'cognitive', ...config }),
  )
  await ctx.plugin(cognitiveOrchestration, { delegate: 'delegate', providerName: 'cognitive', ...config })
  const session = Session.create(SessionId('orch-parent'))
  const parent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status(): import('@deepseek-ai/dsh-agent').AgentStatus { return 'running' },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(parent)
  const teardown = async (): Promise<void> => {
    rmSync(root, { recursive: true, force: true })
  }
  return { ctx, delegate, parent, orchestrator, teardown }
}

/** Run one wrapped child with the given prompt and resolve its result. */
export async function runChild(ctx: Context, parent: Agent, promptText: string): Promise<SubagentResult> {
  const run = await ctx.subagents.start('cognitive', {
    prompt: [{ type: 'text', text: promptText }],
    parent,
    signal: new AbortController().signal,
  })
  return run.result
}
