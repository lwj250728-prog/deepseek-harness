/**
 * Goal-trajectory contract, shared by both faces of the plugin.
 *
 * This module is the ONLY meeting point of the two halves, so it is
 * deliberately inert: plain interfaces, string constants, and one pure lane
 * ordering. It imports nothing — not node builtins, not `@deepseek-ai/*`
 * packages — which is what lets the browser bundle inline it under the client
 * purity gate while the node half imports the very same types. The data source
 * is generated outside the harness (`dsh-goal-trajectory.py`), so these types
 * describe a file schema owned by that generator, not a host registry.
 *
 * @module @deepseek-ai/dsh-client-ui-goal-tree/src/goal-trajectory
 */

/** Logical RPC channel the goal-trajectory endpoint is served on. */
export const GOAL_TREE_CHANNEL = '/goal-tree'

/** Channel-relative endpoint: `POST /goal-tree/trajectory/overview`. */
export const GOAL_TREE_ENDPOINT = 'trajectory/overview'

/** Payload file name under the cognitive-pipeline state directory. */
export const TRAJECTORY_FILE_NAME = 'goal-trajectory.json'

/** Generator script path relative to the checkout root (three levels above `packages/host/apiproxy/lib`). */
export const TRAJECTORY_SCRIPT_RELATIVE = 'dsh-goal-trajectory.py'

/** The three visible lanes of a trajectory tree, plus the abnormal-blocked count lane. */
export type GoalLane = 'completed' | 'executing' | 'planned'

/** Lane render order: finished work first, then live work, then what is queued. */
export const GOAL_LANES: readonly GoalLane[] = ['completed', 'executing', 'planned']

/** Step classification vocabulary (mirrors the generator's per-step `kind`). */
export type GoalStepKind = 'completed' | 'executing' | 'planned' | 'blocked'

/** Goal lifecycle status as the dormant-goal store spells it. */
export type GoalStatus = 'active' | 'dormant' | 'paused'

/** Per-lane step counts of one goal. */
export interface GoalCounts {
  readonly completed: number
  readonly executing: number
  readonly planned: number
  readonly blocked: number
}

/** One ledger claim under a goal: the trajectory node. */
export interface GoalStep {
  /** Ledger id (`cl-201`). */
  readonly id: string
  /** Lane the step is classified into. */
  readonly kind: GoalStepKind
  /** Raw ledger status (`done` / `open` / …). */
  readonly status: string
  /** Local timestamp `YYYY-MM-DDTHH:MM:SS`. */
  readonly ts: string
  /** The claim text carried by the ledger entry. */
  readonly claim: string
  /** Deadline of a future-dated claim; null when the ledger entry has none. */
  readonly reviewBy: string | null
  /** Evidence recorded against the claim. */
  readonly evidence: string
}

/** One goal as a compact tree: the goal row plus its ledger steps. */
export interface GoalTrajectoryGoal {
  /** Stable goal id (`goal-…`). */
  readonly id: string
  /** Human-readable goal title. */
  readonly title: string
  /** Lifecycle status from the goal store. */
  readonly status: string
  /** The lane the goal's current work sits in. */
  readonly lane: GoalLane
  /** Whether the goal's next action is a waiting step rather than an executable one. */
  readonly waiting: boolean
  /** The next action the goal is committed to; empty when none is declared. */
  readonly nextAction: string
  /** Timestamp of the most recent ledger activity, `YYYY-MM-DDTHH:MM:SS`. */
  readonly lastActionAt: string
  /** Wake count of the goal (trigger-log wakes, or the goal's own wake counter). */
  readonly wakes: number
  /** Adopted-experience count attributed to the goal. */
  readonly adopted: number
  /** Per-lane step counts. */
  readonly counts: GoalCounts
  /** Ledger steps of this goal, oldest first. */
  readonly steps: readonly GoalStep[]
}

/** Lane legend prose published by the generator. */
export interface GoalLaneLegend {
  readonly completed: string
  readonly executing: string
  readonly planned: string
  readonly blocked: string
}

/** Absolute paths the generator read to build the snapshot. */
export interface GoalTrajectorySources {
  readonly goals: string
  readonly claims: string
  readonly triggers: string
}

/** One generated trajectory snapshot (the whole payload file). */
export interface GoalTrajectorySnapshot {
  /** ISO8601 timestamp with offset at generation time. */
  readonly generatedAt: string
  /** Ledger files the snapshot was derived from. */
  readonly source: GoalTrajectorySources
  /** Lane classification rubric, in the generator's own words. */
  readonly legend: GoalLaneLegend
  /** Every goal, in the generator's order. */
  readonly goals: readonly GoalTrajectoryGoal[]
}

/** The `overview` result: the snapshot plus where it was read from and when. */
export interface GoalTrajectoryOverview {
  /** The generated snapshot, verbatim. */
  readonly snapshot: GoalTrajectorySnapshot
  /** Absolute path the snapshot was read from. */
  readonly path: string
  /** Whether this call ran the generator before reading. */
  readonly regenerated: boolean
  /** Epoch milliseconds at read; the panel shows staleness against this. */
  readonly readAt: number
}

/** Request payload of the overview endpoint. */
export interface GoalTrajectoryRequest {
  /** Run the generator before reading, so the panel can force a fresh snapshot. */
  readonly regenerate?: boolean
}
