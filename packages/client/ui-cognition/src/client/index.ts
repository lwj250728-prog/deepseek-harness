/**
 * Learning-area plugin, browser half: the sidebar `sidebar.learning` occupant
 * rendering the cognitive pipeline's exploration task queue. Data arrives on
 * demand through the `cognition.list` RPC (fetch on first expand, manual
 * refresh) — the plugin issues no polling and holds no server state beyond
 * the last snapshot. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge (the 'conversation.chat.node'
// entry) into every program that sees this plugin's chat renderer registration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LearningInjected } from './contract/slots.ts'
import { LearningArea } from './LearningArea.tsx'
import { CognitionSummaryNodeView } from './CognitionSummaryNodeView.tsx'
import { registerCognitionSummaryNode } from './conversation-nodes/cognition-summary.ts'
import { createLearningStore } from './store.ts'
import { en, NS, zh, type CognitionKey } from './locales.ts'
export { createLearningStore } from './store.ts'
export type {
  ExplorationTaskStatus, ExplorationTaskView, LearningActions, LearningAreaProps,
  LearningFilter, LearningInjected, LearningState,
} from './contract/slots.ts'
export type { CognitionKey } from './locales.ts'
export type { CognitionSummaryChatData, TurnCognitionSummaryWire } from './conversation-nodes/cognition-summary.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The learning area's copy. */
    cognition: CognitionKey
  }
}

/** Required services: the slot registry, the locale seat, the carrier, and
 * the conversation event registry (for the per-turn cognition bubble). */
export const inject = ['slots', 'locale', 'connection', 'conversationEvents']

/**
 * Client plugin body: register the `cognition` dictionaries, the learning
 * area into the sidebar hole, and the per-turn cognition bubble into the chat
 * stream (both with the store/inject faces they need).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cognition: dictionaries')

  // The per-turn cognition bubble: engine node + keyed chat renderer.
  registerCognitionSummaryNode(ctx)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'cognition-summary', locale: NS },
    CognitionSummaryNodeView,
  ))

  ctx.slots.inject('sidebar.learning', () => ctx.slots.register(
    {
      name: 'sidebar.learning',
      store: createLearningStore,
      locale: NS,
      inject: (actions): LearningInjected => {
        const { api } = ctx.get('connection') as ConnectionHandle
        const refresh: LearningInjected['refresh'] = async (signal) => {
          actions.begin()
          try {
            const response = await api.cognition.list({}, signal)
            if (!response.result.ok) {
              actions.fail(response.result.error.message)
              return
            }
            actions.replace(response.result.value)
          } catch (error) {
            if (signal.aborted) return
            actions.fail(error instanceof Error ? error.message : String(error))
          }
        }
        return { refresh }
      },
    },
    LearningArea,
  ))
}
