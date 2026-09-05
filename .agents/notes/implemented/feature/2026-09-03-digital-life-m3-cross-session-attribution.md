# Agent Note: Digital-life M3 — truthful cross-session state attribution

Status: implemented

English | [中文](2026-09-03-digital-life-m3-cross-session-attribution.zh.md)

## Problem

The injected situational-context preamble always claimed the reading session owned the committed state: `【情景状态参考】当前会话最近提交的情景状态…`. The chain is shared across sessions — a fresh conversation inherits the life thread through the head — so when session B read a head committed by session A, the model was told a lie about ownership. Cross-session continuation (the digital-life identity milestone) depends on the reader knowing whose state it is picking up.

## Decision

`renderSituationalContext` takes an optional reader session id; the pre-step listener passes the reading agent's session. When the reader differs from the head's committing session, the preamble names the true owner and adds one cross-session note:

- same-session or reader-neutral renders keep the legacy `当前会话最近提交…` wording unchanged;
- a different reader renders `会话 <owner> 最近提交…` plus a 【跨会话】 note that the state was committed by another session and may be continued, with `situational_state_commit` available to commit the reader's own state.

## Verification

`situational-state` tests (32 green, 4 new): a different reader renders the true owner with the cross-session note; the owning reader keeps the same-session wording; the reader-neutral render keeps the legacy wording; a fresh session's first pre-step injects the head with the true owner's attribution. The package typechecks; the web profile loads the change on the next restart.

## Alternatives considered

- **Keep the false "当前会话" wording**: zero change, zero cost. Rejected — the whole cross-session identity design rests on the reader knowing whose state it sees; a lie at the first injection poisons continuation.
- **Push every cross-session reader to continue the life**: add an imperative continuation instruction. Rejected — designation is a marker, not a coercion (the RFC's alternatives); the note is informative, and side conversations stay free to ignore it.

## Consequences

A fresh session reading the life thread now sees an honest handover: whose state it is, that it crosses sessions, and that committing its own state advances the chain. Same-session and reader-neutral renders are byte-identical to before, so existing contracts and tests hold.
