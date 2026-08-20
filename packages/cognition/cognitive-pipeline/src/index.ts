/**
 * Prediction-error-driven dynamic cognition (DCA-PED) as a harness plugin:
 * SAR experience memory, a hot-loop online predictor with OOD detection and
 * five-layer confidence calibration, a temp-strategy scratchpad, simulated
 * experience generation, and a cold-loop taxonomy rebuild gated by sandbox
 * backtesting. The plugin exposes six model-facing tools, the
 * `ctx.cognitivePipeline` service, and a dynamic `cognition:taxonomy`
 * system-prompt section.
 *
 * @module @deepseek-ai/dsh-cognitive-pipeline
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import {
  CognitivePipelineService,
  Config,
} from './service.ts'
import type { CognitivePipelineConfig } from './service.ts'
import { registerPipelineTools } from './tools.ts'
import type { TurnEpisode } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'cognitive-pipeline'

/** Services required before the pipeline can mount. */
export const inject = ['llm', 'tools', 'systemPrompt']

/** Re-export the service and config schema for consumers and Loader validation. */
export { CognitivePipelineService, Config }
export type { CognitivePipelineConfig } from './service.ts'
export * from './types.ts'
export * from './vectorizer.ts'

/** Reconstruct one completed turn into candidate accumulation material. */
function reconstructTurn(session: Session, endEvent: SessionEvent<'turn/end'>): TurnEpisode {
  const turn = (endEvent.data as { turn: number }).turn
  const events = session.events
  const texts: string[] = []
  const actions: string[] = []
  const outcomes: string[] = []
  let toolCallCount = 0
  let failed = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'turn/start' && (event.data as { turn: number }).turn === turn) break
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        const message = data.message as { content?: readonly { type: string; text?: string }[] } | undefined
        const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0) texts.push(text)
        break
      }
      case 'assistant/message': {
        const message = data.message as { content?: readonly { type: string; text?: string }[] } | undefined
        const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ')
        if (text !== undefined && text.trim().length > 0) outcomes.push(text)
        break
      }
      case 'tool/call': {
        toolCallCount += 1
        const name = typeof data.name === 'string' ? data.name : '?'
        actions.push(`调用 ${name}`)
        break
      }
      case 'tool/result': {
        if (data.isError === true) failed = true
        break
      }
      default:
        break
    }
  }
  const reason = (endEvent.data as { reason?: { kind?: string } }).reason?.kind ?? 'unknown'
  const outcome = [...outcomes, `轮次结束（${reason}）`].join(' ').trim()
  return {
    situation: texts.reverse().join(' ').slice(0, 800),
    action: actions.reverse().join('；').slice(0, 800) || outcome.slice(0, 300),
    outcome: outcome.slice(0, 800),
    toolCallCount,
    failed,
    turnId: turn,
  }
}

/**
 * Mount the pipeline: construct the service (its `Service` base registers
 * `ctx.cognitivePipeline` on this fiber's context), wait for the store, then
 * register the dynamic taxonomy prompt section and (unless disabled) the
 * model tools. When `autoAccumulate` is enabled, also listen for completed
 * turns and run each through the accumulation gate.
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

  if (service.resolved.autoAccumulate) {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
      if (reason !== 'completed' && reason !== 'error') return
      const episode = reconstructTurn(session, event)
      if (episode.situation.trim().length === 0) return
      void service.accumulateTurn(episode).catch((error) => {
        ctx.logger.warn(`cognitive-pipeline: automatic accumulation failed: ${String(error)}`)
      })
    })
  }
}
