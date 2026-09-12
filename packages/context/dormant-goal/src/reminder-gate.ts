/** 提醒门(cl-267): 是否把命中的目标**从提醒块里排除** —— 与驱动侧同一判据。
 *
 * 抽成独立模块 + 导出纯函数(而不是留在插件闭包里)是**为了让它可被行为断言直接测**: 2026-09-12 的教训是
 * 我把"排除提醒"直接复用 `shouldSkipAsWaiting`(文本启发式 **且** checker 未满足的与) ⇒ **行动型措辞但
 * checker 未满足**的目标照样收提醒, 而当时三条结构断言全绿 —— 结构断言只证明"接线在", 证不了"语义对"。
 * 判据: **有 checker 就由 checker 说了算**(两侧同一判据); 没有 checker 时才退回文本启发式兜底。
 */

/** @param goal - 池内目标。 @param runChecker - 求值 checker(返回 true = 条件已满足)。 @param waitingFallback - 无 checker 时的文本启发式(返回 true = 看起来在等待)。 @returns true 表示不发提醒。 */
export function shouldSkipReminder(
  goal: { nextAction?: string, waitChecker?: string },
  runChecker: (cmd: string) => boolean,
  waitingFallback: (nextAction: string) => boolean,
): boolean {
  const wc = String(goal.waitChecker ?? '').trim()
  if (wc !== '') return !runChecker(wc)
  return waitingFallback(String(goal.nextAction ?? ''))
}
