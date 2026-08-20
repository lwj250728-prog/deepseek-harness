# Agent Note: Feedback folds result quality back into the experience label

Status: implemented

English | [中文](2026-08-18-feedback-folds-result-quality-into-experience-label.zh.md)

## Problem

The cold loop was correctly deferring on the real store — but the diagnosis surfaced a deeper break in the feedback loop. `report_outcome` computed the prediction error from `outcome_quality` and wrote it back to the bound experience, yet the quality itself was discarded: `resolvePrediction` updated only `predictionError` and `cumulativeError`, never `sar.outcomeUtility`. Experiences resolved with high confidence about their result quality therefore stayed at the neutral 5/5/5 recorded at `remember` time. Measured: exp_9 and exp_14 carried 0.2–1.8 accumulated prediction error with neutral utility — "predicted wrong, quality known" experiences the cold loop's labeled-validation gate then correctly refused to cluster.

## Decision

**`resolvePrediction` accepts an optional result quality and folds it into the bound experience's utility.** The single quality axis maps to material gain (`5 + (q-5)*0.8`, clamped to [0,10], one decimal); emotional valence and energy cost are not conveyed by a single quality score, so they keep their recorded values. A neutral 5/5/5 experience gains a real label on the first resolved prediction (q=8 → materialGain 7.4; q=2 → 2.6). `service.report` passes `input.outcomeQuality` through. When quality is absent the label is untouched.

## Alternatives considered

**Map quality to all three utility axes.** Rejected: a single 0–10 quality score conveys overall result quality, not the gain/valence/cost split; inventing values for axes the feedback does not carry would fabricate clustering signal.

**Keep quality only in the prediction log.** Rejected: that is the exact break observed — the error propagates but the label does not, leaving cold-loop sampling blind to resolved outcomes.

**Write a separate label field instead of reusing `outcomeUtility`.** Rejected: the utility vector is already the clustering axis and the sampling filter's `successUtilityThreshold`; a second label source would split the store's one authority.

## Consequences

Resolved experiences carry a real material-gain label derived from feedback, so the cold loop's labeled-validation gate sees them and the clustering axis reflects verified outcomes rather than initial extraction. `report_outcome`'s model-visible behavior is unchanged (the quality was already required); the backfill is a store-level write. Known limits retained: the mapping is a linear heuristic from one quality axis to one utility axis. The acceptance side of the loop is covered by the [cold-loop acceptance note](2026-08-18-cold-loop-acceptance-first-build-and-deferral.md): the labeled-validation gate and the continuous `|calibrated − observed|` acceptance axis both consume the material-gain labels this backfill produces.
