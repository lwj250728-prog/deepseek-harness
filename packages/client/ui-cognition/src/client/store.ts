/**
 * The learning area's viewing store: the last fetched task snapshot plus the
 * presentation state (status filter, body expansion). The fetch itself lives
 * in the inject face, not here — this store only records what arrived and
 * what the user is looking at.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { LearningActions, LearningFilter, LearningState } from './contract/slots.ts'

/** Empty snapshot before the first fetch. */
export const INITIAL_LEARNING_STATE: LearningState = {
  status: 'idle',
  tasks: [],
  counts: { pending: 0, running: 0, completed: 0, failed: 0 },
  error: null,
  filter: 'all',
  expanded: false,
}

/**
 * Create the learning-area store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLearningStore(): EngineStoreHandle<LearningState, LearningActions> {
  return defineStore({
    init: (): LearningState => ({ ...INITIAL_LEARNING_STATE }),
    actions: {
      replace(state, snapshot) {
        state.status = 'ready'
        state.tasks = snapshot.tasks
        state.counts = snapshot.counts
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
      setFilter(state, filter: LearningFilter) {
        state.filter = filter
      },
      setExpanded(state, expanded: boolean) {
        state.expanded = expanded
      },
    },
  })
}
