# Agent Note: trigger-jump lexicon and the citation-rate loop

Status: implemented

English | [中文](2026-08-19-trigger-jump-lexicon-citation-loop.zh.md)

## Problem

The injection gate (cognitive-inject) opens on literal triggers: static behavior words and SAR-derived keywords. Literal matching misses paraphrases — "卡壳" does not trigger "卡住", "发版" does not trigger "发布" — so users describing the same situation in different words get no recall at all (the gate closes before retrieval runs). Broadening the gate with free semantic similarity would re-open the noise door exp_69 closed (0.41-weak literal hits). What is needed is an associative layer whose every entry is accountable: learned from real co-occurrence in experiences, measured by whether injections it helped trigger were actually cited, and pruned when they were not.

## Decision

The pipeline gains a **trigger-jump lexicon** plus a **citation-rate loop**:

- **Trigger lexicons move into the pipeline** (`src/triggers.ts`): `STATIC_TRIGGERS`, `STOP_WORDS`, `importanceOf`, and `deriveTriggerWords` are now pipeline-owned (the lexicon is experience-derived knowledge, like the taxonomy and acceptance ledger); cognitive-inject imports them.
- **`learn_trigger_jumps`** (tool + service method) builds the jump table deterministically: for each important experience, every trigger present in its text associates with every other non-trigger, non-stop token — directional (the co-occurring token jumps TO the trigger). A jump enters only with ≥ `triggerJumpEvidenceMin` distinct experiences, its weight normalized to [0.3, 1], capped per trigger (`triggerJumpMaxPerTrigger`) and in total (`triggerJumpTotalCap`). Derived-trigger tokens are NOT excluded from being jump candidates: they share the experience vocabulary, and a jump adds association strength toward the more diagnostic trigger on top of the token's own derived weight. With an explicit LLM route, template 9 additionally proposes synonym variants (卡住↔卡壳) that enter at zero evidence with a conservative weight — the citation loop is their evidence gate.
- **The citation loop (B)**: every injection is recorded (`recordInjection`: expIds, trigger source, contributing jump words, session) and settled at turn end (`settleInjectionCitations`: the closed turn's assistant text referencing an injected expId means cited). The outcome folds into the contributing jump words' hit/cited ledger (`foldJumpCitation`).
- **Reinforcement on rebuild**: `learn_trigger_jumps` carries each surviving jump's measured stats and applies reinforcement — a jump with ≥ `triggerJumpPruneHits` hits whose citation rate is at/below `triggerJumpPruneRate` is pruned; a well-cited jump is boosted by `rate × triggerJumpCitationBoost`. The jump table persists in `trigger_jumps.json`, injection records in `injections.jsonl`.
- **Gate integration**: the inject gate gains a jump route — jump words match as substrings (single-char co-occurrence tokens and multi-char LLM variants alike), each contribution scaled by `triggerJumpWeightScale` (default 0.5), so a single weak jump never opens the gate alone (≥2 佐证). `triggeredBy` is exported for tests and observability.

## Alternatives considered

**Free semantic similarity for gate expansion.** Rejected: it re-opens the exp_69 noise door — 0.41-weak literal hits would enter the trigger side, and the downstream retrieval/veto gates would be doing the gate's job. Every jump must carry evidence (co-occurrence count, importance, or an LLM rationale) and measured utility.

**LLM-only jump learning.** Rejected: without a route the gate would never learn (violating the pipeline's deterministic-fallback doctrine); co-occurrence is free, testable, and always available. The LLM layer is the optional enhancement on top.

**Excluding derived-trigger tokens from jump candidates.** Rejected after implementation: derived triggers and jump tokens share the experience vocabulary, so the exclusion emptied the co-occurrence layer whenever the derived lexicon was non-empty (dead code). Derived tokens may be jumps; the jump adds association strength rather than duplicating the derived route.

**Token-based jump matching in the gate.** Rejected: CJK tokenization splits per character, so multi-char LLM variants (卡壳) would never match; substring matching handles single-char and multi-char jump words uniformly.

## Consequences

- Thirteen model tools (was twelve); two new persisted tables; the inject gate opens through associative words with evidence-backed weights and a conservative scale.
- The citation loop makes the injection gate measurable: hit/cited ledgers are the ground truth behind reinforcement, so the gate learns which words actually pay off and prunes the rest — the same evidence-backed ruler as prediction calibration and acceptance criteria.
- The lexicons moved into the pipeline package, so cognitive-inject no longer owns trigger vocabulary; the deep import `@deepseek-ai/dsh-cognitive-pipeline/src/triggers.ts` is the crossing point (the package's `./src/*` export covers it).
- LLM-sourced jumps enter at zero co-occurrence evidence: their legitimacy is provisional until the citation loop validates (boosted) or prunes them.
