# Agent Note: Multi-layer SAR experience injection

Status: implemented

English | [中文](2026-08-18-multi-layer-sar-experience-injection.zh.md)

## Problem

The cognitive pipeline's SAR memory had no working recall path for the situations where experiences matter most. The orchestrator's one-shot pre-task `retrieve()` matched the task text against each experience's action vector (`minSimilarity 0.3`); measured against real bug experiences, typical subtask texts scored 0.00–0.27 — below every threshold. So even when a subtask hit the exact bug a stored experience described, nothing surfaced it. Worse, there was no recall point *during* execution at all: `start()` injected once before delegation, `settle()` only wrote back, and a mid-task failure had no channel to pull related experience into the model's next step. Human memory chains by situation, not by keyword; the system recalled by action wording, and only at task boundaries.

## Decision

**Retrieval is situation- and action- dual-axis.** The orchestrator's `retrieve()` now scores each experience with `max(cosine(task, actionVector), cosine(task, situationVector))` and takes the higher. A task text like "tests suddenly hang" recalls the bug experience whose *situation* was "tests suddenly hang", even when the repair wording differs.

**A new opt-in plugin, `dsh-cognitive-inject`, primes at every agent pre-step.** It extracts the trailing message blocks of the step about to enter the model request, retrieves situation-related experiences from the shared pipeline store, and folds the closest hits into `decision.messages` as a `cognitive-inject`-sourced reference block. Because every agent — main conversation and subtasks alike — runs the same `agent/pre-step` waterfall, the plugin covers both layers with one listener.

**A failed step primes harder.** A `tools/result` listener records the per-agent most recent tool outcome; when it was an error, the next pre-step multiplies `minSimilarity` by `failureThresholdFactor` (default 0.6), raises the cap from `topK` (1) to `failureTopK` (3), and prefixes the block with "上一步执行失败". This is the memory-chaining analogue: failure is the strongest situation cue.

**Injection is durable and source-attributed.** The reference block rides the step's `decision.messages`, so the agent loop appends it as a `user/message` event — model-visible and logged together, per the "model-visible ⟺ logged" invariant. The package's invariant companion validates that every `cognitive-inject` event carries exactly the snapshot source and preamble it was written with.

## Alternatives considered

**Recall only through `predict_outcome`.** Rejected: it depends on the model remembering to call a tool mid-task, and its retrieval is action-weighted; the observed hit rate for bug experiences was near zero.

**Pre-task injection only (fix the orchestrator axis, nothing else).** Rejected: it still has no mid-execution recall point, which is exactly where a bug first appears.

**Agent-loop-level injection (modify `agent-loop`).** Rejected: the loop already exposes the `agent/pre-step` waterfall and appends `decision.messages` durably; a plugin on the existing extension point covers every agent without a loop change (per "plugins, not loop changes").

**Priming at every step with no token guard.** Rejected: unconditional injection would bloat every request. The default `topK: 1`, `minSimilarity: 0.4`, and context-depth cap keep most steps at zero injected tokens; only the failure path widens recall.

## Consequences

Bug experiences now surface at three layers: pre-task (orchestrator, situation-aware), mid-task (step priming on every agent), and post-failure (relaxed threshold). Injection is opt-in (`cognitive-inject` is not in the `web` profile by default), so products that never mount it pay nothing. The `context` package group gains one opt-in member with its own invariant companion. Known limits retained: hashed bag-of-words vectors (no synonym matching), per-agent not per-step failure marking, and no cross-agent recall between parent and child mid-flight.
