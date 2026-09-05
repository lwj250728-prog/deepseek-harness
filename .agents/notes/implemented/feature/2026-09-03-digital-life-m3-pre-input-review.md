# Agent Note: Digital-life agent M3 — main-session pre-input review

Status: implemented

English | [中文](2026-09-03-digital-life-m3-pre-input-review.zh.md)

## Problem

The pre-step priming delivered raw memory: retrieved experiences were injected as 【认知经验参考】 blocks, and the main model had to do the synthesis itself — read the scattered entries, judge relevance, extract the lesson — while answering the user. The operator's requirement for the digital-life milestone M3 added a stronger shape: before the main conversation answers a genuine user input, a review pass should first look back over past experience and analyze it, and the resulting analysis — not the raw entries — should come back into the main conversation.

## Decision

`cognitive-inject` now offers an opt-in **pre-input review** channel (`review.enabled`, default false; enabled in the web profile). On the first step of a turn, for a root conversation session whose input is substantive and whose session is out of the review cooldown, a review subagent is spawned with a prompt carrying the user input, the retrieved accepted experiences (up to `maxHits`), and the current situational chain head (soft-read when the situational-state plugin is mounted). The child's synthesized analysis is injected back as one 【过往经验回顾】 plugin message, REPLACING the raw experience blocks for that step. Every skip, timeout, spawn failure, or empty output falls back to the existing raw injection, so the review is a strictly additive upgrade.

- The child runs through the plain `spawn` provider (default `review.provider`); the prompt itself carries the retrieved material, so no SAR wrapper is required and the mechanism does not depend on the orchestration wrapper.
- Recursion guard: the review runs only when the session header carries no `parentSession` — a review subagent's own session is a child, so it never reviews its own input.
- Gate knobs: `minTextChars` (default 60 — chitchat never spawns a child), `cooldownMs` (default 120 s per session), `timeoutMs` (default 45 s — on expiry the raw blocks inject and the late child output is discarded), `maxHits` (default 3).
- The injection ledger records the review under `triggerSource: pre-input-review:<gate>` with the same expIds, so citation measurement and reinforcement treat it like any injection.

## Verification

`cognitive-inject` tests (34 green, 6 new): the review synthesis block replaces the raw blocks on step 1 of a root session (asserting the 【过往经验回顾】 text and the absence of 【认知经验参考】, plus the `pre-input-review:` trigger source); with no subagents seam mounted the raw blocks inject (fallback); an empty review output falls back to raw; step 2 of the same turn does not review; a child session (header `parentSession` set) never reviews; `buildReviewPrompt` carries input, head, expIds, and the required-output instruction. The web profile patch enables the review for the main conversation; the host typecheck is clean for these packages (the only remaining host errors are the operator's pre-existing WIP specs).

## Alternatives considered

- **Direct LLM synthesis without a subagent**: call the LLM route inline at pre-step and inject its synthesis. Rejected — the review is meant to happen outside the main context and cross back only its conclusion; a subagent provides the fresh-context review the operator asked for and keeps the main window unbloated.
- **Review every message**: spawn a child on every user turn regardless of length. Rejected — latency and cost scale with chitchat; the substantive-input floor and the per-session cooldown keep the review on real work.
- **Keep raw-only priming**: do nothing new because raw blocks already carry memory. Rejected — the operator explicitly wants the analyzed, subagent-mediated form back in the main dialog; raw blocks remain the deterministic fallback.

## Consequences

A genuine, substantive main-conversation input now gets an experience-grounded review before the model answers: the user sees answers informed by an explicit look-back pass, and the raw-memory noise stays out of the main window. Cost: the first step of an eligible turn blocks on one child run (bounded by `timeoutMs`; the fallback keeps the turn moving when the child fails), and each review costs one subagent completion per cooldown window. Review children are excluded from reviewing their own input by the `parentSession` guard, so no recursion loop exists.
