# @deepseek-ai/dsh-cognitive-pipeline

English | [中文](README.zh.md)

Prediction-error-driven dynamic cognition (DCA-PED) as a DeepSeek Harness plugin. It gives the agent an evolving experience memory: experiences are encoded as **Situation–Action–Result (SAR)** triplets, retrieved by action similarity, predicted with a **five-layer calibrated confidence interval**, corrected by **real feedback**, and periodically **re-clustered in utility space** — a rebuild only wins when a sandbox backtest proves a ≥15% error cut.

This package implements the DCA-PED design documents — `01-计划书.md` (technical plan), `02-技术报告.md` (TR-2026-08-11-V2.0), and the prompt library `03-提示词模板库.md` — as a self-contained Cordis plugin with a deterministic fallback for every model-assisted step.

## What the plugin does

```
输入(新经验) → remember_experience → SAR提取 → 向量化(action + outcome)
拟行动       → predict_outcome → 热环路: OOD检测 → 熟路(校准) / 陌路(临时工作区)
实际结果     → report_outcome → 误差计算 + 标签回填 → 校准统计 / 临时策略反馈 / 紧急局部修补
离线         → rebuild_taxonomy → 冷环路: 采样 → 效用聚类 → 因果锚定 → 沙盒回测 → 回写
会话         → cognition:taxonomy prompt section (认知框架摘要动态注入)
```

- **热环路 (hot loop)** — `predict_outcome`: retrieves the top-K similar past actions via **multi-channel fusion** (semantic action cosine + situational situation cosine + symptom-signature substring overlap + outcome-polarity priority for failure-flagged queries), with **feedback-learned channel weights** (persisted in `channel_weights.json`; EWMA from `|calibrated − observed|`, so "what similarity is transferable" grows from feedback rather than a fixed proxy). Novelty is judged on each hit's **strongest channel** (`channelMax`): a diluted semantic cosine does not declare history irrelevant when a situational or symptom channel strongly matches the same experience. It computes the OOD signals (`Top1 相似度 < 0.65`, `Top1-Top3 方差 < 0.1` (ambiguous, not near-exact), `Strangeness Index > 1.5`), and routes to the familiar path (five-layer calibration) or the novel path (scratchpad trial strategy with a `⚠️ 全新现象` marker). When the deterministic routing is low-confidence (thin taxonomy margin or flat-top), the **LLM refine pass** (template 7) reads the fused candidates and drops genuinely inapplicable top hits instead of blindly trusting the cosine ranking, bounded by `refineMaxDrops` (the advice marks it `检索复核`). Both branches additionally match the situation against proven success clusters and return the closest one as a `success_reference` strategy. Retrieval also **consults the taxonomy** (`taxonomy_context`): the query situation is scored against every cluster's situation centroid, reporting whether SAR has coverage there (`covered` / `gap` / `no-taxonomy`), the routed cluster, and the routing margin (best-minus-second-best cosine). A thin margin surfaces as `路由置信低` in the advice, telling the model its deterministic routing is unreliable — the pipeline's structural self-knowledge feeds the retrieval decision.
- **五层校准 (five-layer calibration)** — frequency-prior prompt injection, sample-size shrinkage `P_cal = (k/(k+50))·P_raw + (50/(k+50))·0.5`, minimum-width 80% confidence interval, adversarial risk-factor listing, and lifetime bucket correction against empirical accuracy. The prior counts only experiences with a net-positive or net-negative utility score; neutral 5/5/5 experiences are excluded from both counts.
- **临时工作区 (episodic scratchpad)** — OOD actions create `temp_strategies` with a 24 h TTL; matching reuses them; ≥3 hits with ≥66.7% positive feedback graduate them into the next rebuild as label seeds. **主动探索 (active exploration, scheme 2)** disciplines this: a novel scratchpad creation counts against a daily curiosity budget (`exploreDailyBudget`) only when the action is **reversible** (safety gate: irreversible markers like 删除/发布/推送 in `exploreRiskWords` never consume budget), the advice names the budget (`主动探索（今日预算 n/N）`, or `探索预算已耗尽` / `动作不可逆`), and the outcome is tracked (`exploration.json`): graduated strategies are successful explorations, expired ones are failures — an inspect-visible ROI ledger. The ROI ledger is then **validated in practice**: every later prediction that reuses a scratchpad folds its real-world `|calibrated − observed|` error back into the entry's `validatedError` (EWMA, `exploreValidationLearningRate`); the entry flips `validated`/`refuted` once that EWMA clears or crosses `exploreValidationErrorThreshold`. Graduation says a strategy *became* memory; validation says reusing it actually *reduced prediction error* — closing the meta-cognition loop on the same ruler as every other prediction.
- **模拟经验 (simulated experiences)** — `simulate_experience` generates a retrieval-only, unverified candidate via the LLM route when real testing is costly or impossible. It shapes no cluster until real feedback verifies it under the **evidence-replacement model**: a decisive single feedback fast-tracks to provisional, cumulative evidence upgrades to verified, contradiction at provisional rolls back, and unverified simulations expire after the fallback TTL. This mirrors human reality monitoring — mental rehearsal advises but does not become memory until the real thing is done.
- **元认知环路 (meta-cognition loops, 造新环路)** — the reusable abstraction behind the special-experience layers built so far (policy:* delegation decisions, active exploration, exploration validation): a **named loop** is a declarative decision stream whose choices flow through the SAME `predict`/`report` calibration ruler as every prediction. Register a loop (`register_loop` tool or `ctx.cognitivePipeline.registerLoop`), then drive it with `decideLoop`/`feedbackLoop` — the loop's situation carries a `loop:<name>` prefix, so its decision history forms its own retrievable, aggregable special-experience layer. `inspect_memory` reports per-loop prediction/resolved counts and average `|calibrated − observed|` error, so a newly declared "when to X" decision (compact, retry, ask the user) is learnable instead of hard-coded — the third layer's 意志 measured on the same ruler as the first. A loop can go further and **act**: registering `MetaLoopSpec.execution` (a list of `LoopExecutionSink`s) turns it into a decision-to-execution bridge. A sink is an execution-layer endpoint that accepts `LoopExecutionRequest`s and applies them **under its own discipline** — the loop only approves, the sink decides whether to actually execute (budget, safety gates, reversibility), and refuses with a reason string when it will not. `decideAndExecute(name, decision, situation, threshold?)` runs one decision and, when the calibrated probability clears the threshold, submits it to every declared sink, returning one execution receipt per sink. The built-in `createExplorationSink()` (`hot-engine.explore-create`) is a ready-made example: it enforces the active-exploration safety gate and daily budget and, on acceptance, creates the scratchpad and exploration entry (dedup-first against the entry the predict call itself may already have created) and optionally queues an autonomous task — 意志提交申请，执行层按纪律受理, so a new loop genuinely drives execution instead of only advising.
- **参考经验 (reference experiences)** — `reference_experience` is the second cold-start source: instead of simulating a hypothetical outcome, it retrieves the most similar real history, asks the LLM route to extract their **shared pattern** ("这类情境通常如何解决"), and writes that generalization as a retrieval-only simulated candidate with the same evidence-replacement lifecycle. It generalizes from what already happened rather than guessing what might; a derivation is rejected deterministically (no LLM call) when no anchor survives the filters (dissimilar below `referenceMinSimilarity`, or only simulated experiences present), so a reference is never fabricated from nothing.
- **冷环路 (cold loop)** — `rebuild_taxonomy`: decay-weighted sampling `W = e^(−λ·Δt)` of high-error experiences **plus proven successes** (utility score ≥ `successUtilityThreshold`), agglomerative clustering on **outcome utility vectors** (utility-first, not semantic), LLM causal anchoring with a hard ≥3-evidence constraint (backend-verified pairwise distance ≤ 0.85, hallucinated clusters rejected; the deterministic fallback groups pass the *same* evidence gate before write-back — a rejected cluster is never resurrected), and a sandbox backtest on the newest 20%. The reconstruction prompt anchors on **situation–strategy recurrence patterns**, so premise differentiation (e.g. the same action under a novice-teaching premise vs an expert-direct premise) **emerges from accumulation** without any hardcoded actor/environment fields — a pattern needs ≥3 in-sample instances to form its own cluster. The reconstruct route is stochastic, so a draw that yields nothing verified is retried up to `reconstructRetries` extra times. Acceptance measures the **continuous material-gain axis** — the taxonomy's predicted utility versus each experience's real gain (normalized to [0,1]) — aligning the acceptance metric with the pipeline's first-principle `|calibrated − observed|` error rather than a 0/1 polarity bucket. Acceptance has **two regimes**: a first build (no stored clusters) compares against the empty-view baseRate baseline and is accepted when it is not measured worse (`Δerr ≤ 0`), because the 15% margin is statistically meaningless on a young store's 2-3 sample validation slice and would block cold start; iteration keeps the `Δerr ≤ −0.15` bar against the existing taxonomy. When the labeled validation slice falls below `minValidationCount` the rebuild **defers** with a diagnosable reason instead of rejecting on merit. Experiences with a real material-gain label (resolved ones after feedback-backfill) participate in the denominator; unverified simulated experiences never enter the sample — only verified or provisional samples may shape clusters. Each accepted cluster carries a `success`/`risk` polarity and a **situation centroid derived from its evidence experiences** (not from every outcome-similar member, which would dilute premise-differentiated centroids into a mixture), and the taxonomy rules are annotated with it. Structured LLM template calls (SAR/OOD/calibration/reconstruction) explicitly request `reasoningEffort: off` — chain-of-thought would consume the small token budgets and starve the JSON answer.
- **动态认知摘要** — an accepted rebuild compresses into a taxonomy summary injected into the session system prompt (附录B), so the model's hot-loop advice reflects what the pipeline has learned.

## Quick start

Compose the plugin (it is already wired into the `web` profile):

```yaml
- id: cognitive-pipeline
  name: '@deepseek-ai/dsh-cognitive-pipeline'
  config:
    root: !!js dshHomePath('cognitive-pipeline')
    # Optional LLM assists: SAR extraction, OOD review, calibration,
    # reconstruction. When omitted (or when the route is unreachable), every
    # step degrades to deterministic math.
    provider: deepseek
    model: deepseek-v4-flash
```
The model can then use the seven tools:

- `remember_experience` — encode a raw experience into SAR memory (utility fields are required; a partial extraction degrades to the fallback instead of a fake neutral score).
- `simulate_experience` — generate a retrieval-only simulated experience via the LLM route when real testing is costly or impossible.
- `reference_experience` — generalize the common pattern of the most similar history into a retrieval-only reference candidate (cold-start online generalization); rejected when no similar anchor exists.
- `predict_outcome` — calibrated prediction with an 80% interval; returns a `prediction_id` and, when the situation matches a proven success cluster, a `success_reference` strategy.
- `report_outcome` — feed the actual outcome back with a **required** `outcome_quality` (0–10), which updates calibration stats, folds the quality back into the bound experience's utility label, drives simulated-experience verification, and may trigger an emergency local repair.
- `rebuild_taxonomy` — run the cold loop (`scope: local | global`).
- `inspect_memory` — read experiences, clusters, calibration buckets, and the taxonomy summary.

## Service API

Loading the plugin provides `ctx.cognitivePipeline`:

```ts ignore-check
ctx.cognitivePipeline.remember({ rawText })                       // → { expId, sar }
ctx.cognitivePipeline.simulate({ situation, action })            // → { expId, sar } (simulated)
ctx.cognitivePipeline.deriveReference({ situation, action })     // → { expId, sar } (simulated) | null
ctx.cognitivePipeline.predict({ situation, action, context? })   // → PredictResult
ctx.cognitivePipeline.report({ predictionId, actualOutcome, outcomeQuality }) // → FeedbackResult
ctx.cognitivePipeline.rebuild('local' | 'global')                // → RebuildResult
ctx.cognitivePipeline.inspect()                                  // → InspectResult
ctx.cognitivePipeline.taxonomyPrefix()                           // → prompt prefix text
ctx.cognitivePipeline.store                                      // → CognitiveStore (public)
// meta-cognition loops
ctx.cognitivePipeline.registerLoop(spec)                         // → void (spec may declare execution: LoopExecutionSink[])
ctx.cognitivePipeline.decideLoop(name, decision, situation)      // → PredictResult (decision only)
ctx.cognitivePipeline.feedbackLoop(name, predictionId, actualOutcome, outcomeQuality) // → FeedbackResult
ctx.cognitivePipeline.decideAndExecute(name, decision, situation, threshold?) // → { decision, approved, executions }
ctx.cognitivePipeline.createExplorationSink()                    // → LoopExecutionSink ('hot-engine.explore-create')
ctx.cognitivePipeline.loopList()                                 // → readonly MetaLoopSpec[]
```

Every method accepts an optional `{ sessionId?, signal? }` call context used for LLM-assisted steps. All persisted state lives under `root` (`experiences.jsonl`, `predictions.jsonl`, `temp_strategies.jsonl`, `clusters.json`, `calibration.json`, `taxonomy.json`).

## Configuration

All fields optional; engine defaults follow the design documents.

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | `<dshHome>/cognitive-pipeline` | Store directory |
| `provider` / `model` | unset | Explicit LLM route (both or neither) |
| `enabled` | `true` | False keeps the service but skips tool registration |
| `topK` | `10` | Hot-loop retrieval depth |
| `oodSimThreshold` | `0.65` | OOD low-similarity threshold |
| `oodFlatThreshold` | `0.1` | OOD flat-top spread threshold |
| `oodSiThreshold` | `1.5` | OOD strangeness-index threshold |
| `tempStrategyTtlMs` | `86_400_000` | Scratchpad TTL |
| `tempStrategyHitThreshold` | `3` | Graduation hit count |
| `tempStrategyPositiveRatio` | `0.667` | Graduation positive ratio |
| `tempStrategyMatchThreshold` | `0.5` | Scratchpad fuzzy-match cosine |
| `shrinkageAlpha` | `50` | Layer-2 ignorance-prior strength |
| `minConfidenceIntervalWidth` | `0.2` | Minimum 80%-interval width |
| `successReferenceThreshold` | `0.4` | Situation-cosine threshold for returning a success-cluster reference |
| `coverageThreshold` | `0.3` | Situation-centroid cosine below which the taxonomy is considered uncovered (taxonomy_context) |
| `retrievalFailureMargin` | `0.1` | Routing margin below which a known-path prediction is SAR-ized as a retrieval-failure meta experience |
| `decayLambda` | `0.01` | Cold-loop time decay per day |
| `minDecayWeight` | `0.1` | Minimum decay weight to sample |
| `predictionErrorThreshold` | `0.3` | PE needed to join the rebuild sample |
| `successUtilityThreshold` | `3` | Utility-score threshold admitting proven successes to the rebuild sample |
| `maxSampleRatio` | `0.15` | Cold-loop sample cap (32-sample floor) |
| `evidenceMinCount` | `3` | Evidence hard-constraint minimum |
| `evidenceMaxDistance` | `0.85` | Evidence pairwise distance cap |
| `sandboxImprovement` | `0.15` | Required validation error reduction for rebuilds against an existing taxonomy (iteration); a first build with no stored clusters accepts on non-worsening (`Δerr ≤ 0`) |
| `validationRatio` | `0.2` | Validation slice of the sampled set |
| `reconstructRetries` | `2` | Extra reconstruct draws when one stochastic LLM sample yields nothing verified |
| `minValidationCount` | `3` | Minimum labeled validation samples before a rebuild may be accepted; below this the rebuild defers instead of rejecting |
| `clusterMergeCosine` | `0.4` | Agglomerative merge cosine |
| `clusterMatchCosine` | `0.3` | Cluster-membership cosine |
| `emergencyErrorThreshold` | `0.8` | Feedback error triggering a local repair |
| `simulationFastTrackThreshold` | `0.8` | Evidence weight at/above which one feedback fast-tracks a simulation to provisional verified |
| `simulationPermanentThreshold` | `2` | Cumulative evidence score needed for permanent verified |
| `simulationTtlMs` | `2_592_000_000` | Fallback TTL (30 days) after which an unverified simulation expires |
| `autoAccumulate` | `false` | Automatically accumulate completed turns as experiences when the LLM route judges them worth it (pure chat never reaches the gate) |
| `exploreDailyBudget` | `3` | Active-exploration daily budget (scheme 2): how many reversible novel scratchpad creations count as exploration per day |
| `exploreRiskWords` | `['删除','清空','覆盖','发布','推送','rm','移除','迁移','重置','格式化']` | Irreversible-action markers; a novel attempt containing one is never counted as active exploration (safety gate) |
| `exploreAutoDispatch` | `false` | Queue an autonomous exploration task (`exploration_tasks.json`) for each budgeted reversible novel attempt; a scheduler session picks it up and writes the outcome back as an experience (conservative default: queueing only when explicitly enabled) |
| `exploreValidationLearningRate` | `0.3` | EWMA step folding a reused scratchpad's real-world prediction error into the exploration entry's `validatedError` |
| `exploreValidationErrorThreshold` | `0.3` | Prediction-error ceiling: a reuse error below it validates the exploration (paid off in practice), at/above it refutes it |
| `embedding` | unset | Real-embedding seam (roadmap R3): an OpenAI-compatible `/embeddings` object `{ baseUrl?, model?, apiKeyEnv?, apiKey? }` (defaults `https://api.deepseek.com` / `deepseek-embedding` / `DEEPSEEK_API_KEY`). When set, experiences store their action embedding at write time and the semantic retrieval channel prefers the embedding cosine; the hash-bag cosine serves queries/experiences without a vector, so the endpoint being unreachable only degrades similarity, never breaks the pipeline |
| `referenceTopK` | `5` | How many similar history hits anchor one reference derivation |
| `referenceMinSimilarity` | `0.3` | Minimum dual-axis similarity for a history hit to anchor a reference derivation (below it, or with only simulated hits, the derivation rejects without an LLM call) |
| `channelLearningRate` | `0.2` | EWMA step for the feedback-driven multi-channel retrieval weights |
| `channelErrorThreshold` | `0.3` | Feedback error below which the dominant retrieval channel is rewarded, at/above which it is penalized |
| `refineMaxDrops` | `2` | Bounded LLM-refine drops in one low-confidence prediction |

## Deterministic degradation

Every LLM step is a best-effort enhancement (附录C of the design):

- **SAR extraction** — sentence-split fallback with neutral utility when no route is configured or the call fails; both the LLM prompt and the fallback put observable failure symptoms (挂起/超时/编译失败…) into the situation, so a later similar failure is retrievable by its signature.
- **OOD review** — the math-only decision is trusted.
- **Calibration** — pure frequency prior with a wide interval.
- **Reconstruction** — deterministic cluster naming from utility means.

Failures are logged at `warn`; the pipeline never throws for model outages.

## Model Experience

### The seven model-facing tools

#### What the model sees

`remember_experience`, `simulate_experience`, `reference_experience`, `predict_outcome`, `report_outcome`, `rebuild_taxonomy`, and `inspect_memory` register with the tool registry (`ctx.tools.register` + `defineTool`); their schemas flow into the system-prompt tool catalog automatically, each tool returns one canonical JSON value mirrored into model-facing text by `output.render`, and the tool descriptions defined in `src/tools.ts` are the only static prompt text this package owns (surfaced in the generated [tool catalog](../../../docs/tool-catalog.md)).

#### Token effect

Conditional, model-invoked: tool schemas and descriptions add fixed tokens to every request once registered, the returned JSON is appended to the turn when the model calls a tool, and `predict_outcome` also emits auxiliary LLM calls (SAR/OOD/calibration) that never enter the session prompt.

#### KV Cache effect

The tool schema/description prefix is stable between rebuilds — an accepted taxonomy rebuild rewrites the `cognition:taxonomy` section below, which is the package-owned change that can invalidate prefix reuse.

### The `cognition:taxonomy` system-prompt section

#### What the model sees

A dynamic system-prompt section (order 300) rendered from the current taxonomy: before any rebuild it states the system is in cold start, and after an accepted rebuild it renders the summary plus the top-5 decision rules (附录B prefix), with the full literal produced by `cognitionPrefix()` in `src/prompts.ts`.

#### Token effect

Conditional, small and bounded: roughly 150–400 tokens depending on the number of rules (max 5), present in every request of every session that mounts the plugin.

#### KV Cache effect

Replacing: the section text is re-rendered per assembly from store state and changes whenever `rebuild_taxonomy` accepts a new taxonomy (version bump), which invalidates prefix reuse for the host's cache; the tool catalog section is unaffected.

## Known Limitations and Deferred Work

- **Embedding seam is action-only and write-time** — the real-embedding channel (roadmap R3) embeds the action text at write time and prefers the embedding cosine at retrieval; experiences written before the seam was enabled have no vector (hash fallback), and the situational/symptom/outcome channels remain hash-based. A lazy backfill for pre-seam experiences is deferred.
- **Per-cluster cumulative error is not tracked online** — `cumPredictionError` is recomputed at write-back from member errors; the design's per-cluster error accumulator that triggers a local repair mid-lifecycle is only approximated by the emergency feedback threshold.
- **No scheduled cold loop** — the design's daily/weekly scheduler is a manual `rebuild_taxonomy` call today; a timer-driven row (e.g. via `@deepseek-ai/cordis-plugin-timer`) is future work.
- **No PostgreSQL/pgvector backend** — the store is JSONL+JSON files; the design's pgvector single-store plan is deferred until a scale need appears.
- **Single pipeline instance** — one store per plugin mount; multi-tenant or per-agent stores are not supported.
- **Observed outcome quality** — feedback now requires the model to supply `outcome_quality` (0–10); the pipeline no longer infers a neutral baseline from outcome text, so unresolved quality is a loud tool error rather than a silent 0.5.
