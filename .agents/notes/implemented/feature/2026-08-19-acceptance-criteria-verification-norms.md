# Agent Note: acceptance-criteria verification norms

Status: implemented

English | [中文](2026-08-19-acceptance-criteria-verification-norms.zh.md)

## Problem

The pipeline's online loops (`predict`/`report`) and offline loop (`rebuild`) calibrate predictions and cluster experiences, but nothing institutionalizes verification norms: the model can state a claim as settled without evidence, and the pipeline neither records the claim's audit, counts the violation, nor measures what skipping verification costs. The self-reference boundary makes this harder than it looks — the pipeline cannot judge the truth of its own claims, so a norm layer can only observe evidence **presence**, never evidence **quality** (a judge cannot grade its own testimony). The repository's own answer to institutionalized verification is executable gates (`AGENTS.md`: `test:coverage`, `verify-cordis-config`, `verify-agent-note-format`); the pipeline lacked the equivalent durable norm layer. The doc gates for this package had in fact not run since several earlier features shipped: the generated cordis catalog still showed a 12-method service, and the type-equivalence blocks predated the current `InspectResult`.

## Decision

The pipeline gains an acceptance-criteria capability: the `define_acceptance_check` / `verify_claim` / `update_acceptance_check` tools plus the service methods `defineAcceptanceCheck`, `auditClaim`, `updateAcceptanceCheck`, `acceptanceChecks`, and `claimAudits`, persisted in two new tables (`acceptance.json`, `claim_audits.jsonl`).

- An audit applies the active criteria whose trigger marker appears in the claim or its situation; a claim with no applicable check audits as `not-applicable` and touches no ledger. A check is satisfied when the claim carries evidence (non-empty) and violated when it does not — evidence presence, never truth.
- Criteria keep an append-only evidence ledger (invoked/passed/violated plus `cumulativeError`/`errorFoldCount`). `report()` folds the `|calibrated − observed|` of any resolved prediction whose audit violated criteria into those criteria — "claims made without verification" is measured on the same ruler as every prediction (验收回流).
- A criterion whose invoked count clears `acceptanceMinEvidenceCount` (default 3) while its deviation rate crosses `acceptanceDeviationThreshold` (default 0.5) flags `reworkNeeded` on the crossing audit and records one deviation meta experience, so the cold loop can cluster the pipeline's own acceptance-failure patterns.
- Criteria are revisable (`revision` bumps) but their track record is not; retiring a criterion freezes it — audits no longer apply it and its ledger is never reset (mirroring the frozen archived Agent Notes).
- `inspect_memory` reports the ledger (`checkCount`/`activeCount`/`retiredCount`/`invokedCount`/`passedCount`/`violatedCount`/`deviationRate`/`reworkCheckIds`) and the recent audits.

## Alternatives considered

**Judge evidence quality with an LLM review.** Rejected: the pipeline grading its own claims' truth is exactly the self-reference trap — a second model call is still the same agent family testifying about itself. Only presence is observable; truth is adjudicated downstream by the resolved outcome and the user.

**Make `report_outcome` enforce an audit (reject unverified feedback).** Rejected: `report_outcome` carries no claim context (a prediction is not a claim), and hard enforcement belongs to the executing agent's discipline — the pipeline's role is to record, count, and feed back, not to refuse. Enforcement is observational and documented as a limitation.

**Fold criteria into the taxonomy rebuild.** Rejected: criteria are norms with a preserved track record, not utility-space clusters. The taxonomy is replaced wholesale by a rebuild, while an acceptance ledger must survive criterion rewrites (`revision` bumps); a separate append-only table is the only shape that keeps the evidence.

**Reuse only the loop machinery (`register_loop`).** Rejected: loops calibrate *decisions* on the predict/report ruler but persist no norm artifacts; the acceptance layer needs durable checklists with audited counts, which the loop registry does not provide.

## Consequences

- Three model tools added (eleven total); two new persisted tables; `report()` folds prediction errors into violated criteria; the deviation gate feeds deviation meta experiences to the cold loop.
- The doc gates for this package run again: regenerating the cordis catalog surfaced pre-existing missing type annotations (`hot-engine.retrieveTopK`, `service.decideAndExecute`) and seven previously-undocumented types (`TurnEpisode`, `ExplorationTask`, `MetaLoopSpec`, `LoopExecutionSink`, `LoopExecutionReceipt`, plus `AcceptanceCheck` and `ClaimAudit`), which are now registered in the type-link map and type-equivalence manifest and documented on the subsystem page.
- Enforcement remains observational: a claim is audited only when the agent chooses to call `verify_claim`; the pipeline counts and prices skipping verification but cannot force it. Evidence quality is adjudicated by the outcome and the user, not by the pipeline.
