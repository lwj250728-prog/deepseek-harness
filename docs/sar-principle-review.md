# Agent Note: SAR principle review — prediction error is an attention trigger, not an encoding filter

Status: proposed

English | [中文](2026-08-19-sar-principle-review.zh.md)

## Problem

DCA-PED's founding claim is that experience accumulates through prediction error: the hot loop (predict/report, |calibrated − observed|) learns, the cold loop (`rebuild_taxonomy`) re-clusters errorful experiences, and both are supposed to drive which experiences matter. Three measured facts contradict that claim.

First, prediction coverage is 6.2%. Of 195 stored experiences, only 12 are bound to a prediction expId. The main accumulation paths — `remember_experience` and `accumulateTurn` — encode and store without any predict step: `predictionError: null, cumulativeError: 0` at birth. Prediction error can reach an experience only through `resolvePrediction`, which requires a bound predictionId. "Prediction-error-driven accumulation" therefore holds for 6.2% of the store; 93.8% is LLM-gate-driven accumulation.

Second, the calibration-error decline may be shrinkage, not skill. Mean calibrated probability is 0.563 with a 0.22 spread; the five-layer calibrator pulls toward mid-range. |calibrated − observed| then falls because predictions get vaguer, not because they get more accurate. The single metric cannot separate reliability gain from resolution loss (Brier decomposition).

Third, error does not predict value. exp_8 carries cumulative error 0.67 yet was never injected; exp_25 carries cumulative error 0.15 and was also never injected. Of 195 experiences, only 26 were ever injected and 8 ever cited. Error size is orthogonal to whether a decision adopts an experience.

The first-principles review explains why: six structural misalignments between what SAR claims and what it implements.

**A. Encoding has no expectation field.** Schank's expectation failure and Friston's free energy both make surprise the trigger for memory update. The SAR schema (situation/action/outcome/utility) has no predicted-outcome or expected-result field. `extractSar` splits text and labels utility; it never records what the actor expected. There is no encoding-time surprise signal, so accumulation is undifferentiated.

**B. The main path never touches the loop.** `accumulateTurn` gates by an LLM judgment (worth remembering?), not by any prediction. Experiences born outside the predict/report loop can never accumulate predictionError, so the cold loop's error-first sampling never sees them as errorful.

**C. Utility is self-report, not measurement.** `outcomeUtility` is the LLM's encoding-time self-assessment. The clustering axis is a hash of that self-assessment, weighted ×4 at the head. `resolvePrediction` retrofits materialGain = 5 + (q−5)·0.8, but only for the 12 bound experiences. Clusters therefore group what the model claims it felt, not what actually worked. Self-reported utility is a hypothesis, never a fact.

**D. Error is an attention trigger, not a value metric.** High error has two causes: the situation is unpredictable noise (nothing learnable), or the model lacks experience (worth learning). The error size cannot distinguish them. The cold loop samples errorful experiences for clustering, so noise can shape clusters while genuinely adopted low-error experiences never join.

**E. The situation dimension has no representation.** The retrieval axis is `actionVector(action + keywords)`; the clustering axis is `outcomeVector(utility + outcomeText)`. The situation is not an axis: `situationCentroid` is built from `actionVector(exp.sar.situation)`, and `taxonomyContext` also computes `actionVector(situation)`. "Same situation, different action" and "different situation, same action" are indistinguishable in vector space.

**F. Experiences are snapshots that never evolve.** After write, an experience changes only through error/utility backfill. `hitCount` accumulates on cluster matches but never enters retrieval ranking, the clustering axis, or any retention decision. There is no consolidation and no forgetting — precisely what the self-sustaining goal needs to add.

**G. Disequilibrium is always assimilated — there is no variance perception, so there is no accommodation.** Piaget's disequilibrium is the engine of cognitive development: when an existing schema cannot absorb a new observation, the learner either assimilates (folds it into the old schema, e.g. "bad luck / bad soil") or accommodates (modifies the schema, e.g. the farmer who germinates seeds before transplanting). The farmer analogy splits learners by which path they take on the same anomaly: the ordinary learner assimilates the dead seedlings away, the talented one tolerates the disequilibrium and revises the procedure. The system today is the ordinary learner. `outcomeUtility` is a single-point self-report (materialGain = 7), so outcome variability is erased at encode time; prediction error only books keeping (exp_8 accumulated 0.67 with no resulting action); every success is assimilated as "the steps are right" and every failure as "the environment changed". The system never asks whether a step can be improved, because it never perceives that a step's result varies. Without variance perception there is no disequilibrium, and without disequilibrium there is no accommodation — the system has the "smart learner" half (follows steps, executes stably) and none of the "talented learner" half (revises steps through many rounds of reasoning and testing).

## Proposal

The review's deliverable is a re-positioning of each SAR element's role, stated as the design constraint for every future self-sustaining mechanism. No mechanism is designed here; the constraint set is the gate.

| Element | Current role | Correct role |
| --- | --- | --- |
| situation | stuffed into the action vector | situation recognition: "what kind of event is this", on its own axis |
| action | retrieval axis (hashed text) | behavioral candidate: a transferable strategy |
| outcome | clustering tail text | settlement evidence: post-hoc verification |
| predictionError | clustering sampling signal | attention trigger: "the model needs updating here", never a value measure |
| outcomeUtility | clustering head, ×4 | initial hypothesis, pending machine-checkable verification |
| citation / adoption | not tracked as a signal | the actual value signal: how often a decision adopted this experience |
| cluster | outcome-utility grouping | behavior pattern: the transfer unit |

Six constraints on self-sustaining design:

1. **Encoding gating uses prediction against existing memory, not LLM self-reported surprise.** The gate is how far this event sits from what prior experience predicts, which requires an expectation to exist at encode time.
2. **The value signal switches from self-reported utility to machine-checkable citation.** This aligns with the external-witness philosophy (log/file/command anchors): adoption counts, not felt utility.
3. **Error triggers re-evaluation of existing memory, not new experience.** Bartlett: surprise revises a schema. High error on an experience should update, merge, or roll back that memory, not spawn a duplicate.
4. **Experiences need a lifecycle: strengthen, decay, prune.** This requires a citation ledger first; without it, retention has no evidence.
5. **The clustering axis moves from utility pattern to behavior pattern plus outcome evidence.** Clusters become strategy-transfer units keyed by what was done and what was verified.
6. **The situation gets an independent representation.** Otherwise situation similarity and action similarity stay conflated, and situation-driven recall cannot exist.

### The driving-force framework: disequilibrium × variance × variant × iteration

The review above answers "why does experience accumulate badly". The second review answers "what would make the system revise its own steps". Four stacked drivers power a talented learner's improvement, and each maps to a missing mechanism:

1. **Variance perception.** The talented farmer knows the same steps give different results across fields and years; a deterministic outcome would make improvement pointless. The system erases variability by encoding a single self-reported utility. Variance must become a first-class quantity: every settlement appends one result sample to the experience, and variance over samples is the new measure. Without variance there is no disequilibrium, and without disequilibrium there is no improvement motive.
2. **Disequilibrium detection.** At execution time, when the observed result departs from the experience's expected distribution beyond a threshold, disequilibrium fires. The response bifurcates explicitly: low departure assimilates (attribute to noise, keep the steps); high departure accommodates (enter improvement). Today the system always assimilates — error is booked, never acted on.
3. **Variant generation.** The search space is the known step chain (the `chainSignature` causal axis): variants perturb one link at a time ("germinate first" is a perturbation of the sowing link's environment). Generation sources: single-link perturbation, analogical transfer from other domains, pain-point back-derivation. Improvement is not random exploration; it is a structured perturbation of a link whose result varies.
4. **Iterative convergence.** Hypothesis → small test → observe → revise → retest, each round lowering uncertainty about the variant until it drops below the adoption threshold. Today's exploration is one-shot (budget-capped, single ROI settlement); a candidate needs multiple rounds to converge.

The four drivers compose the motive: dissatisfaction (comes from the task — the farmer is dissatisfied because seedlings die), variance perception (comes from settlement — multiple results differ), comprehension drive (comes from the chain's causal structure), and disequilibrium tolerance (a designed threshold). The motive is not idle curiosity; it is dissatisfaction with uncertainty during execution, which anchors on the task stream (dissatisfaction) and the settlement stream (variance) — no invented goals.

Four supplementary constraints:

7. **An experience records a result distribution, not a single utility point.** Each settlement appends a sample; variance over samples becomes a first-order quantity. This is constraint 5's evidence made temporal, and the precondition of variance perception.
8. **The disequilibrium bifurcation must be explicit.** The system must choose between assimilate (attribute to noise, keep the steps) and accommodate (generate variants, revise the steps) instead of defaulting to assimilate, which is today's implicit behavior.
9. **Variant generation anchors on the known chain.** Improvement candidates are perturbations of the link whose result varies, not random actions; exploration budget is spent on structurally-grounded directions.
10. **Improvement iterates to convergence.** A candidate undergoes multiple test rounds until its uncertainty drops below the adoption threshold; one-shot exploration does not graduate a revision.

## Alternatives considered

**Keep prediction error as the working mechanism and only widen coverage.** Rejected: widening coverage makes every experience pass through predict/report, but the measurements show the loop itself is mis-placed (B: the main path is outside it; D: error does not equal value). Coverage would buy a better backtest, not a better encoding.

**Replace SAR with a TD-style value model (rewards instead of utilities).** Rejected: the store's working structure (chains, clusters, acceptance ledgers, injection records) is reusable; the defect is the value signal, not the memory container. A TD rewrite would discard working structure for the same defect.

**Drop error entirely; keep only citation as the signal.** Rejected: error remains the correct trigger for where predictions are unreliable, which is what cold-loop re-clustering of hard regions needs. The fix is to demote error from value metric to attention trigger, not to delete it.

**Drive improvement by behavioral cloning (replay demonstrated expertise).** Rejected: cloning replicates the "smart learner" half — follow the demonstrated steps faithfully — and by construction cannot produce the "talented learner" half, which is precisely the disequilibrium-driven revision of those steps. The farmer analogy is the counterexample: mastery of the procedure (assimilation) and revision of the procedure (accommodation) are different capabilities, and only the second yields improvement.

## Acceptance criteria

- Every misalignment claim above maps to a src/ line or a data fact reproducible from `data/cognitive-pipeline/`; the note records the mapping.
- The three measured facts (6.2% coverage, 0.22 spread, error–citation orthogonality) are reproducible from the JSONL data.
- Every future self-sustaining mechanism design states, for each of the six constraints, either how it satisfies it or why it explicitly overrides it.
- Each driver in the framework has an observable counterpart: variance = the distribution statistic over an experience's settlement samples; disequilibrium = a threshold-crossing trigger record; variant = an exploration task traceable to the perturbed chain link; iteration = multiple settlement rounds for the same candidate.

## Risks

- **The review over-corrects.** Existing machinery (clusters, chains, acceptance criteria, deferred settlement) demonstrably works; the note re-positions SAR's value layer and does not condemn the store. Constraint 3 keeps error useful.
- **Citation-led value needs a ledger that does not exist yet.** Constraint 4 depends on it; the ledger is a prerequisite, not a side effect.
- **Situation representation may cost tokens or a new seam.** Constraint 6 is the least constrained; it may land after the other five.
- **Over-accommodation: noise mistaken for disequilibrium.** Random fluctuation attributed to a step defect triggers meaningless variant generation. The disequilibrium threshold must be calibrated conservatively — the "宁缺毋滥" leak-aversion principle applied to improvement.
- **Accommodation cost.** Revising a solidified strategy is itself risky (the restart domain proved this); variant tests must stay in the reversible, low-risk space, reusing the exploration reversibility gate.
