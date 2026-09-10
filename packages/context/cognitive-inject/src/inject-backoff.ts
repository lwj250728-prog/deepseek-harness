/**
 * Per-experience injection backoff (cl-118 revised).
 *
 * Measured: the same handful of experiences dominate injections (top-5 = 69% of
 * slots in the clean window), so the headline adoption rate mostly measures
 * *reminding*, not retrieval quality. But hard suppression is wrong: the two
 * adoptions in the record happened on the **68th** and **6th** injection of
 * their experience — a "3 uncited strikes and you're out" rule would have killed
 * both while making the metric look better.
 *
 * So: back off, don't suppress. Each uncited injection of the same experience
 * in this session doubles its cooldown (base → cap), which keeps the
 * eventually-lands channel open while cutting volume.
 *
 * Pure functions here, so the schedule is unit-testable without waiting for
 * real repetitions to accumulate (dsh-inject-backoff-test.ts / tp-079).
 */

/** How long to wait before injecting an experience again.
 * @param uncitedStreak - prior injections of this experience in this session
 *   that settled as uncited (0 = never injected, or cited since).
 * @param baseMs - the base cooldown for a never-injected experience.
 * @param maxMs - ceiling for the backoff.
 * @returns the effective cooldown in milliseconds.
 */
export function backoffDelayMs(uncitedStreak: number, baseMs: number, maxMs: number): number {
  if (baseMs <= 0) return 0
  const streak = Math.max(0, Math.floor(uncitedStreak))
  // 2^streak overflows quickly; cap the exponent before shifting.
  const exponent = Math.min(streak, 20)
  return Math.min(baseMs * Math.pow(2, exponent), Math.max(baseMs, maxMs))
}

/** One prior injection of an experience, as the backoff reads it. */
export interface PriorInjection {
  readonly expId: string
  readonly injectedAt: number
  readonly cited: boolean | null
}

/** Per-experience backoff state derived from a session's injection history.
 * @param prior - prior injections of this session, any order.
 * @param now - reference time.
 * @param baseMs - base cooldown.
 * @param maxMs - ceiling.
 * @returns a map expId → { lastInjectedAt, uncitedStreak, effectiveCooldownMs }.
 */
export function backoffState(
  prior: readonly PriorInjection[],
  now: number,
  baseMs: number,
  maxMs: number,
): Map<string, { lastInjectedAt: number, uncitedStreak: number, effectiveCooldownMs: number }> {
  const byExp = new Map<string, PriorInjection[]>()
  for (const record of prior) {
    const bucket = byExp.get(record.expId) ?? []
    bucket.push(record)
    byExp.set(record.expId, bucket)
  }
  const state = new Map<string, { lastInjectedAt: number, uncitedStreak: number, effectiveCooldownMs: number }>()
  for (const [expId, records] of byExp) {
    const ordered = [...records].sort((a, b) => a.injectedAt - b.injectedAt)
    const last = ordered[ordered.length - 1]!
    // 引用过就把连击清零: 一次落地证明这条提醒能落地, 不该继续处罚它。
    let streak = 0
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (ordered[index]!.cited === true) break
      streak += 1
    }
    state.set(expId, {
      lastInjectedAt: last.injectedAt,
      uncitedStreak: streak,
      effectiveCooldownMs: backoffDelayMs(streak, baseMs, maxMs),
    })
  }
  void now
  return state
}
