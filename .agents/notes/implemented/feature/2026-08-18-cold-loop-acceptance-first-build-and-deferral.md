# Agent Note: Cold-loop acceptance mechanism — first-build baseline and deferral

Status: implemented

English | [中文](2026-08-18-cold-loop-acceptance-first-build-and-deferral.zh.md)

## Problem

The cold loop never accepted a rebuild: the store sat at 0 clusters and taxonomy version 0 despite 18 resolved predictions. Two mechanism defects caused it, and the second hid the first:

- **First-build deadlock (latent).** `runRebuild` accepted a proposal with `oldError === null ? newError <= 1e-9 : deltaError <= -0.15`. The `newError <= 1e-9` branch exists for the no-old-taxonomy case, but in practice the first build's `oldError` is not null — `evaluateViews` with an empty view returns the pure baseRate error over the labeled validation (a finite number). The deadlock branch only triggers when the validation slice is entirely neutral, which yields `oldError === null`.
- **Undiagnosable zero-cluster state.** When validation had no labeled samples, the rebuild returned `reason: "无旧分类基线，跳过回写"` — a misleading message that hid the real cause: there were no labeled validation samples to judge anything. The observable state (0 clusters) gave no hint whether the mechanism was broken, the data insufficient, or the proposals bad.

## Decision

**A — first build compares against the empty-view baseline.** `runRebuild` computes `referenceError = oldError ?? evaluateViews(all, train, validation, [])` and accepts when `deltaError <= -sandboxImprovement` against it. The first cluster set therefore only needs to beat "guess the base rate" by the improvement margin, and the latent `newError <= 1e-9` deadlock branch is unreachable; a near-perfect reference (baseline or old taxonomy) still rejects rather than churning taxonomy versions.

**B — deferral is a first-class, diagnosable state.** A new `RebuildResult.deferred: boolean` distinguishes "postponed for insufficient labeled validation" from a merit rejection. Before clustering, `runRebuild` counts the validation samples carrying a real material-gain label; below the new `minValidationCount` config (default 3) it returns `deferred: true` with `reason: "验证样本不足（带标签 N 条 < M），暂缓重建"` and leaves the store untouched. The `rebuild_taxonomy` tool output carries `deferred` alongside `accepted`.

**C — acceptance measures the continuous utility axis, not 0/1 polarity.** `predictionsFor` predicts each validation experience's material-gain label (the nearest cluster's mean gain, normalized to [0,1]; base-rate gain when unmatched), and `evaluateViews` scores `|predicted − actual|` against the experience's real `materialGain / 10`. The rollback failure-promotion uses the same continuous axis. This aligns the acceptance metric with the pipeline's first-principle error `|calibrated − observed|`: the taxonomy is accepted when it predicts *utility magnitude*, not merely which polarity bucket an experience falls into. Experiences with a real material-gain label (resolved ones after the feedback-backfill) participate in the denominator; the deferral gate counts the same label axis.

## Alternatives considered

**Lower the first-build bar to "any cluster set accepted".** Rejected: accepting without a baseline comparison would write taxonomy for proposals no better than guessing; the empty-view baseRate reference keeps a real improvement threshold.

**Merge deferral into the existing rejection path.** Rejected: the whole point is diagnosability — "insufficient data" and "proposal failed validation" need different follow-up actions and different reasons; a boolean plus a distinct reason makes them separable by consumers and logs.

**Treat a neutral-heavy validation slice as "no information, skip silently".** Rejected: that is exactly the state that produced the misleading 0-cluster situation; surfacing it as a deferred state is the fix.

## Consequences

The cold loop now reports why it did not rebuild: with the current real store, the diagnosis changed from the misleading "无旧分类基线，跳过回写" to "验证样本不足（带标签 0 条 < 3），暂缓重建". The first-build acceptance path is exercised by a dedicated test (16 experiences, two utility families) that asserts a finite `oldError` baseline and `deltaError <= -0.15`; the continuous-axis metric has its own test (12 experiences, two gain families) that passes only when the taxonomy predicts utility magnitude. `minValidationCount` is a config field (default 3) per the no-hardcoded-tunables rule; the tool schema and README document the `deferred` output and the continuous acceptance axis.

Partially superseded by [2026-08-19-cold-loop-real-data-verification.md](2026-08-19-cold-loop-real-data-verification.md): its decision A relaxes the first-build margin from `Δerr ≤ −sandboxImprovement` to non-worsening (`Δerr ≤ 0`) against the empty-view baseRate baseline, because the 15% margin is statistically meaningless on a young store's 2-3 sample validation slice; the baseRate baseline reference and the deferral design stay in force.
