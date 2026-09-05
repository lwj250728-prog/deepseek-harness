/**
 * Fixed-window per-key attempt limiter for the gateway's login endpoint.
 * The clock is injected so the trust decision is unit-testable without fake
 * timers; the map is bounded by the number of distinct caller keys in one
 * window, which the gateway prunes by clearing on success and by window
 * expiry on the next hit.
 * @module @deepseek-ai/dsh-mobile-gateway/rate-limit
 */

/** One key's window state. */
export interface WindowState {
  /** Window start epoch ms. */
  start: number
  /** Failures recorded in the current window. */
  count: number
}

/**
 * A fixed-window limiter keyed by caller identity (the socket peer address
 * in the gateway). `maxFailures` is the count that trips the limit: the
 * window closes on the failure that exceeds it, and every later attempt
 * within the window is rejected without further checks.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, WindowState>()

  /**
   * @param windowMs - window length in ms.
   * @param maxFailures - failures per window before the limit trips.
   * @param now - clock, injectable for tests.
   */
  constructor(
    private readonly windowMs: number,
    private readonly maxFailures: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one failure for `key`; true when the key is now over the limit. */
  recordFailure(key: string): boolean {
    const t = this.now()
    let win = this.windows.get(key)
    if (win === undefined || t - win.start >= this.windowMs) {
      win = { start: t, count: 0 }
      this.windows.set(key, win)
    }
    win.count += 1
    return win.count > this.maxFailures
  }

  /** Whether `key` is currently over the limit (rejects without recording). */
  isLimited(key: string): boolean {
    const win = this.windows.get(key)
    if (win === undefined) return false
    if (this.now() - win.start >= this.windowMs) {
      this.windows.delete(key)
      return false
    }
    return win.count > this.maxFailures
  }

  /** Forget `key`; called after a successful login resets the streak. */
  clear(key: string): void {
    this.windows.delete(key)
  }

  /** Whole seconds until the current window resets for `key` (Retry-After). */
  retryAfterSeconds(key: string): number {
    const win = this.windows.get(key)
    if (win === undefined) return 0
    const remaining = win.start + this.windowMs - this.now()
    return Math.max(1, Math.ceil(remaining / 1000))
  }
}
