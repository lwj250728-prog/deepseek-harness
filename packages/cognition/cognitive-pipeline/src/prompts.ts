/**
 * Prompt templates of the cognitive pipeline, adapted from the DCA-PED
 * production prompt library (03-提示词模板库.md). Four templates plus the
 * dynamic cognition prefix (附录B). Every template demands structured JSON
 * output; callers enforce the JSON contract and degrade deterministically.
 * @module @deepseek-ai/dsh-cognitive-pipeline/prompts
 */

import type { Experience, TaxonomyState } from './types.ts'

/** Template 1: SAR triplet extraction and utility scoring. */
export const SAR_SYSTEM_PROMPT = [
  '你是一位经验编码专家。你的任务是从用户提供的原始经历文本中，提取出严格的"情境-行动-结果"（SAR）三元组。',
  '【提取规则】：',
  '1. 情境（S）：客观约束，不含主观情绪（如"老板深夜发来修改意见"）。',
  '2. 行动（A）：主体发出的具体行为策略（如"立即起身去健身房"而非"感觉很糟"）。',
  '3. 结果（R）：可观测的短期+长期反馈（如"失眠但次日获得表扬"）。必须包含收益/代价的量化描述。',
  '【输出格式】：严格按照以下JSON Schema输出：',
  '{',
  '  "situation": "string",',
  '  "action": "string",',
  '  "outcome": "string",',
  '  "action_keywords": ["list", "of", "verbs"],',
  '  "outcome_utility_score": {',
  '    "material_gain": 0-10,',
  '    "emotional_valence": 0-10,',
  '    "energy_cost": 0-10',
  '  }',
  '}',
].join('\n')

/** Template 2: hot-loop OOD review / strangeness confirmation. */
export const OOD_REVIEW_SYSTEM_PROMPT = [
  '你是系统的"不确定性雷达"。给你一段新的【行动描述】和检索到的【Top-3历史相似行动】。',
  '请判断：新行动是否属于历史模式中某个已知策略的合理变体，还是完全陌生的新物种？',
  '判断标准：',
  '- 如果只是"参数调整"（如跑步距离从5公里变6公里），标记为"known"。',
  '- 如果"逻辑意图"发生了变化（如从"为健康跑步"变为"为逃避工作跑步"），标记为"novel"。',
  '【输出JSON格式】：',
  '{',
  '  "is_known": boolean,',
  '  "confidence_score": 0-100,',
  '  "reasoning_short": "一句话理由",',
  '  "suggested_initial_risk_level": "low" | "medium" | "high"',
  '}',
].join('\n')

/** Template 3: five-layer confidence calibration with adversarial challenge. */
export const CALIBRATION_SYSTEM_PROMPT = [
  '你是一位严谨的决策顾问。基于用户当前的【情境】和【拟采取行动】，以及系统检索到的历史相似案例（其中正向结果M个，负向结果N个），请执行以下分步思维：',
  '第一步（基准估算）：仅根据M和N的比例，给出初始成功率基准。',
  '第二步（对抗性挑战，关键步骤）：请强制列举3个独立的、具体的、即使历史数据看起来不错但仍可能导致本次行动彻底失败的外部因素。例如：天气突变、关键人物临时缺席、政策窗口关闭等。',
  '第三步（区间校准）：基于上述风险因素，重新校正你的判断。不要给单点概率，而是给出一个80%的置信区间 [下限, 上限]。注意：越不确定，区间应该越宽（例如允许20%~80%）；越确定，区间可以缩窄（如60%~75%）。',
  '【严格JSON输出格式】：',
  '{',
  '  "base_success_rate": 0-100,',
  '  "risk_factors": ["具体因素1", "具体因素2", "具体因素3"],',
  '  "final_confidence_interval_low": 0-100,',
  '  "final_confidence_interval_high": 0-100,',
  '  "final_calibrated_probability": 0-100,',
  '  "advice_preview": "给用户的极简行动建议（不超过20字）"',
  '}',
].join('\n')

/** Template 4: cold-loop causal-anchored taxonomy reconstruction. */
export const RECONSTRUCT_SYSTEM_PROMPT = [
  '你是认知架构的"首席重构官"。现在提供给你一组经过筛选的经历样本（每个样本包含ID、情境、行动、结果效用评分）。当前旧的分类体系已经因为高频预测误差而失效。',
  '【重构任务】：',
  '1. 放弃旧标签，完全基于这些样本的结果效用评分（outcome_utility_score）的相似性，重新聚类。',
  '2. 每个新簇必须拥有鲜明的策略导向。标签命名格式必须为："当【触发条件】出现，应【采用行动姿态】，预期获得【效用区间】"。',
  '【硬性约束（防幻觉锁）】：',
  '- 每创建一个新簇，必须从提供的样本中引用至少3个不同的exp_id作为支撑证据。',
  '- 禁止将仅出现1次的孤立事件设为一个新簇；若无法找到3个支撑证据，请将该样本归类至"噪声/偶发池"并忽略。',
  '【输出JSON格式】：',
  '{',
  '  "new_clusters": [',
  '    {',
  '      "cluster_name": "string",',
  '      "decision_rule": "if condition X then action Y",',
  '      "expected_utility_range": {"low": 0, "high": 10},',
  '      "supporting_evidence_ids": ["exp_001", "exp_045", "exp_102"],',
  '      "fallback_action": "当匹配度<60%时的备选策略"',
  '    }',
  '  ],',
  '  "taxonomy_summary_short": "一句话概括本次重构的核心逻辑变化（限30字）"',
  '}',
].join('\n')

/** Frame template-1 input.
 * @param rawText - the raw experience text.
 * @returns the user message body.
 */
export function frameSarInput(rawText: string): string {
  return `原始经历文本：\n${rawText}`
}

/** Frame template-2 input with the new action and the top-3 historical actions.
 * @param action - the proposed action.
 * @param topActions - historical actions with similarity.
 * @returns the user message body.
 */
export function frameOodInput(action: string, topActions: readonly { expId: string; action: string; similarity: number }[]): string {
  const history = topActions.length === 0
    ? '（无历史相似行动）'
    : topActions.map(sample =>
      `- ${sample.expId} (相似度 ${sample.similarity.toFixed(3)}): ${sample.action}`).join('\n')
  return `【新的行动描述】：${action}\n\n【Top-3历史相似行动】：\n${history}`
}

/** Frame template-3 input with the situation/action and top-K sample stats.
 * @param situation - the current situation.
 * @param action - the proposed action.
 * @param context - optional extra context.
 * @param positiveCount - positive history hits.
 * @param negativeCount - negative history hits.
 * @param samples - compact sample summaries.
 * @returns the user message body.
 */
export function frameCalibrationInput(
  situation: string,
  action: string,
  context: string | undefined,
  positiveCount: number,
  negativeCount: number,
  samples: readonly { expId: string; actionKeywords: string; utility: string }[],
): string {
  const contextLine = context === undefined || context.length === 0 ? '' : `\n【额外上下文】：${context}`
  return `【情境】：${situation}\n【拟采取行动】：${action}${contextLine}\n\n`
    + `【历史相似案例统计】：正向结果 ${positiveCount} 个，负向结果 ${negativeCount} 个\n`
    + '【历史相似案例摘要（仅关键词与效用评分，无完整原文）】：\n'
    + samples.map(sample =>
      `- ${sample.expId}: 关键词[${sample.actionKeywords}] 效用(${sample.utility})`).join('\n')
}

/** Frame template-4 input with the sampled experiences.
 * @param samples - the sampled train experiences.
 * @returns the user message body.
 */
export function frameReconstructInput(samples: readonly Experience[]): string {
  return samples.map((sample) => {
    const u = sample.sar.outcomeUtility
    return `- ${sample.expId}: 情境="${sample.sar.situation}" 行动="${sample.sar.action}" `
      + `结果效用(material_gain=${u.materialGain}, emotional_valence=${u.emotionalValence}, energy_cost=${u.energyCost})`
  }).join('\n')
}

/** 附录B: the dynamic cognition prefix injected into the hot-loop system prompt.
 * @param taxonomy - the current taxonomy, or null before the first rebuild.
 * @returns the prefix text.
 */
export function cognitionPrefix(taxonomy: TaxonomyState | null): string {
  if (taxonomy === null || taxonomy.rules.length === 0) {
    return [
      '【当前活跃认知框架（最后更新于：无——尚未完成首次重构）】：',
      '1. 分类体系摘要：尚无。系统处于冷启动阶段，一切情境按"全新现象"谨慎处理。',
      '',
      '【系统元认知】：',
      '- 对于未列入上述规则的陌生情境，系统将明确告知不确定性。',
      '- 所有概率输出均经过样本量收缩与校准，请用户参考区间而非点估计。',
    ].join('\n')
  }
  const ruleLines = taxonomy.rules.map((rule, index) =>
    `   - 规则${String.fromCharCode(65 + index)}：若 ${rule.condition} → 推荐 ${rule.action}，预期效用 ${rule.utilityRange.low}~${rule.utilityRange.high}`)
  return [
    `【当前活跃认知框架（最后更新于 ${new Date(taxonomy.updatedAt).toISOString()}，版本 ${taxonomy.version}）】：`,
    `1. 分类体系摘要：${taxonomy.summaryShort}`,
    '2. 核心决策规则树：',
    ...ruleLines,
    '',
    '【系统元认知】：',
    '- 对于未列入上述规则的陌生情境，系统将明确告知不确定性。',
    '- 所有概率输出均经过样本量收缩与校准，请用户参考区间而非点估计。',
  ].join('\n')
}
