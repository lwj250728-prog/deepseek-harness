# Agent Note: driving-force mechanisms — variance ledger, disequilibrium gate, and variant candidates

Status: implemented

English | [中文](2026-08-19-driving-force-mechanisms.zh.md)

## Problem

The [SAR principle review](../../proposed/architecture/2026-08-19-sar-principle-review.md) found that the pipeline assimilates every anomaly as noise: `outcomeUtility` is a single-point self-report, prediction error is only booked, and nothing ever asks whether a recorded step can be improved. Its driving-force framework demands four mechanisms — variance perception, disequilibrium detection, variant generation, iterative convergence — with the motive anchored on the task stream (dissatisfaction) and the settlement stream (variance), never on invented goals.

## Decision

Three of the four mechanisms ship as one chain on the existing store, each consuming the previous one's output.

**1. Settlement variance ledger.** `Experience.settlements` appends one raw-quality sample (`SettlementSample{ts, quality}`) per resolved prediction that carries an outcome quality. The distribution over samples is the variance measure; the single-point utility label stays untouched as the clustering input. Sampling is conservative: a settlement without a quality never appends, so the ledger holds only real execution results.

**2. Disequilibrium gate.** `disequilibriumOf` judges a new sample against the prior distribution: `z = |q − μ|/σ` with at least `disequilibriumMinSamples` (default 3) prior samples and `z ≥ disequilibriumZThreshold` (default 2) flags the experience with `DisequilibriumEvent{atTs, sampleQuality, zScore}`. A degenerate prior (σ = 0) never judges. The gate is the explicit alternative to default assimilation: a flagged experience is an accommodation candidate, not a noise attribution. Both thresholds are validated config fields on the hot engine.

**3. Variant candidates.** `generateStrategyVariants(strategyId)` runs the template-8 LLM route over a rework-flagged strategy's action, verification anchor, and pre-checks, producing up to three `VariantCandidate`s that perturb one step or parameter while keeping the anchor unchanged — the anchor is the test, the variant is the revised procedure. Candidates enter the `variants` table as `proposed` and carry a settlement list for the iterative-convergence gate. Without an explicit route the generation deterministically returns zero candidates: no model, no invented variants. Trigger wiring: `settleInjectionCitations` folds strategy usage, and a newly-crossed `reworkNeeded` flag (was clean, now flagged) triggers generation best-effort, wrapped in a try/catch so a failed generation never breaks settlement.

**4. Iterative convergence.** `variantConvergence` is the conservative graduation gate over a candidate's real-use settlement distribution: fewer than `minSamples` (default 3) never judge; adoption requires a high mean (≥ 7) with no low outlier (all samples ≥ 6); rejection requires a clearly poor mean (≤ 4); anything between keeps testing. `settleVariant(variantId, quality)` appends a sample, moves the candidate into `testing`, and runs the gate; a terminal candidate (adopted/rejected) is immutable and ignores further settles. Automatic feedback: `report` folds a matched reported action into its non-terminal candidates (hash-bag cosine at/above the temp-strategy match threshold) — a variant is tested by being actually executed, not by fiat. Adoption marks the candidate; replacing the underlying strategy is a separate, explicit decision left to callers.

The inspect aggregate (`InspectResult.settlement` + `variants`) exposes the ledger coverage and the candidate lifecycle counts; the `inspect_memory` tool schema carries them.

## Alternatives considered

**Generate variants without a route (deterministic fallback).** Rejected: a deterministic variant generator would either template-rephrase (worthless, the prompt explicitly forbids pure rewording) or invent perturbations without model judgment. The empty-degradation keeps the pipeline's best-effort-over-safe-fallback contract.

**Wire generation to the experience-level disequilibrium flag.** Rejected: an experience carries no verification anchor, so a variant would have no machine-checkable test. The strategy-level anchor (already a drift sensor) is the only place where "variant succeeds" is mechanically decidable today. Experience-level accommodation remains unshipped.

**Keep the lifecycle one-shot (exploration ROI).** Rejected: mechanism 3 only opens the door; mechanism 4 closes it with a conservative multi-round convergence gate, so a variant graduates only from real-use evidence, never from a single run.

## Consequences

- The pipeline can now perceive result variance (mechanism 1), detect a shifted distribution (mechanism 2), generate structured revisions for a failing strategy (mechanism 3), and graduate a revision only from converging real-use evidence (mechanism 4) — the accommodation half of the farmer analogy is no longer structurally absent.
- Every real `predict → report` cycle with a quality now feeds the ledger; the first live sample landed on `exp_121` from a real prediction in the working session.
- The deviation gate of solidified strategies gains an action: crossing `reworkNeeded` now spawns candidates instead of silently flagging, and a candidate that keeps succeeding in real use converges to `adopted`.
- Costs: one new table (`variants.json`), one prompt template (template 8), three config fields, and the invariant checks for both new shapes. The trigger is LLM-route-dependent by design — in deployments without a route, rework flags without generating, which is the safe degradation.
