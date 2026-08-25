# Agent Note: chain principle distillation — from experiences to one reusable rule

Status: implemented

English | [中文](2026-08-25-experience-distillation-chain-principles.zh.md)

## Problem

The EvolveR comparison (external research, [SAR principle review](../../proposed/architecture/2026-08-19-sar-principle-review.md) context) identified the highest-value borrowed idea we lacked: EvolveR distills a reusable decision principle from accumulated experiences, while our chains only fold member experiences into a structural summary (`assembleChain` collapses routine successes, keeps failure steps). A consolidated chain answered "what happened in this goal execution" but never "what rule should I follow next time" — the leap from atoms to principle was left to the model at every retrieval, re-deriving the same lesson from raw material each time.

## Decision

Chain consolidation gains a distillation step: with an explicit LLM route, `consolidateChain` asks the route to extract ONE reusable decision rule from the chain's members — failures first, then successes — and stores it as `ChainExperience.distilledPrinciple` (template 9, `DISTILL_SYSTEM_PROMPT` + `frameDistillInput`, the `distillChainPrinciple` helper). The principle is shorter than the folded summary and directly reusable as guidance; `chainExpose` and `chainTreeExpose` render it as `原则：…` so the injection path surfaces it.

The "宁缺毋滥" discipline applies at four points:

- **No route → nothing distilled.** Without an explicit route the chain stays a folded summary, never a fabricated rule (the same safe degradation as variant generation and trigger-jump proposals).
- **Null judgment respected.** The prompt tells the route to output `principle: null` when members are too few or share no common pattern; a null result is stored as no principle, not as a placeholder.
- **Member-set gating.** `assembleChain` carries the previous `distilledPrinciple` only while the member set is unchanged (same member ids, same order). A changed member set drops the stale rule so the caller re-distills from the new atoms — never serve an old principle against changed evidence. `consolidateChain` runs distillation only on first consolidation or when the member set changed, so an unchanged chain keeps its rule (or its judged "no common pattern" verdict) without a fresh LLM call each idle cycle.
- **Bounds.** The route's principle is capped at 120 chars and its reasoning at 200 chars on read; the prompt itself demands ≤ 60 chars.

## Alternatives considered

**Distill inside the cold-loop taxonomy rebuild instead.** Rejected: taxonomy clusters are utility-space groupings, not goal-anchored sequences; the principle belongs to the chain, which already carries the causal skeleton and the goal anchor that give the rule its transferable meaning.

**Always re-distill every consolidation.** Rejected: offline consolidation runs on an idle cadence; an unchanged chain would burn an LLM call every cycle for the same atoms. The member-set gate keeps the cheap path deterministic and the expensive path evidence-driven.

**Store multiple principles per chain (one per failure mode).** Rejected: the EvolveR analogue is one distilled lesson per episode; a list would blur the boundary between the principle and the already-present step list. One rule per chain keeps the injection surface sharp.

## Consequences

- `ChainExperience` gains `distilledPrinciple?`; `chains.json` rows written before this change load without it (absent on legacy rows).
- One new prompt template (template 9, shared numbering with the trigger-jump proposal template — both are the ninth template slot in `prompts.ts`/`llm.ts`), one new llm helper with a deterministic no-route fallback, and the member-set carry logic in `assembleChain` shared by both consolidation paths (`consolidateChain` and the `chain` object-kind projection).
- The model-visible chain surface now carries the distilled rule (`chainExpose`/`chainTreeExpose`), so a retrieved chain teaches the principle directly instead of only narrating what happened.
- The zh/EN `ChainExperience` type-equiv docs and both package READMEs were updated in the same change; the existing 158-test suite plus five new distillation tests cover the route/non-route, member-set carry, member-set re-distill, and offline-consolidation paths.
