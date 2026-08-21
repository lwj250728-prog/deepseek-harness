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
  '1. 情境（S）：客观约束，不含主观情绪（如"老板深夜发来修改意见"）。若是排障/失败经历，必须把可观测的失败症状写进情境——错误信息、挂起、编译失败、超时、exit code 等（如"测试脚本突然无限挂起"而非"测试出了问题"）。症状是未来相似问题被检索到的关键线索。',
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
  '1. 放弃旧标签，基于【情境-策略配对的重现模式】重新聚类：把情境前提（行动者水平、环境约束、时间压力等）与所采用策略一起反复出现的模式识别为簇。',
  '2. 同一类行动在不同前提（例如新手教学 vs 资深例行）下反复出现且策略不同时，拆分为不同簇，各自给出独立策略；情境措辞有差异但策略相同则合并为一簇。',
  '3. 每个新簇必须拥有鲜明的策略导向。标签命名格式必须为："当【触发条件】出现，应【采用行动姿态】，预期获得【效用区间】"。',
  '【证据相干性（硬性约束，后端会按此校验并驳回不相干簇）】：',
  '- 每个簇的支撑证据必须是"同一效用模式"的经历：彼此在 material_gain、emotional_valence、energy_cost 三个维度上都应接近（单维差距不宜超过3），并且与簇的 expected_utility_range 一致。',
  '- energy_cost 会把表面相似的"成功"拆成不同模式：低成本成功（cost 2~4）与高投入成功（cost 5~8）是不同策略簇，禁止混入同一簇。',
  '- 无法归入任何相干簇的样本——高代价离群、中性（三个维度都是5）、仅出现1次的孤立事件——必须放入"噪声/偶发池"并忽略，禁止强行并入某个簇。',
  '- 宁缺毋滥：只有模式差异稳定且有至少3条支撑证据时才拆簇，不要为单次措辞差异过度拆分。',
  '【防幻觉锁】：',
  '- 每创建一个新簇，必须从提供的样本中引用至少3个不同的exp_id作为支撑证据；引用的exp_id必须真实存在于样本列表中，禁止编造。',
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
  samples: readonly { expId: string; actionKeywords: string; utility: string; meta?: boolean }[],
): string {
  const contextLine = context === undefined || context.length === 0 ? '' : `\n【额外上下文】：${context}`
  return `【情境】：${situation}\n【拟采取行动】：${action}${contextLine}\n\n`
    + `【历史相似案例统计】：正向结果 ${positiveCount} 个，负向结果 ${negativeCount} 个\n`
    + '【历史相似案例摘要（仅关键词与效用评分，无完整原文）】：\n'
    + samples.map(sample =>
      `- ${sample.expId}${sample.meta === true ? '【元经验-管道自身】' : ''}: 关键词[${sample.actionKeywords}] 效用(${sample.utility})`).join('\n')
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

/** Template 5: the accumulation gate — judge whether a completed turn is worth
 * becoming an experience, and extract the SAR triplet when it is. */
export const ACCUMULATE_SYSTEM_PROMPT = [
  '你是认知管线的"记忆评估官"。现在提供给你一段刚完成的代理工作（情境、行动、结果摘要）以及若干历史相似经验。',
  '【判断任务】：',
  '1. 判断这段工作是否值得沉淀为一条新经验：是否包含可复用的情境-策略模式、是否与历史经验显著不同、是否对未来的预测有指导价值。',
  '2. 值得则提取 SAR 三元组与三维效用（material_gain / emotional_valence / energy_cost，0-10，5 为中性）；不值得则 should_accumulate 为 false。',
  '【判断标准（宁缺毋滥）】：',
  '- 纯寒暄、无实质工作、与历史经验高度重复的片段不值得沉淀。',
  '- 成功经验（完成了有价值的工作）与失败经验（踩了坑、定位了根因）都值得沉淀。',
  '- 情境、行动、结果必须来自提供的材料，禁止编造。',
  '【输出JSON格式】：',
  '{',
  '  "should_accumulate": true,',
  '  "situation": "string（情境）",',
  '  "action": "string（行动）",',
  '  "outcome": "string（结果）",',
  '  "material_gain": 0-10,',
  '  "emotional_valence": 0-10,',
  '  "energy_cost": 0-10',
  '}',
].join('\n')

/** Frame template-5 input with the completed episode and similar history. */
export function frameAccumulateInput(
  episode: { situation: string; action: string; outcome: string },
  similar: readonly { expId: string; text: string; similarity: number }[],
): string {
  return `【刚完成的工作】：\n- 情境：${episode.situation}\n- 行动：${episode.action}\n- 结果：${episode.outcome}\n\n`
    + (similar.length === 0
      ? '【历史相似经验】：（无）'
      : '【历史相似经验】（用于判断是否与已积累经验重复）：\n'
        + similar.map(hit => `- [${hit.expId}] (相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join('\n'))
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
  const ruleLines = taxonomy.rules.map((rule, index) => {
    const marker = rule.polarity === 'success' ? '✅成功' : '⚠️风险'
    return `   - 规则${String.fromCharCode(65 + index)}（${marker}）：若 ${rule.condition} → 推荐 ${rule.action}，预期效用 ${rule.utilityRange.low}~${rule.utilityRange.high}`
  })
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

/** Template 6: derive a reference experience from the commonalities of similar
 * history — an online generalization for cold start. */
export const DERIVE_REFERENCE_SYSTEM_PROMPT = [
  '你是认知管线的"经验归纳官"。现在提供给你一段当前情境/拟行动，以及若干条相似的历史经验。',
  '【归纳任务】：',
  '1. 挖掘这些相似历史经验的【共同模式】：它们在什么典型情境下、采取了什么典型行动、得到了什么典型结果与效用。',
  '2. 基于共同模式，合成一条【参考经验】：一条能代表"这类情境通常如何解决"的通用经验，供未来检索使用。',
  '【生成规则】：',
  '- 参考经验的每个字段必须来自提供的相似经验，禁止凭空编造超出共同模式的细节。',
  '- 如果相似经验过少或彼此矛盾（找不到共同模式），应明确拒绝（should_derive 为 false）。',
  '- 参考经验的效用取相似经验的典型区间（material_gain / emotional_valence / energy_cost，0-10，5 为中性）。',
  '【输出JSON格式】：',
  '{',
  '  "should_derive": true,',
  '  "situation": "string（典型情境模式）",',
  '  "action": "string（典型行动策略）",',
  '  "outcome": "string（典型结果）",',
  '  "material_gain": 0-10,',
  '  "emotional_valence": 0-10,',
  '  "energy_cost": 0-10',
  '}',
].join('\n')

/** Frame template-6 input with the query and its similar history. */
export function frameDeriveReferenceInput(
  query: { situation: string; action: string },
  similar: readonly { expId: string; text: string; similarity: number }[],
): string {
  return `【当前情境】：${query.situation}\n【拟采取行动】：${query.action}\n\n`
    + (similar.length === 0
      ? '【相似历史经验】：（无——没有足够相似经验时请拒绝派生）'
      : '【相似历史经验】（按相似度排序）：\n'
        + similar.map(hit => `- [${hit.expId}] (相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join('\n'))
}

/** Template 7: refine retrieval when the deterministic routing is
 * low-confidence — the LLM route judges whether the fused top hit genuinely
 * applies, instead of the hot loop blindly trusting the cosine ranking. */
export const REFINE_RETRIEVAL_SYSTEM_PROMPT = [
  '你是认知管线的"检索精排官"。现在给出当前情境/拟行动，以及按相似度排序的候选经验。',
  '【精排任务】：',
  '1. 判断排第一的候选经验是否【真正适用于】当前情境与行动——余弦相似不代表情境可迁移。',
  '2. 重点关注前提是否一致：相同行动在不同前提（用户熟练度、环境约束、时间压力等）下可能策略相反。',
  '3. 只有当你确信 Top1 会误导（前提矛盾、情境不可迁移）时才拒绝；否则保留。',
  '【输出JSON格式】：',
  '{',
  '  "should_keep": true,',
  '  "rejected_exp_id": "string|null（拒绝时填被拒经验的expId）",',
  '  "reason": "string|null（拒绝理由，一句）"',
  '}',
].join('\n')

/** Frame template-7 input with the query and the fused candidates. */
export function frameRefineRetrievalInput(
  query: { situation: string; action: string },
  candidates: readonly { expId: string; text: string; similarity: number }[],
): string {
  return `【当前情境】：${query.situation}\n【拟采取行动】：${query.action}\n\n【候选经验】（按融合相似度排序）：\n`
    + candidates.map(hit => `- [${hit.expId}] (语义相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join('\n')
}
