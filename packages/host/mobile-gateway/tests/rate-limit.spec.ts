/**
 * FixedWindowLimiter unit spec: window accounting, the trip threshold, the
 * limited check without recording, success reset, and Retry-After math — all
 * against an injected clock so no timers are needed.
 */

import { describe, expect, it } from 'vitest'
import { FixedWindowLimiter } from '../src/rate-limit.ts'

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('FixedWindowLimiter', () => {
  it('allows failures up to the threshold and trips on the exceeding one', () => {
    const { now, advance } = clock()
    const limiter = new FixedWindowLimiter(60_000, 2, now)
    expect(limiter.recordFailure('ip')).toBe(false)
    expect(limiter.recordFailure('ip')).toBe(false)
    expect(limiter.recordFailure('ip')).toBe(true)
    advance(1)
    expect(limiter.isLimited('ip')).toBe(true)
  })

  it('keys are independent', () => {
    const { now } = clock()
    const limiter = new FixedWindowLimiter(60_000, 1, now)
    expect(limiter.recordFailure('a')).toBe(false)
    expect(limiter.recordFailure('a')).toBe(true)
    expect(limiter.isLimited('b')).toBe(false)
    expect(limiter.recordFailure('b')).toBe(false)
  })

  it('a new window opens after expiry and forgets the old count', () => {
    const { now, advance } = clock()
    const limiter = new FixedWindowLimiter(60_000, 2, now)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    expect(limiter.isLimited('ip')).toBe(false) // at threshold, not over
    advance(60_001)
    expect(limiter.isLimited('ip')).toBe(false)
    expect(limiter.recordFailure('ip')).toBe(false)
  })

  it('isLimited never records', () => {
    const { now } = clock()
    const limiter = new FixedWindowLimiter(60_000, 1, now)
    expect(limiter.isLimited('ip')).toBe(false)
    expect(limiter.isLimited('ip')).toBe(false)
    expect(limiter.recordFailure('ip')).toBe(false)
  })

  it('clear resets the streak (successful login)', () => {
    const { now } = clock()
    const limiter = new FixedWindowLimiter(60_000, 1, now)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip') // exceeds maxFailures=1
    expect(limiter.isLimited('ip')).toBe(true)
    limiter.clear('ip')
    expect(limiter.isLimited('ip')).toBe(false)
    expect(limiter.recordFailure('ip')).toBe(false)
  })

  it('retryAfterSeconds reports the window remainder, floored at 1', () => {
    const { now, advance } = clock()
    const limiter = new FixedWindowLimiter(60_000, 1, now)
    expect(limiter.retryAfterSeconds('ip')).toBe(0)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip') // over the limit
    advance(30_000)
    expect(limiter.retryAfterSeconds('ip')).toBe(30)
    advance(30_001)
    expect(limiter.isLimited('ip')).toBe(false)
  })
})
