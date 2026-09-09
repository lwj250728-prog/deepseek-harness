/**
 * Self-frame experience detection, shared by the accumulation gate and the
 * injection retrieval (the same two-sided wiring as {@link isTaskRestatement}).
 *
 * An autonomous frame turn (quiet-driver's action/epistemic/test frames) has no
 * genuine user message: its "situation" is the frame text itself and its
 * "outcome" is the model's self-narration about the frame. Accumulated, those
 * records describe the agent's own machinery, and retrieval then injects them
 * back into later frames — a self-echo loop that grows with every frame.
 *
 * Measured (cl-102, 2026-09-10): of the last 200 injections, 21.5% carried at
 * least one such record; among the 13 historically cited injections, **zero**
 * carried one. They are pure noise in the injection set, and they crowd out
 * task-relevant experiences at the top of the ranking.
 *
 * Suppression is retrieval-side only: the records stay in the store as history
 * (they are honest records of what happened), they simply never open a frame's
 * context again.
 * @module @deepseek-ai/dsh-cognitive-pipeline/self-frame
 */

/** The minimal SAR slice this detector reads (an Experience or a raw triplet). */
export interface SelfFrameCandidate {
  readonly sar: {
    readonly situation: string
  }
}

/** Situation prefixes that mark a record as born from an autonomous frame. */
const SELF_FRAME_PREFIXES = ['自主回合', '检索路由歧义'] as const
/** Marker embedded in frame-derived situations (retrieval-ambiguity records). */
const SELF_FRAME_MARKER = '自主回合(无用户在场)'

/** Whether one candidate was born from an autonomous frame turn.
 * @param candidate - the experience or extracted SAR to judge.
 * @returns true when the situation is frame-derived self-narration.
 */
export function isSelfFrameExperience(candidate: SelfFrameCandidate): boolean {
  const situation = candidate.sar.situation
  return SELF_FRAME_PREFIXES.some(prefix => situation.startsWith(prefix))
    || situation.includes(SELF_FRAME_MARKER)
}
