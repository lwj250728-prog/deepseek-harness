# Agent Note: Digital-life review scheduler v1 — activation bookkeeping + drift re-verification

Status: implemented

English | [中文](2026-09-03-review-scheduler-v1-activation-drift.zh.md)

## Problem

The memory programs had no review scheduler: experiences and solidified strategies were written once and never deliberately re-surfaced, so foundational or high-cost items could decay past usefulness ("nobody evaluates forgetting well" — the agent-memory survey gap), and a strategy whose environment had drifted could keep auto-injecting stale, now-wrong procedures at full activation.

## Decision

A v1 review scheduler ships in `cognitive-pipeline`, implementing the activation-regulator rule (see the [activation-regulator proposal](../../proposed/architecture/2026-09-03-review-scheduling-activation-regulator.md)):

- Bookkeeping: `Experience` and `SolidifiedStrategy` records carry optional `lastReviewedAt`/`reviewCount`; `store.recordExperienceReview`/`recordStrategyReview` refresh the activation clock and lengthen the next interval.
- Due rule (`review-schedule.ts`, exported): interval = baseMs × 2^reviewCount (capped 30 days); high-cost negative experiences (materialGain ≥ 6, energyCost ≥ 5) review earlier (×0.5); a rework-flagged strategy is ALWAYS due — the validity axis is orthogonal to activation.
- Drift re-verification (`runStrategyReviewPass`, on the offline-consolidation idle cadence): due strategies (cap 3/pass, ≥10 min cooldown per strategy) have their `verificationAnchor` re-checked — a real command run only when `acceptanceCommandExecution` is enabled AND the anchor reads as an ASCII command line; otherwise the re-check is unverified (clock refresh only, never a false "held"). `store.foldStrategyRecheck` folds the verdict: a failed re-check records one violation and flags rework immediately (the anchor no longer holds now — independent of the historical use ratio); a held re-check clears rework without touching counts; `hitCount` is never bumped — a re-check is not a use.
- Recall-as-use wiring: cognitive-inject records a review on every experience it actually injects (raw and pre-input-review paths) — a genuine retrieval and surfacing IS a use in the activation model, so the scheduler stops re-scheduling items the context still uses (the used item's clock refreshes; the due set naturally becomes the items NOT being used).

## Verification

`review-schedule.spec.ts` (12 green): interval growth with cap, last-review fallback, high-cost urgency, aged vs fresh due, interval lengthening after a review, always-due rework, and the pass behavior — failed re-check → rework + violation with hitCount untouched, held re-check clears rework, and the pass reviews due strategies and refreshes their clock while the cooldown holds back an immediate second pass. The pipeline's own full suite remains green apart from the operator's pre-existing WIP spec.

## Alternatives considered

- **Schedule by human review classes on a calendar**: rejected in the proposal — the activation rule explains the intervals instead of importing categories.
- **Run anchor commands unconditionally at idle**: rejected — command execution stays behind `acceptanceCommandExecution`; an unverifiable re-check records the review without a verdict rather than risking a false pass.

## Consequences

Foundational/high-cost memories now have a decay-aware re-review path and broken strategies get re-verified instead of auto-injecting stale procedure at full activation. Cost: the pass runs on the consolidation cadence (at most hourly by default), re-check verdicts are mostly "unverified" until command execution is enabled for the deployment, and experience-level extraction-practice drills (recalling without a matching input) remain future work — recall-as-use covers experiences the context still reaches, not idle drills.
