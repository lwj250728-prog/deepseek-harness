/**
 * Waiting-type nextAction detection (cl-110).
 *
 * The action-frame loop must not push a goal whose next step is *waiting* —
 * for the user, for an external event, or for a calendar date. Otherwise the
 * loop "reminds" the agent every cooldown about a step nobody can execute yet
 * (the exp_126 bombardment), burning tokens without advancing anything.
 *
 * The guard existed but keyed on tightly-spelled prefixes, so a trivially
 * different spelling slipped through: `待 09-11 06:5x 复核(等待型)` (space after
 * 待) failed `待[0-9]{4}` and the goal kept firing action frames. Whitespace is
 * formatting, not intent — this predicate tolerates it, and the classification
 * is a pure function so the cases are unit-testable (dsh-waiting-guard-test.ts).
 * @module @deepseek-ai/dsh-quiet-driver/waiting
 */

/** Prefixes that mean "this step waits for the user or an external actor". */
const WAITING_PREFIX = /^(?:待用户|等待用户|请用户|需用户|等用户|待你|等你|待事件|待日期|等待外部|等外部)/

/** "Waiting for a date/clock": 待09-11 / 待 2026-09-11 / 等待 09-11 / 等 6 点. */
const WAITING_DATE = /^(?:等待|等|待)\s*(?:[0-9]{4}|[0-9]{1,2}\s*[-/.月])/

/** Chinese/Latin words that look like "pending" but are not waiting intent
 *  (e.g. 待办 = todo, 待修 = to be fixed) — these stay actionable. */
const NOT_WAITING = /^(?:待办|待修|待补|待验证|待测试|待评估|待实现|待重构)/

/** Whether one nextAction is a waiting-type step (not to be pushed by the loop).
 * @param nextAction - the goal's next action text.
 * @returns true when the step waits for the user, an event, or a date.
 */
export function isWaitingNextAction(nextAction: string): boolean {
  const text = nextAction.trim()
  if (text.length === 0) return false
  if (NOT_WAITING.test(text)) return false
  return WAITING_PREFIX.test(text) || WAITING_DATE.test(text)
}
