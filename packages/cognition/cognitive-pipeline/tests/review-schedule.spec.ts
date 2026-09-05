/**
 * Review-schedule predicates (activation-regulator rule): interval growth per
 * review, high-cost urgency for negative experiences, and the always-due
 * rework-flagged strategy.
 */

import { describe, expect, it } from 'vitest'
import { pipelineHarness } from './helpers.ts'
import {
  experienceDueForReview,
  isHighCost,
  lastReviewOrCreation,
  reviewInterval,
  strategyDueForReview,
} from '../src/index.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

function exp(overrides: Record<string, unknown> = {}): Parameters<typeof experienceDueForReview>[0] {
  return {
    expId: 'exp_1',
    timestamp: NOW - 10 * DAY,
    sar: { outcomeUtility: { materialGain: 3, emotionalValence: 3, energyCost: 2 } },
    ...overrides,
  } as never
}

function strat(overrides: Record<string, unknown> = {}): Parameters<typeof strategyDueForReview>[0] {
  return {
    strategyId: 'solidified-1',
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    reworkNeeded: false,
    ...overrides,
  } as never
}

describe('review scheduling (activation regulator)', () => {
  it('grows the interval by 2 per review, capped at the ceiling', () => {
    expect(reviewInterval(0, DAY, 30 * DAY)).toBe(DAY)
    expect(reviewInterval(1, DAY, 30 * DAY)).toBe(2 * DAY)
    expect(reviewInterval(2, DAY, 30 * DAY)).toBe(4 * DAY)
    expect(reviewInterval(10, DAY, 30 * DAY)).toBe(30 * DAY) // capped
  })

  it('last-review moment falls back to creation time', () => {
    expect(lastReviewOrCreation({ timestamp: 100, lastReviewedAt: 200 })).toBe(200)
    expect(lastReviewOrCreation({ timestamp: 100 })).toBe(100)
    expect(lastReviewOrCreation({ createdAt: 50 })).toBe(50)
  })

  it('flags only costly negative outcomes as high-cost', () => {
    expect(isHighCost({ materialGain: 6, emotionalValence: 6, energyCost: 5 })).toBe(true)
    expect(isHighCost({ materialGain: 6, emotionalValence: 1, energyCost: 3 })).toBe(false)
    expect(isHighCost({ materialGain: 2, emotionalValence: 2, energyCost: 8 })).toBe(false)
  })

  it('an unreviewed fresh experience is not due; an aged one is', () => {
    const fresh = exp({ timestamp: NOW - 10_000 })
    expect(experienceDueForReview(fresh, NOW)).toBe(false)
    const aged = exp({ timestamp: NOW - 2 * DAY })
    expect(experienceDueForReview(aged, NOW)).toBe(true)
  })

  it('a high-cost experience is due earlier than a mild one', () => {
    const opts = { baseMs: DAY }
    const mild = exp({ timestamp: NOW - DAY + 10_000 })
    // Mild: interval 1d, elapsed ~1d − 10s → not due.
    expect(experienceDueForReview(mild, NOW, opts)).toBe(false)
    // High-cost: interval × 0.5 = 12h → due well before 1d.
    const costly = exp({
      timestamp: NOW - 20 * HOUR,
      sar: { outcomeUtility: { materialGain: 8, emotionalValence: 7, energyCost: 6 } },
    })
    expect(experienceDueForReview(costly, NOW, opts)).toBe(true)
  })

  it('a reviewed experience lengthens its next interval', () => {
    const opts = { baseMs: DAY }
    const once = exp({ timestamp: NOW - 2 * DAY, lastReviewedAt: NOW - DAY + 10_000, reviewCount: 1 })
    // Second interval = 2d; only 1d elapsed → not due.
    expect(experienceDueForReview(once, NOW, opts)).toBe(false)
  })

  it('a rework-flagged strategy is always due regardless of recency', () => {
    const broken = strat({ lastReviewedAt: NOW - 1_000, reworkNeeded: true })
    expect(strategyDueForReview(broken, NOW)).toBe(true)
  })

  it('an aged healthy strategy is due; a fresh one is not', () => {
    const fresh = strat({ createdAt: NOW - 1_000, updatedAt: NOW - 1_000 })
    expect(strategyDueForReview(fresh, NOW, { baseMs: DAY })).toBe(false)
    const aged = strat({ createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY })
    expect(strategyDueForReview(aged, NOW, { baseMs: DAY })).toBe(true)
  })
})

describe('review record bookkeeping (store)', () => {
  it('records strategy and experience reviews through the store', async () => {
    const { ctx, teardown } = await pipelineHarness({ autoAccumulate: false })
    try {
      const service = ctx.cognitivePipeline
      service.solidifyStrategy({
        goalDomain: '重启',
        action: 'bash 重启脚本并健康检查',
        verificationAnchor: 'curl 健康检查返回 200',
        preChecks: [],
      })
      const strategy = service.store.solidifiedStrategiesSnapshot()[0]
      expect(strategy).toBeDefined()
      const reviewed = service.store.recordStrategyReview(strategy!.strategyId)
      expect(reviewed?.lastReviewedAt).toBeGreaterThan(0)
      expect(reviewed?.reviewCount).toBe(1)
      expect(reviewed?.updatedAt).toBeGreaterThanOrEqual(strategy!.updatedAt)

      const { expId } = await service.remember({ rawText: '清晨天气晴朗。晨跑五公里。精力充沛一整天。' })
      const expReviewed = service.store.recordExperienceReview(expId)
      expect(expReviewed.lastReviewedAt).toBeGreaterThan(0)
      expect(expReviewed.reviewCount).toBe(1)
    } finally {
      await teardown()
    }
  })
})

describe('strategy drift re-verification pass', () => {
  async function withBrokenStrategy(): Promise<{ ctx: Awaited<ReturnType<typeof pipelineHarness>>['ctx']; strategyId: string; teardown: () => Promise<void> }> {
    const { ctx, teardown } = await pipelineHarness({ autoAccumulate: false })
    ctx.cognitivePipeline.solidifyStrategy({
      goalDomain: '重启',
      action: '重启并健康检查',
      verificationAnchor: '健康检查通过',
      preChecks: [],
    })
    const strategy = ctx.cognitivePipeline.store.solidifiedStrategiesSnapshot()[0]
    // Force the validity ledger into "broken": a failed re-check flags rework
    // (which the due rule treats as always-due).
    ctx.cognitivePipeline.store.foldStrategyRecheck(strategy!.strategyId, false)
    return { ctx, strategyId: strategy!.strategyId, teardown }
  }

  it('folds a failed re-check into rework immediately and records the violation', async () => {
    const { ctx, strategyId, teardown } = await withBrokenStrategy()
    try {
      const s = ctx.cognitivePipeline.store.solidifiedStrategiesSnapshot().find(x => x.strategyId === strategyId)!
      expect(s.reworkNeeded).toBe(true)
      expect(s.violatedCount).toBe(1)
      // hitCount stays untouched — a re-check is not a use.
      expect(s.hitCount).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('a held re-check clears rework without touching counts', async () => {
    const { ctx, strategyId, teardown } = await withBrokenStrategy()
    try {
      ctx.cognitivePipeline.store.foldStrategyRecheck(strategyId, true)
      const s = ctx.cognitivePipeline.store.solidifiedStrategiesSnapshot().find(x => x.strategyId === strategyId)!
      expect(s.reworkNeeded).toBe(false)
      expect(s.violatedCount).toBe(1) // history kept
      expect(s.hitCount).toBe(0)
    } finally {
      await teardown()
    }
  })

  it('the review pass re-checks due strategies and refreshes their clock', async () => {
    const { ctx, strategyId, teardown } = await withBrokenStrategy()
    try {
      // Command execution off → re-check unverified, but the review still
      // records (clock refresh) and the cooldown protects from hammering.
      const summary = await ctx.cognitivePipeline.runStrategyReviewPass()
      expect(summary.reviewed).toBe(1)
      expect(summary.unverified).toBe(1)
      const s = ctx.cognitivePipeline.store.solidifiedStrategiesSnapshot().find(x => x.strategyId === strategyId)!
      expect(s.lastReviewedAt).toBeGreaterThan(0)
      expect(s.reviewCount).toBe(1)
      // Second immediate pass is held back by the re-check cooldown.
      const second = await ctx.cognitivePipeline.runStrategyReviewPass()
      expect(second.reviewed).toBe(0)
    } finally {
      await teardown()
    }
  })
})
