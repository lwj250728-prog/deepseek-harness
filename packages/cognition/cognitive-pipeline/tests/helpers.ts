/**
 * Shared test harness: a scripted LLM adapter (text-per-call), a pipeline
 * context builder, and a registry-compatible stub agent for tool executions.
 * @module @deepseek-ai/dsh-cognitive-pipeline/tests/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as cognitivePipeline from '../src/index.ts'
import type { CognitivePipelineConfig } from '../src/service.ts'

/** A text-chunk adapter that yields one scripted response per call. */
export class ScriptedAdapter extends LlmAdapter {
  private cursor = 0
  constructor(private readonly responses: readonly string[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.responses[this.cursor] ?? '{}'
    this.cursor += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** How many calls were consumed so far. */
  get consumed(): number {
    return this.cursor
  }
}

/** Build a pipeline context with the given config and optional scripted LLM. */
export async function pipelineHarness(
  config: CognitivePipelineConfig = {},
  script?: readonly string[],
): Promise<{
  ctx: Context
  adapter: ScriptedAdapter | undefined
  root: string
  fiber: { dispose(): Promise<void> }
  teardown: () => Promise<void>
}> {
  const root = mkdtempSync(join(tmpdir(), 'cognition-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  const adapter = script === undefined ? undefined : new ScriptedAdapter(script)
  const fiber = await ctx.plugin(cognitivePipeline, { root, ...config })
  if (adapter !== undefined) {
    ctx.llm.registerAdapter(['cognition-test'], adapter)
  }
  const teardown = async (): Promise<void> => {
    rmSync(root, { recursive: true, force: true })
  }
  return { ctx, adapter, root, fiber, teardown }
}

/** Stub agent binding tools to a session (mirrors tool-goal's harness). */
export function stubAgent(rawId: string): { agent: Agent; session: Session } {
  const session = Session.create(SessionId(rawId))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status(): AgentStatus { return 'running' },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

/** Execute one registered tool and return the canonical value. */
export async function executeTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
): Promise<unknown> {
  const signal = new AbortController().signal
  const result = await ctx.tools.execute({
    signal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  if (result.isError) {
    const block = result.content[0]
    throw new Error(`tool ${name} failed: ${block?.type === 'text' ? block.text : 'unknown error'}`)
  }
  return result.value
}
