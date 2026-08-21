/**
 * Learning-area slot contract: the registrant-side props composition for the
 * sidebar-owned `sidebar.learning` hole, plus the area's store and inject
 * faces. The area is a read-only projection of the host's exploration-task
 * RPC: the store holds the last fetched snapshot and the presentation state
 * (filter, expanded), and the inject face owns the fetch itself so the
 * component stays free of subscription machinery.
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.learning' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ExplorationTaskStatus, ExplorationTaskView } from '@deepseek-ai/dsh-api-remotes/client'
import type { createLearningStore } from '../store.ts'
import type { CognitionKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The learning area's copy. */
    cognition: CognitionKey
  }
}

/** Wire status set, re-exported for the component's status vocabulary. */
export type { ExplorationTaskStatus, ExplorationTaskView }

/** Presentation filter over the task list. */
export type LearningFilter = 'all' | ExplorationTaskStatus

/** Learning-area snapshot store state. */
export interface LearningState {
  /** Fetch lifecycle: idle until the first refresh. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last successful task snapshot, oldest first. */
  tasks: readonly ExplorationTaskView[]
  /** Status counts from the same snapshot. */
  counts: { pending: number; running: number; completed: number; failed: number }
  /** Load/refresh failure message, null while healthy. */
  error: string | null
  /** Status filter; 'all' shows every task. */
  filter: LearningFilter
  /** Whether the area body is expanded. */
  expanded: boolean
}

/** Learning-area store actions (complete mutation API). */
export type LearningActions = {
  /** Apply a fetched snapshot; clears any stale error. */
  replace: (state: LearningState, snapshot: {
    tasks: readonly ExplorationTaskView[]
    counts: LearningState['counts']
  }) => void
  /** Mark a fetch in flight. */
  begin: (state: LearningState) => void
  /** Record a fetch failure. */
  fail: (state: LearningState, message: string) => void
  setFilter: (state: LearningState, filter: LearningFilter) => void
  setExpanded: (state: LearningState, expanded: boolean) => void
}

/** The inject face: the only place the area touches the wire. */
export interface LearningInjected {
  /** Fetch the task snapshot; resolves when the snapshot replaces the store. */
  refresh: (signal: AbortSignal) => Promise<void>
}

/**
 * Full component props: the framework runtime + store shares (the owner passes
 * the sidebar column state), the inject face, and the locale seat.
 */
export type LearningAreaProps =
  PropsRuntime<'sidebar.learning'>
  & PropsStore<ReturnType<typeof createLearningStore>>
  & LearningInjected
  & PropsLocale<'cognition'>
