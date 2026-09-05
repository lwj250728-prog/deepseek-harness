# Agent Note: Digital-life agent M4 — the sidebar life strip

Status: implemented

English | [中文](2026-09-03-digital-life-m4-sidebar-life-strip.zh.md)

## Problem

The digital life's substrate (situational chain, trace ledger, experiences) was invisible in the GUI: the sidebar listed every session flat, nothing marked the main conversation, and the current state lived in files only a tool could read. The "main conversation as entry" posture needed a visible face — one place where the life's current state and recent trajectory are readable at a glance, above the session list.

## Decision

A new sidebar seat `sidebar.life` sits above the browsing region (declared by ui-sidebar's shell, occupied by ui-cognition): a collapsible **life strip** that fetches the read-only `life.overview` RPC on mount and renders:

- a state card for the chain head — the situation text, commit age, owner session (truncated), and a 主对话 badge when the owner is the designated session (v1 designation = the session owning the current head);
- the newest trace entries as a mini timeline — kind word (注入/提交), origin badge (工具/自举/回合末/压缩), node id, age;
- a rail-only life glyph trigger when the sidebar is collapsed; a refresh button re-fetches. Read-only, no polling — the same discipline as the learning area.

The `life.overview` RPC (host: apiproxy `life` domain; data: `ctx.situationalState.head()`/`traceTail`) was added with its wire schema, client method, connection fixture, and fake-api coverage; the connection/runtime fake clients gained the method, and the slot catalog was regenerated for the new hole.

## Verification

Client suites green: ui-cognition 20/20 (5 new LifeStrip specs: mount fetch + state card, trace rows with origin badges, expand/collapse, rail trigger, empty-chain hint), ui-sidebar 25/25 (snapshots updated for the new seat), connection + runtime 494/494 across the affected packages, and the client aggregate typechecks clean. The host `life.overview` was probed live against the running web service (chain head sstate-10, designated session = the active conversation).

## Alternatives considered

- **Reuse `sidebar.learning`**: hang the life strip inside the exploration-task area. Rejected — learning is the task queue; the life's state/trajectory is a different read that belongs above the browsing region.
- **Fold the strip into the workspaces browser**: render it as a pinned first row of the session list. Deferred — the session browser is ui-workspace's own territory; the strip-first placement keeps the shell change minimal and the data read uniform for every open conversation.
- **Host-side designation marker first**: persist an explicit main-session id before shipping the strip. Rejected for v1 — the head owner is already the live truth of "who owns the current state"; the badge shows it, and an explicit override can layer on without UI change.

## Consequences

The life now has a visible face: opening the sidebar shows the main conversation's current state and its recent commits/recalls above the session list, updated on refresh, with the designated badge making the "main conversation" legible. Cost: one more sidebar seat and one read-only RPC (no polling, no mutation verbs); the strip is collapsed by default so the column layout is unchanged until expanded. The designation badge is only as good as the v1 rule (head owner); an explicit override and the session-list pinning remain follow-up work.
