# Agent Note: Review scheduling as an activation regulator

Status: proposed

English | [中文](2026-09-03-review-scheduling-activation-regulator.zh.md)

## Problem

The route's memory programs need a review scheduler: when to surface an old experience again so it is recalled when needed. A naive class schedule (review "important" or "foundational" items on a calendar) imports a human artifact without the underlying law. The scheduler needs one formal model that explains WHY some items need review and WHEN, and that corrects an earlier design error (treating "likely to be needed soon" as a scheduling category).

## Proposal

Model review as an **activation regulator**, after ACT-R declarative memory: every memory item carries an activation `Aᵢ(t)` that decays power-law since its last use and receives diffusion activation from the current context. Retrieval happens when activation crosses a needed threshold. Review is one more use event: it raises activation and resets the decay clock. Spaced repetition is the discrete approximation of "re-review just before activation would drop below the needed threshold" — the Ebbinghaus/SM-2 intervals are mathematics, not a second rule set.

Within this model the human review categories are coefficients, not separate schedules:

- foundational content (later learning depends on it) sets a high baseline threshold `Rᵢ` — structurally important items may not sink low;
- high-cost content (forgetting is expensive) multiplies the threshold by the forgetting cost times its probability;
- "likely to be needed soon" is NOT a scheduling category — it is diffusion activation, supplied by retrieval at the moment of need (the current goal, the situational chain head, the prewarm window). Scheduling it in advance duplicates what the context does for free. This corrects the earlier three-class weighted formula, whose recency term scheduled diffusion activation.

Decay and use history are already pipeline concepts (`decayLambda`, `minDecayWeight`, the injection ledger's citation timestamps). The scheduler therefore becomes: at idle maintenance, find items whose predicted activation is about to cross below their needed threshold and schedule a review — an extraction practice (recall without looking), the form the pre-input review subagent already implements.

**Orthogonal axis — validity:** activation governs accessibility, not correctness. A frequently used, high-activation stale strategy is the most dangerous kind of false belief (it auto-injects). Drift re-verification checks the strategy's `verificationAnchor` and is orthogonal to activation. Both axes meet in one review action: every review is an extraction practice (raises activation) and, for procedural items, a re-verification of the anchor (checks validity). "Skilled is not the same as correct; habits need checkups."

## Epistemic status and falsification

The activation model is adopted as an engineering hypothesis (see the human-memory-orchestration note): its value is judged by whether the "review just before the needed threshold is breached" rule produces better recall at the cross-compaction acceptance than class schedules do. The activation values are proxies (citation recency, hit counts), not measurements of a brain.

## Alternatives considered

- **Class calendar schedule**: review by human categories on fixed intervals. Rejected as the formal model — it imports categories without the law, mis-schedules diffusion activation, and cannot explain why intervals should grow.
- **No scheduler (retrieval-only)**: rely on similarity hits alone. Rejected — items never re-encountered by the context decay past usefulness even when foundational; the "nobody evaluates forgetting well" gap from the agent-memory survey is exactly this silence.

## Acceptance criteria

A `dueForReview` predicate implements the activation rule over the existing records (last-use/citation timestamps, hit counts, strategy `updatedAt`, the goal/head context for diffusion) and a `recordReview` primitive refreshes activation. The scheduler consuming them runs extraction-practice reviews through the pre-input review machinery and merges drift re-verification of solidified strategies into the same pass.

## Risks

The validity axis must not be collapsed into activation — a high-activation stale strategy must still be re-verified. Command-executing anchor checks are a real execution surface and stay gated by the acceptance-command policy rather than being run unconditionally at idle.
