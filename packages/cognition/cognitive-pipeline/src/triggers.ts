/**
 * Trigger lexicon of the injection gate: the static behavior words, the
 * SAR-derived keywords weighted by importance, and the co-occurrence jump
 * builder that turns "words that appear with a trigger in real experiences"
 * into associative jump words. The lexicon is experience-derived knowledge,
 * so it lives with the pipeline store (like the taxonomy and the acceptance
 * ledger); the inject plugin imports it rather than re-deriving it.
 * @module @deepseek-ai/dsh-cognitive-pipeline/triggers
 */

import type { CognitivePipelineService } from './service.ts'
import type { Experience } from './types.ts'
import { tokenize } from './vectorizer.ts'

/** Static behavior triggers: words whose presence means the current message
 * is asking for help, exploring, or deciding — the situations where humans
 * actually consult past experience. A single static hit triggers injection. */
export const STATIC_TRIGGERS: ReadonlySet<string> = new Set([
  '失败', '报错', '错误', '卡住', '挂起', '超时', '崩溃', '异常', '排查', '修复', '恢复',
  '怎么', '如何', '怎样', '为什么', '试试', '尝试', '测试', '验证', '确认',
  '风险', '危险', '慎重', '谨慎', '建议', '推荐', '帮助', '求助',
  '以前', '之前', '曾经', '上次', '遇到过', '经验', '参考', '回忆', '记得',
  '发布', '部署', '上线', '推送', '提交', '合并', '迁移', '升级', '安装', '配置',
  '计划', '打算', '准备', '决定', '方案', '步骤', '流程', '检查', '诊断',
])

/** CJK stop words: tokens too common to carry trigger signal. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '在', '和', '我', '你', '他', '她', '它', '是', '一', '个', '这', '那',
  '到', '就', '都', '也', '要', '会', '能', '与', '及', '或', '有', '对', '从', '被',
  '把', '让', '用', '以', '为', '上', '下', '中', '不', '没', '很', '太', '再', '又',
  '吗', '呢', '吧', '啊', '的', '地', '得', '等', '并', '而', '但', '如果', '然后',
])

/** How many SAR-derived trigger words to keep (by accumulated importance). */
export const DERIVED_TRIGGER_COUNT = 60

/** Minimum derived-trigger weight to count as a hit. */
export const DERIVED_TRIGGER_MIN = 0.3

/**
 * Importance of one experience for trigger learning: outcome extremity
 * (|utilityScore|/15) plus a high-risk bonus for negative outcomes and a
 * frequency bonus for experiences the hot loop has hit before. Experiences
 * with no signal (neutral utility, never hit) contribute nothing.
 * @param exp - the experience.
 * @returns the importance in [0, 1.2].
 */
export function importanceOf(exp: Experience): number {
  const { materialGain: gain, emotionalValence: valence, energyCost: cost } = exp.sar.outcomeUtility
  const utility = Math.abs((gain - 5) + (valence - 5) - (cost - 5)) / 15
  if (utility < 0.01 && exp.hitCount === 0 && (gain >= 5 && valence >= 5 && cost <= 5)) return 0
  const risk = gain < 5 ? 0.3 : 0
  const frequency = exp.hitCount > 0 ? Math.min(exp.hitCount, 5) * 0.1 : 0
  return utility + risk + frequency
}

/**
 * Derive the trigger lexicon from the experience store: tokens of the
 * situation/action of important experiences (high utility, high-risk, or
 * frequently hit) accumulate their importance into per-token weights, the
 * top-N survive, normalized to [DERIVED_TRIGGER_MIN, 1].
 * @param service - the pipeline service whose store feeds the lexicon.
 * @returns the derived trigger map (token → weight).
 */
export function deriveTriggerWords(service: CognitivePipelineService): Map<string, number> {
  const weights = new Map<string, number>()
  for (const exp of service.store.experiencesSnapshot()) {
    const importance = importanceOf(exp)
    if (importance <= 0) continue
    const tokens = new Set([
      ...tokenize(exp.sar.situation),
      ...tokenize(exp.sar.action),
    ])
    for (const token of tokens) {
      if (STOP_WORDS.has(token) || STATIC_TRIGGERS.has(token)) continue
      weights.set(token, (weights.get(token) ?? 0) + importance)
    }
  }
  const ranked = [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DERIVED_TRIGGER_COUNT)
  const max = ranked[0]?.[1] ?? 0
  if (max <= 0) return new Map()
  const span = 1 - DERIVED_TRIGGER_MIN
  return new Map(ranked.map(([token, weight]) => [token, DERIVED_TRIGGER_MIN + (weight / max) * span]))
}

/** One accumulated (jumpWord → trigger) association before thresholding. */
export interface JumpAccumulation {
  /** Distinct experiences backing the association. */
  readonly evidenceCount: number
  /** Sum of experience importance over the backing experiences. */
  readonly importance: number
}

/** The raw co-occurrence accumulator keyed by jump word then trigger word. */
export type JumpAccumulator = Map<string, Map<string, JumpAccumulation>>

/** Initialize an empty jump accumulator.
 * @returns a fresh empty accumulator.
 */
export function emptyJumpAccumulator(): JumpAccumulator {
  return new Map()
}

/**
 * Accumulate trigger↔token co-occurrence from the experience store. For each
 * important experience, every trigger word (static phrase or derived token)
 * present in its situation/action text associates with every other
 * non-trigger, non-stop token in that text — the jump candidate. Directional:
 * the candidate maps the co-occurring token TO the trigger, so hitting the
 * jump word activates its trigger in the gate. Derived trigger tokens are NOT
 * excluded from being jump candidates: they share the experience vocabulary,
 * and a jump adds association strength toward the more diagnostic trigger on
 * top of the token's own derived weight.
 * @param service - the pipeline service whose store feeds the accumulation.
 * @param accumulator - the accumulator to fold into (fresh from
 *   {@link emptyJumpAccumulator} for a rebuild).
 * @param derived - the derived trigger lexicon (static triggers are matched
 *   as substrings, derived ones as exact tokens).
 */
export function accumulateTriggerJumps(
  service: CognitivePipelineService,
  accumulator: JumpAccumulator,
  derived: ReadonlyMap<string, number>,
): void {
  const derivedTokens = new Set(derived.keys())
  for (const exp of service.store.experiencesSnapshot()) {
    const importance = importanceOf(exp)
    if (importance <= 0) continue
    const text = `${exp.sar.situation} ${exp.sar.action}`
    const tokens = [...new Set(tokenize(text))]
    const presentTriggers = new Set<string>()
    for (const trigger of STATIC_TRIGGERS) {
      if (text.includes(trigger)) presentTriggers.add(trigger)
    }
    for (const token of tokens) {
      if (derivedTokens.has(token)) presentTriggers.add(token)
    }
    for (const trigger of presentTriggers) {
      for (const token of tokens) {
        if (token === trigger || STOP_WORDS.has(token) || STATIC_TRIGGERS.has(token)) continue
        const byTrigger = accumulator.get(token) ?? new Map<string, JumpAccumulation>()
        const prior = byTrigger.get(trigger) ?? { evidenceCount: 0, importance: 0 }
        byTrigger.set(trigger, { evidenceCount: prior.evidenceCount + 1, importance: prior.importance + importance })
        accumulator.set(token, byTrigger)
      }
    }
  }
}
