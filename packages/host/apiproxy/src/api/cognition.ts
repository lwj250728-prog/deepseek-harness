/**
 * cognition domain contract: read-only exploration-task surface. The
 * cognitive pipeline's autonomous exploration queue (scheme-2 execution loop)
 * lives host-side; this domain exposes the task list and status counts to the
 * browser so the learning-area UI can render what the agent is learning
 * without reaching into the pipeline store.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Wire status of one exploration task (mirrors the pipeline's ExplorationTaskStatus). */
export type ExplorationTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

/** One exploration task row (wire projection of the pipeline's ExplorationTask). */
export interface ExplorationTaskView {
  /** Stable task id (`task_N`). */
  readonly taskId: string
  /** The exploration goal the executing session was told to pursue. */
  readonly goal: string
  readonly status: ExplorationTaskStatus
  /** Epoch milliseconds at creation. */
  readonly createdAt: number
  /** Epoch milliseconds when a scheduler picked it up; null while pending. */
  readonly pickedUpAt: number | null
  /** The executing session's outcome; null until settled. */
  readonly result: string | null
}

/** Status-count summary for the learning area's header badge. */
export interface ExplorationTaskCounts {
  readonly pending: number
  readonly running: number
  readonly completed: number
  readonly failed: number
}

/**
 * Cognition-domain unary methods. Read-only: the queue is fed by the pipeline
 * itself (explore()/exploreAutoDispatch) and settled by the orchestrator's
 * scheduler, so the browser has no mutation verbs here.
 */
export interface CognitionApi {
  /** List every exploration task, oldest first, plus status counts. */
  list(request: RpcRequest<Record<string, never>>):
  Promise<RpcResponse<{ tasks: readonly ExplorationTaskView[]; counts: ExplorationTaskCounts }>>
}
