# Agent Note: Symptom-first SAR extraction and recall

Status: implemented

English | [中文](2026-08-18-symptom-first-sar-extraction-and-recall.zh.md)

## Problem

The multi-layer injection design (see [multi-layer SAR experience injection](2026-08-18-multi-layer-sar-experience-injection.md)) fixed *where* and *when* the SAR memory recalls, but not *whether the stored situation carries the recall key*. Bug experiences were stored with situation text like "深夜出现了一个会死循环的浮点 bug" — the repair context, not the failure signature. A later task "修复测试挂起问题" shares the symptom 挂起 with the original bug but not the repair wording; measured against real experiences, its dual-axis cosine was 0.147–0.236, below every threshold. The retrieval axis was correct; the data on the other side of it was not.

## Decision

**SAR extraction is symptom-first on both paths.** The `SAR_SYSTEM_PROMPT` rule for situation now requires observable failure symptoms — error text, hang, compile failure, timeout, exit code — and says the symptom is the key future-recall clue ("测试脚本突然无限挂起" rather than "测试出了问题"). The deterministic `sarFallback` mirrors it: any sentence carrying a marker from the shared `SYMPTOM_MARKERS` table is fused into the situation, so a no-route pipeline stores the same signature the LLM path would.

**Recall adds an exact-substring symptom channel.** `symptomOverlap(query, text)` in `vectorizer.ts` returns the fraction of the query's symptom markers present in the experience text. All three retrieval points — orchestrator `retrieve()`, `dsh-cognitive-inject` priming, and the hot loop — score with `max(action cosine, situation cosine, symptomOverlap)`. The hashed bag-of-words vectors dilute a short symptom query against a long situation; the exact-substring channel is the complement that survives dilution.

## Alternatives considered

**Store symptoms in a dedicated field.** Rejected: it changes the SAR triplet's durable format and every consumer for one extra axis; fusing the symptom into the situation serves both the vector and the substring channel from the data already stored.

**Rely on the cosine axes alone after symptom fusion.** Rejected: the empirical check showed "修复测试挂起问题" still scored 0.233 against the fused situation — the short query is diluted in the hashed vectors. Only the exact-substring channel crosses the threshold.

**A learned embedding for symptom matching.** Deferred: it is the pipeline's existing real-embedding deferred work; the substring channel is the deterministic step that works today.

## Consequences

Bug experiences are now stored with their failure signature in the situation and retrievable by that signature through an exact-substring channel at every recall point, including short symptom queries. `SYMPTOM_MARKERS` is shared by the fallback extraction and the recall scoring, so the vocabulary that writes the data is the same one that reads it. Known limits retained: the marker table is a fixed heuristic (no learned synonymy), and a query whose symptom never appears verbatim in any stored experience still misses.
