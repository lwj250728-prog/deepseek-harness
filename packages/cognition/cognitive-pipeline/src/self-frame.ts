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

/** The minimal slice this detector reads (an Experience or a raw triplet).
 *
 * cl-280(2026-09-12 16:0x, **跨会话发现 + 主会话复核**): 读侧此前只看 `sar.situation` 的前缀, 而现帧格式
 * 的 situation 是"三问帧旁路评估 #N（原因：…）" ⇒ 对 135 条帧层经验 **命中 0/135**, 而同一条判据在写侧
 * (`store.isFrameExperience`, 按 `kind`/`action` 前缀) 命中 134/134。后果被实测到: 帧层 135 条里 **131 条
 * utility 完全相同(1,0,2)且 135/135 为负极性**, 这个"novelty 恒 0 的同质失败吸引子"被 coverViewpoints 的
 * 轮换系统性捞进上下文 —— 时代内注入的 535 条条目里 **161 条是帧层(30.1%)**, 最近 30 次注入里 37%。
 * 故读侧改用与写侧**同一判据**(kind 优先, 回退 action 前缀), 而不是继续往 situation 前缀表里加条目。
 */
export interface SelfFrameCandidate {
  /** Write-side layer tag: 'frame' rows live in experiences-frames.jsonl. */
  readonly kind?: string
  readonly sar: {
    readonly situation: string
    readonly action?: string
  }
}

/** The frame template the write side prefixes onto frame-layer actions. */
const SELF_FRAME_ACTION_PREFIX = 'quiet-driver 旁路三问帧'
/** Current frame-narration format in `situation` (kept as a defence-in-depth rule). */
const SELF_FRAME_SITUATION_PREFIXES = ['三问帧旁路评估'] as const

/** Situation prefixes that mark a record as born from an autonomous frame. */
const SELF_FRAME_PREFIXES = ['自主回合', '检索路由歧义'] as const
/** Marker embedded in frame-derived situations (retrieval-ambiguity records). */
const SELF_FRAME_MARKER = '自主回合(无用户在场)'

/** Whether one candidate was born from an autonomous frame turn.
 * @param candidate - the experience or extracted SAR to judge.
 * @returns true when the situation is frame-derived self-narration.
 */
export function isSelfFrameExperience(candidate: SelfFrameCandidate): boolean {
  // 与写侧同一判据: kind 优先(cl-102/cl-033: 文本嗅探曾把一条引用了模板字符串的任务经验误判成帧经验)。
  if (candidate.kind === 'frame') return true
  if (candidate.kind === 'task') return false
  const situation = candidate.sar.situation
  const action = String(candidate.sar.action ?? '')
  return SELF_FRAME_ACTION_PREFIX.length > 0 && action.startsWith(SELF_FRAME_ACTION_PREFIX)
    || SELF_FRAME_SITUATION_PREFIXES.some(prefix => situation.startsWith(prefix))
    || SELF_FRAME_PREFIXES.some(prefix => situation.startsWith(prefix))
    || situation.includes(SELF_FRAME_MARKER)
}
