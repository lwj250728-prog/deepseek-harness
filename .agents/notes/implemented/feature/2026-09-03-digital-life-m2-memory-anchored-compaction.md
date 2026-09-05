# Agent Note: Digital-life agent M2 — memory-anchored context approximation

Status: implemented

English | [中文](2026-09-03-digital-life-m2-memory-anchored-compaction.zh.md)

## Problem

Context approximation was a raw token mechanic. When `compaction-basic` replaced an evicted surface range under token pressure, the summarizer wrote one summary node into the session surface, but nothing wrote the evicted thread into the memory substrate: the situational chain kept whatever head it had (often a stale node from before the long arc), the experience store learned nothing from the arc, and continuity after compaction rested on the static in-context summary alone. A crash between eviction and any future write, or a later compaction of the summary itself, lost the thread for good.

## Decision

Compaction now anchors into the substrate on both memory planes, per milestone M2 of the [digital-life route proposal](../../proposed/feature/2026-09-03-digital-life-agent.md). Both listeners subscribe to the session's `compaction/summary` event — the log-only metering event that carries the summary text and is contractually followed by the surface-replacing `user/message` — and both write at most once per compaction id.

- `situational-state` commits one chain node whose situation text is the compaction summary (capped at 320 characters), with trace `origin: 'compaction'`. The pre-step injection then surfaces the refreshed head on the next step, and the node persists for later sessions — post-compaction recovery rides the chain, not the evicted surface. Config `compactionWriteBack` (default true) disables it.
- `cognitive-pipeline` offers the summarized arc to the accumulation gate once (`accumulateTurn`), but only while `autoAccumulate` is on, with an episode whose outcome is the summary. The gate decides worth — substantiality pre-filter, prediction-gap assimilation, LLM judgment, task-restatement rejection — so a rejected arc writes nothing and a long session cannot flood the store (at most one gated experience per compaction id).

The write happens asynchronously after the `compaction/summary` append; the summary text is itself a durable session event, so a crash before the write-back loses only the substrate node, never the arc content (the session log retains the summary and the replacement).

## Verification

`situational-state` tests (28 green) add: a `compaction/summary` event commits one node with the summary text and `origin: 'compaction'`; a repeated compaction id writes no second node; `compactionWriteBack: false` writes nothing. `cognitive-pipeline` adds `compaction-accumulation.spec.ts` (4 green): with `autoAccumulate` on and an explicit route, one gated experience lands from a compaction summary; the same compaction id consumed exactly one LLM gate call (idempotence asserted through the adapter call counter); without a route the gate rejects and nothing is written; with `autoAccumulate` off nothing is written. README pairs for both packages were updated and re-recorded.

## Alternatives considered

- **Write-back inside the compaction backend**: teach `compaction-basic` to call the memory plugins at replacement time. Rejected — the backend owns token policy, not memory; the substrate listeners react to the durable `compaction/summary` event any backend emits, keeping the seam one-way.
- **Recover by re-deriving from the session log**: skip the chain node because the summary remains in the log. Rejected — the chain is what outlives repeated compactions and crosses sessions; log-only recovery needs a replay pass nobody runs.
- **Synthesize an experience unconditionally**: write one experience per compaction without the gate. Rejected — auto-accumulation exists precisely to keep the store gated; an unjudged synthetic inflow would pollute retrieval.

## Consequences

A long working arc now survives token pressure in both memory planes: the chain head tracks the summarized state (recoverable on the next step and in later sessions), and the arc may graduate into the experience store when the gate judges it worth remembering. Cost: each compaction can cost one LLM gate call (pipeline side, only under auto-accumulation) and one chain node plus trace entry (situational side); both are bounded per compaction id. The write-back is asynchronous to the event stream, so the strict "durable before eviction" guarantee is not literal — the summary is safe in the session log, the substrate node is best-effort-before-next-compaction.
