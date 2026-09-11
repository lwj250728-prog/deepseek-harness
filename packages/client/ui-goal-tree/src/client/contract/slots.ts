/**
 * Goal-tree slot contract: the registrant-side props composition for the
 * sidebar-owned `sidebar.footer.action` hole, plus the panel's store and inject
 * faces. The panel is a read-only projection of the host's trajectory endpoint:
 * the store holds the last fetched snapshot and the presentation state (path
 * collapse, expansion set), and the inject face owns the fetch itself so the
 * component stays free of subscription machinery.
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.footer.action'
// entry) into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the snapshot shape both faces agree on (inert module, no runtime edge).
import type { GoalTrajectoryOverview } from './goal-trajectory.ts'
import type { createGoalTreeStore } from '../store.ts'
import type { GoalTreeKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal-trajectory panel's copy. */
    goalTree: GoalTreeKey
  }
}

/** Re-exported for the component's data vocabulary. */
export type { GoalTrajectoryOverview }

/** Goal-tree panel store state. */
export interface GoalTreeState {
  /** Fetch lifecycle: idle until the first refresh. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Last successful overview, null before the first fetch. */
  overview: GoalTrajectoryOverview | null
  /** Load/refresh failure message, null while healthy. */
  error: string | null
  /** Whether the floating panel is open. */
  open: boolean
  /** Goal ids whose step list is expanded. */
  expanded: readonly string[]
}

/** Goal-tree store actions (complete mutation API). */
export type GoalTreeActions = {
  /** Apply a fetched overview; clears any stale error. */
  replace: (state: GoalTreeState, overview: GoalTrajectoryOverview) => void
  /** Mark a fetch in flight. */
  begin: (state: GoalTreeState) => void
  /** Record a fetch failure. */
  fail: (state: GoalTreeState, message: string) => void
  /** Open or close the floating panel. */
  setOpen: (state: GoalTreeState, open: boolean) => void
  /** Toggle one goal's step list. */
  toggleGoal: (state: GoalTreeState, goalId: string) => void
}

/** The inject face: the only place the panel touches the wire. */
export interface GoalTreeInjected {
  /**
   * Fetch the trajectory overview; resolves when the snapshot replaces the store.
   * @param signal - caller cancellation.
   * @param regenerate - run the generator before reading, instead of reading the published file.
   */
  refresh: (signal: AbortSignal, regenerate?: boolean) => Promise<void>
}

/**
 * Full component props: the sidebar owner's column state, the store shares, the
 * inject face, and the locale seat.
 */
export type GoalTreeProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createGoalTreeStore>>
  & GoalTreeInjected
  & PropsLocale<'goalTree'>
