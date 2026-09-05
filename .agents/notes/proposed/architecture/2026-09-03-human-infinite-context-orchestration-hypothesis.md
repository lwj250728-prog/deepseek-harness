# Agent Note: Human infinite context is grounded in orchestrated memory programs — a hypothesis

Status: proposed

English | [中文](2026-09-03-human-infinite-context-orchestration-hypothesis.zh.md)

## Problem

The digital-life route promises a main conversation that approximates unbounded context through the cognitive pipeline and persistent memory. Engineering alone cannot justify that promise: "near-infinite context" is currently an architecture claim, not a tested property. To build the right acceptance tests — and to know what would make the route a failure — the route needs an explicit model of what human-like unbounded continuity actually is. This note records that model **as a hypothesis**, with its epistemic status and its falsification path, so the engineering does not silently mistake a guess for a fact.

## Proposal

The hypothesis, stated precisely:

> Human-like unbounded continuity is not the product of a large working window, nor of storage capacity, but of orchestrated memory programs: what to encode, how to retrieve by cue, what to forget, and how the self-model is reconsolidated at every step. The sense of an "infinite context" is the functional illusion produced by these programs running continuously — continuity is regenerated each moment from cues plus reconstruction, never replayed from storage.

The supporting observations are: working memory holds only a few chunks and attention is single-channel, so no human ever "sees" their whole past; yet people sustain a single thread for decades, which implies continuity lives outside the window and is recomputed on demand (Baddeley's central-executive and Tulving's encoding/retrieval framing). Retrieval is construction, not archival replay (Bartlett); forgetting is a feature that keeps noise from poisoning every later extraction; and each recall reconsolidates the memory it touches.

Mapped to this route's built organs, each human program has an engineering analogue: encoding selection → the auto-accumulation gates; cue-based reconstruction → situation-similarity retrieval with trigger/similarity/veto gates and viewpoint coverage; forgetting/gating → injection cooldown, task-restatement rejection, retrieval thresholds; self-model reconsolidation → the situational chain head advancing at turn end and compaction write-back; deliberate recollection before action → the pre-input review subagent.

The operative definition of "infinite" for this route is therefore retrieval-side, not storage-side: a fact needed to complete a task, placed arbitrarily far back (even evicted by compaction), must be returned by the memory programs when it becomes relevant — the model answers from what was recalled, without the operator restating it.

## Epistemic status

This is a **model-level hypothesis, not an empirical claim about the brain**. Cognitive science has no settled neural account of these control processes (prefrontal executive, hippocampal indexing, cortical reconstruction are competing proposals). The mapping to the built organs is an engineering analogy whose value is judged by whether it produces correct acceptance tests, not by its neurological truth.

## Falsification path

The hypothesis is falsifiable for this implementation: run a scripted conversation that plants an old fact, crosses a real compaction boundary, changes topic, then returns to ask for the fact; if the main conversation cannot answer from the recalled material without restatement, the orchestration hypothesis fails for this system at that horizon. A second probe is precision under scale: as the experience store grows to hundreds of records, retrieval must still surface the relevant hits and the gates must still keep noise out — a curve, not a single point. These are the same two verifications M2 already owes (compaction write-back live evidence; retrieval precision at scale).

## Alternatives considered

- **Long-window storage-centric model**: treat unbounded context as a larger window plus better summarization. Rejected as the grounding model — it defers the boundary instead of explaining continuity, and its acceptance test ("can the window hold more") never touches whether the agent recalls on its own.
- **Pure external RAG**: retrieval over stored documents with no self-model. Rejected — it captures facts but not the ongoing self that must be reconsolidated; the route's chain-head loop is precisely the missing program.

## Acceptance criteria

The hypothesis is recorded with its falsification path attached to the route's verification plan: the cross-compaction recall acceptance (M2) and the retrieval-precision-at-scale probe are the tests that would confirm or refute it for this implementation.

## Risks

The main risk is category error: treating the hypothesis as doctrine and over-indexing engineering on the analogy (e.g., adding deliberate forgetting where retention would be better, or assuming retrieval construction must distort like Bartlett's). The note's status line is the guardrail — it stays a guess until the acceptance tests say otherwise.
