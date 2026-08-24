# Agent Note: per-turn cognition bubble — the pipeline's learning made visible

Status: implemented

English | [中文](2026-08-19-turn-cognition-bubble.zh.md)

## Problem

The cognitive pipeline accumulates, settles, and learns on every completed turn, but that activity is invisible in the chat: the user sees answers, not the learning. The user proposed surfacing it — "像每次进行代码处理那样，在会话结束的底部增加积累的经验气泡" — a per-turn bubble at the end of the conversation that shows what the turn actually taught the pipeline.

## Decision

Two halves, one data path.

**Data (cognitive-pipeline).** `summarizeTurn(sessionId, episode)` aggregates one completed turn's cognition activity: it settles the turn's injection citations, accumulates the episode when `autoAccumulate` is on, and counts predictions resolved since the last summarize call for the session (a per-session counter, so the delta is accurate across sessions). It returns `TurnCognitionSummary` and the pipeline's `turn/end` listener (now unconditionally registered, no longer gated by `autoAccumulate`) appends it as a `cognition/turn-summary` session event — UI-only, non-surface, never entering a model request — only when the turn produced activity, so quiet turns append nothing. Citation settlement at turn end moved from `cognitive-inject` to `summarizeTurn` so one owner aggregates the turn without a cross-plugin race; the deferred pre-step settlement (self-reflexive interruptions) stays in the inject plugin. The persistence catalog regenerated so the event type is known vocabulary.

**Display (ui-cognition).** A `cognition-summary` Conversation Node matches the event and renders a collapsible bubble at the turn's end in the chat stream: one line of counts (new experiences · citations cited/settled · resolved predictions) expanding to the experience ids and topics. The node uses structural narrowing of the host event (the client never declares the host's session vocabulary) and extends `ChatNodeDataMap` so the renderer is a type-safe keyed chat node.

## Alternatives considered

**Render the bubble from the client-side turn events only.** Rejected: the citation and experience facts live in the pipeline store, not in the session event stream; the host must supply the aggregate.

**Settle citations in the inject plugin and publish the bubble from there.** Rejected: the summary needs the accumulation result too, which lives in the pipeline; two owners would race on the same settlement.

**Every turn shows a bubble, empty when quiet.** Rejected by the user's choice: only turns with actual cognition activity render one, so a quiet turn does not interrupt.

## Consequences

- The learning loop is now visible: the user sees what each turn deposited (new experiences, citations that paid off, predictions resolved), and can inspect the exact experience ids and topics.
- Citation settlement is single-owned at turn end, removing a cross-plugin ordering hazard that existed implicitly.
- Costs: one host event type (regenerated catalog), one service method with a per-session counter, one client conversation node + renderer + locale + CSS, and their tests (host + jsdom component + GUI suite green: 3788 tests).
- The bubble only appears when the pipeline has something to say — a quiet turn stays quiet, matching the "有活动才显示" choice.
