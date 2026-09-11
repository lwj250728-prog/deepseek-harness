/**
 * Goal-tree plugin, browser half: the `sidebar.footer.action` occupant (a foot
 * trigger that opens a floating panel) rendering every goal as a compact
 * three-lane trajectory tree. Data arrives on demand through the plugin's own
 * `/goal-tree` RPC channel (`trajectory/overview`, node half) — fetch on first
 * open plus a manual regenerate-and-refresh, no polling, no browser-held server
 * state beyond the last snapshot. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { GoalTreeInjected } from './contract/slots.ts'
import { GoalTree } from './GoalTree.tsx'
import { createGoalTreeStore } from './store.ts'
import { en, NS, zh, type GoalTreeKey } from './locales.ts'
import {
  GOAL_TREE_CHANNEL,
  GOAL_TREE_ENDPOINT,
  type GoalTrajectoryOverview,
  type GoalTrajectoryRequest,
} from './contract/goal-trajectory.ts'

export { createGoalTreeStore, INITIAL_GOAL_TREE_STATE } from './store.ts'
export { GoalTree } from './GoalTree.tsx'
export type {
  GoalTreeActions, GoalTreeInjected, GoalTreeProps, GoalTreeState, GoalTrajectoryOverview,
} from './contract/slots.ts'
export type { GoalTreeKey } from './locales.ts'
export type {
  GoalCounts, GoalLane, GoalStep, GoalStepKind, GoalTrajectoryGoal, GoalTrajectorySnapshot,
} from './contract/goal-trajectory.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal-trajectory panel's copy. */
    goalTree: GoalTreeKey
  }
}

/** Required services: the slot registry, the locale seat, and the carrier. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the `goalTree` dictionaries and the panel into
 * the sidebar foot, with the fetch face it needs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal-tree: dictionaries')

  const { rpc } = ctx.get('connection') as ConnectionHandle

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'goal-tree',
      order: 20,
      label: () => ctx.locale.bind(NS)('panel.label'),
      store: createGoalTreeStore,
      locale: NS,
      inject: (actions): GoalTreeInjected => {
        const refresh: GoalTreeInjected['refresh'] = async (signal, regenerate) => {
          actions.begin()
          try {
            // The endpoint is served by this plugin's node half; the result is
            // validated structurally on the host side, so the browser only has
            // to unwrap the carrier's result slot.
            const result = await rpc.call(
              GOAL_TREE_CHANNEL,
              GOAL_TREE_ENDPOINT,
              { ...regenerate === true ? { regenerate: true } : {} } satisfies GoalTrajectoryRequest,
              signal,
            )
            if (!result.ok) {
              actions.fail(result.error.message)
              return
            }
            actions.replace(result.value as GoalTrajectoryOverview)
          } catch (error) {
            if (signal.aborted) return
            actions.fail(error instanceof Error ? error.message : String(error))
          }
        }
        return { refresh }
      },
    },
    GoalTree,
  ))
}
