# Agent Note: Digital-life agent M1 — the situational state chain sustains itself

Status: implemented

English | [中文](2026-09-03-digital-life-m1-situational-self-sustain.zh.md)

## Problem

The situational state chain could not start or advance itself. The pre-step injection hook short-circuited on an empty chain, and `situational_state_commit`, the only tool that creates the first node, was not registered in the running deployment: the plugin registered its tools inside `apply` through a guard that silently returned when `ctx.get('tools')` was undefined, and the plugin declared no `inject` dependencies to guarantee the tool registry existed at mount time. The first node therefore had to be hand-written into `chain.json` (the 2026-09-02 verification seeded `sstate-1` manually). Even with a head present, advancing the chain depended on the model remembering to call the commit tool unprompted — the same weakness that had already frozen the chain for four days once.

## Decision

`situational-state` now keeps its own thread alive end to end, per milestone M1 of the [digital-life route proposal](../../proposed/feature/2026-09-03-digital-life-agent.md). Three mechanisms ship in `packages/context/situational-state`:

- The plugin declares `inject = ['agents', 'tools']`, so the loader mounts it after the agent registry and the tool registry. `situational_state_commit` and `situational_state_trace` therefore register unconditionally; the silent-skip gap is closed and pinned by a regression test.
- Empty-chain bootstrap (`autoBootstrap`, default true): when a pre-step finds the chain empty, the plugin commits the session's opening situation — the trailing text blocks of the messages entering the step, capped at 220 characters — as the first node with trace `origin: 'bootstrap'`. The injection hook never silently dies on an empty chain again; the conversation starts its own state chain without a manual tool call or a hand-edited document.
- Turn-end self-check (`selfCheckEnabled`, default true; `selfCheckMinHeadAgeMs`, default 5 minutes; `selfCheckMinToolCalls`, default 1): on every `turn/end` with a completed or error reason, when the chain head is older than the age floor and the finished turn recorded at least the tool-call floor, the plugin commits a node whose text is the turn's latest self-authored statement (last assistant text, else last genuine user request — `extractTurnActivity`, capped at 220 characters), with trace `origin: 'turn-end'`.

Commit provenance rides the trace ledger: every commit entry carries an optional `origin` (`'tool'`, the default for model-tool commits; `'bootstrap'`; `'turn-end'`; absent on legacy entries written before the field existed), and `situational_state_trace` returns it.

## Verification

Unit tests in `packages/context/situational-state/tests/situational-state.spec.ts` now mount the plugin behind its declared services (agents, tools, prompt runtime) and assert: both tools are registered; the commit tool executes and records `origin: 'tool'`; the first pre-step of an empty chain creates `sstate-1` with `origin: 'bootstrap'` and the second pre-step injects it; `autoBootstrap: false` leaves the chain empty; a completed working turn over an old head commits `sstate-2` with the turn's own text and `origin: 'turn-end'`; a fresh head under the age floor is skipped; and `extractTurnActivity` reads tool calls plus the latest self-authored text. The full suite is 25 tests green, and the bilingual package README (pairing re-recorded) documents the five new config fields.

## Alternatives considered

- **Prompt-only guidance instead of bootstrap**: inject a "no state committed yet" guide and wait for the model to call the tool. Rejected — models do not reliably self-commit (the measured four-day freeze), and the first node must not depend on model compliance; the deterministic opening-node commit closes the loop regardless.
- **LLM-judged stage transitions for the self-check**: ask the pipeline's LLM route whether a real transition happened before committing. Deferred — it costs a completion per stale turn, and the deterministic proxy (age floor plus real tool work plus the turn's own words) already advances the chain at working cadence; an LLM judgement can be layered on later if node quality demands it.
- **Registering tools lazily at first pre-step**: retry registration when the tool registry appears, avoiding an `inject` declaration. Rejected — `inject` is the loader's own ordering mechanism; lazy registration risks a one-step tool gap on the very first request of a session.

## Consequences

The chain now grows automatically as a conversation works: bootstrap at open, self-check commits after working turns (cadence bounded by the five-minute age floor), and the model tool remains for deliberate commits. Cost: the chain no longer stays empty by default, so a trivial opener ("你好") produces a low-value root node; operators set `autoBootstrap: false` when the chain should only record deliberate commits. Concurrent first pre-steps from different sessions can race on the shared chain document — the read-modify-write is first-writer-wins and an in-process `bootstrapPending` flag suppresses double bootstrap within one process; the trace `origin` field keeps provenance auditable per node. Automatic commits carry no self-decided wake, so checkpoint reminders stay a model-tool feature.
