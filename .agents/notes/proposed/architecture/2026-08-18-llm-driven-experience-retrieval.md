# Agent Note: LLM-driven experience retrieval and the experience network

Status: proposed

English | [中文](2026-08-18-llm-driven-experience-retrieval.zh.md)

## Problem

The cognitive pipeline's retrieval is entirely deterministic. Every recall path — the hot loop's `retrieveTopK`, the orchestrator's `retrieve()`, and `dsh-cognitive-inject`'s step priming — scores experiences with hashed bag-of-words cosine plus an exact-substring symptom channel. The LLM route participates only in *processing* experiences (`extractSar`, `reviewOod`, `calibrate`, `reconstructTaxonomy`); it never *retrieves* them. Measured on real bug experiences, the deterministic channels miss short symptom queries unless the symptom verbatim appears in stored text, and they cannot express synonymy, causality, or conflict between experiences.

The pipeline's stated design intent is an experience network retrieved with model capacity (the design's `all-MiniLM-L6-v2` / `text-embedding-3-small` retrieval axis), not a flat list matched by hashed keywords. The current implementation treats the deterministic floor as the architecture: the [symptom-first recall work](../../implemented/feature/2026-08-18-symptom-first-sar-extraction-and-recall.md) improved the floor but did not move toward the ceiling. The bug-scale, fine-grained handling that motivated those rounds is the *lower bound demonstration*, not the design target.

## Proposal

**A hybrid retrieval architecture: deterministic coarse recall → LLM re-rank → LLM synthesis.** Deterministic channels stay as the zero-cost candidate generator (they already cover the common case); the LLM route becomes the ranking and synthesis engine at the decision points where a model call is already being made. The experience store grows an explicit relationship network alongside the cluster table.

### Layer 1 — Coarse recall (deterministic, unchanged)

The existing `retrieveTopK` / `retrieve()` cosine + symptom channels remain the first stage. They produce a candidate set (currently top-K, widened for synthesis to a larger cap) at zero token cost. This is what keeps step-level priming cheap: every `agent/pre-step` still runs deterministic recall, and only the *decision* to inject consults the model.

### Layer 2 — LLM re-rank (new, at existing LLM call sites)

Where the pipeline already makes a model call for the same input, the candidate set rides along and the model ranks it. Concretely:

- **Hot loop** (`predict_outcome`): the OOD review already receives the top-3 actions and judges "known variant vs novel species". Extend that single call to also return a relevance ordering of the candidates, so `predictKnown`'s samples are model-ranked rather than cosine-ranked.
- **Orchestrator inject decision** (`policy:inject`): the prediction call already frames the task; the candidate hits are passed in and the model's calibrated probability becomes the inject decision — ranking the candidates inside the same call replaces the `retrieve()` sort as the tie-break.

The re-rank is *scoped to calls that already happen*: no new model call is introduced at step priming. The contract is a JSON ranking of the supplied candidate ids, with a deterministic fallback to the cosine order when the route is absent or the call fails.

### Layer 3 — LLM synthesis (new output shape)

Retrieval returns more than text. At the two decision points (predict, orchestrator inject), the model synthesizes the ranked candidates into one recommendation — "based on your past float-overflow fix and this hang symptom, first bisect, then replace the loop with arithmetic" — instead of returning a raw reference block. The synthesized advice becomes the `advice` / injected block text; the candidate ids remain attached for auditability.

### The experience network

The cluster table (`Cluster`) becomes nodes; a new relation table records edges between them. `reconstructTaxonomy`'s LLM call is extended to emit, alongside clusters:

- **similar-to**: experiences or clusters that are the same strategy family (the cold loop already computes this; now it is persisted as an explicit edge).
- **causes / preceded-by**: failure experiences linked to the fix that resolved them and the outcome that followed — the retrieval chain for "I saw this symptom before".
- **conflicts-with**: same situation, different actions with divergent utilities — the retrieval answer for "what did NOT work".

Retrieval becomes network activation: the coarse recall seeds nodes, and the re-rank walks their edges (similar-to warms siblings, preceded-by warms the resolution) before the model ranks. This is the memory-chaining semantics: a situation activates a node, the edges pre-warm the neighbors the model is about to consider.

### Migration path

| Step | Scope | Ships |
| --- | --- | --- |
| 1 | Extend OOD review + calibrate calls to return candidate rankings; deterministic fallback to cosine order | LLM re-rank in the hot loop and orchestrator, no new model calls |
| 2 | Extend `reconstructTaxonomy` to emit relation edges; new relation table + store methods | The experience network's write side |
| 3 | Network-aware retrieval: coarse recall seeds nodes, edges pre-warm neighbors, re-rank consumes the warmed set | The experience network's read side |
| 4 | LLM synthesis at predict + inject: ranked candidates become one recommendation block | The ceiling output shape |

## Alternatives considered

**Replace hashed vectors with LLM embeddings.** Rejected as the first step: it requires a new embedding provider seam and an embedding call per experience write and per query, while the model is already called at the decision points — re-ranking inside existing calls delivers semantic ranking today without a new dependency.

**Keep deterministic retrieval as the ceiling (current state).** Rejected: the empirical symptom work demonstrated the floor's limit — short queries only hit when the symptom verbatim appears in stored text, and synonymy, causality, and conflict are inexpressible in a flat cosine ranking.

**A separate retrieval service called before every step.** Rejected: it reintroduces the model-call cost at step priming that the deterministic coarse recall exists to avoid; re-ranking only at the decision points keeps priming cheap.

**Store the network implicitly (derive edges on the fly).** Rejected: the cold loop already pays the clustering pass; persisting the edges makes retrieval and the taxonomy summary deterministic across processes and reproducible, matching the store's existing reproducibility contract.

## Acceptance criteria

- Hot-loop `predict_outcome` and orchestrator `policy:inject` rank candidates through the model when a route is configured, and fall back to the cosine order identically when it is not.
- A relation table exists, populated by `reconstructTaxonomy`, with the three edge kinds; retrieval warms neighbor nodes across edges before ranking.
- Predict and inject outputs carry synthesized recommendations with the candidate ids attached for audit.
- No new model call at step priming; step-level injection stays deterministic coarse recall.
- Package tests, typecheck, lint, and doc gates green; keyless snapshots updated for the changed model-visible output shapes.

## Risks

- **Re-rank latency**: a ranking field on an existing call adds output tokens; bounded by keeping the candidate cap small and the ranking schema minimal.
- **Network bloat**: unbounded edges grow the store; the cold loop's decay-weighted sampling already bounds cluster growth and extends to edges.
- **Synthesis drift**: model-composed advice may overstate certainty; the injected block keeps the "reference, not current fact" framing and the candidate ids remain inspectable.
- **Relation hallucination**: an LLM-emitted edge may not hold; each edge is backend-verified against its endpoints' vectors before persistence, mirroring the existing cluster evidence hard-constraint.
