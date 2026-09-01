# Agent Note: veto-before-strategy-promotion — injection accuracy for solidified strategies

Status: implemented

English | [中文](2026-08-26-veto-before-strategy-promotion.zh.md)

## Problem

The cognitive-inject priming path promoted solidified strategies **before** the template-7 veto gate ran, and the promotion rule trusted chain membership alone. Both defects fired together in the live `web` deployment and produced an unrelated injection.

The observed trace (`inject_75` in `injections.jsonl`): a user asked "why does experience injection stay inaccurate" — the message contained the static trigger 错误, retrieval surfaced `exp_69` (a record of the same noise-injection problem) and `exp_182` (a record of a prior solidified-strategy verification run), and `solidifiedStrategyForHits` Channel 1 saw `exp_182.chainId === 'chain-restart'`, matched the strategy seeded by that chain (`solidified-1`, goal domain 重启), and returned it. The plugin then injected the 【固化策略 重启】 block and returned — the veto gate below it never ran. The LLM精排官, which by design receives the prewarmed session context, was never consulted. The correct retrieval (two directly relevant experiences) was replaced by an unrelated restart strategy.

Two root causes:

1. **Promotion bypassed the veto gate.** The strategy branch (chain match → inject STRATEGY → return) sat *above* `vetoTopCandidates`, so an LLM route — when present — never judged whether the strategy genuinely applied. A chain link was treated as self-justifying transferability.
2. **Channel 1 trusted chain membership alone.** `solidifiedStrategyForHits` returned a strategy when any hit's `chainId` matched `sourceChainId`, with no check that the strategy's goal domain relates to the current situation. An experience that merely *records* the chain's past verification (its situation is about the strategy, not the task) could promote the strategy out of context.

## Decision

Two changes in `packages/context/cognitive-inject/src/index.ts`:

- **Veto before promotion (B2).** The strategy branch moved below `vetoTopCandidates`. The veto gate now runs on every retrieved candidate first; promotion considers only the **accepted** hits. An all-rejected step suppresses strategy injection exactly as it suppresses plain reference injection, and `recordInjection` records the accepted `expIds` in both branches.
- **Goal-domain gate on Channel 1 (B1).** `solidifiedStrategyForHits` Channel 1 now requires `strategy.goalDomain.length > 0 && situation.includes(strategy.goalDomain)` in addition to the chain link — the same relevance gate Channel 2 already applied. A chain-linked hit whose situation does not carry the goal domain falls through to the plain reference block instead of promoting the strategy.

The order is now: trigger gate → retrieval → veto (with prewarm context) → strategy promotion on accepted hits → reference block.

## Alternatives considered

**Reject the chain member in retrieval instead.** Rejected: the chain-linked experiences (`exp_69`, `exp_182`) were genuinely the right recall for the user's question; the defect was the *promotion*, not the retrieval. Filtering them would have thrown away the correct answer alongside the wrong one.

**Run the veto only when a chain link is present.** Rejected: the veto is the general applicability judgement; making it conditional on chain links would re-introduce the bypass for every non-chain promotion path and keep two parallel admission standards.

## Consequences

- A chain-linked hit whose situation matches the strategy's goal domain and passes the veto still injects the STRATEGY block (the converged form wins when it genuinely applies); every other chain-linked hit falls through to the plain reference block, and a vetoed chain hit injects nothing.
- The LLM精排官's prewarm-enriched situation (`【当前会话正在进行】…【当前消息】…`) now also governs strategy promotion, closing the design gap that let a verification-record experience promote the restart strategy.
- Costs: one reordered branch plus one added condition in `solidifiedStrategyForHits`; two new package tests (`does not promote a strategy when the chain-linked hit lacks the goal domain`, `vetoes a chain-linked candidate before any strategy promotion`) and the existing strategy-priority test still pass (24 tests). README (EN/ZH) flow updated to show veto → promotion → reference.
- The same class of defect is now covered by tests at the exact failure shape observed live: a chain-linked hit that merely records the chain, and a goal-matching hit vetoed by the route.

## Verification

`pnpm vitest run packages/context/cognitive-inject` — 24 passed. `tsc -p packages/context/cognitive-inject` and `oxlint` on the changed files — clean. Live confirmation on the `web` deployment is pending a restart of the DSH host (the profile patch mounts the pipeline at the host plane).
