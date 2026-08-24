# @deepseek-ai/dsh-cognitive-pipeline

Prediction-error-driven dynamic cognition (DCA-PED) as a DeepSeek Harness plugin. It gives the agent an evolving experience memory: experiences are encoded as **Situation–Action–Result (SAR)** triplets, retrieved by action similarity, predicted with a **five-layer calibrated confidence interval**, corrected by **real feedback**, and periodically **re-clustered in utility space** — a rebuild only wins when a sandbox backtest proves a ≥15% error cut.

This package is a self-contained, npm-publishable form of the plugin, shipped together with the original design documents under [`docs/`](docs/README.md).

## What it does

- **Hot loop** — `predict_outcome`: top-K retrieval, OOD detection (`Top1 相似度 < 0.65`, `Top1-Top3 方差 < 0.1` (ambiguous), `Strangeness Index > 1.5`), routing to the familiar path (five-layer calibration) or the novel path (episodic scratchpad with a `⚠️ 全新现象` marker).
- **Five-layer calibration** — frequency-prior prompt injection, sample-size shrinkage `P_cal = (k/(k+50))·P_raw + (50/(k+50))·0.5`, minimum-width 80% confidence interval, adversarial risk-factor listing, lifetime bucket correction.
- **Cold loop** — `rebuild_taxonomy`: decay-weighted sampling `W = e^(−λ·Δt)`, agglomerative clustering on **outcome utility vectors**, LLM causal anchoring with a hard ≥3-evidence constraint (backend-verified), sandbox backtest requiring `Δerr ≤ −0.15` before atomic write-back.
- **Feedback loop** — `report_outcome`: prediction error, calibration stats, scratchpad graduation, emergency local repair.
- Every model-assisted step degrades to deterministic math when no LLM route is configured.

## The driving-force mechanisms (v0.1.0-rc.6)

Beyond the original predict/rebuild loops, the pipeline now ships the four-mechanism driver framework that grew out of the [SAR principle review](docs/sar-principle-review.md): the pipeline perceives result variance, detects when a recorded strategy's result distribution shifts, generates structured revisions, and graduates a revision only from converging real-use evidence.

| Mechanism | What it does | Entry point |
| --- | --- | --- |
| 1. Settlement variance ledger | Each quality-carrying `report_outcome` appends a raw sample to the bound experience; the distribution over samples is the variance measure | `Experience.settlements` |
| 2. Disequilibrium gate | A sample deviating ≥ `disequilibriumZThreshold` σ from a ≥ `disequilibriumMinSamples`-sample prior flags the experience as an accommodation candidate | `disequilibriumOf` |
| 3. Variant candidates | A strategy whose deviation gate newly crosses `reworkNeeded` gets LLM-generated single-step perturbations that keep the verification anchor unchanged | `generateStrategyVariants` |
| 4. Iterative convergence | A candidate graduates to `adopted` only when ≥3 real-use samples show a high mean with no low outlier; clearly poor means reject | `variantConvergence` / `settleVariant` |

Goal-anchored chains (`remember_experience` with `chain_id`, `consolidate_chain`, `explore_chain`, `rebuild_cognition_object`) record causal skeletons across executions; acceptance criteria and claim audits (`define_acceptance_check`, `verify_claim`) gate claims with machine-checkable evidence; the trigger-jump lexicon (`learn_trigger_jumps`) learns which words open the injection gate. Design rationale lives in [`docs/`](docs/README.md).

## Install

### As a DeepSeek Harness plugin (npm)

Once published, install and enable it in any dsh profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-cognitive-pipeline
```

This adds the package to the profile manifest and runs its pnpm install; the profile's patch layer then references it:

```yaml
# <dshHome>/profiles/web/cordis.patch.yml
- insert:
    - id: cognitive-pipeline
      name: '@deepseek-ai/dsh-cognitive-pipeline'
      config:
        root: !!js dshHomePath('cognitive-pipeline')
        # Reuses the harness's own LLM route and credentials — no separate API
        # key. Omit provider/model (or leave the route unreachable) for
        # deterministic mode. See examples/cordis.patch.yml.
        provider: deepseek-official
        model: deepseek-v4-flash
```

Alternatively add it to any Cordis composition:

```sh
pnpm add @deepseek-ai/dsh-cognitive-pipeline
```

A ready-to-use patch snippet is in [`examples/cordis.patch.yml`](examples/cordis.patch.yml). The LLM route reuses the harness's own credentials (e.g. `DEEPSEEK_API_KEY`); nothing extra is configured on the plugin side.

### From source (development)

Copy this package into a DeepSeek Harness checkout and register it:

```sh
cp -r src <dsh>/packages/cognition/cognitive-pipeline/src
# then in the checkout: pnpm install && pnpm run build:lib:host
```

## Usage

The model gets five tools:

- `remember_experience` — encode a raw experience into SAR memory.
- `predict_outcome` — calibrated prediction with an 80% interval; returns a `prediction_id`.
- `report_outcome` — feed the actual outcome back (optional `outcome_quality` 0–10).
- `rebuild_taxonomy` — run the cold loop (`scope: local | global`).
- `inspect_memory` — read experiences, clusters, calibration buckets, taxonomy summary.

The plugin also provides the `ctx.cognitivePipeline` service and the dynamic `cognition:taxonomy` system-prompt section. See [`src/service.ts`](src/service.ts) for the exact service API.

## Configuration

All fields optional; engine defaults follow the design documents.

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | `<dshHome>/cognitive-pipeline` | Store directory (JSONL + JSON state files) |
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
| `decayLambda` | `0.01` | Cold-loop time decay per day |
| `minDecayWeight` | `0.1` | Minimum decay weight to sample |
| `predictionErrorThreshold` | `0.3` | PE needed to join the rebuild sample |
| `maxSampleRatio` | `0.15` | Cold-loop sample cap (32-sample floor) |
| `evidenceMinCount` | `3` | Evidence hard-constraint minimum |
| `evidenceMaxDistance` | `0.85` | Evidence pairwise distance cap |
| `sandboxImprovement` | `0.15` | Required validation error reduction |
| `validationRatio` | `0.2` | Validation slice of the sampled set |
| `clusterMergeCosine` | `0.4` | Agglomerative merge cosine |
| `clusterMatchCosine` | `0.3` | Cluster-membership cosine |
| `emergencyErrorThreshold` | `0.8` | Feedback error triggering a local repair |

## Compatibility

The shipped `lib/` is pre-built against DeepSeek Harness `0.1.0-rc.5` (the peer APIs this source is written against). When installed from npm, peers resolve to the published `@deepseek-ai/dsh-*` versions; if a peer's published API has drifted from that baseline, rebuild from a matching checkout instead:

```sh
npm run build   # emits ./build via the standalone tsconfig
```

## Tests

The test suite (`tests/`) drives the full loop with scripted LLM adapters and a real Cordis Loader smoke. It is most reliable inside a DeepSeek Harness checkout (which provides the exact peer APIs); in this package, `npm install` then `npm test` works when the installed peer APIs match.

## Documentation

- [`docs/README.md`](docs/README.md) — index of the DCA-PED design documents
- [`docs/01-计划书.md`](docs/01-计划书.md) — technical plan (V2.0)
- [`docs/02-技术报告.md`](docs/02-技术报告.md) — technical report TR-2026-08-11-V2.0
- [`docs/03-提示词模板库.md`](docs/03-提示词模板库.md) — production prompt library

## License

MIT — see [LICENSE](LICENSE).
