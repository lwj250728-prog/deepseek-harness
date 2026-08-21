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
import type { LearningInjected } from './contract/slots.ts'
import { LearningArea } from './LearningArea.tsx'
import { createLearningStore } from './store.ts'
import { en, NS, zh, type CognitionKey } from './locales.ts'
export { createLearningStore } from './store.ts'
export type {
  ExplorationTaskStatus, ExplorationTaskView, LearningActions, LearningAreaProps,
  LearningFilter, LearningInjected, LearningState,
} from './contract/slots.ts'
export type { CognitionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The learning area's copy. */
    cognition: CognitionKey
  }
}

/** Required services: the slot registry, the locale seat, and the carrier. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the `cognition` dictionaries and the learning
 * area into the sidebar hole, with a store for the fetched snapshot and an
 * inject face that owns the RPC.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cognition: dictionaries')

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
