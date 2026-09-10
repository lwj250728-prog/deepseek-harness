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

/** The candidate to admit when the backoff would silence the channel entirely.
 *
 * 实测(cl-118 上线 40 分钟后): 6h 上限 + "只有少数经验能匹配帧查询" => 所有候选都在
 * 退避中, **注入数为 0**(退避前 5.7 条/小时)。通道全静默比"提醒早一点"更糟——所以
 * 当全部候选都被退避挡下时, 放行"最接近到期"的那一个; 但仅当它的**基础冷却**已过,
 * 否则会破坏"同经验不得在基础冷却内重复"的不变式(T96)。
 *
 * 实测 2026-09-11(cl-195): 这条保活把退避**架空**了。本会话注入节奏中位 5.2 分钟,
 * 而保活只要求基础冷却(2 分钟)已过 => 该前提几乎恒真: 134 条带遥测的审计里 **19 条
 * (14.2%) 是保活放行**, 放行时被绕过的有效冷却多为 2 小时, 连击最深 53 次——
 * 于是 exp_80 在一个会话里被注入 258 次, 退避形同不存在。
 * 修法: 给保活加**闲置门**——只有当本会话距上一次注入(任意经验)已超过 idleMs 时,
 * 保活才允许开火。这保留了它的原始目的(别让通道静默一小时), 又让 5 分钟级别的重复
 * 真正吃到退避。默认 60 分钟 = 原始事故(40 分钟零注入)的同一量级。
 * @param candidates - 被退避挡下的候选(含各自的基础冷却到期时间)。
 * @param now - 参考时刻。
 * @param baseMs - 基础冷却(保活不得破坏它)。
 * @param lastAnyInjectionAt - 本会话上一次注入任意经验的时刻(无注入传 0)。
 * @param idleMs - 保活所需的闲置时长; <= 0 表示关闭闲置门(退回旧行为)。
 * @returns 应放行的 expId, 或 null(基础冷却未过 / 通道并不闲置, 就该静默)。
 */
export function admitLeastBackedOff(
  candidates: readonly { expId: string, lastInjectedAt: number, effectiveCooldownMs: number }[],
  now: number,
  baseMs: number,
  lastAnyInjectionAt = 0,
  idleMs = 0,
): string | null {
  if (idleMs > 0 && lastAnyInjectionAt > 0 && now - lastAnyInjectionAt < idleMs) return null
  const eligible = candidates.filter(c => now - c.lastInjectedAt >= baseMs)
  if (eligible.length === 0) return null
  let best = eligible[0]!
  let bestRemaining = best.lastInjectedAt + best.effectiveCooldownMs - now
  for (const candidate of eligible.slice(1)) {
    const remaining = candidate.lastInjectedAt + candidate.effectiveCooldownMs - now
    if (remaining < bestRemaining) { best = candidate; bestRemaining = remaining }
  }
  return best.expId
}
