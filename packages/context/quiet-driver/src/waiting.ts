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
const WAITING_DATE = /^(?:等待|等|待)\s*(?:[0-9]{4}|[0-9]{1,2}\s*[-/.月]|[0-9]{1,2}\s*[:点])/

/** Chinese/Latin words that look like "pending" but are not waiting intent
 *  (e.g. 待办 = todo, 待修 = to be fixed) — these stay actionable. */
const NOT_WAITING = /^(?:待办|待修|待补|待验证|待测试|待评估|待实现|待重构)/

/** Whether one nextAction is a waiting-type step (not to be pushed by the loop).
 * @param nextAction - the goal's next action text.
 * @returns true when the step waits for the user, an event, or a date.
 */
export function isWaitingNextAction(nextAction: string, now: Date = new Date()): boolean {
  const text = nextAction.trim()
  if (text.length === 0) return false
  if (NOT_WAITING.test(text)) return false
  if (WAITING_PREFIX.test(text)) return true
  if (!WAITING_DATE.test(text)) return false
  // cl-198（2026-09-11 06:5x）: 原实现在这里直接 return true —— **只看文本、从不看时钟**。
  // 于是 `待 09-11 06:5x 复核(等待型)` 在 06:5x 早已过去后仍被判"等待中", 唤醒循环**永久跳过**
  // 该目标: 实测 goal-trigger-log 35 次唤醒 **0 采纳**, 修复后的唤醒全部 skipped:waiting, 而该目标的
  // nextAction 一次都没被更新。等待守卫把"轰炸"换成了"永久静默"。
  const at = parseWaitingMoment(text, now)
  if (at !== null && at.getTime() <= now.getTime()) return false
  return true
}

/** Parse the moment a date-typed wait points at, or null when it is not resolvable.
 *
 * 支持 `YYYY-MM-DD` / `MM-DD` / `M月D日`, 可带 `HH:MM` / `H点` 时间(缺省按当日 00:00)。
 * 只解析**前缀里紧跟着的那个日期**(与 WAITING_DATE 同一位置), 不做全文搜索——
 * 正文里顺带提到的日期(如"①cl-100 引用率 24h 重算(09-11 05:30)")不该被当成等待时刻。
 * @param text - the trimmed nextAction.
 * @param now - reference time (for year-less forms).
 * @returns the target Date, or null when unresolvable.
 */
export function parseWaitingMoment(text: string, now: Date = new Date()): Date | null {
  const rest = text.replace(/^(?:等待|等|待)\s*/, '')
  let year: number | null = null
  let month: number | null = null
  let day: number | null = null
  let tail = ''
  let m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(.*)$/.exec(rest)
  if (m !== null) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); tail = m[4] ?? ''
  } else if ((m = /^([0-9]{1,2})-([0-9]{1,2})(.*)$/.exec(rest)) !== null) {
    month = Number(m[1]); day = Number(m[2]); tail = m[3] ?? ''
  } else if ((m = /^([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日(.*)$/.exec(rest)) !== null) {
    month = Number(m[1]); day = Number(m[2]); tail = m[3] ?? ''
  }
  if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null
  // 没写钟点 → 以当日结束为准: "待 09-11 复核" 表示 09-11 那天都还算等待;
  // 写了钟点(06:5x) → 以那一刻为准, 到点即恢复可执行。二者都不再"永久等待"。
  let hour = 23
  let minute = 59
  let hasTime = false
  const tm = /^\s*([0-9]{1,2})\s*[:点]\s*([0-9]{0,2})/.exec(tail)
  if (tm !== null) {
    hour = Number(tm[1])
    minute = tm[2] === '' ? 0 : Number(tm[2])
    hasTime = true
    if (hour > 23 || minute > 59) { hour = 0; minute = 0 }
  }
  if (!hasTime) { /* 保持当日结束 */ }
  return new Date(year ?? now.getFullYear(), month - 1, day, hour, minute, 0, 0)
}
