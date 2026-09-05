/**
 * Review-scheduling predicates: the activation-regulator rule (see
 * .agents/notes/proposed/architecture/2026-09-03-review-scheduling-activation-regulator.md).
 * An item is due for review when its activation is predicted to have dropped
 * below the activation needed for its importance — approximated v1 as:
 *   elapsed since the last review (or creation) ≥ baseMs · 2^reviewCount ·
 *   urgency, where urgency ≤ 1 for high-cost items (negative, high-gain
 *   experiences) and a rework-flagged strategy is ALWAYS due (the validity
 *   axis — activation is orthogonal to correctness, and a broken strategy
 *   must be re-verified regardless of its activation).
 */

import type { Experience, SolidifiedStrategy } from './types.ts'

/** Default base review interval (ms) for an item reviewed for the first time. */
export const REVIEW_BASE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Interval growth per review: interval = baseMs · 2^reviewCount. */
export const REVIEW_GROWTH = 2

/** Ceiling so a heavily reviewed item is never scheduled less often than this. */
export const REVIEW_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

/** Urgency multiplier for high-cost (negative, high-gain) experiences: they
 * may not sink as low before review (interval × factor, factor ≤ 1). */
export const REVIEW_NEGATIVE_URGENCY = 0.5

/** The pure shape the predicates read (kept structural so callers can test
 * with minimal fixtures; the store records satisfy it). */
export interface ReviewableExperience {
  readonly expId: string
  readonly timestamp: number
  readonly lastReviewedAt?: number
  readonly reviewCount?: number
  readonly sar: { readonly outcomeUtility: {
    readonly materialGain: number
    readonly emotionalValence: number
    readonly energyCost: number
  } }
}

/** The pure shape of a strategy for the due predicate. */
export interface ReviewableStrategy {
  readonly strategyId: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastReviewedAt?: number
  readonly reviewCount?: number
  readonly reworkNeeded: boolean
}

/** Options controlling the schedule (tests override; defaults are the rule). */
export interface ReviewScheduleOptions {
  /** First-review interval (default 24 h). */
  baseMs?: number
  /** Interval ceiling (default 30 days). */
  maxMs?: number
  /** High-cost urgency factor (default 0.5). */
  negativeUrgency?: number
}

/** Resolve the schedule options to concrete numbers. */
export function resolveScheduleOptions(options: ReviewScheduleOptions = {}): Required<ReviewScheduleOptions> {
  return {
    baseMs: options.baseMs ?? REVIEW_BASE_INTERVAL_MS,
    maxMs: options.maxMs ?? REVIEW_MAX_INTERVAL_MS,
    negativeUrgency: options.negativeUrgency ?? REVIEW_NEGATIVE_URGENCY,
  }
}

/** The item's last activation-refresh moment (review, else creation). */
export function lastReviewOrCreation(item: { timestamp?: number; createdAt?: number; lastReviewedAt?: number }): number {
  return item.lastReviewedAt ?? item.createdAt ?? item.timestamp ?? 0
}

/** Interval for an item given its review count, capped at the ceiling. */
export function reviewInterval(reviewCount: number, baseMs: number, maxMs: number): number {
  const interval = baseMs * Math.pow(REVIEW_GROWTH, reviewCount)
  return Math.min(interval, maxMs)
}

/** Whether a (negative) outcome reads as high-cost: material loss ≥ 6 and
 * energy spent ≥ 5 — forgetting a costly failure is more dangerous than
 * forgetting a mild one. */
export function isHighCost(utility: ReviewableExperience['sar']['outcomeUtility']): boolean {
  return utility.materialGain >= 6 && utility.energyCost >= 5
}

/**
 * Whether an experience is due for review under the activation rule.
 * @param exp - the experience (structural).
 * @param now - reference time.
 * @param options - schedule options.
 * @returns true when a review should run now.
 */
export function experienceDueForReview(
  exp: ReviewableExperience,
  now: number,
  options: ReviewScheduleOptions = {},
): boolean {
  const resolved = resolveScheduleOptions(options)
  const since = now - lastReviewOrCreation(exp)
  if (since < 0) return false
  const urgency = isHighCost(exp.sar.outcomeUtility) ? resolved.negativeUrgency : 1
  const interval = reviewInterval(exp.reviewCount ?? 0, resolved.baseMs, resolved.maxMs) * urgency
  return since >= interval
}

/**
 * Whether a solidified strategy is due for drift re-verification. A
 * rework-flagged strategy is ALWAYS due — the validity axis is orthogonal to
 * activation, and a strategy that has started failing must be re-verified
 * regardless of how recently it was reviewed.
 * @param strategy - the strategy (structural).
 * @param now - reference time.
 * @param options - schedule options.
 * @returns true when a re-verification review should run now.
 */
export function strategyDueForReview(
  strategy: ReviewableStrategy,
  now: number,
  options: ReviewScheduleOptions = {},
): boolean {
  if (strategy.reworkNeeded) return true
  const resolved = resolveScheduleOptions(options)
  const since = now - lastReviewOrCreation(strategy)
  if (since < 0) return false
  const interval = reviewInterval(strategy.reviewCount ?? 0, resolved.baseMs, resolved.maxMs)
  return since >= interval
}

/** Convenience: due predicates over the store's own record types. */
export function experienceRecordDue(exp: Experience, now: number, options: ReviewScheduleOptions = {}): boolean {
  return experienceDueForReview(exp as ReviewableExperience, now, options)
}

export function strategyRecordDue(
  strategy: SolidifiedStrategy,
  now: number,
  options: ReviewScheduleOptions = {},
): boolean {
  return strategyDueForReview(strategy as ReviewableStrategy, now, options)
}
