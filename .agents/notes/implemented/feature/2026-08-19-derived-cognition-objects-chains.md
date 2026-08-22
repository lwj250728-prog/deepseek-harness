# Agent Note: derived cognition objects and goal-anchored chains

Status: implemented

English | [中文](2026-08-19-derived-cognition-objects-chains.zh.md)

## Problem

Every special-experience layer built so far — clusters, meta-cognition loops, acceptance criteria, trigger jumps — followed the same lifecycle (project from experience, persist with evidence, measure on a feedback ruler, reinforce on rebuild, expose model-visibly), but each was hand-rolled. The fifth intended layer (goal-anchored chains: aggregating a goal execution across sessions and agents into a causal skeleton) was about to be built the same way, and the recurring shape was about to repeat without being named. Meanwhile short-scenario experiences had no place for cross-session, cross-agent structure: exp_73 showed delegation rounds lost (orphaned scenes), and exp_108's viewpoint coverage operates at single-experience granularity.

## Decision

Three things ship together:

**1. The derived cognition object abstraction** (`CognitionObjectKind` in `src/cognition-objects.ts`): a kind declares its lifecycle — `project` (store → candidate build, evidence-gated), `persist`, `measure` (fold feedback into the object's ruler), `reinforce` (carry stats, apply gates), `expose` (current objects). The service holds a registry (`registerCognitionObject`/`cognitionObjects`) and a generic driver (`rebuildCognitionObject`) that runs any kind through its lifecycle. The abstraction covers the DECISION layer only: storage, channel wiring, and legacy normalization stay per-kind (the exp_93 boundary lesson — a generic abstraction must not become a brittle wrapper around per-kind execution). The four prior layers are NOT force-migrated; they informally conform and may be declared as kinds incrementally.

**2. Goal-anchored chains as the first declarative kind** (`chain`): experiences gain optional `chainId`/`parentNodeId`/`sequence` tags (legacy-normalized at load); `chains.json` persists the consolidated `ChainExperience`. `consolidate_chain` (or the generic driver) assembles the causal skeleton from tagged members: failure steps and cross-agent delegation nodes (receipts) stay structural steps, routine successes collapse into a bounded summary (memory organizes around surprises — Schank's MOP), and the chain carries its member/delegation ids, collapsed count, and the previous chain's citation stats. The citation loop extends to chains: `recordInjection` accepts a `chainId`, and `settleInjectionCitations` folds the chain-level outcome (a turn referencing the chain counts as cited) into the chain's hit/cited ledger. `chainExpose` renders the chain as structured steps for the injection path. Chains form a **goal tree**: a delegated sub-goal's chain hangs under the delegating chain (its root member references the parent's receipt), derived at consolidation/projection into `childChainIds`; `chainChildren`/`chainTreeExpose` expose the subtree for goal-structured diffusion — a hit on the parent can surface sub-goal outcomes.

**3. Chain patterns as the abstraction's first recursive consumer** (`chain-pattern`): patterns project from the chain table the way chains project from experiences. Chains sharing a structural signature (coarse goal domain + step polarity sequence, e.g. `发布:失败,失败,成功`) aggregate into a recurring goal-execution pattern (the TOPS analogue: from similar MOPs, extract the cross-situation thematic pattern), gated by `chainPatternMinMembers`, persisted in `chain_patterns.json`. Measured utility is aggregated from the member chains' citation stats: the chain-pattern kind's `measure` is dispatched from the same `settleInjectionCitations` fold, so a pattern's cited rate retroactively measures whether the grouping was useful.

## Alternatives considered

**Build chains without the object abstraction.** Rejected: the lifecycle shape had recurred four times; adding a fifth hand-rolled instance was repeating a now-identifiable pattern. The declaration costs ~30 lines per kind against the generic driver.

**Build chain patterns as bespoke logic.** Rejected: the recursion (patterns from chains, as chains from experiences) is precisely what the abstraction exists to serve — the sixth kind cost a declaration plus a store table, and its measure step reuses the same fold dispatch.

**Force-migrate the four existing layers onto the abstraction now.** Rejected per the exp_93 boundary: the abstraction must not become a brittle wrapper around per-kind execution (storage tables, legacy normalization, channel wiring all differ). Declaration is incremental.

**Chains as a linear list of recent turns (no goal tag).** Rejected: event segmentation says chains are cut at goal/state changes, not fixed intervals; the chainId tag (a goal trace id propagated by the orchestrator or set explicitly) is the binding glue.

## Consequences

- Fourteen model tools (was thirteen); a sixth persisted table (`chain_patterns.json`, plus `chains.json`); the injection citation loop now measures chain-level and pattern-level utility too.
- The chain is a DERIVED view over tagged atoms: atoms accumulate online, chains consolidate offline (at goal completion / agent idle — the systems-consolidation analogue). A chain without tags never forms. The remember tool path now carries the tag (`remember_experience` accepts `chain_id`, the goal trace id), so a caller executing a goal can tag each member as it is remembered — closing the exp_73 gap that untagged channels produced orphan scenes. Channels that still do not tag (e.g. plain subagent delegation outside the orchestrator) keep producing orphan scenes; the abstraction does not fix untagged channels, it names the gap. Patterns inherit that dependence: they aggregate only the chains that actually formed.
- Child detection anchors on a chain's ROOT member referencing the parent's receipt, which breaks the cycle a shared receipt would otherwise create (a chain whose mid-chain delegation node carries the same receipt cannot appear as its own child).
- The generic driver means the seventh and later derived objects cost a declaration, not plumbing.
