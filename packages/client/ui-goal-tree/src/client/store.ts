/**
 * The goal-tree panel's viewing store: the last fetched trajectory overview plus
 * the presentation state (panel visibility, expanded goals). The fetch itself
 * lives in the inject face, not here — this store only records what arrived and
 * what the user is looking at.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { GoalTreeActions, GoalTreeState } from './contract/slots.ts'

/** Empty snapshot before the first fetch. */
export const INITIAL_GOAL_TREE_STATE: GoalTreeState = {
  status: 'idle',
  overview: null,
  error: null,
  open: false,
  expanded: [],
}

/**
 * Create the goal-tree panel's store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createGoalTreeStore(): EngineStoreHandle<GoalTreeState, GoalTreeActions> {
  return defineStore({
    init: (): GoalTreeState => ({ ...INITIAL_GOAL_TREE_STATE, expanded: [] }),
    actions: {
      replace(state, overview) {
        state.status = 'ready'
        state.overview = overview
        state.error = null
      },
      begin(state) {
        state.status = 'loading'
        state.error = null
      },
      fail(state, message) {
        state.status = 'error'
        state.error = message
      },
      setOpen(state, open) {
        state.open = open
      },
      toggleGoal(state, goalId) {
        state.expanded = state.expanded.includes(goalId)
          ? state.expanded.filter(id => id !== goalId)
          : [...state.expanded, goalId]
      },
    },
  })
}
