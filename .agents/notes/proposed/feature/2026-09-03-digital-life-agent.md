# Agent Note: Digital-life agent — one continuous main conversation on the cognitive substrate

Status: proposed

English | [中文](2026-09-03-digital-life-agent.zh.md)

## Problem

The cognitive stack on the web profile now verifies piece by piece — the embedding seam (SiliconFlow bge-m3, exp_11), LLM restructuring, turn-end auto-accumulation, the GUI learning-area bubbles, and the situational-state pre-step injection once a chain head exists (a hand-seeded `sstate-1` node surfaces as the 【情景状态参考】 block in this very conversation). Each mechanism works in isolation, but none of them yet adds up to the outcome they exist for: one main conversation that keeps its own thread — what it is doing now, how similar situations went before, and a durable identity — no matter how long the raw transcript grows.

Three verified gaps block that outcome. First, the situational-state chain cannot start itself: the injection hook short-circuits on an empty chain, and `situational_state_commit`, the only tool that creates the first node, is not in the main conversation's tool catalog (this session exposes the cognitive-pipeline tools such as `predict_outcome` but not the situational tools) — the first node had to be written into `chain.json` by hand. Second, context approximation is a raw token mechanic: `compaction-basic` summarizes evicted surface on token pressure, but nothing writes the evicted thread into the memory substrate (experience store, situational chain) and nothing recovers it from the substrate on the first post-compaction step — continuity after compaction rests on the static summary alone. Third, there is no notion of "the life conversation": sessions are per-working-directory UUIDs, nothing marks one as the continuing dialogue, and no defined resume path hands a new session the old thread (current state, recent experience, active goals).

The functional requirement, stated by the operator: the next development step is a digital-life agent whose observable behavior is a main conversation that approximates unbounded context through the cognitive pipeline and persistent-memory plugins, with continuity shaped like human thought — the agent always knows what it is doing, remembers how similar things went, and can be talked to indefinitely without re-priming.

## Proposal

Treat the digital-life agent as a thin product layer over the verified substrate: designate one durable main conversation, and carry its continuity with four cooperating loops. Each loop names its owning seam and the change it needs; none invents a new runtime — they rewire and complete mechanisms that already run on the web profile.

### L1 — self-state loop (owning package: @deepseek-ai/dsh-situational-state)

The conversation always has a current committed state: the chain head is injected at every pre-step (verified), the agent commits a node at stage transitions, and a stale head (older than `staleUpdateGuideMs`, default 1 hour) carries an explicit update guide. Three fixes close the verified gaps: empty-chain bootstrap (on first pre-step of the designated main conversation with no head, the plugin performs an initial commit of the session's opening state instead of short-circuiting); tool exposure (put `situational_state_commit` and `situational_state_trace` in the main agent's tool catalog through the same registration path that already exposes the cognitive-pipeline tools); and a turn-end self-check (after a completed turn, when the turn's summarize/accumulate path observes a stage transition — new goal, changed environment, long task boundary — conditionally commit a state node, so the chain advances without the model remembering to call the tool).

### L2 — memory loop and context approximation (owning packages: @deepseek-ai/dsh-cognitive-pipeline, @deepseek-ai/dsh-cognitive-inject, compaction seam)

Completed turns already auto-accumulate into the SAR store and pre-step retrieval re-injects related experience (verified). The missing half is memory-anchored compaction: before `compaction-basic` replaces surface under token pressure, the evicted thread is written back into the substrate — a synthetic bounded write (one situational-state commit capturing "what was happening" plus at most one gated experience summarizing the evicted arc) — and on the first post-compaction step, retrieval re-seeds the thread from the substrate (chain head plus recent experiences) rather than relying on the static summary alone. The write-back is a compaction listener on the existing `ctx.compaction` seam; the write happens before the surface replacement so a crash cannot evict without persisting.

### L3 — identity loop (owning packages: session persistence, profile config)

One durable main-conversation identity: a profile-level marker naming the life conversation (its session id and working directory) so any web session can find and resume it. Resume = replay the persisted tail, inject the situational head on the first pre-step, and prime recent experience — the same primings that keep a running conversation continuous, applied at open time. Persona and system-prompt continuity ride the existing persona rows.

### L4 — surface loop (owning packages: @deepseek-ai/dsh-ui-cognition, apps/web)

The GUI presents the main conversation as one continuous dialog with an adjacent life stream: current committed state, situational trace entries (inject/commit), and learning-area bubble events rendered against the same transcript, so the operator sees the memory activity that keeps the thread alive. The situational trace ledger (`trace.jsonl`) and bubble events already exist as data; the work is presentation and a stable route back to the designated conversation.

### Roadmap

1. M0 — this note: agreed route, owning seams, and acceptance criteria for M1-M3.
2. M1 — self-sustaining loop: L1 fixes (bootstrap, tool exposure, turn-end self-check). Observable end state: from a pristine home, a fresh main conversation acquires its first situational node with no manual seed, advances it across a real stage transition, and the trace ledger shows commit/inject pairs.
3. M2 — memory-anchored context approximation: L2 write-back and post-compaction recovery. Observable end state: a scripted long conversation crosses a compaction boundary, and afterwards the agent answers "what were we doing / what did we decide" from the substrate, verified by transcript assertions.
4. M3 — identity and surface: L3 marker/resume plus L4 presentation. Observable end state: closing and reopening the browser (new session id) resumes the same life conversation with state injected on the first pre-step, and the GUI shows the continuous dialog with the life stream.

Each milestone lands its own implemented Agent Note and verification as it ships; M0 only fixes the route.

## Alternatives considered

### Why not grow the token window instead of approximating context?

Raising the window defers rather than removes the limit, costs linearly, and produces no durable memory: after any reset the operator must re-prime. The substrate already exists and is verified; the work is wiring continuity to it, not paying for raw context. Rejected.

### Why not a retrieval-only memory that never accumulates?

Pure retrieval over stored documents (external RAG) captures facts but not this conversation's ongoing state or the outcome-shaped lessons the auto-accumulate path records; it also has no feedback loop. The pipeline's prediction/report loop is exactly the accumulation the alternative would discard. Rejected.

### Why not run the life as a separate daemon process?

A background process that talks to the GUI over IPC splits the verified in-process plugin seams, adds lifecycle machinery (start/stop/restart, including observed self-reflexive host restarts), and must duplicate the context/injection plumbing. The first incarnation is an in-process main conversation; an autonomous daemon remains possible later as its own note. Rejected for M1-M3.

### Why not one new mega-plugin owning all four loops?

The repo rule is that every product piece is a plugin and every plugin owns one seam; a coordinator owning state, memory, identity, and surface duplicates and shadows the verified owners. The new layer stays thin: fixes inside owning packages plus a small marker/presentation layer. Rejected.

### Why not treat every session as equally "the main conversation"?

The chain and the store are shared across sessions already; without a designated identity the chain head thrashes between whoever last spoke, and "the life" stays fragments instead of one continuous thing. Designation is a marker, not a restriction — other sessions keep working, they just are not the life conversation. Rejected.

## Acceptance criteria

### M0 — this note

The route is agreed: the four loops, their owning seams, and the M1-M3 sequence map one-to-one onto code seams that exist in the tree, and the acceptance criteria below are reviewable.

### M1 — self-sustaining loop

From a pristine `$DSH_HOME` and a fresh main conversation: the chain acquires its first node automatically (no hand-edited `chain.json`, no manual tool call), the conversation advances the head across a real stage transition, and `situational_state_trace` lists commit/inject entries for the session. The commit and trace tools are callable from the main conversation.

### M2 — memory-anchored context approximation

A scripted conversation long enough to cross a compaction boundary: after the boundary the agent recovers the thread from the substrate — it states what it was doing and what it decided — with transcript assertions, and the store shows the bounded write-back (one situational node, at most one gated experience) rather than a flood.

### M3 — identity and surface

A browser close/reopen with a new session id resumes the same designated conversation: the situational head is injected on the first pre-step, recent experience is retrievable, and the GUI renders the continuous dialog with the life stream visible.

## Risks

The compaction write-back must be durable before the surface replacement, or a crash between evict and persist loses the thread on replay; the listener therefore writes first and the synthetic writes are idempotent (retry on restart must not double nodes). Self-reflexive interruptions (the agent restarting its own host mid-turn) already interrupt citation settlement and pre-step work; bootstrap and turn-end commits must tolerate restart and never double-commit. The tool-catalog seam that exposes `predict_outcome` but not `situational_state_commit` is not yet located in code — M1 starts by finding it and follows the registration path the exposed cognition tools use; if the seam runs deep, the fix may need a dedicated note. The GUI half of M3 touches `apps/web` and client packages whose artifacts need a rebuild plus refresh verification (the shell has no HMR); M3 must budget that step. Auto-accumulation is five-gate filtered, but compaction-time synthetic writes must not become a second unvetted inflow — they reuse the same gates and stay at most one per compaction.
