# Agent Note: SAR memory success anchors and neutral-experience exclusion

Status: implemented

English | [中文](2026-08-18-sar-success-anchors-and-neutral-exclusion.zh.md)

## Problem

The cognitive pipeline's SAR memory only produced learning signals on prediction errors, which in practice meant only bug-class failures accumulated high error and entered the cold loop. Two mechanisms made this structural. First, `isPositiveOutcome` is a binary `utilityScore > 0` test, so neutral 5/5/5 extractions were silently counted as *negative* in the hot-loop frequency prior (`samples.length - positive`), the cold-loop base rate, and the backtest labels — "no signal" masqueraded as "failed". Second, cold-loop sampling (`sample()`) admitted only errorful experiences (`predictionError >= threshold || cumulativeError > 0`), so proven successes never became clusters even though the design's utility-space clustering axis already favors them. The memory was degenerating into a bug library, and successful strategies were invisible to prediction.

## Decision

**Outcome polarity is now tri-state.** `outcomePolarity(utility)` returns `'positive' | 'neutral' | 'negative'` from the composite score sign; a zero score (including 5/5/5) is `neutral`. The hot-loop M/N prior counts only positive and negative experiences; the cold-loop base rate, backtest labels, and rollback failure-promotion all skip neutral experiences instead of scoring them as failures.

**The cold loop samples successes too.** `sample()` admits an experience when it is errorful **or** its `utilityScore` reaches the new `successUtilityThreshold` (default 3). Accepted clusters now carry a `polarity: 'success' | 'risk'` field (from the candidate's mean utility) and a `situationCentroid` (normalized centroid of member situation vectors). Taxonomy rules inherit the polarity, and the `cognition:taxonomy` prompt prefix renders rules with a `✅成功` / `⚠️风险` marker. The store load path normalizes legacy rows lacking the new fields.

**Prediction returns a success reference.** `predict_outcome` matches the current situation against success-cluster situation centroids (`successReferenceThreshold`, default 0.4) and returns the closest hit as `success_reference` (cluster id/name/rule/utility range), appended to the advice text as well. This answers "what proven strategy does this situation resemble" instead of only "will this fail".

**Feedback quality is mandatory and extraction is strict.** `report_outcome` requires `outcome_quality` (0–10); the pipeline no longer infers a neutral 0.5 baseline from outcome text. SAR extraction requires all three utility fields to be present and finite; a partial score degrades to the deterministic fallback (with a warn) rather than silently producing a fake 5/5/5.

## Alternatives considered

**Keep the binary polarity and lower the sampling threshold.** Rejected: lowering `predictionErrorThreshold` admits noise, not successes; it does not create a positive anchor axis. The tri-state split is the minimal change that stops neutral records from polluting both priors and backtests.

**Score successes through a separate "anchor" table.** Rejected: the design already clusters in utility space, so successes belong in the same cluster table with a polarity field; a second table would duplicate the cold loop.

**Return only the probability and let the model reason about success.** Rejected: the retrieval axis is action similarity, which does not surface situation-level success patterns; an explicit `success_reference` is what makes the memory actionable in novel situations.

**Keep `outcome_quality` optional with the LLM-extraction fallback.** Rejected: the fallback produced neutral 5/5/5 scores for routine tasks, which is exactly the signal collapse the fix targets. Mandatory quality makes success feedback observable at the tool boundary.

## Consequences

Neutral experiences no longer depress calibration priors or inflate backtest error; proven successes enter clustering and become referenceable strategies; the taxonomy summary distinguishes success from risk rules. `predict_outcome` gains a `success_reference` field, and `report_outcome` fails loudly without `outcome_quality`. On-disk `clusters.json` and `taxonomy.json` gain the `polarity` / `situationCentroid` fields with load-time normalization for legacy rows; the invariant now checks the situation-centroid dimension. The `successUtilityThreshold` and `successReferenceThreshold` config fields are deployment-tunable per the no-hardcoded-tunables rule. Known limitations retained: hashed bag-of-words vectors, no scheduled cold loop, single store instance.
