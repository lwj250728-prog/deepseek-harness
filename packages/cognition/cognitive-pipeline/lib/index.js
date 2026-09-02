import { _ as symptomOverlap, a as SYMPTOM_MARKERS, b as variantConvergence, c as cosine, d as isPositiveOutcome, f as normalize, g as situationVector, h as signatureHash, i as OUTCOME_VECTOR_DIM, l as disequilibriumOf, m as outcomeVector, n as DEFAULT_DISEQUILIBRIUM_MIN_SAMPLES, o as UTILITY_SLOTS, p as outcomePolarity, r as DEFAULT_DISEQUILIBRIUM_Z, s as actionVector, t as ACTION_VECTOR_DIM, u as hashToken, v as tokenize, y as utilityScore } from "./vectorizer-CLvOIhoX.js";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { BlockAssembler, ReasoningEffortId, createUserMessage, deepFreeze } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
//#region lib/types/prompts.js
/**
* Prompt templates of the cognitive pipeline, adapted from the DCA-PED
* production prompt library (03-提示词模板库.md). Four templates plus the
* dynamic cognition prefix (附录B). Every template demands structured JSON
* output; callers enforce the JSON contract and degrade deterministically.
* @module @deepseek-ai/dsh-cognitive-pipeline/prompts
*/
/** Template 1: SAR triplet extraction and utility scoring. */
const SAR_SYSTEM_PROMPT = [
	"你是一位经验编码专家。你的任务是从用户提供的原始经历文本中，提取出严格的\"情境-行动-结果\"（SAR）三元组。",
	"【提取规则】：",
	"1. 情境（S）：客观约束，不含主观情绪（如\"老板深夜发来修改意见\"）。若是排障/失败经历，必须把可观测的失败症状写进情境——错误信息、挂起、编译失败、超时、exit code 等（如\"测试脚本突然无限挂起\"而非\"测试出了问题\"）。症状是未来相似问题被检索到的关键线索。",
	"2. 行动（A）：主体发出的具体行为策略（如\"立即起身去健身房\"而非\"感觉很糟\"）。",
	"3. 结果（R）：可观测的短期+长期反馈（如\"失眠但次日获得表扬\"）。必须包含收益/代价的量化描述。",
	"【输出格式】：严格按照以下JSON Schema输出：",
	"{",
	"  \"situation\": \"string\",",
	"  \"action\": \"string\",",
	"  \"outcome\": \"string\",",
	"  \"action_keywords\": [\"list\", \"of\", \"verbs\"],",
	"  \"outcome_utility_score\": {",
	"    \"material_gain\": 0-10,",
	"    \"emotional_valence\": 0-10,",
	"    \"energy_cost\": 0-10",
	"  }",
	"}"
].join("\n");
/** Template 2: hot-loop OOD review / strangeness confirmation. */
const OOD_REVIEW_SYSTEM_PROMPT = [
	"你是系统的\"不确定性雷达\"。给你一段新的【行动描述】和检索到的【Top-3历史相似行动】。",
	"请判断：新行动是否属于历史模式中某个已知策略的合理变体，还是完全陌生的新物种？",
	"判断标准：",
	"- 如果只是\"参数调整\"（如跑步距离从5公里变6公里），标记为\"known\"。",
	"- 如果\"逻辑意图\"发生了变化（如从\"为健康跑步\"变为\"为逃避工作跑步\"），标记为\"novel\"。",
	"【输出JSON格式】：",
	"{",
	"  \"is_known\": boolean,",
	"  \"confidence_score\": 0-100,",
	"  \"reasoning_short\": \"一句话理由\",",
	"  \"suggested_initial_risk_level\": \"low\" | \"medium\" | \"high\"",
	"}"
].join("\n");
/** Template 3: five-layer confidence calibration with adversarial challenge. */
const CALIBRATION_SYSTEM_PROMPT = [
	"你是一位严谨的决策顾问。基于用户当前的【情境】和【拟采取行动】，以及系统检索到的历史相似案例（其中正向结果M个，负向结果N个），请执行以下分步思维：",
	"第一步（基准估算）：仅根据M和N的比例，给出初始成功率基准。",
	"第二步（对抗性挑战，关键步骤）：请强制列举3个独立的、具体的、即使历史数据看起来不错但仍可能导致本次行动彻底失败的外部因素。例如：天气突变、关键人物临时缺席、政策窗口关闭等。",
	"第三步（区间校准）：基于上述风险因素，重新校正你的判断。不要给单点概率，而是给出一个80%的置信区间 [下限, 上限]。注意：越不确定，区间应该越宽（例如允许20%~80%）；越确定，区间可以缩窄（如60%~75%）。",
	"【严格JSON输出格式】：",
	"{",
	"  \"base_success_rate\": 0-100,",
	"  \"risk_factors\": [\"具体因素1\", \"具体因素2\", \"具体因素3\"],",
	"  \"final_confidence_interval_low\": 0-100,",
	"  \"final_confidence_interval_high\": 0-100,",
	"  \"final_calibrated_probability\": 0-100,",
	"  \"advice_preview\": \"给用户的极简行动建议（不超过20字）\"",
	"}"
].join("\n");
/** Template 4: cold-loop causal-anchored taxonomy reconstruction. */
const RECONSTRUCT_SYSTEM_PROMPT = [
	"你是认知架构的\"首席重构官\"。现在提供给你一组经过筛选的经历样本（每个样本包含ID、情境、行动、结果效用评分）。当前旧的分类体系已经因为高频预测误差而失效。",
	"【重构任务】：",
	"1. 放弃旧标签，基于【情境-策略配对的重现模式】重新聚类：把情境前提（行动者水平、环境约束、时间压力等）与所采用策略一起反复出现的模式识别为簇。",
	"2. 同一类行动在不同前提（例如新手教学 vs 资深例行）下反复出现且策略不同时，拆分为不同簇，各自给出独立策略；情境措辞有差异但策略相同则合并为一簇。",
	"3. 每个新簇必须拥有鲜明的策略导向。标签命名格式必须为：\"当【触发条件】出现，应【采用行动姿态】，预期获得【效用区间】\"。",
	"【证据相干性（硬性约束，后端会按此校验并驳回不相干簇）】：",
	"- 每个簇的支撑证据必须是\"同一效用模式\"的经历：彼此在 material_gain、emotional_valence、energy_cost 三个维度上都应接近（单维差距不宜超过3），并且与簇的 expected_utility_range 一致。",
	"- energy_cost 会把表面相似的\"成功\"拆成不同模式：低成本成功（cost 2~4）与高投入成功（cost 5~8）是不同策略簇，禁止混入同一簇。",
	"- 无法归入任何相干簇的样本——高代价离群、中性（三个维度都是5）、仅出现1次的孤立事件——必须放入\"噪声/偶发池\"并忽略，禁止强行并入某个簇。",
	"- 宁缺毋滥：只有模式差异稳定且有至少3条支撑证据时才拆簇，不要为单次措辞差异过度拆分。",
	"【防幻觉锁】：",
	"- 每创建一个新簇，必须从提供的样本中引用至少3个不同的exp_id作为支撑证据；引用的exp_id必须真实存在于样本列表中，禁止编造。",
	"【输出JSON格式】：",
	"{",
	"  \"new_clusters\": [",
	"    {",
	"      \"cluster_name\": \"string\",",
	"      \"decision_rule\": \"if condition X then action Y\",",
	"      \"expected_utility_range\": {\"low\": 0, \"high\": 10},",
	"      \"supporting_evidence_ids\": [\"exp_001\", \"exp_045\", \"exp_102\"],",
	"      \"fallback_action\": \"当匹配度<60%时的备选策略\"",
	"    }",
	"  ],",
	"  \"taxonomy_summary_short\": \"一句话概括本次重构的核心逻辑变化（限30字）\"",
	"}"
].join("\n");
/** Frame template-1 input.
* @param rawText - the raw experience text.
* @returns the user message body.
*/
function frameSarInput(rawText) {
	return `原始经历文本：\n${rawText}`;
}
/** Frame template-2 input with the new action and the top-3 historical actions.
* @param action - the proposed action.
* @param topActions - historical actions with similarity.
* @returns the user message body.
*/
function frameOodInput(action, topActions) {
	return `【新的行动描述】：${action}\n\n【Top-3历史相似行动】：\n${topActions.length === 0 ? "（无历史相似行动）" : topActions.map((sample) => `- ${sample.expId} (相似度 ${sample.similarity.toFixed(3)}): ${sample.action}`).join("\n")}`;
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
function frameCalibrationInput(situation, action, context, positiveCount, negativeCount, samples) {
	return `【情境】：${situation}\n【拟采取行动】：${action}${context === void 0 || context.length === 0 ? "" : `\n【额外上下文】：${context}`}\n\n【历史相似案例统计】：正向结果 ${positiveCount} 个，负向结果 ${negativeCount} 个\n【历史相似案例摘要（仅关键词与效用评分，无完整原文）】：
` + samples.map((sample) => `- ${sample.expId}${sample.meta === true ? "【元经验-管道自身】" : ""}: 关键词[${sample.actionKeywords}] 效用(${sample.utility})`).join("\n");
}
/** Frame template-4 input with the sampled experiences.
* @param samples - the sampled train experiences.
* @returns the user message body.
*/
function frameReconstructInput(samples) {
	return samples.map((sample) => {
		const u = sample.sar.outcomeUtility;
		return `- ${sample.expId}: 情境="${sample.sar.situation}" 行动="${sample.sar.action}" 结果效用(material_gain=${u.materialGain}, emotional_valence=${u.emotionalValence}, energy_cost=${u.energyCost})`;
	}).join("\n");
}
/** Template 8: structured variant generation for a strategy whose deviation
* gate flagged rework (or a disequilibrated experience). The variant perturbs
* one step or parameter while keeping the verification anchor's semantics
* unchanged — the anchor is the test, the variant is the revised procedure. */
const VARIANT_SYSTEM_PROMPT = [
	"你是认知架构的\"策略改进工程师\"。给定一个已失衡的固化策略（其结果分布偏移/偏离门触发），需要生成结构化变体候选。",
	"【生成任务】：",
	"1. 对原行动的**单一环节或参数**做扰动（如：调整超时值、增删一个前置校验、改变执行顺序、更换工具选择），生成 2-3 个变体。",
	"2. **验收锚点语义必须保持不变**：变体执行后仍必须能用同一个锚点机器核验成功——锚点是测试判据，变体是修订后的流程。",
	"3. 每个变体必须指明扰动了哪个环节/参数，以及一句话理由（针对给定的失衡原因）。",
	"【宁缺毋滥】：",
	"- 只生成有真实改进假设的变体；不要纯措辞改写，不要与原文案等价的不同说法。",
	"- 如果原行动没有可安全扰动的环节，返回空数组。",
	"【输出JSON格式】：",
	"{",
	"  \"variants\": [",
	"    {",
	"      \"variant_action\": \"扰动后的完整行动文本\",",
	"      \"perturbed_aspect\": \"被扰动的环节/参数名\",",
	"      \"rationale\": \"一句话改进理由\"",
	"    }",
	"  ]",
	"}"
].join("\n");
/** Frame template-8 input with the base strategy and the failure signal.
* @param input - base action, verification anchor, pre-checks, and the reason.
* @returns the user message body.
*/
function frameVariantInput(input) {
	const preChecks = input.preChecks.length === 0 ? "（无）" : input.preChecks.map((check) => `- ${check}`).join("\n");
	return `【原策略行动】：${input.baseAction}\n\n【验收锚点】：${input.verificationAnchor}\n\n【前置校验】：\n${preChecks}\n\n【失衡原因】：${input.reason}`;
}
/** Template 5: the accumulation gate — judge whether a completed turn is worth
* becoming an experience, and extract the SAR triplet when it is. */
const ACCUMULATE_SYSTEM_PROMPT = [
	"你是认知管线的\"记忆评估官\"。现在提供给你一段刚完成的代理工作（情境、行动、结果摘要）以及若干历史相似经验。",
	"【判断任务】：",
	"1. 判断这段工作是否值得沉淀为一条新经验：是否包含可复用的情境-策略模式、是否与历史经验显著不同、是否对未来的预测有指导价值。",
	"2. 值得则提取 SAR 三元组与三维效用（material_gain / emotional_valence / energy_cost，0-10，5 为中性）；不值得则 should_accumulate 为 false。",
	"【判断标准（宁缺毋滥）】：",
	"- 纯寒暄、无实质工作、与历史经验高度重复的片段不值得沉淀。",
	"- 成功经验（完成了有价值的工作）与失败经验（踩了坑、定位了根因）都值得沉淀。",
	"- 情境、行动、结果必须来自提供的材料，禁止编造。",
	"- 材料中标注【自反操作】或【推测性行动】时：行动不得把外部动作写成代理自身所为——杀进程后的实际动作不由本会话执行，若无法区分\"我做的\"与\"外部做的\"，应如实标注或拒绝沉淀，禁止脑补。",
	"- 任务委派轮次不值得沉淀：当这段工作只是\"接收/转述一个任务指令\"（情境是任务文本、行动是复述任务而非真实工具操作）时，拒绝——任务指令描述的是未来目标，不是发生过的经历；把它存成经验会产生与检索情境逐字相似的任务复述，污染注入头条（exp_155/168 教训）。",
	"【输出JSON格式】：",
	"{",
	"  \"should_accumulate\": true,",
	"  \"situation\": \"string（情境）\",",
	"  \"action\": \"string（行动）\",",
	"  \"outcome\": \"string（结果）\",",
	"  \"material_gain\": 0-10,",
	"  \"emotional_valence\": 0-10,",
	"  \"energy_cost\": 0-10",
	"}"
].join("\n");
/** Frame template-5 input with the completed episode and similar history.
* @param episode - the completed turn's situation/action/outcome material.
* @param similar - retrieved history hits for the novelty judgment.
* @returns the framed prompt text.
*/
function frameAccumulateInput(episode, similar) {
	return `【刚完成的工作】：\n- 情境：${episode.situation}\n- 行动：${episode.action}\n- 结果：${episode.outcome}\n\n` + (similar.length === 0 ? "【历史相似经验】：（无）" : "【历史相似经验】（用于判断是否与已积累经验重复）：\n" + similar.map((hit) => `- [${hit.expId}] (相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join("\n"));
}
/** 附录B: the dynamic cognition prefix injected into the hot-loop system prompt.
* @param taxonomy - the current taxonomy, or null before the first rebuild.
* @returns the prefix text.
*/
function cognitionPrefix(taxonomy) {
	if (taxonomy === null || taxonomy.rules.length === 0) return [
		"【当前活跃认知框架（最后更新于：无——尚未完成首次重构）】：",
		"1. 分类体系摘要：尚无。系统处于冷启动阶段，一切情境按\"全新现象\"谨慎处理。",
		"",
		"【系统元认知】：",
		"- 对于未列入上述规则的陌生情境，系统将明确告知不确定性。",
		"- 所有概率输出均经过样本量收缩与校准，请用户参考区间而非点估计。"
	].join("\n");
	const ruleLines = taxonomy.rules.map((rule, index) => {
		const marker = rule.polarity === "success" ? "✅成功" : "⚠️风险";
		return `   - 规则${String.fromCharCode(65 + index)}（${marker}）：若 ${rule.condition} → 推荐 ${rule.action}，预期效用 ${rule.utilityRange.low}~${rule.utilityRange.high}`;
	});
	return [
		`【当前活跃认知框架（最后更新于 ${new Date(taxonomy.updatedAt).toISOString()}，版本 ${taxonomy.version}）】：`,
		`1. 分类体系摘要：${taxonomy.summaryShort}`,
		"2. 核心决策规则树：",
		...ruleLines,
		"",
		"【系统元认知】：",
		"- 对于未列入上述规则的陌生情境，系统将明确告知不确定性。",
		"- 所有概率输出均经过样本量收缩与校准，请用户参考区间而非点估计。"
	].join("\n");
}
/** Template 6: derive a reference experience from the commonalities of similar
* history — an online generalization for cold start. */
const DERIVE_REFERENCE_SYSTEM_PROMPT = [
	"你是认知管线的\"经验归纳官\"。现在提供给你一段当前情境/拟行动，以及若干条相似的历史经验。",
	"【归纳任务】：",
	"1. 挖掘这些相似历史经验的【共同模式】：它们在什么典型情境下、采取了什么典型行动、得到了什么典型结果与效用。",
	"2. 基于共同模式，合成一条【参考经验】：一条能代表\"这类情境通常如何解决\"的通用经验，供未来检索使用。",
	"【生成规则】：",
	"- 参考经验的每个字段必须来自提供的相似经验，禁止凭空编造超出共同模式的细节。",
	"- 如果相似经验过少或彼此矛盾（找不到共同模式），应明确拒绝（should_derive 为 false）。",
	"- 参考经验的效用取相似经验的典型区间（material_gain / emotional_valence / energy_cost，0-10，5 为中性）。",
	"【输出JSON格式】：",
	"{",
	"  \"should_derive\": true,",
	"  \"situation\": \"string（典型情境模式）\",",
	"  \"action\": \"string（典型行动策略）\",",
	"  \"outcome\": \"string（典型结果）\",",
	"  \"material_gain\": 0-10,",
	"  \"emotional_valence\": 0-10,",
	"  \"energy_cost\": 0-10",
	"}"
].join("\n");
/** Frame template-6 input with the query and its similar history.
* @param query - the current situation/action to anchor the derivation.
* @param similar - the retrieved similar history hits.
* @returns the framed prompt text.
*/
function frameDeriveReferenceInput(query, similar) {
	return `【当前情境】：${query.situation}\n【拟采取行动】：${query.action}\n\n` + (similar.length === 0 ? "【相似历史经验】：（无——没有足够相似经验时请拒绝派生）" : "【相似历史经验】（按相似度排序）：\n" + similar.map((hit) => `- [${hit.expId}] (相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join("\n"));
}
/** Template 7: refine retrieval when the deterministic routing is
* low-confidence — the LLM route judges whether the fused top hit genuinely
* applies, instead of the hot loop blindly trusting the cosine ranking. */
const REFINE_RETRIEVAL_SYSTEM_PROMPT = [
	"你是认知管线的\"检索精排官\"。现在给出当前情境/拟行动，以及按相似度排序的候选经验。",
	"【精排任务】：",
	"1. 判断排第一的候选经验是否【真正适用于】当前情境与行动——余弦相似不代表情境可迁移。",
	"2. 重点关注前提是否一致：相同行动在不同前提（用户熟练度、环境约束、时间压力等）下可能策略相反。",
	"3. 只有当你确信 Top1 会误导（前提矛盾、情境不可迁移）时才拒绝；否则保留。",
	"【输出JSON格式】：",
	"{",
	"  \"should_keep\": true,",
	"  \"rejected_exp_id\": \"string|null（拒绝时填被拒经验的expId）\",",
	"  \"reason\": \"string|null（拒绝理由，一句）\"",
	"}"
].join("\n");
/** Frame template-7 input with the query and the fused candidates.
* @param query - the current situation/action being predicted.
* @param candidates - the fused candidates, best first.
* @returns the framed prompt text.
*/
function frameRefineRetrievalInput(query, candidates) {
	return `【当前情境】：${query.situation}\n【拟采取行动】：${query.action}\n\n【候选经验】（按融合相似度排序）：\n` + candidates.map((hit) => `- [${hit.expId}] (语义相似度 ${hit.similarity.toFixed(2)}) ${hit.text}`).join("\n");
}
/** Template 8: propose acceptance-criterion updates from evidence — the
* pipeline amends its own verification norms only through the experience
* gate (only failing criteria, only with rationale and concrete text). */
const PROPOSE_ACCEPTANCE_SYSTEM_PROMPT = [
	"你是认知管线的\"验收准则修订官\"。现在提供给你若干条【已被证据证明持续失败的验收准则】（违规率越过阈值、审计次数达标）及其证据账本，以及相关的偏离元经验。",
	"【修订任务】：",
	"1. 对每条失败的准则，决定是【重写】(rewrite) 还是【退役】(retire)。",
	"2. 重写：给出新的 criterion（准则陈述，保持\"声称X前必须给出Y证据\"式）、evidence_hint（证据提示）与 trigger（触发标记，可选）——必须针对该准则为何失败；退役：该准则已无法通过改写挽救（例如触发条件本身不再适用）。",
	"【修订规则】：",
	"- 只允许修订【提供的失败准则】中的条目；不得新增准则，不得修订未列出的准则。",
	"- 每条提案必须给出 rationale（理由），引用该准则账本中的具体证据（invoked/violated 次数、违规率、机器见证通过数、累计误差）。",
	"- 把握不准时宁可不提案（proposals 可为空数组），绝不凭空改写。",
	"【输出JSON格式】：",
	"{",
	"  \"proposals\": [",
	"    {",
	"      \"check_id\": \"check_N\",",
	"      \"action\": \"rewrite 或 retire\",",
	"      \"criterion\": \"string（重写时必填）\",",
	"      \"evidence_hint\": \"string（重写时必填）\",",
	"      \"trigger\": \"string（重写时选填）\",",
	"      \"rationale\": \"string（必填，引用账本证据）\"",
	"    }",
	"  ]",
	"}"
].join("\n");
/** Frame template-8 input with the failing criteria and the deviation evidence.
* @param flagged - the failing active criteria (deviation gate already crossed).
* @param deviationMeta - related deviation meta experiences.
* @returns the framed prompt text.
*/
function frameProposeAcceptanceInput(flagged, deviationMeta) {
	return `【证据证明失败的准则】：\n${flagged.map((check) => [
		`- [${check.checkId}] 准则「${check.criterion}」 trigger「${check.trigger}」`,
		`  账本：invoked=${check.invokedCount} passed=${check.passedCount} violated=${check.violatedCount} 违规率=${(check.violatedCount / check.invokedCount * 100).toFixed(0)}%`,
		`  机器见证通过=${check.machineVerifiedCount} 累计误差=${check.cumulativeError.toFixed(3)}（${check.errorFoldCount} 次回流）`
	].join("\n")).join("\n")}\n\n` + (deviationMeta.length === 0 ? "【相关偏离元经验】：（无）" : "【相关偏离元经验】：\n" + deviationMeta.map((exp) => `- [${exp.expId}] ${exp.text}`).join("\n"));
}
/** Template 9: propose synonym-variant trigger jumps from the LLM route — the
* associative layer BEYOND co-occurrence. Co-occurrence can only learn words
* that actually appear together in experience text; paraphrases (卡住↔卡壳)
* never co-occur. Every variant must attach to a real trigger word and carry a
* reason. LLM-sourced jumps enter with zero co-occurrence evidence and a
* conservative weight — the citation loop is their evidence gate: they are
* boosted only when injections they helped trigger are actually cited, and
* pruned when they never pay off. */
const PROPOSE_TRIGGER_JUMPS_SYSTEM_PROMPT = [
	"你是认知管线的\"触发联想官\"，负责搭建主动联想网络：把触发词及其**真实使用情景**与用户可能说的话、可能关联的知识连接起来（像人学习时刻意联想同义词、反义词、上下位词、以及\"什么情景会用到它\"一样）。",
	"【联想任务】：",
	"1. 对【触发词表】中的每个词，先看它对应的【情景实例】——这些是经验库里真实发生过、这个词被用来描述的情境。",
	"2. 基于【词义 + 情景实例】，联想三类变体：",
	"   a. 表达变体：用户可能用哪些【同义/近义/口语】说法描述同一类情境（\"卡住\"↔\"卡壳/没反应/死循环\"、\"发布\"↔\"发版/上线/灰度\"）",
	"   b. 情景变体：与情景实例强相关的【具体对象/现象/操作词】（如情景\"服务重启后需验证\"→联想\"服务起来了吗/恢复了吗/健康检查\"）",
	"   c. 上下位/相关：更细或更粗的同域词（\"报错\"→\"异常堆栈/exit code/告警\"）",
	"3. 每个触发词至少给出 1 个变体；变体是词或短短语（2-6 字或英文词），不得是整句。",
	"4. 不得发明新的触发词——trigger 字段必须来自提供的词表。",
	"【联想规则】：",
	"- 宁可多而准：对每个触发词给出你最有把握的 1-3 个变体，不要因为\"把握不准\"就跳过。",
	"- 情景变体最有价值：优先基于【情景实例】联想用户真实会说的具体词，其次才是通用同义词。",
	"- 每个变体必须附 reason（一句话：基于什么情景/语义，用户为什么可能这样说）。",
	"【输出JSON格式】：",
	"{",
	"  \"jumps\": [",
	"    {",
	"      \"trigger\": \"触发词（必须来自提供的触发词表）\",",
	"      \"variants\": [\"变体1\", \"变体2\"],",
	"      \"reason\": \"一句话理由\"",
	"    }",
	"  ]",
	"}"
].join("\n");
/** Frame template-9 input with the trigger lexicons, each bound to the real
* situations where it appeared in the experience store. The association task
* then sees both the word AND its usage context — producing situation-grounded
* variants (how a user would describe THAT kind of situation) instead of bare
* synonym lists.
* @param staticTriggers - the static behavior trigger words.
* @param derived - the derived trigger words with weights.
* @param samples - important experience samples for context.
* @param situationsByWord - map of trigger word → situation snippets where it occurred.
* @returns the framed prompt text.
*/
function frameProposeTriggerJumpsInput(staticTriggers, derived, samples, situationsByWord = /* @__PURE__ */ new Map()) {
	const withSituations = (word) => {
		const situations = situationsByWord.get(word);
		return situations !== void 0 && situations.length > 0 ? `${word}（情景：${situations.slice(0, 2).join("；")}）` : word;
	};
	const derivedLine = derived.length === 0 ? "（无——冷启动）" : derived.map((entry) => `${withSituations(entry.word)}(${entry.weight.toFixed(2)})`).join("、");
	return `【静态行为触发词】（附情景实例）：\n${staticTriggers.map(withSituations).join("、")}\n\n【经验库派生触发词】（附情景实例）：\n${derivedLine}\n\n【重要经验样例】（用于理解词的真实语境）：
` + (samples.length === 0 ? "（无）" : samples.map((sample) => `- [${sample.expId}] ${sample.text}`).join("\n"));
}
/** Template 9: chain principle distillation — from experiences to ONE
* reusable decision rule (the EvolveR experience-distillation analogue). */
const DISTILL_SYSTEM_PROMPT = [
	"你是认知架构的\"经验蒸馏师\"。给定一条目标链的成员经验（情境-行动-结果），把多条经验蒸馏成**一条**可直接复用的决策原则。",
	"【蒸馏任务】：",
	"1. 优先从失败经验提炼教训（失败比成功更值得记住）。",
	"2. 输出一条 ≤60 字的行动原则，形如\"当【触发条件】时，应【行动】，避免【失败模式】\"。",
	"3. 原则必须能迁移到同类新情境（不是对某条经验的复述，而是抽象出的规则）。",
	"【宁缺毋滥】：",
	"- 若成员经验过少或彼此无共同模式，输出 null。",
	"- 禁止编造成员中不存在的事实；原则只能基于提供的材料。",
	"【输出JSON格式】：",
	"{",
	"  \"principle\": \"蒸馏出的原则，或 null\",",
	"  \"reasoning\": \"一句话说明蒸馏依据\"",
	"}"
].join("\n");
/** Frame template-9 input with the chain's member experiences.
* @param goal - the chain's goal anchor.
* @param members - the member experiences (situation/action/outcome), failures first.
* @returns the user message body.
*/
function frameDistillInput(goal, members) {
	return `【目标】：${goal}\n\n【成员经验】（失败在前）：
` + members.map((member) => `- [${member.expId}]${member.failed ? "（失败）" : ""} ${member.text}`).join("\n");
}
/** Template 10: discriminant-axis extraction — from one over-broad cluster to
* the axes that separate its members into behaviorally distinct sub-groups.
* This is the L2 complement to embedding clustering (LLM 定轴): embedding
* groups, the LLM names the discriminating dimension and its poles. */
const PROPOSE_DISCRIMINANT_AXES_SYSTEM_PROMPT = [
	"你是认知架构的\"判别维度分析师\"。给定一个语义聚类得到的簇及其成员经验（情境-行动-结果），这些成员表面相似（嵌入相近）但内部可能存在行为上不同的子群体。",
	"【任务】：",
	"1. 找出簇内真正导致策略/行为不同的**判别维度**（轴），例如：用户熟练度（新手↔资深）、环境故障类型、任务阶段、风险等级、时间压力。",
	"2. 每个轴给出两个或更多**极性判别词**（该轴两端/各档的典型词或短语），用于在查询侧区分成员。",
	"3. 只提炼**对行动选择有实际影响**的轴——如果簇内所有成员策略一致、无行为差异，输出空数组（宁缺毋滥）。",
	"【判别词要求】：",
	"- 必须来自成员经验中真实出现的词/短语，禁止编造。",
	"- 每个轴 2-4 个判别词，按区分力排序。",
	"- 判别词是词或短短语（≤8字），不是整句。",
	"【输出JSON格式】：",
	"{",
	"  \"axes\": [",
	"    {",
	"      \"dimension\": \"situation 或 action\",",
	"      \"axisName\": \"判别轴名称，如 用户熟练度\",",
	"      \"terms\": [\"新手\", \"资深\"],",
	"      \"rationale\": \"一句话说明为什么这个轴区分行为\"",
	"    }",
	"  ]",
	"}"
].join("\n");
/** Frame template-10 input with one over-broad cluster's members.
* @param clusterLabel - the cluster's current name/label.
* @param members - the member experiences (situation/action/outcome text).
* @returns the user message body.
*/
function frameDiscriminantAxesInput(clusterLabel, members) {
	return `【当前簇】：${clusterLabel}\n\n【簇内成员经验】（${members.length} 条）：\n` + members.map((member) => `- [${member.expId}] ${member.text}`).join("\n");
}
//#endregion
//#region lib/types/llm.js
/**
* Typed LLM helpers for the cognitive pipeline. Each model-assisted step is a
* best-effort enhancement over a deterministic fallback: a missing adapter, an
* unreachable route, or a malformed JSON reply never breaks the pipeline — it
* degrades to the mathematically safe path (附录C of the design).
* @module @deepseek-ai/dsh-cognitive-pipeline/llm
*/
/** Stable error taxonomy for pipeline-side failures. */
var CognitivePipelineError = class extends Error {
	/** Stable machine-readable error code. */
	code;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable machine code.
	*/
	constructor(message, code) {
		super(message);
		this.name = "CognitivePipelineError";
		this.code = code;
	}
};
/** Whether an explicit route is configured at all.
* @param route - the configured route pair.
* @returns true when both provider and model are set.
*/
function hasExplicitRoute(route) {
	return route.provider !== void 0 && route.model !== void 0;
}
/** Validate the route pair; both or neither must be present and non-empty.
* @param route - the candidate route.
* @returns a validated route, or an empty route.
*/
function resolveRoute(route) {
	const provider = route.provider;
	const model = route.model;
	if (provider === void 0 && model === void 0) return {};
	if (provider === void 0 || model === void 0 || provider.length === 0 || model.length === 0) throw new CognitivePipelineError("cognitive-pipeline: provider and model must be supplied together as non-empty strings", "INVALID_LLM_ROUTE");
	return {
		provider,
		model
	};
}
/** Extract the first balanced JSON object from model text.
* @param text - the raw model output.
* @returns the parsed JSON value.
*/
function extractJson(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) throw new CognitivePipelineError("cognitive-pipeline: model produced empty output", "EMPTY_LLM_OUTPUT");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		if (start < 0) throw new CognitivePipelineError("cognitive-pipeline: model output contains no JSON object", "LLM_JSON_PARSE_FAILED");
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < trimmed.length; index += 1) {
			const char = trimmed[index] ?? "";
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === "\"") inString = false;
				continue;
			}
			if (char === "\"") inString = true;
			else if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) try {
					return JSON.parse(trimmed.slice(start, index + 1));
				} catch {
					break;
				}
			}
		}
		throw new CognitivePipelineError("cognitive-pipeline: model output is not valid JSON", "LLM_JSON_PARSE_FAILED");
	}
}
/** Map LLM text blocks to one string. */
function textOf(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ");
}
/** Ensure the parsed JSON is a non-null object before field access. */
function asObject(value, label) {
	if (typeof value !== "object" || value === null) throw new CognitivePipelineError(`cognitive-pipeline: ${label} output must be a JSON object`, "LLM_SCHEMA_FAILED");
	return value;
}
/** Translate a terminal finish reason into an error, or undefined on stop. */
function finishError(finish) {
	switch (finish.kind) {
		case "stop": return;
		case "error":
		case "aborted": return new CognitivePipelineError(`cognitive-pipeline: model call failed: ${finish.failure.message}`, finish.failure.code);
		case "max-tokens": return new CognitivePipelineError("cognitive-pipeline: model output reached maxTokens", "LLM_MAX_TOKENS");
		case "tool-calls": return new CognitivePipelineError("cognitive-pipeline: model unexpectedly requested a tool", "LLM_UNEXPECTED_TOOL");
		default: return new CognitivePipelineError("cognitive-pipeline: unsupported finish reason", "LLM_FINISH_FAILED");
	}
}
/** Terminate a stream and return the assembled text; throws on failure. */
async function drainText(ctx, options, maxTokens) {
	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream(options)) {
		options.signal?.throwIfAborted();
		assembler.push(chunk);
	}
	options.signal?.throwIfAborted();
	const failure = finishError(assembler.finish);
	if (failure !== void 0) throw failure;
	if (assembler.blocks().some((block) => block.type === "tool-call")) throw new CognitivePipelineError("cognitive-pipeline: model output must contain text only", "LLM_UNEXPECTED_TOOL");
	const text = textOf(assembler.blocks());
	if (text.trim().length === 0) throw new CognitivePipelineError(`cognitive-pipeline: model produced no text (maxTokens=${maxTokens})`, "EMPTY_LLM_OUTPUT");
	return text;
}
/** Call one template and parse its JSON output. */
async function callJson(ctx, route, system, user, options) {
	const maxTokens = options.maxTokens ?? 800;
	const messages = [createUserMessage({
		content: [{
			type: "text",
			text: user
		}],
		source: {
			kind: "plugin",
			plugin: "cognitive-pipeline"
		}
	})];
	return extractJson(await drainText(ctx, deepFreeze({
		provider: route.provider,
		model: route.model,
		messages,
		system,
		maxTokens,
		reasoningEffort: ReasoningEffortId("off"),
		...options.sessionId === void 0 ? {} : { sessionId: options.sessionId },
		...options.signal === void 0 ? {} : { signal: options.signal }
	}), maxTokens));
}
/** Clamp a number into [0, 1]. */
function clamp01$2(value) {
	return Math.min(1, Math.max(0, value));
}
/** Clamp an integer into [0, 10]. */
function clampUtility(value) {
	if (!Number.isFinite(value)) return 5;
	return Math.min(10, Math.max(0, Math.round(value)));
}
/** Whether a sentence carries an observable failure symptom. */
function hasSymptom(sentence) {
	const lower = sentence.toLowerCase();
	return SYMPTOM_MARKERS.some((marker) => lower.includes(marker));
}
/** Deterministic template-1 fallback: split sentences, neutral utility. */
function sarFallback(rawText) {
	const sentences = rawText.split(/(?<=[。！？!?.])\s*/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
	const situation = sentences[0] ?? rawText.slice(0, 80);
	const action = sentences[1] ?? rawText.slice(0, 80);
	const outcome = sentences.slice(2).join(" ") || rawText.slice(0, 120);
	const symptomSentences = sentences.filter(hasSymptom);
	return {
		situation: symptomSentences.length === 0 ? situation : [...new Set([situation, ...symptomSentences])].join(" "),
		action,
		outcome,
		actionKeywords: [...new Set(tokenize(action))].slice(0, 8),
		outcomeUtility: {
			materialGain: 5,
			emotionalValence: 5,
			energyCost: 5
		}
	};
}
/**
* Template 1: extract the SAR triplet. Falls back to a deterministic split.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param rawText - the raw experience text.
* @param options - call context (session/signal/maxTokens).
* @returns the extracted triplet.
*/
async function extractSar(ctx, route, rawText, options) {
	if (!hasExplicitRoute(route)) return sarFallback(rawText);
	try {
		const parsed = asObject(await callJson(ctx, route, SAR_SYSTEM_PROMPT, frameSarInput(rawText), {
			...options,
			maxTokens: 500
		}), "SAR");
		if (typeof parsed.situation !== "string" || typeof parsed.action !== "string" || typeof parsed.outcome !== "string") throw new CognitivePipelineError("cognitive-pipeline: SAR output missing string fields", "SAR_SCHEMA_FAILED");
		const utility = parsed.outcome_utility_score;
		const keywords = Array.isArray(parsed.action_keywords) ? parsed.action_keywords.filter((keyword) => typeof keyword === "string").slice(0, 16) : [];
		const materialGain = Number(utility?.material_gain);
		const emotionalValence = Number(utility?.emotional_valence);
		const energyCost = Number(utility?.energy_cost);
		if (!Number.isFinite(materialGain) || !Number.isFinite(emotionalValence) || !Number.isFinite(energyCost)) throw new CognitivePipelineError("cognitive-pipeline: SAR output missing utility fields", "SAR_UTILITY_FAILED");
		return {
			situation: parsed.situation,
			action: parsed.action,
			outcome: parsed.outcome,
			actionKeywords: keywords.length > 0 ? keywords : [...new Set(tokenize(parsed.action))].slice(0, 8),
			outcomeUtility: {
				materialGain: clampUtility(materialGain),
				emotionalValence: clampUtility(emotionalValence),
				energyCost: clampUtility(energyCost)
			}
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: SAR extraction degraded to fallback: ${String(error)}`);
		return sarFallback(rawText);
	}
}
/** Deterministic template-2 fallback: trust the math-only OOD signal.
* @param isKnown - the math-only decision.
* @returns a review with 50% confidence.
*/
function oodReviewFallback(isKnown) {
	return {
		isKnown,
		confidenceScore: 50,
		reasoningShort: "无模型复核（降级模式），仅依据数学相似度判定",
		suggestedInitialRiskLevel: isKnown ? "low" : "high"
	};
}
/**
* Template 2: confirm or deny OOD. Falls back to the math-only decision.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param action - the proposed action text.
* @param topActions - the top historical actions for review.
* @param mathSaysKnown - the math-only OOD decision.
* @param options - call context (session/signal/maxTokens).
* @returns the review verdict.
*/
async function reviewOod(ctx, route, action, topActions, mathSaysKnown, options) {
	if (!hasExplicitRoute(route)) return oodReviewFallback(mathSaysKnown);
	try {
		const parsed = asObject(await callJson(ctx, route, OOD_REVIEW_SYSTEM_PROMPT, frameOodInput(action, topActions), {
			...options,
			maxTokens: 300
		}), "OOD review");
		const isKnown = parsed.is_known === true || parsed.is_known === "known";
		const confidence = Number(parsed.confidence_score);
		const risk = parsed.suggested_initial_risk_level;
		return {
			isKnown,
			confidenceScore: Number.isFinite(confidence) ? Math.min(100, Math.max(0, Math.round(confidence))) : 50,
			reasoningShort: typeof parsed.reasoning_short === "string" ? parsed.reasoning_short : "",
			suggestedInitialRiskLevel: risk === "medium" || risk === "high" ? risk : "low"
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: OOD review degraded to fallback: ${String(error)}`);
		return oodReviewFallback(mathSaysKnown);
	}
}
/** Deterministic template-3 fallback: pure frequency prior with a wide interval.
* @param positiveCount - positive history hits.
* @param negativeCount - negative history hits.
* @returns a fallback calibration output.
*/
function calibrationFallback(positiveCount, negativeCount) {
	const total = positiveCount + negativeCount;
	const base = total === 0 ? .5 : positiveCount / total;
	return {
		baseSuccessRate: base,
		riskFactors: [],
		finalConfidenceIntervalLow: Math.max(0, base - .2),
		finalConfidenceIntervalHigh: Math.min(1, base + .2),
		finalCalibratedProbability: base,
		advicePreview: total === 0 ? "无历史样本，谨慎行动" : `历史成功率${Math.round(base * 100)}%`
	};
}
/**
* Template 3: five-layer calibration (frequency prior, adversarial factors,
* interval output). Backend shrinkage and bucket correction happen in the hot
* engine; this helper only covers the LLM-facing layers.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param input - the situation/action plus history statistics.
* @param options - call context (session/signal/maxTokens).
* @returns the calibration output.
*/
async function calibrate(ctx, route, input, options) {
	if (!hasExplicitRoute(route)) return calibrationFallback(input.positiveCount, input.negativeCount);
	try {
		const parsed = asObject(await callJson(ctx, route, CALIBRATION_SYSTEM_PROMPT, frameCalibrationInput(input.situation, input.action, input.context, input.positiveCount, input.negativeCount, input.samples), {
			...options,
			maxTokens: 600
		}), "calibration");
		const base = Number(parsed.base_success_rate);
		const raw = Number(parsed.final_calibrated_probability);
		const low = Number(parsed.final_confidence_interval_low);
		const high = Number(parsed.final_confidence_interval_high);
		const advice = parsed.advice_preview;
		const factors = Array.isArray(parsed.risk_factors) ? parsed.risk_factors.filter((factor) => typeof factor === "string").slice(0, 5) : [];
		const fallbackBase = input.positiveCount / Math.max(1, input.positiveCount + input.negativeCount);
		return {
			baseSuccessRate: clamp01$2(Number.isFinite(base) ? base / 100 : fallbackBase),
			riskFactors: factors,
			finalConfidenceIntervalLow: clamp01$2(Number.isFinite(low) ? low / 100 : .3),
			finalConfidenceIntervalHigh: clamp01$2(Number.isFinite(high) ? high / 100 : .7),
			finalCalibratedProbability: clamp01$2(Number.isFinite(raw) ? raw / 100 : .5),
			advicePreview: typeof advice === "string" && advice.length > 0 ? advice.slice(0, 40) : "参考历史经验谨慎行动"
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: calibration degraded to fallback: ${String(error)}`);
		return calibrationFallback(input.positiveCount, input.negativeCount);
	}
}
/** Deterministic template-4 fallback: name clusters from utility means.
* @param groups - the agglomerative groups with evidence and mean utility.
* @param summaryShort - the fallback taxonomy summary.
* @returns deterministic cluster output.
*/
function reconstructFallback(groups, summaryShort) {
	return {
		newClusters: groups.map((group, index) => {
			const mean = group.meanUtility;
			return {
				clusterName: `策略簇#${index + 1}（收益${mean.materialGain.toFixed(1)}/情绪${mean.emotionalValence.toFixed(1)}/代价${mean.energyCost.toFixed(1)}）`,
				decisionRule: `if 情境特征与簇${index + 1}相似 then 沿用簇内已验证行动`,
				expectedUtilityRange: {
					low: Math.max(0, mean.materialGain - 2),
					high: Math.min(10, mean.materialGain + 2)
				},
				supportingEvidenceIds: group.evidenceIds,
				fallbackAction: "降低行动强度并观察反馈"
			};
		}),
		taxonomySummaryShort: summaryShort
	};
}
/**
* Template 4: causal-anchored taxonomy reconstruction. Falls back to
* deterministic cluster naming when the model path is unavailable.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param samples - the sampled train experiences.
* @param groups - the agglomerative groups with evidence and mean utility.
* @param summaryShort - fallback taxonomy summary.
* @param options - call context (session/signal/maxTokens).
* @returns the reconstruction output.
*/
async function reconstructTaxonomy(ctx, route, samples, groups, summaryShort, options) {
	if (!hasExplicitRoute(route)) return reconstructFallback(groups, summaryShort);
	try {
		const parsed = asObject(await callJson(ctx, route, RECONSTRUCT_SYSTEM_PROMPT, frameReconstructInput(samples), {
			...options,
			maxTokens: 4096
		}), "reconstruction");
		const rawClusters = Array.isArray(parsed.new_clusters) ? parsed.new_clusters : [];
		const newClusters = [];
		for (const raw of rawClusters) {
			if (typeof raw !== "object" || raw === null) continue;
			const cluster = raw;
			if (typeof cluster.cluster_name !== "string" || typeof cluster.decision_rule !== "string") continue;
			const range = cluster.expected_utility_range;
			const evidence = Array.isArray(cluster.supporting_evidence_ids) ? cluster.supporting_evidence_ids.filter((id) => typeof id === "string") : [];
			const low = Number(range?.low);
			const high = Number(range?.high);
			newClusters.push({
				clusterName: cluster.cluster_name,
				decisionRule: cluster.decision_rule,
				expectedUtilityRange: {
					low: Number.isFinite(low) ? Math.min(10, Math.max(0, low)) : 0,
					high: Number.isFinite(high) ? Math.min(10, Math.max(0, high)) : 10
				},
				supportingEvidenceIds: evidence,
				fallbackAction: typeof cluster.fallback_action === "string" ? cluster.fallback_action : "降低行动强度并观察反馈"
			});
		}
		const summary = parsed.taxonomy_summary_short;
		return {
			newClusters,
			taxonomySummaryShort: typeof summary === "string" && summary.length > 0 ? summary.slice(0, 60) : summaryShort
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: taxonomy reconstruction degraded to fallback: ${String(error)}`);
		return reconstructFallback(groups, summaryShort);
	}
}
/** Deterministic template-5 fallback: reject accumulation (no route → no gate).
* @returns the rejection decision.
*/
function accumulationFallback() {
	return {
		shouldAccumulate: false,
		sar: null
	};
}
/**
* Template 5: the accumulation gate. The LLM route judges whether a completed
* turn is worth becoming an experience and extracts the SAR triplet when it is.
* Without an explicit route the gate deterministically rejects — automatic
* accumulation never runs unjudged.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param episode - the completed turn's situation/action/outcome material.
* @param similar - retrieved history hits for the novelty judgment.
* @param options - call context (session/signal/maxTokens).
* @returns the accumulation decision.
*/
async function evaluateAccumulation(ctx, route, episode, similar, options) {
	if (!hasExplicitRoute(route)) return accumulationFallback();
	try {
		const parsed = asObject(await callJson(ctx, route, ACCUMULATE_SYSTEM_PROMPT, frameAccumulateInput(episode, similar), {
			...options,
			maxTokens: 500
		}), "accumulation");
		if (!(parsed.should_accumulate === true)) return {
			shouldAccumulate: false,
			sar: null
		};
		const situation = parsed.situation;
		const action = parsed.action;
		const outcome = parsed.outcome;
		const materialGain = Number(parsed.material_gain);
		const emotionalValence = Number(parsed.emotional_valence);
		const energyCost = Number(parsed.energy_cost);
		if (typeof situation !== "string" || typeof action !== "string" || typeof outcome !== "string" || !Number.isFinite(materialGain) || !Number.isFinite(emotionalValence) || !Number.isFinite(energyCost)) throw new CognitivePipelineError("cognitive-pipeline: accumulation output missing SAR fields", "ACCUMULATE_SCHEMA_FAILED");
		return {
			shouldAccumulate: true,
			sar: {
				situation,
				action,
				outcome,
				utility: {
					materialGain: clampUtility(materialGain),
					emotionalValence: clampUtility(emotionalValence),
					energyCost: clampUtility(energyCost)
				}
			}
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: accumulation gate degraded to fallback: ${String(error)}`);
		return accumulationFallback();
	}
}
/** Deterministic template-6 fallback: reject derivation (no route → no reference).
* @returns the rejection decision.
*/
function deriveReferenceFallback() {
	return {
		shouldDerive: false,
		sar: null
	};
}
/**
* Template 6: derive a reference experience from the commonalities of similar
* history — an online generalization for cold start. The LLM route extracts
* the shared situation/action/outcome/utility pattern; without a route it
* deterministically rejects.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param query - the current situation/action to anchor the derivation.
* @param similar - the retrieved similar history hits.
* @param options - call context (session/signal/maxTokens).
* @returns the derivation decision with the reference SAR when derived.
*/
async function deriveReference(ctx, route, query, similar, options) {
	if (!hasExplicitRoute(route)) return deriveReferenceFallback();
	try {
		const parsed = asObject(await callJson(ctx, route, DERIVE_REFERENCE_SYSTEM_PROMPT, frameDeriveReferenceInput(query, similar), {
			...options,
			maxTokens: 500
		}), "derive-reference");
		if (!(parsed.should_derive === true)) return deriveReferenceFallback();
		const situation = parsed.situation;
		const action = parsed.action;
		const outcome = parsed.outcome;
		const materialGain = Number(parsed.material_gain);
		const emotionalValence = Number(parsed.emotional_valence);
		const energyCost = Number(parsed.energy_cost);
		if (typeof situation !== "string" || typeof action !== "string" || typeof outcome !== "string" || !Number.isFinite(materialGain) || !Number.isFinite(emotionalValence) || !Number.isFinite(energyCost)) throw new CognitivePipelineError("cognitive-pipeline: derive-reference output missing SAR fields", "DERIVE_REFERENCE_SCHEMA_FAILED");
		return {
			shouldDerive: true,
			sar: {
				situation,
				action,
				outcome,
				utility: {
					materialGain: clampUtility(materialGain),
					emotionalValence: clampUtility(emotionalValence),
					energyCost: clampUtility(energyCost)
				}
			}
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: derive-reference degraded to fallback: ${String(error)}`);
		return deriveReferenceFallback();
	}
}
/** Deterministic template-7 fallback: keep the fused ranking untouched.
* @returns the keep decision.
*/
function refineRetrievalFallback() {
	return {
		shouldKeep: true,
		rejectedExpId: null,
		reason: null
	};
}
/**
* Template 7: refine retrieval when the deterministic routing is
* low-confidence. The LLM route reads the query and the fused candidates and
* judges whether the fused top hit genuinely applies (cosine similarity does
* not imply premise transferability); without a route it keeps the ranking.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param query - the current situation/action being predicted.
* @param candidates - the fused candidates, best first.
* @param options - call context (session/signal/maxTokens).
* @returns the refinement decision.
*/
async function refineRetrieval(ctx, route, query, candidates, options) {
	if (!hasExplicitRoute(route)) return refineRetrievalFallback();
	try {
		const parsed = asObject(await callJson(ctx, route, REFINE_RETRIEVAL_SYSTEM_PROMPT, frameRefineRetrievalInput(query, candidates), {
			...options,
			maxTokens: 400
		}), "refine-retrieval");
		if (parsed.should_keep !== false) return refineRetrievalFallback();
		const rejectedExpId = parsed.rejected_exp_id;
		const reason = parsed.reason;
		if (typeof rejectedExpId !== "string" || rejectedExpId.length === 0) throw new CognitivePipelineError("cognitive-pipeline: refine-retrieval rejected without an expId", "REFINE_RETRIEVAL_SCHEMA_FAILED");
		return {
			shouldKeep: false,
			rejectedExpId,
			reason: typeof reason === "string" && reason.length > 0 ? reason : null
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: refine-retrieval degraded to fallback: ${String(error)}`);
		return refineRetrievalFallback();
	}
}
/**
* Template 8: structured variant generation for a strategy whose deviation
* gate flagged rework (or a disequilibrated experience). The variants perturb
* one step or parameter of the base action while keeping the verification
* anchor's semantics unchanged — the anchor is the test, the variant is the
* revised procedure. Without an explicit route it deterministically proposes
* nothing: no model, no invented variants.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param input - base action, verification anchor, pre-checks, and the reason.
* @param options - call context (session/signal/maxTokens).
* @returns the proposed variants (ungated, ≤ 3, schema-filtered).
*/
async function generateVariants(ctx, route, input, options) {
	if (!hasExplicitRoute(route)) return [];
	try {
		const parsed = asObject(await callJson(ctx, route, VARIANT_SYSTEM_PROMPT, frameVariantInput(input), {
			...options,
			maxTokens: 600
		}), "variant generation");
		return (Array.isArray(parsed.variants) ? parsed.variants : []).filter((variant) => typeof variant === "object" && variant !== null).map((variant) => ({
			variantAction: typeof variant.variant_action === "string" ? variant.variant_action : "",
			perturbedAspect: typeof variant.perturbed_aspect === "string" ? variant.perturbed_aspect : "",
			rationale: typeof variant.rationale === "string" ? variant.rationale : ""
		})).filter((proposal) => proposal.variantAction.length > 0 && proposal.perturbedAspect.length > 0).slice(0, 3);
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: variant generation degraded to none: ${String(error)}`);
		return [];
	}
}
/** Deterministic template-8 fallback: no proposals (no route → no self-legislation).
* @returns the empty-proposal decision.
*/
function proposeAcceptanceFallback() {
	return { proposals: [] };
}
/**
* Template 8: the acceptance-criterion proposal route. The LLM route reads
* the demonstrably failing criteria and their evidence ledgers and proposes
* rewrites or retirements. The service still gates every proposal against the
* evidence before applying — the route proposes, the experience gate disposes.
* Without an explicit route it deterministically proposes nothing: the
* pipeline never amends its own norms unjudged.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param flagged - the failing active criteria (deviation gate already crossed).
* @param deviationMeta - related deviation meta experiences.
* @param options - call context (session/signal/maxTokens).
* @returns the proposed updates (ungated).
*/
async function proposeAcceptanceUpdates(ctx, route, flagged, deviationMeta, options) {
	if (!hasExplicitRoute(route)) return proposeAcceptanceFallback();
	try {
		const parsed = asObject(await callJson(ctx, route, PROPOSE_ACCEPTANCE_SYSTEM_PROMPT, frameProposeAcceptanceInput(flagged, deviationMeta), {
			...options,
			maxTokens: 600
		}), "acceptance-proposal");
		const rawProposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
		const proposals = [];
		for (const raw of rawProposals) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw;
			const checkId = entry.check_id;
			const action = entry.action;
			const rationale = entry.rationale;
			if (typeof checkId !== "string" || checkId.length === 0 || action !== "rewrite" && action !== "retire" || typeof rationale !== "string" || rationale.length === 0) continue;
			if (action === "rewrite") {
				const criterion = entry.criterion;
				const evidenceHint = entry.evidence_hint;
				if (typeof criterion !== "string" || criterion.length === 0 || typeof evidenceHint !== "string" || evidenceHint.length === 0) continue;
				const trigger = entry.trigger;
				proposals.push({
					checkId,
					action,
					criterion,
					evidenceHint,
					...typeof trigger === "string" && trigger.length > 0 ? { trigger } : {},
					rationale
				});
			} else proposals.push({
				checkId,
				action,
				rationale
			});
		}
		return { proposals };
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: acceptance proposal degraded to fallback: ${String(error)}`);
		return proposeAcceptanceFallback();
	}
}
/** Deterministic template-9 fallback: no proposals (no route → no LLM jumps).
* @returns the empty-proposal decision.
*/
function triggerJumpsFallback() {
	return { jumps: [] };
}
/**
* Template 9: propose synonym-variant trigger jumps — the associative layer
* beyond co-occurrence. The route proposes paraphrase variants for real
* trigger words; the pipeline still validates each variant (real trigger,
* non-empty, not a stop word) and the citation loop measures whether it pays
* off. Without an explicit route nothing is proposed.
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param input - the static triggers, derived triggers, and important samples.
* @param options - call context (session/signal/maxTokens).
* @returns the proposed jumps (ungated).
*/
async function proposeTriggerJumps(ctx, route, input, options) {
	if (!hasExplicitRoute(route)) return triggerJumpsFallback();
	const maxDraws = 3;
	for (let draw = 0; draw < maxDraws; draw += 1) try {
		const parsed = asObject(await callJson(ctx, route, PROPOSE_TRIGGER_JUMPS_SYSTEM_PROMPT, frameProposeTriggerJumpsInput(input.staticTriggers, input.derived, input.samples, input.situationsByWord), {
			...options,
			maxTokens: 4e3
		}), "trigger-jumps");
		const rawJumps = Array.isArray(parsed.jumps) ? parsed.jumps : [];
		const jumps = [];
		for (const raw of rawJumps) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw;
			const trigger = entry.trigger;
			const reason = entry.reason;
			const variants = Array.isArray(entry.variants) ? entry.variants.filter((variant) => typeof variant === "string" && variant.length > 0) : [];
			if (typeof trigger !== "string" || trigger.length === 0 || typeof reason !== "string" || reason.length === 0 || variants.length === 0) continue;
			jumps.push({
				trigger,
				variants,
				reason
			});
		}
		if (jumps.length > 0) return { jumps };
		ctx.logger.warn(`cognitive-pipeline: trigger-jump draw ${draw + 1} produced zero proposals, retrying`);
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: trigger-jump proposal degraded to fallback: ${String(error)}`);
		return triggerJumpsFallback();
	}
	return triggerJumpsFallback();
}
/** Deterministic template-9 fallback: no principle (no route → no distillation).
* @returns a null-principle result.
*/
function distillFallback() {
	return {
		principle: null,
		reasoning: "无模型复核（降级模式），不蒸馏原则"
	};
}
/**
* Template 9: distill one reusable decision principle from a chain's member
* experiences — the offline-consolidation analogue of EvolveR's
* experience-to-principle learning. The route extracts a single ≤60-character
* transferable rule, failures first; without an explicit route nothing is
* distilled (宁缺毋滥: a chain without a distilled principle is a folded
* summary, never a fabricated rule).
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param input - the chain goal and its member experiences.
* @param options - call context (session/signal/maxTokens).
* @returns the distillation result.
*/
async function distillChainPrinciple(ctx, route, input, options) {
	if (!hasExplicitRoute(route)) return distillFallback();
	try {
		const parsed = asObject(await callJson(ctx, route, DISTILL_SYSTEM_PROMPT, frameDistillInput(input.goal, input.members), {
			...options,
			maxTokens: 400
		}), "chain distillation");
		const principle = parsed.principle;
		const reasoning = parsed.reasoning;
		return {
			principle: typeof principle === "string" && principle.length > 0 ? principle.slice(0, 120) : null,
			reasoning: typeof reasoning === "string" && reasoning.length > 0 ? reasoning.slice(0, 200) : ""
		};
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: chain distillation degraded to none: ${String(error)}`);
		return distillFallback();
	}
}
/** Deterministic template-10 fallback: no axes (no route → no extraction).
* @returns an empty axes result.
*/
function discriminantAxesFallback() {
	return { axes: [] };
}
/**
* Template 10: extract discriminant axes from one over-broad cluster — the
* L2 complement to embedding clustering (LLM 定轴). Embedding groups surface
* near-duplicate members; this step asks the LLM which dimension actually
* drives behavior differences inside the cluster (e.g. 新手↔资深 within a
* git-push cluster), producing polarity terms for query-side routing. Without
* an explicit route nothing is extracted; one unlucky empty draw is retried
* once (the association task is stochastic, measured finding #11).
* @param ctx - plugin context for the LLM call.
* @param route - explicit model route.
* @param input - the over-broad cluster's label and member experiences.
* @param options - call context (session/signal/maxTokens).
* @returns the extracted axes, or an empty set.
*/
async function proposeDiscriminantAxes(ctx, route, input, options) {
	if (!hasExplicitRoute(route)) return discriminantAxesFallback();
	const maxDraws = 2;
	for (let draw = 0; draw < maxDraws; draw += 1) try {
		const parsed = asObject(await callJson(ctx, route, PROPOSE_DISCRIMINANT_AXES_SYSTEM_PROMPT, frameDiscriminantAxesInput(input.clusterLabel, input.members), {
			...options,
			maxTokens: 1500
		}), "discriminant-axes");
		const rawAxes = Array.isArray(parsed.axes) ? parsed.axes : [];
		const axes = [];
		for (const raw of rawAxes) {
			if (typeof raw !== "object" || raw === null) continue;
			const entry = raw;
			const dimension = entry.dimension;
			const axisName = entry.axisName;
			const terms = Array.isArray(entry.terms) ? entry.terms.filter((term) => typeof term === "string" && term.length > 0) : [];
			if (dimension !== "situation" && dimension !== "action" || typeof axisName !== "string" || axisName.length === 0 || terms.length < 2) continue;
			axes.push({
				dimension,
				axisName: axisName.slice(0, 30),
				terms: terms.slice(0, 4).map((term) => term.slice(0, 12)),
				rationale: typeof entry.rationale === "string" ? entry.rationale.slice(0, 100) : ""
			});
		}
		if (axes.length > 0) return { axes };
		ctx.logger.warn(`cognitive-pipeline: discriminant-axis draw ${draw + 1} produced zero axes, retrying`);
	} catch (error) {
		ctx.logger.warn(`cognitive-pipeline: discriminant-axis extraction degraded to none: ${String(error)}`);
		return discriminantAxesFallback();
	}
	return discriminantAxesFallback();
}
//#endregion
//#region lib/types/cold-engine.js
/**
* Cold-loop engine: offline taxonomy reconstruction. Samples decay-weighted
* high-error experiences, clusters them in utility space, anchors clusters
* with LLM causal evidence (hard-constrained), backtests the proposal on the
* newest slice, and atomically writes back only on a ≥15% error reduction.
* @module @deepseek-ai/dsh-cognitive-pipeline/cold-engine
*/
/** Calibrated agglomerative merge cosine for the embedding space
* (colddomain-test/calibrate-merge.mjs): bge-m3 similarity on this corpus is
* high (pairwise median 0.504), so the outcome-space default 0.4 would merge
* everything into one giant cluster; 0.75 yields 118 clusters with a 53% giant
* and semantically correct small clusters. */
const EMBEDDING_MERGE_COSINE = .75;
/** Calibrated membership cosine for the embedding space
* (colddomain-test/calibrate-match.mjs): ≥0.65 keeps 89% of true members while
* cutting cross-cluster bleed from 145 to 68 per cluster at 0.60. */
const EMBEDDING_MATCH_COSINE = .65;
/** Mean of outcome utilities. */
function meanUtility(items) {
	if (items.length === 0) return {
		materialGain: 5,
		emotionalValence: 5,
		energyCost: 5
	};
	let materialGain = 0;
	let emotionalValence = 0;
	let energyCost = 0;
	for (const item of items) {
		materialGain += item.sar.outcomeUtility.materialGain;
		emotionalValence += item.sar.outcomeUtility.emotionalValence;
		energyCost += item.sar.outcomeUtility.energyCost;
	}
	return {
		materialGain: materialGain / items.length,
		emotionalValence: emotionalValence / items.length,
		energyCost: energyCost / items.length
	};
}
/** Composite mean utility score (gains + valence − cost). */
function meanUtilityScore(utility) {
	return utilityScore(utility);
}
/** Clamp a number into [0, 10] (mirrors the store's feedback label clamp). */
function clampLabel$1(value) {
	return Math.min(10, Math.max(0, Math.round(value)));
}
/**
* The experience's clustering vector with result evidence folded in
* (constraint 5): when real settlement samples exist, the material-gain slot
* is synthesized from the MEASURED mean quality (5 + (μ−5)·0.8, the same
* scaling resolvePrediction uses) instead of the self-reported utility — the
* cluster axis reflects what was actually verified, not what the record
* claimed. Experiences without samples keep their self-reported vector, so
* legacy and young records are unaffected.
*
* In `embedding` space (source === 'embedding') the stored real-embedding
* vector is used directly when present (semantic clustering, the roadmap R3
* axis that carries premise discrimination missing from utility space); a
* record without an embedding degrades to the outcome vector, so a
* partially-embedded store still clusters.
* @param exp - the experience to vectorize for clustering.
* @param source - the clustering space: outcome (legacy) or embedding (semantic).
* @returns the evidence-aware vector in the requested space.
*/
function clusterVectorOf(exp, source) {
	if (source === "embedding" && exp.embedding !== void 0) return exp.embedding;
	const samples = exp.settlements ?? [];
	if (samples.length === 0) return exp.outcomeVector;
	const mean = samples.reduce((sum, sample) => sum + sample.quality, 0) / samples.length;
	return outcomeVector({
		...exp.sar.outcomeUtility,
		materialGain: clampLabel$1(5 + (mean - 5) * .8)
	}, exp.sar.outcome);
}
/** Centroid of outcome vectors, re-normalized. */
function centroidOf$1(vectors) {
	const dim = vectors[0]?.length ?? 0;
	const sum = new Array(dim).fill(0);
	for (const vector of vectors) for (let index = 0; index < dim; index += 1) sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0);
	if (vectors.length === 0) return sum;
	const mean = sum.map((value) => value / vectors.length);
	let norm = 0;
	for (const value of mean) norm += value * value;
	norm = Math.sqrt(norm);
	return norm < 1e-9 ? mean : mean.map((value) => value / norm);
}
/** Agglomerative clustering on outcome vectors (centroid linkage). */
function agglomerate(vectors, mergeCosine) {
	const clusters = vectors.map((vector) => ({
		memberIndices: [0],
		centroid: [...vector],
		meanUtility: {
			materialGain: 5,
			emotionalValence: 5,
			energyCost: 5
		}
	}));
	const membersOf = vectors.map((_, index) => [index]);
	for (;;) {
		let bestI = -1;
		let bestJ = -1;
		let bestScore = mergeCosine;
		for (let i = 0; i < clusters.length; i += 1) for (let j = i + 1; j < clusters.length; j += 1) {
			const score = cosine(clusters[i]?.centroid ?? [], clusters[j]?.centroid ?? []);
			if (score >= bestScore) {
				bestScore = score;
				bestI = i;
				bestJ = j;
			}
		}
		if (bestI < 0 || bestJ < 0) break;
		const aMembers = membersOf[bestI] ?? [];
		const bMembers = membersOf[bestJ] ?? [];
		const mergedMembers = [...aMembers, ...bMembers];
		const merged = {
			memberIndices: mergedMembers,
			centroid: centroidOf$1(mergedMembers.map((index) => vectors[index]).filter((vector) => vector !== void 0)),
			meanUtility: {
				materialGain: 5,
				emotionalValence: 5,
				energyCost: 5
			}
		};
		clusters.splice(bestJ, 1);
		clusters.splice(bestI, 1, merged);
		membersOf.splice(bestJ, 1);
		membersOf.splice(bestI, 1, mergedMembers);
	}
	return clusters.map((cluster, index) => ({
		memberIndices: membersOf[index] ?? cluster.memberIndices,
		centroid: cluster.centroid,
		meanUtility: cluster.meanUtility
	}));
}
/** Verify the evidence hard constraint for one candidate cluster. */
function verifyEvidence(candidate, byId, minCount, maxDistance, source) {
	if (candidate.evidenceIds.length < minCount) return {
		ok: false,
		reason: `证据不足（${candidate.evidenceIds.length} < ${minCount}）`
	};
	const evidence = candidate.evidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
	if (evidence.length !== candidate.evidenceIds.length) return {
		ok: false,
		reason: "支撑证据包含不存在的exp_id（幻觉因果）"
	};
	let maxDistanceSeen = 0;
	for (let i = 0; i < evidence.length; i += 1) for (let j = i + 1; j < evidence.length; j += 1) {
		const distance = 1 - cosine(clusterVectorOf(evidence[i], source), clusterVectorOf(evidence[j], source));
		maxDistanceSeen = Math.max(maxDistanceSeen, distance);
	}
	if (maxDistanceSeen > maxDistance) return {
		ok: false,
		reason: `证据间最大余弦距离 ${maxDistanceSeen.toFixed(3)} 超过阈值 ${maxDistance}`
	};
	return {
		ok: true,
		reason: "verified"
	};
}
/**
* Cold-loop engine. `runRebuild` is the offline entry point; it never throws
* for domain reasons — every outcome is a {@link RebuildResult}.
*/
var ColdEngine = class {
	ctx;
	store;
	config;
	route;
	constructor(ctx, store, config, route) {
		this.ctx = ctx;
		this.store = store;
		this.config = config;
		this.route = route;
	}
	/** Agglomerative merge cosine resolved for the configured clustering space.
	* Embedding mode uses the corpus-calibrated threshold (0.75) because bge-m3
	* similarity on this corpus is high; outcome mode keeps the configured value. */
	mergeCosine() {
		return this.config.clusterVectorSource === "embedding" ? EMBEDDING_MERGE_COSINE : this.config.clusterMergeCosine;
	}
	/** Membership cosine resolved for the configured clustering space
	* (embedding 0.65 calibrated against member recall vs cross-cluster bleed). */
	matchCosine() {
		return this.config.clusterVectorSource === "embedding" ? EMBEDDING_MATCH_COSINE : this.config.clusterMatchCosine;
	}
	/**
	* Run one rebuild. `local` restricts sampling to the highest-error cluster;
	* `global` samples the whole store.
	* @param scope - the rebuild scope.
	* @param sessionId - optional session identity for the reconstruction call.
	* @param signal - optional cancellation for the reconstruction call.
	* @returns the backtested rebuild outcome; never rejects for domain reasons.
	*/
	async runRebuild(scope, sessionId, signal) {
		const all = this.store.experiencesSnapshot();
		if (all.length === 0) return this.rejected(scope, [], 0, "无经验样本，跳过重构");
		const sampled = this.sample(all, scope);
		if (sampled.length < this.config.evidenceMinCount) return this.rejected(scope, sampled, 0, "采样样本不足，跳过重构");
		const metaSamples = sampled.filter((exp) => exp.meta === true);
		const nonMeta = sampled.filter((exp) => exp.meta !== true);
		const validationSize = Math.max(1, Math.floor(nonMeta.length * this.config.validationRatio));
		const validation = nonMeta.slice(nonMeta.length - validationSize);
		const train = [...nonMeta.slice(0, nonMeta.length - validationSize), ...metaSamples].sort((a, b) => a.timestamp - b.timestamp);
		const labeledValidation = validation.filter((exp) => Number.isFinite(exp.sar.outcomeUtility.materialGain)).length;
		if (labeledValidation < this.config.minValidationCount) return this.deferred(scope, sampled, labeledValidation);
		const groups = agglomerate(train.map((exp) => clusterVectorOf(exp, this.config.clusterVectorSource)), this.mergeCosine()).filter((group) => group.memberIndices.length >= this.config.evidenceMinCount);
		const groupsWithUtility = groups.map((group) => {
			const members = group.memberIndices.map((index) => train[index]).filter((exp) => exp !== void 0);
			return {
				evidenceIds: members.map((exp) => exp.expId),
				meanUtility: meanUtility(members)
			};
		});
		const summaryShort = this.composeGroupSummary(groups.length, groupsWithUtility);
		const byId = new Map(all.map((exp) => [exp.expId, exp]));
		let finalCandidates = [];
		let rejectedClusters = 0;
		let modelSummaryShort = "";
		const retries = this.config.reconstructRetries;
		for (let attempt = 0; attempt <= retries; attempt += 1) {
			const reconstruct = await reconstructTaxonomy(this.ctx, this.route, train, groupsWithUtility, summaryShort, {
				sessionId,
				signal
			});
			const candidates = reconstruct.newClusters.map((cluster) => {
				const evidence = cluster.supportingEvidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
				const mean = meanUtility(evidence);
				return {
					name: cluster.clusterName,
					decisionRule: cluster.decisionRule,
					expectedUtilityRange: cluster.expectedUtilityRange,
					evidenceIds: cluster.supportingEvidenceIds,
					fallbackAction: cluster.fallbackAction,
					centroid: centroidOf$1(evidence.map((exp) => clusterVectorOf(exp, this.config.clusterVectorSource))),
					meanUtility: mean,
					polarity: meanUtilityScore(mean) > 0 ? "success" : "risk"
				};
			});
			const verified = [];
			for (const candidate of candidates) {
				const check = verifyEvidence(candidate, byId, this.config.evidenceMinCount, this.config.evidenceMaxDistance, this.config.clusterVectorSource);
				if (!check.ok) {
					rejectedClusters += 1;
					this.ctx.logger.warn(`cognitive-pipeline: 簇 "${candidate.name}" 被证据校验驳回：${check.reason}`);
					continue;
				}
				verified.push(candidate);
			}
			if (verified.length > 0 || attempt === retries) {
				finalCandidates = verified;
				modelSummaryShort = reconstruct.taxonomySummaryShort;
				if (reconstruct.newClusters.length === 0 && groupsWithUtility.length > 0) this.ctx.logger.warn("cognitive-pipeline: 重构返回0个簇，将本轮样本标记为极端异常以提升下轮采样权重");
				break;
			}
			this.ctx.logger.warn(`cognitive-pipeline: 重构抽样产出不可用（${rejectedClusters} 个候选簇均未通过证据校验），第 ${attempt + 2} 次尝试`);
		}
		if (finalCandidates.length === 0 && groupsWithUtility.length > 0) for (const candidate of this.fallbackCandidates(groupsWithUtility, byId)) {
			const check = verifyEvidence(candidate, byId, this.config.evidenceMinCount, this.config.evidenceMaxDistance, this.config.clusterVectorSource);
			if (check.ok) finalCandidates = [...finalCandidates, candidate];
			else {
				rejectedClusters += 1;
				this.ctx.logger.warn(`cognitive-pipeline: 回退簇 "${candidate.name}" 被证据校验驳回：${check.reason}`);
			}
		}
		const oldViews = this.clusterViews(all, this.store.clustersSnapshot());
		const newViews = finalCandidates.map((candidate) => ({
			centroid: candidate.centroid,
			meanUtility: candidate.meanUtility
		}));
		const oldError = this.evaluateViews(all, train, validation, oldViews);
		const newError = this.evaluateViews(all, train, validation, newViews);
		const firstBuild = this.store.clustersSnapshot().length === 0;
		const requiredImprovement = firstBuild ? 0 : this.config.sandboxImprovement;
		const referenceError = oldError ?? this.evaluateViews(all, train, validation, []);
		const deltaError = referenceError === null || referenceError <= 1e-9 || newError === null ? null : (newError - referenceError) / referenceError;
		const accepted = finalCandidates.length > 0 && newError !== null && (referenceError === null ? false : referenceError <= 1e-9 ? false : deltaError !== null && deltaError <= -requiredImprovement);
		const taxonomyVersion = (this.store.taxonomySnapshot()?.version ?? 0) + (accepted ? 1 : 0);
		const reason = finalCandidates.length === 0 ? `证据校验未通过：${rejectedClusters} 个候选簇均未满足证据约束（≥${this.config.evidenceMinCount}条真实经验、两两距离≤${this.config.evidenceMaxDistance}），无可写回簇` : accepted ? firstBuild ? `沙盒验证通过：新误差 ${newError.toFixed(3)} ≤ 基线 ${referenceError?.toFixed(3) ?? "—"}（冷启动，不差于纯基线预测）` : `沙盒验证通过：新误差 ${newError.toFixed(3)} ≤ 旧误差 ${referenceError?.toFixed(3) ?? "—"} × ${(1 - this.config.sandboxImprovement).toFixed(2)}` : deltaError === null ? referenceError !== null && referenceError <= 1e-9 ? firstBuild ? "基线预测已接近完美（验证误差≈0），暂不写入簇" : "旧分类已接近完美（验证误差≈0），无需进一步重构" : "无旧分类基线，跳过回写" : firstBuild ? `冷启动验收未达标：新误差 ${newError?.toFixed(3) ?? "—"} vs 基线 ${referenceError?.toFixed(3) ?? "—"}（不得变差）` : `沙盒验证未达标：新误差 ${newError?.toFixed(3) ?? "—"} vs 旧误差 ${referenceError?.toFixed(3) ?? "—"}（需降低≥${Math.round(this.config.sandboxImprovement * 100)}%）`;
		if (accepted) {
			this.writeBack(finalCandidates, taxonomyVersion, all, modelSummaryShort);
			return {
				scope,
				accepted: true,
				deferred: false,
				oldError,
				newError,
				deltaError,
				clusterCount: finalCandidates.length,
				rejectedClusters,
				sampleCount: sampled.length,
				reason,
				taxonomyVersion
			};
		}
		if (validation.length > 0) {
			const predicted = this.predictionsFor(train, newViews, validation);
			validation.forEach((exp, index) => {
				if (!Number.isFinite(exp.sar.outcomeUtility.materialGain)) return;
				const actual = exp.sar.outcomeUtility.materialGain / 10;
				const error = Math.abs((predicted[index] ?? .5) - actual);
				if (error >= this.config.predictionErrorThreshold) this.store.updateExperience(exp.expId, { cumulativeError: exp.cumulativeError + error });
			});
		}
		return {
			scope,
			accepted: false,
			deferred: false,
			oldError,
			newError,
			deltaError,
			clusterCount: 0,
			rejectedClusters,
			sampleCount: sampled.length,
			reason,
			taxonomyVersion
		};
	}
	/** Short-circuit rejection result. */
	rejected(scope, sampled, rejectedClusters, reason) {
		return {
			scope,
			accepted: false,
			deferred: false,
			oldError: null,
			newError: null,
			deltaError: null,
			clusterCount: 0,
			rejectedClusters,
			sampleCount: sampled.length,
			reason,
			taxonomyVersion: this.store.taxonomySnapshot()?.version ?? 0
		};
	}
	/** Short-circuit deferral result: insufficient labeled validation samples. */
	deferred(scope, sampled, labeledValidation) {
		return {
			scope,
			accepted: false,
			deferred: true,
			oldError: null,
			newError: null,
			deltaError: null,
			clusterCount: 0,
			rejectedClusters: 0,
			sampleCount: sampled.length,
			reason: `验证样本不足（带标签 ${labeledValidation} 条 < ${this.config.minValidationCount}），暂缓重建`,
			taxonomyVersion: this.store.taxonomySnapshot()?.version ?? 0
		};
	}
	/** Decay-weighted, error-preferring sample selection (≤ maxSampleRatio).
	* A candidate joins when it is errorful (high prediction error or any
	* accumulated error) OR carries a clearly successful utility score — so the
	* cold loop learns from proven successes, not only from failures. Pipeline-own
	* meta experiences with a non-neutral utility also join (their error signal
	* has no user-feedback channel), so the cold loop can learn about the
	* pipeline's own failure modes (e.g. retrieval-routing ambiguity).
	*/
	sample(all, scope) {
		const now = Date.now();
		const day = 1440 * 60 * 1e3;
		const candidates = all.filter((exp) => {
			if (exp.simulated && exp.verification === "unverified") return false;
			const days = Math.max(0, (now - exp.timestamp) / day);
			if (Math.exp(-this.config.decayLambda * days) < this.config.minDecayWeight) return false;
			const errorful = (exp.predictionError ?? 0) >= this.config.predictionErrorThreshold || exp.cumulativeError > 0;
			const successful = utilityScore(exp.sar.outcomeUtility) >= this.config.successUtilityThreshold;
			const metaSignal = exp.meta === true && outcomePolarity(exp.sar.outcomeUtility) !== "neutral";
			return errorful || successful || metaSignal;
		});
		if (scope === "local") {
			const clusters = this.store.clustersSnapshot();
			let worst;
			for (const cluster of clusters) if (worst === void 0 || cluster.cumPredictionError > worst.cumPredictionError) worst = cluster;
			if (worst !== void 0) {
				const memberIds = new Set(worst.supportingEvidenceIds);
				const members = candidates.filter((exp) => memberIds.has(exp.expId));
				if (members.length >= this.config.evidenceMinCount) return this.cap(members, all.length).sort((a, b) => a.timestamp - b.timestamp);
			}
		}
		return this.cap(candidates, all.length).sort((a, b) => a.timestamp - b.timestamp);
	}
	/**
	* Keep at most maxSampleRatio of the total population, error-first, with a
	* small-store floor so a rebuild stays possible before a store reaches
	* production scale (the ratio cap targets the 10万-record regime).
	*/
	cap(candidates, total) {
		const budget = Math.min(total, Math.max(32, Math.floor(total * this.config.maxSampleRatio)));
		const kept = [...candidates].sort((a, b) => b.cumulativeError + (b.predictionError ?? 0) - (a.cumulativeError + (a.predictionError ?? 0))).slice(0, budget);
		const meta = candidates.filter((exp) => exp.meta === true && !kept.includes(exp));
		return meta.length === 0 ? kept : [...kept, ...meta];
	}
	/** Deterministic candidate clusters from the agglomerative groups. */
	fallbackCandidates(groups, byId) {
		return groups.map((group, index) => {
			const evidence = group.evidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
			const mean = group.meanUtility;
			return {
				name: `策略簇#${index + 1}（收益${mean.materialGain.toFixed(1)}/情绪${mean.emotionalValence.toFixed(1)}/代价${mean.energyCost.toFixed(1)}）`,
				decisionRule: `if 情境特征与簇${index + 1}相似 then 沿用簇内已验证行动`,
				expectedUtilityRange: {
					low: Math.max(0, mean.materialGain - 2),
					high: Math.min(10, mean.materialGain + 2)
				},
				evidenceIds: group.evidenceIds,
				fallbackAction: "降低行动强度并观察反馈",
				centroid: centroidOf$1(evidence.map((exp) => exp.outcomeVector)),
				meanUtility: mean,
				polarity: meanUtilityScore(mean) > 0 ? "success" : "risk"
			};
		});
	}
	/** ≤30-char summary of the rebuild's logical change from group statistics. */
	composeGroupSummary(groupCount, groups) {
		const tones = groups.map((group) => {
			const score = meanUtilityScore(group.meanUtility);
			if (score > 0) return "正效";
			if (score < 0) return "负效";
			return "中性";
		});
		return `重组为${groupCount}簇（${tones.length === 0 ? "无" : tones.slice(0, 3).join("/")}…）`;
	}
	/** Build normalized views for the stored cluster table. */
	clusterViews(all, clusters) {
		const byId = new Map(all.map((exp) => [exp.expId, exp]));
		const views = [];
		for (const cluster of clusters) {
			const evidence = cluster.supportingEvidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
			if (evidence.length === 0) continue;
			views.push({
				centroid: centroidOf$1(evidence.map((exp) => exp.outcomeVector)),
				meanUtility: meanUtility(evidence)
			});
		}
		return views;
	}
	/** Predict the continuous material-gain label (normalized to [0,1]) for each
	* validation experience under a taxonomy. The prediction is the mean
	* material gain of the nearest cluster; unmatched experiences fall back to
	* the training base-rate gain. This aligns the acceptance metric with the
	* pipeline's first-principle error `|calibrated − observed|` — it measures
	* whether the taxonomy predicts utility, not just which polarity bucket an
	* experience lands in.
	*/
	predictionsFor(train, taxonomy, validation) {
		const baseRate = train.length === 0 ? .5 : train.reduce((sum, exp) => sum + exp.sar.outcomeUtility.materialGain, 0) / train.length / 10;
		return validation.map((exp) => {
			let best = -1;
			let bestScore = this.matchCosine();
			for (const view of taxonomy) {
				const score = cosine(clusterVectorOf(exp, this.config.clusterVectorSource), view.centroid);
				if (score >= bestScore) {
					bestScore = score;
					best = view.meanUtility.materialGain / 10;
				}
			}
			return best < 0 ? baseRate : best;
		});
	}
	/** Mean absolute error of a taxonomy over the validation slice, on the
	* continuous material-gain axis. Every experience with a recorded gain
	* participates (resolved experiences carry a real label after the
	* feedback-backfill), so "predicted wrong but quality known" samples are no
	* longer excluded from the acceptance judgment.
	*/
	evaluateViews(all, train, validation, taxonomy) {
		const labeled = validation.filter((exp) => Number.isFinite(exp.sar.outcomeUtility.materialGain));
		if (labeled.length === 0) return null;
		const predicted = this.predictionsFor(train, taxonomy, validation);
		let error = 0;
		for (let index = 0; index < validation.length; index += 1) {
			const exp = validation[index];
			if (!Number.isFinite(exp.sar.outcomeUtility.materialGain)) continue;
			const actual = exp.sar.outcomeUtility.materialGain / 10;
			error += Math.abs((predicted[index] ?? .5) - actual);
		}
		return error / labeled.length;
	}
	/** Apply the accepted taxonomy: new clusters, assignments, summary, rules. */
	writeBack(candidates, taxonomyVersion, all, modelSummaryShort) {
		const now = Date.now();
		const assignments = /* @__PURE__ */ new Map();
		const clusters = [];
		const byId = new Map(all.map((exp) => [exp.expId, exp]));
		for (const candidate of candidates) {
			const clusterId = this.store.nextClusterId();
			const members = all.filter((exp) => cosine(clusterVectorOf(exp, this.config.clusterVectorSource), candidate.centroid) >= this.matchCosine());
			if (members.length === 0) continue;
			let cumError = 0;
			for (const member of members) {
				cumError += member.cumulativeError + (member.predictionError ?? 0);
				assignments.set(member.expId, {
					clusterId,
					strategyLabel: candidate.name
				});
			}
			const evidence = candidate.evidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
			clusters.push({
				clusterId,
				name: candidate.name,
				decisionRule: candidate.decisionRule,
				expectedUtilityRange: { ...candidate.expectedUtilityRange },
				supportingEvidenceIds: [...candidate.evidenceIds],
				fallbackAction: candidate.fallbackAction,
				createdAt: now,
				origin: "cold-loop",
				sampleCount: members.length,
				cumPredictionError: cumError,
				polarity: candidate.polarity,
				situationCentroid: centroidOf$1(evidence.map((exp) => situationVector(exp.sar.situation)))
			});
		}
		for (const strategy of this.store.tempStrategiesSnapshot()) {
			if (strategy.status !== "graduated") continue;
			const index = this.nearestClusterIndex(strategy, clusters, byId);
			if (index < 0) continue;
			clusters[index] = {
				...clusters[index],
				decisionRule: `if 情境与「${strategy.trialAction}」相似 then 沿用该试行策略`
			};
		}
		const rules = [...clusters].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 5).map((cluster) => ({
			condition: cluster.name,
			action: cluster.decisionRule,
			utilityRange: { ...cluster.expectedUtilityRange },
			polarity: cluster.polarity
		}));
		const taxonomy = {
			version: taxonomyVersion,
			summaryShort: modelSummaryShort.trim().length > 0 ? modelSummaryShort.slice(0, 60) : this.composeVersionSummary(taxonomyVersion, clusters),
			rules,
			updatedAt: now
		};
		this.store.applyTaxonomy(clusters, taxonomy, assignments);
	}
	/** Index of the graduated strategy's nearest verified cluster, or -1. */
	nearestClusterIndex(strategy, clusters, byId) {
		if (strategy.trialAction.length === 0) return -1;
		const source = strategy.sourceExpId === null ? null : byId.get(strategy.sourceExpId) ?? null;
		const strategyVector = outcomeVector(source === null ? {
			materialGain: 6,
			emotionalValence: 6,
			energyCost: 5
		} : source.sar.outcomeUtility, strategy.trialAction);
		let bestIndex = -1;
		let bestScore = this.matchCosine();
		for (let index = 0; index < clusters.length; index += 1) {
			const evidence = clusters[index].supportingEvidenceIds.map((id) => byId.get(id)).filter((exp) => exp !== void 0);
			if (evidence.length === 0) continue;
			const score = cosine(strategyVector, centroidOf$1(evidence.map((exp) => clusterVectorOf(exp, this.config.clusterVectorSource))));
			if (score >= bestScore) {
				bestScore = score;
				bestIndex = index;
			}
		}
		return bestIndex;
	}
	/** Compose the one-sentence taxonomy summary for the prompt prefix. */
	composeVersionSummary(version, clusters) {
		const names = clusters.slice(0, 3).map((cluster) => cluster.name);
		return `v${version}:${(names.length === 0 ? "无有效策略簇" : names.join("；")).slice(0, 30)}`;
	}
};
//#endregion
//#region lib/types/embedding.js
/**
* Real-embedding seam for the cognitive pipeline (roadmap R3): an
* OpenAI-compatible `/embeddings` client with per-text caching. The semantic
* retrieval channel prefers real embeddings when both the query and an
* experience carry one; everything degrades to the deterministic hash-bag
* cosine when the endpoint is unavailable or a vector is missing, so the
* pipeline never depends on the embedding service being reachable.
* @module @deepseek-ai/dsh-cognitive-pipeline/embedding
*/
/** OpenAI-compatible HTTP embedding transport (e.g. DeepSeek `/embeddings`). */
var HttpEmbeddingTransport = class {
	baseUrl;
	model;
	apiKey;
	timeoutMs;
	/**
	* @param baseUrl - API base URL; `/embeddings` is appended.
	* @param model - the embedding model id.
	* @param apiKey - the bearer token.
	* @param timeoutMs - per-call abort timeout.
	*/
	constructor(baseUrl, model, apiKey, timeoutMs = 3e4) {
		this.baseUrl = baseUrl;
		this.model = model;
		this.apiKey = apiKey;
		this.timeoutMs = timeoutMs;
	}
	async embed(text) {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.timeoutMs);
		try {
			const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.apiKey}`
				},
				body: JSON.stringify({
					model: this.model,
					input: text
				}),
				signal: controller.signal
			});
			if (!response.ok) throw new Error(`embedding endpoint returned HTTP ${response.status}`);
			const vector = (await response.json()).data?.[0]?.embedding;
			if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === "number")) throw new Error("embedding endpoint returned no numeric vector");
			return vector;
		} finally {
			clearTimeout(timer);
		}
	}
};
/** Resolve the embedding API key: explicit value, ambient env, then credentials. */
async function resolveApiKey(ctx, env, explicit) {
	if (explicit !== void 0 && explicit.length > 0) return explicit;
	const ambient = process.env[env];
	if (ambient !== void 0 && ambient.length > 0) return ambient;
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const resolved = await credentials.resolve(credentialRef(env));
		if (resolved !== void 0) return resolved.value;
	}
	return null;
}
/** Embedding scorer with a per-text cache; failures return null (hash fallback). */
var EmbeddingScorer = class {
	ctx;
	config;
	injectedTransport;
	cache = /* @__PURE__ */ new Map();
	transport = null;
	keyFailureLogged = false;
	/**
	* @param ctx - context carrying the optional credentials service.
	* @param config - resolved embedding configuration.
	* @param injectedTransport - injectable transport (tests); defaults to the HTTP client.
	*/
	constructor(ctx, config, injectedTransport) {
		this.ctx = ctx;
		this.config = config;
		this.injectedTransport = injectedTransport;
	}
	/** Embed one text; null when the endpoint is unreachable or no key exists.
	* @param text - the text to embed.
	* @returns the embedding vector, or null on failure.
	*/
	async embed(text) {
		const hit = this.cache.get(text);
		if (hit !== void 0) return hit;
		if (this.transport === null) if (this.injectedTransport !== void 0) this.transport = this.injectedTransport;
		else {
			const apiKey = await resolveApiKey(this.ctx, this.config.apiKeyEnv, this.config.apiKey);
			if (apiKey === null) {
				if (!this.keyFailureLogged) {
					this.ctx.logger.warn(`cognitive-pipeline: embedding enabled but no API key for "${this.config.apiKeyEnv}"; falling back to hash vectors`);
					this.keyFailureLogged = true;
				}
				return null;
			}
			this.transport = new HttpEmbeddingTransport(this.config.baseUrl, this.config.model, apiKey);
		}
		try {
			const vector = await this.transport.embed(text);
			this.cache.set(text, vector);
			return vector;
		} catch (error) {
			this.ctx.logger.warn(`cognitive-pipeline: embedding call failed, falling back to hash vectors: ${String(error)}`);
			return null;
		}
	}
};
//#endregion
//#region lib/types/hot-engine.js
/**
* Hot-loop engine: online prediction with OOD detection, branch routing
* (familiar path vs novel path), and the five-layer confidence calibration.
* All math is synchronous and fast; the only awaits are the best-effort LLM
* assists (SAR-independent: OOD review and calibration).
* @module @deepseek-ai/dsh-cognitive-pipeline/hot-engine
*/
/**
* Abstract a novel action into a domain-free transferable strategy — the
* 触类旁通 (analogical transfer) layer. Humans transfer RELATION STRUCTURE
* (an abstract principle) between domains, not surface attributes: "设备异常
* → 小步调参+监控反馈+迭代" transfers from 深海推进器 to 离心泵, while the
* literal action "调整深海推进器参数并增加水下巡检频率" does not. This
* extraction keeps the action's OPERATION pattern and replaces concrete
* domain objects with their generic class, so a structurally similar
* situation in another domain can reuse the strategy correctly.
* @param situation - the situation text at scratchpad creation.
* @param action - the novel action text.
* @returns the abstracted strategy text (≤60 chars, CJK).
*/
function abstractStrategy(situation, action) {
	const generic = `${situation} ${action}`.replace(/深海推进器|离心泵|压缩机|发动机|反应釜|发酵罐|数据库|服务器|web|服务|插件|模块|组件/g, "对象").replace(/患者|病人|游客|用户|客户/g, "对象").replace(/健身房|跑步机|客厅|卧室|书房|办公室/g, "场所");
	const operationWords = "调整 修改 排查 更换 重试 尝试 检测 恢复 重启 观察 监控 验证 评估 优化 处理 分析 设置 清除 清理 备份 建立 实施 开展 推进 部署 迁移 升级 配置 使用 提升 降低 加强 控制 更新 测试 修复 解决 判断 决定 确认 检查 审核 校验 比对 校勘 整理 归纳 提炼 推导 计算 记录 编写 翻译".split(" ");
	const operations = generic.match(new RegExp(operationWords.join("|"), "g")) ?? [];
	if (operations.length > 0) return `策略：${[...new Set(operations)].join("")}（先小步试，观察反馈后迭代）`;
	const compact = generic.replace(/\s+/g, "").slice(0, 40);
	return compact.length > 0 ? compact : action.slice(0, 40);
}
/** Default semantic scorer: hashed bag-of-words cosine over the action text. */
var HashSemanticScorer = class {
	score(queryText, exp) {
		return cosine(actionVector(queryText, []), exp.actionVector);
	}
};
/** Mean and variance of the top-K similarity set. */
function similarityStats(scores) {
	if (scores.length === 0) return {
		mean: 0,
		variance: 0
	};
	const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
	return {
		mean,
		variance: scores.reduce((sum, score) => sum + (score - mean) * (score - mean), 0) / scores.length
	};
}
/** Clamp a probability into [0, 1]. */
function clamp01$1(value) {
	return Math.min(1, Math.max(0, value));
}
/**
* Widen an interval symmetrically until it reaches the minimum width. This is
* computed arithmetically (no loop) so floating-point underflow can never
* stall it: when one side is pinned by the [0,1] clamp, the free side takes
* all remaining slack.
*/
function widenInterval(low, high, minWidth) {
	const lo = low;
	const hi = high;
	const width = hi - lo;
	if (width >= minWidth) return {
		low: lo,
		high: hi
	};
	const missing = minWidth - width;
	const lower = clamp01$1(lo - missing / 2);
	const upper = clamp01$1(hi + missing / 2);
	if (lo - lower + (upper - hi) >= missing - 1e-12) return {
		low: lower,
		high: upper
	};
	if (lower === 0 && upper < 1) return {
		low: 0,
		high: Math.min(1, minWidth)
	};
	if (upper === 1 && lower > 0) return {
		low: Math.max(0, 1 - minWidth),
		high: 1
	};
	return {
		low: 0,
		high: 1
	};
}
/**
* Enforce the interval-consistency invariant: the reported point estimate must
* always lie inside the confidence interval. The point estimate goes through
* shrinkage (layer 2) and the lifetime bucket correction (layer 5) while the
* interval is taken verbatim from the calibration output, so the two can
* drift apart when the raw probability is extreme (observed in cold-domain
* stress tests: point > upper bound on low-raw predictions, point < lower
* bound on high-raw ones). Rather than distorting the point estimate, the
* interval is extended symmetrically by the violated slack so the width
* semantics (uncertainty) are preserved and the invariant point ∈ CI holds.
* @param point - the final calibrated point estimate in [0, 1].
* @param low - the widened interval lower bound in [0, 1].
* @param high - the widened interval upper bound in [0, 1].
* @returns an interval containing the point estimate, never narrower than the input.
*/
function enforcePointInInterval(point, low, high) {
	if (Number.isFinite(point) && point < low) return {
		low: point,
		high
	};
	if (Number.isFinite(point) && point > high) return {
		low,
		high: point
	};
	return {
		low,
		high
	};
}
/**
* Hot-loop engine. Constructed once per service; `predict` is the online
* entry point.
*/
var HotEngine = class {
	ctx;
	store;
	config;
	route;
	scorer;
	embedder;
	constructor(ctx, store, config, route, scorer = new HashSemanticScorer(), embedder = null) {
		this.ctx = ctx;
		this.store = store;
		this.config = config;
		this.route = route;
		this.scorer = scorer;
		this.embedder = embedder;
	}
	/** Embed the query action once per prediction when the seam is enabled;
	* null on failure or when disabled (the hash-bag scorer then serves). */
	async embedQuery(action) {
		if (this.embedder === null) return null;
		return this.embedder.embed(action);
	}
	/** Whether the query text itself carries any failure symptom marker. */
	queryHasFailureMarker(queryText) {
		const lower = queryText.toLowerCase();
		return SYMPTOM_MARKERS.some((marker) => lower.includes(marker));
	}
	/** Raw per-channel scores (w-independent) of one experience for one query,
	* in [semantic, situational, symptom, outcome] order. The semantic channel
	* prefers the real-embedding cosine when the query embedding and the
	* experience's stored embedding both exist; otherwise it falls back to the
	* configured scorer (the hash-bag cosine by default).
	* @param exp - the candidate experience.
	* @param queryAction - the query action text.
	* @param situationVector - the precomputed query situation vector (null when the situation is empty).
	* @param queryText - action + situation, used for symptom/outcome channels.
	* @param queryEmbedding - the real-embedding vector of the query action, or null.
	* @returns the four raw channel scores.
	*/
	channelScores(exp, queryAction, situationVec, queryText, queryEmbedding) {
		return [
			queryEmbedding !== null && exp.embedding !== void 0 ? cosine(queryEmbedding, exp.embedding) : this.scorer.score(queryAction, exp),
			situationVec === null ? 0 : cosine(situationVec, situationVector(exp.sar.situation)),
			symptomOverlap(queryText, `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`),
			this.queryHasFailureMarker(queryText) && outcomePolarity(exp.sar.outcomeUtility) === "negative" ? 1 : 0
		];
	}
	/** Retrieve the top-K experiences by fused multi-channel similarity. The
	* semantic channel alone decides the classic similarity reported downstream;
	* the situational/symptom/outcome channels participate in the ranking, and
	* `channelMax` (the strongest raw channel score) feeds the OOD novelty
	* judgment so a strong situational/symptom hit is not drowned by a diluted
	* semantic cosine.
	* @param action - the proposed action text.
	* @param k - how many hits to return.
	* @param situation - the situation text, feeding the situational channel.
	* @param queryEmbedding - the real-embedding vector of the query action
	* (pre-fetched by the caller), or null to use the hash-bag scorer.
	* @returns ranked hits, best first.
	*/
	retrieveTopK(action, k, situation = "", queryEmbedding = null) {
		const weights = this.store.channelWeightsSnapshot();
		const situationVec = situation.trim().length > 0 ? situationVector(situation) : null;
		const queryText = `${action} ${situation}`.trim();
		const keys = [
			"semantic",
			"situational",
			"symptom",
			"outcome"
		];
		return this.store.experiencesSnapshot().map((exp) => {
			const raws = this.channelScores(exp, action, situationVec, queryText, queryEmbedding);
			const channels = raws.map((raw, index) => raw * weights[keys[index] ?? "semantic"]);
			const citationBonus = (exp.citationCount ?? 0) * this.config.citationRetrievalWeight;
			return {
				exp,
				similarity: raws[0] ?? 0,
				channelMax: Math.max(...raws),
				fused: channels.reduce((sum, value) => sum + value, 0) + citationBonus,
				channels
			};
		}).sort((a, b) => b.fused - a.fused).slice(0, k).map((hit) => ({
			exp: hit.exp,
			similarity: hit.similarity,
			channelMax: hit.channelMax,
			fused: hit.fused,
			channels: hit.channels
		}));
	}
	/** Detect OOD signals from the top-K similarity set. Novelty is judged on
	* each hit's strongest channel (`channelMax`): a diluted semantic cosine
	* must not declare history irrelevant when a situational or symptom channel
	* strongly matches the same experience.
	* @param ranked - the retrieved hits, best first.
	* @returns the strongest signal and the top-1 strength.
	*/
	detectOod(ranked) {
		const top1 = ranked[0]?.channelMax ?? 0;
		if (ranked.length === 0) return {
			signal: "low-similarity",
			top1
		};
		const scores = ranked.map((hit) => hit.channelMax);
		const spread = scores.length >= 3 ? (scores[0] ?? 0) - (scores[2] ?? 0) : 0;
		const { mean, variance } = similarityStats(scores);
		const strangeness = variance / (mean + 1e-9);
		if (top1 < this.config.oodSimThreshold) return {
			signal: "low-similarity",
			top1
		};
		if (spread < this.config.oodFlatThreshold && top1 < .85) return {
			signal: "flat-top",
			top1
		};
		if (strangeness > this.config.oodSiThreshold) return {
			signal: "high-strangeness",
			top1
		};
		return {
			signal: "none",
			top1
		};
	}
	/**
	* Run one hot-loop prediction.
	* @param input - the situation/action to predict.
	* @param sessionId - optional session identity for LLM-assisted calls.
	* @param signal - optional cancellation for LLM-assisted calls.
	* @returns the calibrated prediction result.
	*/
	async predict(input, sessionId, signal) {
		const queryEmbedding = await this.embedQuery(input.action);
		const ranked = this.retrieveTopK(input.action, this.config.topK, input.situation, queryEmbedding);
		const { signal: oodSignal, top1 } = this.detectOod(ranked);
		const taxonomyContext = this.taxonomyContext(input.situation);
		const { note: refineNote, ranked: refined } = await this.refineRetrieval(input, ranked, oodSignal, taxonomyContext, sessionId, signal);
		const samples = refined.map((hit) => hit.exp);
		const topChannels = refined[0] === void 0 ? null : refined[0].channels;
		const taxonomyGap = taxonomyContext.coverage === "gap";
		let isNovel = oodSignal !== "none" || taxonomyGap;
		if ((oodSignal !== "none" || taxonomyGap) && ranked.length > 0) isNovel = !(await reviewOod(this.ctx, this.route, input.action, ranked.slice(0, 3).map((hit) => ({
			expId: hit.exp.expId,
			action: hit.exp.sar.action,
			similarity: hit.similarity
		})), !isNovel, {
			sessionId,
			signal
		})).isKnown;
		const successReference = this.matchSuccessReference(input.situation);
		const adviceSuffix = this.taxonomyAdviceLine(taxonomyContext);
		if (isNovel) return this.predictNovel(input, topChannels, sessionId, signal, oodSignal, top1, successReference, taxonomyContext, adviceSuffix, refineNote);
		return this.predictKnown(input, samples, topChannels, sessionId, signal, oodSignal, top1, successReference, taxonomyContext, adviceSuffix, refineNote);
	}
	/**
	* LLM-refine the fused ranking when the deterministic routing is
	* low-confidence (thin taxonomy margin or flat-top OOD). The template-7
	* route judges whether the fused top hit genuinely applies; each rejection
	* removes that experience and re-ranks the survivors, bounded by
	* `refineMaxDrops`. Without a route (or when the route keeps the ranking)
	* the original ranking is returned untouched.
	* @param input - the query situation/action.
	* @param ranked - the fused ranking, best first.
	* @param oodSignal - the OOD signal from the original ranking.
	* @param taxonomyContext - the query's taxonomy routing.
	* @param sessionId - optional session identity for the LLM call.
	* @param signal - optional cancellation.
	* @returns the refinement note (null when nothing was dropped) and the refined ranking.
	*/
	async refineRetrieval(input, ranked, oodSignal, taxonomyContext, sessionId, signal) {
		if (!(taxonomyContext.coverage === "covered" && taxonomyContext.margin < this.config.retrievalFailureMargin || oodSignal === "flat-top") || ranked.length === 0) return {
			note: null,
			ranked: [...ranked]
		};
		const remaining = new Set(ranked.map((hit) => hit.exp.expId));
		const reasons = [];
		let dropped = 0;
		for (let attempt = 0; attempt < this.config.refineMaxDrops; attempt += 1) {
			const candidates = ranked.filter((hit) => remaining.has(hit.exp.expId)).slice(0, 3);
			if (candidates.length === 0) break;
			const decision = await refineRetrieval(this.ctx, this.route, {
				situation: input.situation,
				action: input.action
			}, candidates.map((hit) => ({
				expId: hit.exp.expId,
				text: `${hit.exp.sar.situation}。${hit.exp.sar.action}。${hit.exp.sar.outcome}`,
				similarity: hit.similarity
			})), {
				sessionId,
				signal
			});
			if (decision.shouldKeep || decision.rejectedExpId === null) break;
			if (!remaining.has(decision.rejectedExpId)) break;
			remaining.delete(decision.rejectedExpId);
			dropped += 1;
			if (decision.reason !== null && decision.reason.length > 0) reasons.push(decision.reason);
		}
		if (dropped === 0) return {
			note: null,
			ranked: [...ranked]
		};
		return {
			note: ` | 检索复核：LLM 判定 Top1 不适用，已剔除 ${dropped} 条候选（${reasons.join("；") || "前提或情境不可迁移"}）`,
			ranked: ranked.filter((hit) => remaining.has(hit.exp.expId))
		};
	}
	/**
	* Feedback-driven channel-weight learning (第一性原理 |calibrated−observed|):
	* the channel that dominated the fused top-1 at predict time is rewarded
	* when the prediction error is small and penalized when it is large, via an
	* EWMA step clamped to [0.2, 3]. Channels that keep surfacing the
	* actually-relevant experience grow; channels that pull in noise shrink.
	* @param prediction - the resolved prediction carrying its fusion record.
	* @param error - the absolute prediction error |calibrated − observed|.
	*/
	learnFromFeedback(prediction, error) {
		const fusion = prediction.fusion;
		if (fusion === null || fusion.scores.length !== 4) return;
		const weights = this.store.channelWeightsSnapshot();
		let dominant = 0;
		for (let index = 1; index < fusion.scores.length; index += 1) if ((fusion.scores[index] ?? 0) > (fusion.scores[dominant] ?? 0)) dominant = index;
		const lr = this.config.channelLearningRate;
		const target = error < this.config.channelErrorThreshold ? 1.6 : .5;
		const updated = {
			semantic: weights.semantic,
			situational: weights.situational,
			symptom: weights.symptom,
			outcome: weights.outcome
		};
		const key = [
			"semantic",
			"situational",
			"symptom",
			"outcome"
		][dominant];
		if (key === void 0) return;
		updated[key] = Math.min(3, Math.max(.2, weights[key] + lr * (target - weights[key])));
		this.store.updateChannelWeights(updated);
	}
	/**
	* Consult the taxonomy during retrieval: match the query situation against
	* every cluster's situation centroid (any polarity), report the routed
	* region, the routing confidence (best-minus-second-best margin), and
	* whether SAR has coverage there. This is the structural layer of the
	* pipeline's self-knowledge — retrieval knows what SAR contains before it
	* scans the experience store.
	* @param situation - the query situation text.
	* @returns the taxonomy context for this query.
	*/
	taxonomyContext(situation) {
		const clusters = this.store.clustersSnapshot().filter((cluster) => cluster.situationCentroid.length === 384);
		if (clusters.length === 0) return {
			cluster: null,
			similarity: 0,
			margin: 0,
			coverage: "no-taxonomy"
		};
		const vector = situationVector(situation);
		const scored = clusters.map((cluster) => ({
			cluster,
			score: cosine(vector, cluster.situationCentroid)
		})).sort((a, b) => b.score - a.score);
		const best = scored[0];
		if (best === void 0 || best.score < this.config.coverageThreshold) return {
			cluster: null,
			similarity: best?.score ?? 0,
			margin: 0,
			coverage: "gap"
		};
		const runner = scored[1];
		return {
			cluster: {
				clusterId: best.cluster.clusterId,
				name: best.cluster.name,
				decisionRule: best.cluster.decisionRule,
				polarity: best.cluster.polarity
			},
			similarity: best.score,
			margin: best.score - (runner?.score ?? 0),
			coverage: "covered"
		};
	}
	/** Compact retrieval-advice line appended to the advice text. */
	taxonomyAdviceLine(context) {
		if (context.coverage === "no-taxonomy") return " | 检索建议：分类体系尚未建立，按全新现象处理";
		if (context.coverage === "gap") return ` | 检索建议：情境落在分类覆盖缺口（最高相似度 ${context.similarity.toFixed(3)} < ${this.config.coverageThreshold}），SAR 无相关经验`;
		const confidence = context.margin < this.config.retrievalFailureMargin ? "，路由置信低" : "";
		return ` | 检索建议：命中簇「${context.cluster?.name.slice(0, 24) ?? "?"}」（相似度 ${context.similarity.toFixed(3)}，路由余量 ${context.margin.toFixed(3)}${confidence}）`;
	}
	/** Match the current situation against proven success clusters. Returns the
	* closest success cluster whose situation centroid clears the threshold, so
	* the model can reference a proven strategy even when the action itself is
	* novel.
	* @param situation - the current situation text.
	* @returns the matched success reference, or null.
	*/
	matchSuccessReference(situation) {
		const vector = situationVector(situation);
		let best = null;
		let bestScore = this.config.successReferenceThreshold;
		for (const cluster of this.store.clustersSnapshot()) {
			if (cluster.polarity !== "success") continue;
			if (cluster.situationCentroid.length !== 384) continue;
			const score = cosine(vector, cluster.situationCentroid);
			if (score >= bestScore) {
				bestScore = score;
				best = {
					clusterId: cluster.clusterId,
					clusterName: cluster.name,
					decisionRule: cluster.decisionRule,
					utilityRange: { ...cluster.expectedUtilityRange }
				};
			}
		}
		return best;
	}
	/** Novel branch: scratchpad lookup or creation, conservative calibration. */
	async predictNovel(input, topChannels, sessionId, signal, oodSignal, top1, successReference, taxonomyContext, adviceSuffix, refineNote) {
		const hash = String(signatureHash(input.action));
		const expired = this.store.expireTempStrategies();
		for (const expiredHash of expired) this.store.resolveExploration(expiredHash, "expired");
		let strategy = this.findMatchingTempStrategy(input.action, input.situation);
		let usedTempStrategy = false;
		let explored = false;
		if (strategy !== void 0 && strategy.status === "active") {
			usedTempStrategy = true;
			explored = true;
			strategy = this.store.updateTempStrategy(strategy.signatureHash, {
				hitCount: strategy.hitCount + 1,
				pendingResult: null
			});
		}
		const calibration = await calibrate(this.ctx, this.route, {
			situation: input.situation,
			action: input.action,
			context: input.context,
			positiveCount: 0,
			negativeCount: 0,
			samples: []
		}, {
			sessionId,
			signal
		});
		const raw = calibration.finalCalibratedProbability;
		const shrunk = this.shrink(raw, 0);
		const widenedIntervalRaw = widenInterval(clamp01$1(calibration.finalConfidenceIntervalLow), clamp01$1(calibration.finalConfidenceIntervalHigh), this.config.minConfidenceIntervalWidth);
		const widened = enforcePointInInterval(shrunk, widenedIntervalRaw.low, widenedIntervalRaw.high);
		let advice;
		if (usedTempStrategy && strategy !== void 0) advice = strategy.strategyText !== void 0 && strategy.strategyText.length > 0 ? `⚠️ 全新现象（命中可迁移策略）：${strategy.strategyText}。此为试探策略，尚未晋升为主记忆，请结合当前领域验证适用性。` : `⚠️ 全新现象（命中临时试行方案）：${strategy.trialAction}。此为临时试行方案，尚未晋升为主记忆。`;
		else {
			const reversible = !this.config.exploreRiskWords.some((word) => input.action.includes(word));
			const exploration = this.store.explorationSnapshot();
			const budgetLeft = exploration.used < this.config.exploreDailyBudget;
			if (reversible && budgetLeft) {
				explored = true;
				this.store.recordExploration({
					ts: Date.now(),
					action: input.action,
					scratchpadHash: hash,
					reversible: true,
					outcome: null,
					validatedError: null,
					validated: null
				});
				if (this.config.exploreAutoDispatch) this.store.addExplorationTask(`探索行动：${input.action}\n情境：${input.situation}`);
			}
			const budgetNote = reversible ? budgetLeft ? `主动探索（今日预算 ${exploration.used + 1}/${this.config.exploreDailyBudget}）` : "探索预算已耗尽，本次谨慎试探" : "动作不可逆，不纳入主动探索预算";
			advice = `⚠️ 全新现象：历史库无匹配（Top1相似度 ${top1.toFixed(3)}，信号 ${oodSignal}）。建议小步试探：${calibration.advicePreview} | ${budgetNote}`;
			this.store.addTempStrategy({
				signatureHash: hash,
				trialAction: input.action,
				strategyText: abstractStrategy(input.situation, input.action),
				pendingResult: null,
				hitCount: 1,
				positiveCount: 0,
				createdAt: Date.now(),
				expiresAt: Date.now() + this.config.tempStrategyTtlMs,
				status: "active",
				sourceExpId: null
			});
		}
		if (successReference !== null) advice += ` | 参照成功策略（簇「${successReference.clusterName}」）：${successReference.decisionRule}`;
		if (refineNote !== null) advice += refineNote;
		advice += adviceSuffix;
		const predictionId = this.store.nextPredictionId();
		this.store.addPrediction({
			predictionId,
			expId: null,
			situation: input.situation,
			action: input.action,
			predictedOutcome: advice,
			rawProbability: raw,
			calibratedProbability: shrunk,
			confidenceLow: widened.low,
			confidenceHigh: widened.high,
			isNovel: true,
			usedTempStrategy,
			clusterId: null,
			exploredActionHash: explored ? usedTempStrategy && strategy !== void 0 ? strategy.signatureHash : hash : null,
			timestamp: Date.now(),
			actualOutcome: null,
			predictionError: null,
			resolvedAt: null,
			fusion: topChannels === null ? null : { scores: [...topChannels] }
		});
		return {
			predictionId,
			advice,
			rawProbability: raw,
			calibratedProbability: shrunk,
			confidenceLow: widened.low,
			confidenceHigh: widened.high,
			isNovel: true,
			oodSignal,
			topHitCount: 0,
			usedTempStrategy,
			clusterId: null,
			successReference,
			taxonomyContext
		};
	}
	/** Familiar branch: five-layer calibration over the top-K samples. */
	async predictKnown(input, samples, topChannels, sessionId, signal, oodSignal, _top1, successReference, taxonomyContext, adviceSuffix, refineNote) {
		const positive = samples.filter((exp) => outcomePolarity(exp.sar.outcomeUtility) === "positive").length;
		const negative = samples.filter((exp) => outcomePolarity(exp.sar.outcomeUtility) === "negative").length;
		const k = samples.length;
		const calibration = await calibrate(this.ctx, this.route, {
			situation: input.situation,
			action: input.action,
			context: input.context,
			positiveCount: positive,
			negativeCount: negative,
			samples: samples.slice(0, Math.min(samples.length, 10)).map((exp) => ({
				expId: exp.expId,
				actionKeywords: exp.sar.actionKeywords.join(","),
				utility: `${exp.sar.outcomeUtility.materialGain}/${exp.sar.outcomeUtility.emotionalValence}/${exp.sar.outcomeUtility.energyCost}`,
				...exp.meta === true ? { meta: true } : {}
			}))
		}, {
			sessionId,
			signal
		});
		const raw = clamp01$1(calibration.finalCalibratedProbability);
		const shrunk = this.shrink(raw, k);
		const widenedIntervalRaw = widenInterval(clamp01$1(calibration.finalConfidenceIntervalLow), clamp01$1(calibration.finalConfidenceIntervalHigh), this.config.minConfidenceIntervalWidth);
		const empirical = this.store.empiricalAccuracyFor(shrunk);
		const finalProbability = empirical === null ? shrunk : clamp01$1(.7 * shrunk + .3 * empirical);
		const widened = enforcePointInInterval(finalProbability, widenedIntervalRaw.low, widenedIntervalRaw.high);
		const nearest = samples[0];
		const clusterId = nearest === void 0 ? null : nearest.clusterId;
		const clusterLabel = nearest === void 0 || nearest.strategyLabel === null ? null : nearest.strategyLabel;
		let advice = calibration.advicePreview;
		if (calibration.riskFactors.length > 0) advice += ` | 风险因素：${calibration.riskFactors.slice(0, 3).join("；")}`;
		if (clusterLabel !== null) advice = `[簇:${clusterLabel}] ${advice}`;
		if (successReference !== null) advice += ` | 参照成功策略（簇「${successReference.clusterName}」）：${successReference.decisionRule}`;
		if (refineNote !== null) advice += refineNote;
		advice += adviceSuffix;
		const predictionId = this.store.nextPredictionId();
		this.store.addPrediction({
			predictionId,
			expId: nearest === void 0 ? null : nearest.expId,
			situation: input.situation,
			action: input.action,
			predictedOutcome: advice,
			rawProbability: raw,
			calibratedProbability: finalProbability,
			confidenceLow: widened.low,
			confidenceHigh: widened.high,
			isNovel: false,
			usedTempStrategy: false,
			clusterId,
			exploredActionHash: null,
			timestamp: Date.now(),
			actualOutcome: null,
			predictionError: null,
			resolvedAt: null,
			fusion: nearest === void 0 || topChannels === null ? null : { scores: [...topChannels] }
		});
		return {
			predictionId,
			advice,
			rawProbability: raw,
			calibratedProbability: finalProbability,
			confidenceLow: widened.low,
			confidenceHigh: widened.high,
			isNovel: false,
			oodSignal,
			topHitCount: k,
			usedTempStrategy: false,
			clusterId,
			successReference,
			taxonomyContext
		};
	}
	/** Layer-2 shrinkage: P_cal = (k/(k+α))·P_raw + (α/(k+α))·0.5. */
	shrink(raw, k) {
		const alpha = this.config.shrinkageAlpha;
		return clamp01$1(k / (k + alpha) * raw + alpha / (k + alpha) * .5);
	}
	/** Find an active scratchpad strategy loosely matching one action.
	* Exact hash first; then a semantic match at the STRATEGY layer — the
	* query is abstracted the same way scratchpads were (触类旁通), so a
	* structurally similar situation in another domain matches the abstracted
	* principle ("调整深海推进器参数+巡检" → "策略：调整（先小步试…）" matches
	* the 离心泵 query's identical strategy), not the raw action. Legacy rows
	* without a strategyText fall back to raw-action matching.
	* @param action - the action text to match.
	* @param situation - the situation text, used for the strategy abstraction.
	* @returns the matching active strategy, or undefined.
	*/
	findMatchingTempStrategy(action, situation = "") {
		const hash = String(signatureHash(action));
		this.store.expireTempStrategies();
		const queryStrategy = abstractStrategy(situation, action);
		return this.store.tempStrategiesSnapshot().find((strategy) => strategy.status === "active" && (strategy.signatureHash === hash || cosine(actionVector(queryStrategy, []), actionVector(strategy.strategyText ?? strategy.trialAction, [])) >= this.config.tempStrategyMatchThreshold));
	}
};
/** Local date key of the exploration budget window (`YYYY-MM-DD`).
* @returns the local date key.
*/
function todayKey() {
	const now = /* @__PURE__ */ new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}
/**
* Index a probability into its decile bucket.
* @param probability - the probability in [0, 1].
* @returns the decile index 0–9.
*/
function bucketIndex(probability) {
	return Math.min(9, Math.max(0, Math.floor(probability * 10)));
}
/** One JSONL line reader that tolerates blank/trailing lines. */
function parseLines(source) {
	const records = [];
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			continue;
		}
	}
	return records;
}
/** Awaitable serial write queue so flushes never interleave. */
var WriteQueue = class {
	tail = Promise.resolve();
	/** Chain one write behind the previous; returns the chained promise. */
	push(write) {
		const next = this.tail.then(write, write);
		this.tail = next.catch(() => {});
		return next;
	}
	/** Settle only after every enqueued write finished. */
	async drain() {
		await this.tail;
	}
};
/** Create a fresh decile bucket table. */
function emptyBuckets() {
	return Array.from({ length: 10 }, (_, index) => ({
		bucketIndex: index,
		totalCount: 0,
		hitCount: 0,
		empiricalAccuracy: null
	}));
}
/** Clamp a persisted channel weight into the learnable band [0.2, 3]. */
function clampWeight(value) {
	return Math.min(3, Math.max(.2, typeof value === "number" && Number.isFinite(value) ? value : 1));
}
/** The complete persisted state of one pipeline store. */
var CognitiveStore = class {
	root;
	queue = new WriteQueue();
	experiences = /* @__PURE__ */ new Map();
	predictions = /* @__PURE__ */ new Map();
	tempStrategies = /* @__PURE__ */ new Map();
	clusterList = [];
	calibration = emptyBuckets();
	channelWeights = {
		semantic: 1,
		situational: 1,
		symptom: 1,
		outcome: 1
	};
	explorationState = {
		date: todayKey(),
		used: 0,
		entries: []
	};
	explorationTasks = /* @__PURE__ */ new Map();
	loopExecutions = /* @__PURE__ */ new Map();
	acceptance = /* @__PURE__ */ new Map();
	claimAudits = /* @__PURE__ */ new Map();
	triggerJumps = /* @__PURE__ */ new Map();
	discriminantAxes = [];
	injections = /* @__PURE__ */ new Map();
	chains = /* @__PURE__ */ new Map();
	chainPatterns = /* @__PURE__ */ new Map();
	solidifiedStrategies = /* @__PURE__ */ new Map();
	variants = /* @__PURE__ */ new Map();
	taxonomyState = null;
	nextExpSeq = 1;
	nextPredictionSeq = 1;
	nextClusterSeq = 1;
	nextTaskSeq = 1;
	nextAcceptanceSeq = 1;
	nextAuditSeq = 1;
	nextStrategySeq = 1;
	nextInjectionSeq = 1;
	nextVariantSeq = 1;
	/**
	* @param root - directory that will hold the JSONL/JSON state files.
	*/
	constructor(root) {
		this.root = root;
	}
	file(name) {
		return join(this.root, name);
	}
	/** Create the root and load every table. Missing files start empty. */
	async load() {
		await mkdir(this.root, { recursive: true });
		const [experiences, predictions, tempStrategies, clusters, calibration, channelWeights, exploration, tasks, loopExecutions, acceptance, claimAudits, triggerJumps, injections, chains, chainPatterns, taxonomy, solidifiedStrategies, variants, discriminantAxes] = await Promise.all([
			readFile(this.file("experiences.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("predictions.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("temp_strategies.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("clusters.json"), "utf8").catch(() => ""),
			readFile(this.file("calibration.json"), "utf8").catch(() => ""),
			readFile(this.file("channel_weights.json"), "utf8").catch(() => ""),
			readFile(this.file("exploration.json"), "utf8").catch(() => ""),
			readFile(this.file("exploration_tasks.json"), "utf8").catch(() => ""),
			readFile(this.file("loop_executions.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("acceptance.json"), "utf8").catch(() => ""),
			readFile(this.file("claim_audits.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("trigger_jumps.json"), "utf8").catch(() => ""),
			readFile(this.file("injections.jsonl"), "utf8").catch(() => ""),
			readFile(this.file("chains.json"), "utf8").catch(() => ""),
			readFile(this.file("chain_patterns.json"), "utf8").catch(() => ""),
			readFile(this.file("taxonomy.json"), "utf8").catch(() => ""),
			readFile(this.file("solidified_strategies.json"), "utf8").catch(() => ""),
			readFile(this.file("variants.json"), "utf8").catch(() => ""),
			readFile(this.file("discriminant_axes.json"), "utf8").catch(() => "")
		]);
		for (const record of parseLines(experiences)) {
			if (typeof record !== "object" || record === null) continue;
			const exp = record;
			if (typeof exp.expId !== "string") continue;
			this.experiences.set(exp.expId, {
				...exp,
				...typeof exp.chainId === "string" ? { chainId: exp.chainId } : {},
				...typeof exp.parentNodeId === "string" ? { parentNodeId: exp.parentNodeId } : {},
				...Number.isInteger(exp.sequence) ? { sequence: exp.sequence } : {},
				...exp.selfReflexive === true ? { selfReflexive: true } : {}
			});
			this.nextExpSeq = Math.max(this.nextExpSeq, expSeqOf(exp.expId) + 1);
		}
		for (const record of parseLines(predictions)) {
			if (typeof record !== "object" || record === null) continue;
			const prediction = record;
			if (typeof prediction.predictionId !== "string") continue;
			this.predictions.set(prediction.predictionId, {
				...prediction,
				fusion: prediction.fusion ?? null
			});
			this.nextPredictionSeq = Math.max(this.nextPredictionSeq, predictionSeqOf(prediction.predictionId) + 1);
		}
		for (const record of parseLines(tempStrategies)) {
			if (typeof record !== "object" || record === null) continue;
			const strategy = record;
			if (typeof strategy.signatureHash !== "string") continue;
			this.tempStrategies.set(strategy.signatureHash, strategy);
		}
		if (clusters !== "") {
			const parsed = JSON.parse(clusters);
			if (Array.isArray(parsed)) {
				this.clusterList = parsed.filter((cluster) => {
					if (typeof cluster !== "object" || cluster === null) return false;
					return typeof cluster.clusterId === "number";
				}).map((cluster) => this.normalizeCluster(cluster));
				for (const cluster of this.clusterList) this.nextClusterSeq = Math.max(this.nextClusterSeq, cluster.clusterId + 1);
			}
		}
		const parsedCalibration = calibration === "" ? null : JSON.parse(calibration);
		if (Array.isArray(parsedCalibration) && parsedCalibration.length === 10) this.calibration = parsedCalibration;
		if (channelWeights !== "") {
			const parsed = JSON.parse(channelWeights);
			if (typeof parsed === "object" && parsed !== null) this.channelWeights = {
				semantic: clampWeight(parsed.semantic),
				situational: clampWeight(parsed.situational),
				symptom: clampWeight(parsed.symptom),
				outcome: clampWeight(parsed.outcome)
			};
		}
		if (exploration !== "") {
			const parsed = JSON.parse(exploration);
			if (typeof parsed === "object" && parsed !== null && typeof parsed.date === "string") {
				const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
				this.explorationState = {
					date: parsed.date,
					used: typeof parsed.used === "number" && Number.isFinite(parsed.used) ? parsed.used : 0,
					entries: entries.filter((entry) => {
						if (typeof entry !== "object" || entry === null) return false;
						const e = entry;
						return typeof e.ts === "number" && typeof e.action === "string" && typeof e.scratchpadHash === "string";
					}).map((entry) => {
						const raw = entry;
						const validatedError = typeof raw.validatedError === "number" ? raw.validatedError : null;
						const validated = raw.validated === true || raw.validated === false ? raw.validated : null;
						return {
							...entry,
							validatedError,
							validated
						};
					})
				};
			}
		}
		if (tasks !== "") {
			const parsed = JSON.parse(tasks);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const task = record;
				if (typeof task.taskId !== "string" || typeof task.goal !== "string") continue;
				this.explorationTasks.set(task.taskId, task);
				const seq = Number(task.taskId.replace("task_", ""));
				if (Number.isFinite(seq)) this.nextTaskSeq = Math.max(this.nextTaskSeq, seq + 1);
			}
		}
		for (const record of parseLines(loopExecutions)) {
			if (typeof record !== "object" || record === null) continue;
			const receipt = record;
			if (typeof receipt.receiptId !== "string" || typeof receipt.predictionId !== "string") continue;
			this.loopExecutions.set(receipt.receiptId, receipt);
		}
		if (acceptance !== "") {
			const parsed = JSON.parse(acceptance);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const check = record;
				if (typeof check.checkId !== "string" || typeof check.criterion !== "string") continue;
				const rawCheck = record;
				const legacyCount = typeof rawCheck.logVerifiedCount === "number" && Number.isInteger(rawCheck.logVerifiedCount) ? rawCheck.logVerifiedCount : 0;
				this.acceptance.set(check.checkId, {
					...check,
					machineVerifiedCount: Number.isInteger(check.machineVerifiedCount) && check.machineVerifiedCount >= 0 ? check.machineVerifiedCount : legacyCount
				});
				const seq = Number(check.checkId.replace("check_", ""));
				if (Number.isFinite(seq)) this.nextAcceptanceSeq = Math.max(this.nextAcceptanceSeq, seq + 1);
			}
		}
		for (const record of parseLines(claimAudits)) {
			if (typeof record !== "object" || record === null) continue;
			const audit = record;
			if (typeof audit.auditId !== "string" || typeof audit.claim !== "string") continue;
			const rawAudit = record;
			const legacyLog = rawAudit.logAnchor;
			const anchor = audit.anchor ?? (typeof legacyLog === "object" && legacyLog !== null ? {
				kind: "log",
				toolName: typeof legacyLog.toolName === "string" ? legacyLog.toolName : "",
				callId: typeof legacyLog.callId === "string" ? legacyLog.callId : "",
				expectedSucceeded: legacyLog.expectedSucceeded === true,
				matched: legacyLog.matched === true
			} : null);
			this.claimAudits.set(audit.auditId, {
				...audit,
				anchor,
				anchorVerified: rawAudit.anchorVerified === true || rawAudit.logVerified === true
			});
			const seq = Number(audit.auditId.replace("audit_", ""));
			if (Number.isFinite(seq)) this.nextAuditSeq = Math.max(this.nextAuditSeq, seq + 1);
		}
		if (triggerJumps !== "") {
			const parsed = JSON.parse(triggerJumps);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const jump = record;
				if (typeof jump.jumpWord !== "string" || jump.jumpWord.length === 0) continue;
				this.triggerJumps.set(jump.jumpWord, jump);
			}
		}
		if (discriminantAxes !== "") {
			const parsed = JSON.parse(discriminantAxes);
			if (Array.isArray(parsed)) this.discriminantAxes = parsed.filter((record) => typeof record === "object" && record !== null && typeof record.clusterId === "number");
		}
		for (const record of parseLines(injections)) {
			if (typeof record !== "object" || record === null) continue;
			const injection = record;
			if (typeof injection.injectionId !== "string") continue;
			this.injections.set(injection.injectionId, injection);
			const seq = Number(injection.injectionId.replace("inject_", ""));
			if (Number.isFinite(seq)) this.nextInjectionSeq = Math.max(this.nextInjectionSeq, seq + 1);
		}
		if (chains !== "") {
			const parsed = JSON.parse(chains);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const chain = record;
				if (typeof chain.chainId !== "string" || chain.chainId.length === 0) continue;
				const rawChain = record;
				this.chains.set(chain.chainId, {
					...chain,
					childChainIds: rawChain.childChainIds === void 0 ? [] : rawChain.childChainIds
				});
			}
		}
		if (chainPatterns !== "") {
			const parsed = JSON.parse(chainPatterns);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const pattern = record;
				if (typeof pattern.patternId !== "string" || pattern.patternId.length === 0) continue;
				this.chainPatterns.set(pattern.patternId, pattern);
			}
		}
		if (solidifiedStrategies !== "") {
			const parsed = JSON.parse(solidifiedStrategies);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const strategy = record;
				if (typeof strategy.strategyId !== "string" || strategy.strategyId.length === 0) continue;
				this.solidifiedStrategies.set(strategy.strategyId, strategy);
				const seq = Number(strategy.strategyId.replace("solidified-", ""));
				if (Number.isFinite(seq)) this.nextStrategySeq = Math.max(this.nextStrategySeq, seq + 1);
			}
		}
		if (variants !== "") {
			const parsed = JSON.parse(variants);
			if (Array.isArray(parsed)) for (const record of parsed) {
				if (typeof record !== "object" || record === null) continue;
				const candidate = record;
				if (typeof candidate.variantId !== "string" || candidate.variantId.length === 0) continue;
				this.variants.set(candidate.variantId, candidate);
				const seq = Number(candidate.variantId.replace("variant-", ""));
				if (Number.isFinite(seq)) this.nextVariantSeq = Math.max(this.nextVariantSeq, seq + 1);
			}
		}
		if (taxonomy !== "") {
			const parsed = JSON.parse(taxonomy);
			if (typeof parsed === "object" && parsed !== null && typeof parsed.version === "number") {
				const rawRules = Array.isArray(parsed.rules) ? parsed.rules : [];
				this.taxonomyState = {
					...parsed,
					rules: rawRules.filter((rule) => typeof rule === "object" && rule !== null).map((rule) => {
						const polarityRaw = rule.polarity;
						const hasPolarity = polarityRaw === "success" || polarityRaw === "risk";
						const rangeLow = typeof rule.utilityRange === "object" && rule.utilityRange !== null ? Number(rule.utilityRange.low) : 0;
						return {
							condition: typeof rule.condition === "string" ? rule.condition : "",
							action: typeof rule.action === "string" ? rule.action : "",
							utilityRange: {
								low: Number.isFinite(rangeLow) ? rangeLow : 0,
								high: typeof rule.utilityRange === "object" && rule.utilityRange !== null ? Number(rule.utilityRange.high) : 10
							},
							polarity: hasPolarity ? polarityRaw : Number.isFinite(rangeLow) && rangeLow >= 5 ? "success" : "risk"
						};
					})
				};
			}
		}
	}
	/** Await every pending persistence write. */
	async flush() {
		await this.queue.drain();
	}
	enqueue(name, payload) {
		const file = this.file(name);
		const data = typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`;
		this.queue.push(async () => {
			const tmp = `${file}.tmp`;
			await writeFile(tmp, data, "utf8");
			await rename(tmp, file);
		});
	}
	enqueueLines(name, records) {
		const lines = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
		this.enqueue(name, lines);
	}
	/**
	* Store one experience and enqueue its persistence.
	* @param exp - the experience to add.
	*/
	addExperience(exp) {
		this.experiences.set(exp.expId, exp);
		this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
	}
	/**
	* Read one experience by id.
	* @param expId - the experience id.
	* @returns the experience, or undefined.
	*/
	getExperience(expId) {
		return this.experiences.get(expId);
	}
	/** Snapshot of every stored experience.
	* @returns experiences in insertion order.
	*/
	experiencesSnapshot() {
		return [...this.experiences.values()];
	}
	/** Remove one experience (lifecycle pruning: an experience with zero
	* citations past its retention age is forgotten, not kept forever).
	* @param expId - the experience to remove.
	* @returns true when it existed and was removed.
	*/
	removeExperience(expId) {
		const existed = this.experiences.delete(expId);
		if (existed) this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
		return existed;
	}
	/**
	* Apply a partial patch to one experience and enqueue its persistence.
	* @param expId - the experience id.
	* @param patch - the fields to replace.
	* @returns the updated experience.
	*/
	updateExperience(expId, patch) {
		const current = this.experiences.get(expId);
		if (current === void 0) throw new Error(`cognitive-pipeline: experience "${expId}" not found`);
		const next = {
			...current,
			...patch
		};
		this.experiences.set(expId, next);
		this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
		return next;
	}
	/**
	* Fold one real-feedback evidence weight into a simulated experience's
	* verification state (the evidence-replacement model): a single decisive
	* weight fast-tracks to provisional, cumulative evidence upgrades to
	* verified, and a contradictory provisional feedback rolls back. Ordinary
	* experiences are verified by construction and unaffected.
	* @param expId - the experience id.
	* @param weight - the feedback evidence weight in [0, 1].
	* @param contradictory - whether the feedback contradicts the simulation.
	* @param fastTrackThreshold - weight at/above which one feedback fast-tracks.
	* @param permanentThreshold - cumulative evidence needed for permanent verified.
	* @returns the updated experience.
	*/
	applyFeedbackEvidence(expId, weight, contradictory, fastTrackThreshold, permanentThreshold) {
		const current = this.getExperience(expId);
		if (current === void 0) throw new Error(`cognitive-pipeline: experience "${expId}" not found`);
		if (!current.simulated || current.verification === "verified") return current;
		if (contradictory && current.verification === "provisional") {
			const rolled = {
				...current,
				verification: "unverified",
				evidenceScore: 0
			};
			this.experiences.set(expId, rolled);
			this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
			return rolled;
		}
		const nextScore = current.evidenceScore + weight;
		const verification = nextScore >= permanentThreshold ? "verified" : weight >= fastTrackThreshold || current.verification === "provisional" ? "provisional" : "unverified";
		const next = {
			...current,
			evidenceScore: nextScore,
			verification
		};
		this.experiences.set(expId, next);
		this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
		return next;
	}
	/**
	* Expire simulated experiences that never earned real feedback within the
	* fallback TTL. This is the backstop of the evidence-replacement model:
	* verification and density are primary, the timeout guards the
	* never-verified corner.
	* @param now - the reference timestamp.
	* @param ttlMs - the fallback TTL for unverified simulated experiences.
	* @returns the expIds removed.
	*/
	expireUnverifiedSimulated(now, ttlMs) {
		const expired = [];
		for (const exp of this.experiences.values()) if (exp.simulated && exp.verification === "unverified" && now - exp.timestamp >= ttlMs) {
			this.experiences.delete(exp.expId);
			expired.push(exp.expId);
		}
		if (expired.length > 0) this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
		return expired;
	}
	/** Store one prediction and enqueue its persistence.
	* @param prediction - the prediction to add.
	*/
	addPrediction(prediction) {
		this.predictions.set(prediction.predictionId, prediction);
		this.enqueueLines("predictions.jsonl", [...this.predictions.values()]);
	}
	/** Read one prediction by id.
	* @param predictionId - the prediction id.
	* @returns the prediction, or undefined.
	*/
	getPrediction(predictionId) {
		return this.predictions.get(predictionId);
	}
	/** Snapshot of every stored prediction.
	* @returns predictions in insertion order.
	*/
	predictionsSnapshot() {
		return [...this.predictions.values()];
	}
	/**
	* Resolve one prediction with its actual outcome, propagating the absolute
	* prediction error to the bound experience's cumulative error. When the
	* feedback carries a result-quality label, it is folded back into the bound
	* experience's utility so "predicted wrong but quality known" experiences
	* carry a real tag instead of staying neutral.
	* @param predictionId - the prediction to resolve.
	* @param actualOutcome - the observed outcome text.
	* @param predictionError - absolute error in [0, 1].
	* @param outcomeQuality - optional result quality 0-10 to fold into the bound experience.
	* @param disequilibriumGate - optional gate parameters; when supplied, each
	* quality-carrying settlement is judged against the prior sample
	* distribution and a threshold-crossing deviation flags the experience.
	* @returns the resolved prediction.
	*/
	resolvePrediction(predictionId, actualOutcome, predictionError, outcomeQuality, disequilibriumGate) {
		const current = this.predictions.get(predictionId);
		if (current === void 0) throw new Error(`cognitive-pipeline: prediction "${predictionId}" not found`);
		const now = Date.now();
		const resolved = {
			...current,
			actualOutcome,
			predictionError,
			resolvedAt: now
		};
		this.predictions.set(predictionId, resolved);
		this.enqueueLines("predictions.jsonl", [...this.predictions.values()]);
		if (current.expId !== null) {
			const exp = this.experiences.get(current.expId);
			if (exp !== void 0) {
				const utility = outcomeQuality === void 0 ? exp.sar.outcomeUtility : {
					...exp.sar.outcomeUtility,
					materialGain: clampLabel(5 + (outcomeQuality - 5) * .8)
				};
				const next = {
					...exp,
					predictionError,
					cumulativeError: exp.cumulativeError + predictionError,
					sar: {
						...exp.sar,
						outcomeUtility: utility
					},
					...outcomeQuality === void 0 ? {} : (() => {
						const prior = exp.settlements ?? [];
						const gate = disequilibriumGate ?? {
							zThreshold: 2,
							minSamples: 3
						};
						const judgment = disequilibriumOf(prior, outcomeQuality, gate.zThreshold, gate.minSamples);
						const active = exp.disequilibrium !== void 0 && exp.disequilibriumRecoveredAt === void 0;
						const mean = prior.length === 0 ? outcomeQuality : prior.reduce((sum, sample) => sum + sample.quality, 0) / prior.length;
						const recovered = active && exp.disequilibrium !== void 0 && Math.abs(outcomeQuality - mean) < Math.abs(exp.disequilibrium.sampleQuality - mean);
						return {
							settlements: [...prior, {
								ts: now,
								quality: outcomeQuality
							}],
							...judgment !== null && judgment.disequilibrated ? { disequilibrium: {
								atTs: now,
								sampleQuality: outcomeQuality,
								zScore: judgment.zScore
							} } : {},
							...recovered ? { disequilibriumRecoveredAt: now } : {}
						};
					})()
				};
				this.experiences.set(exp.expId, next);
				this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
			}
		}
		return resolved;
	}
	/** Read one scratchpad strategy by signature hash.
	* @param signatureHash - the strategy key.
	* @returns the strategy, or undefined.
	*/
	getTempStrategy(signatureHash) {
		return this.tempStrategies.get(signatureHash);
	}
	/** Store one scratchpad strategy and enqueue its persistence.
	* @param strategy - the strategy to add.
	*/
	addTempStrategy(strategy) {
		this.tempStrategies.set(strategy.signatureHash, strategy);
		this.enqueueLines("temp_strategies.jsonl", [...this.tempStrategies.values()]);
	}
	/** Apply a partial patch to one scratchpad strategy.
	* @param signatureHash - the strategy key.
	* @param patch - the fields to replace.
	* @returns the updated strategy.
	*/
	updateTempStrategy(signatureHash, patch) {
		const current = this.tempStrategies.get(signatureHash);
		if (current === void 0) throw new Error(`cognitive-pipeline: temp strategy "${signatureHash}" not found`);
		const next = {
			...current,
			...patch
		};
		this.tempStrategies.set(signatureHash, next);
		this.enqueueLines("temp_strategies.jsonl", [...this.tempStrategies.values()]);
		return next;
	}
	/** Snapshot of every scratchpad strategy.
	* @returns strategies in insertion order.
	*/
	tempStrategiesSnapshot() {
		return [...this.tempStrategies.values()];
	}
	/**
	* Expire active strategies past their TTL.
	* @param now - the reference timestamp; defaults to the current time.
	* @returns the hashes that were expired.
	*/
	expireTempStrategies(now = Date.now()) {
		const expired = [];
		for (const [hash, strategy] of this.tempStrategies) if (strategy.status === "active" && strategy.expiresAt < now) {
			this.tempStrategies.set(hash, {
				...strategy,
				status: "expired"
			});
			expired.push(hash);
		}
		if (expired.length > 0) this.enqueueLines("temp_strategies.jsonl", [...this.tempStrategies.values()]);
		return expired;
	}
	/** Record one resolved prediction in its confidence decile.
	* @param probability - the calibrated probability.
	* @param hit - whether the outcome was positive.
	*/
	recordCalibration(probability, hit) {
		const index = bucketIndex(probability);
		const bucket = this.calibration[index];
		if (bucket === void 0) throw new Error("cognitive-pipeline: calibration bucket out of range");
		const totalCount = bucket.totalCount + 1;
		const hitCount = bucket.hitCount + (hit ? 1 : 0);
		this.calibration[index] = {
			bucketIndex: index,
			totalCount,
			hitCount,
			empiricalAccuracy: hitCount / totalCount
		};
		this.enqueue("calibration.json", this.calibration);
	}
	/** Snapshot of every calibration bucket.
	* @returns a detached decile table.
	*/
	calibrationBucketsSnapshot() {
		return this.calibration.map((bucket) => ({ ...bucket }));
	}
	/**
	* Lifetime empirical accuracy for one probability's decile bucket.
	* @param probability - the calibrated probability.
	* @returns the bucket accuracy, or null when the bucket has no count.
	*/
	empiricalAccuracyFor(probability) {
		const bucket = this.calibration[bucketIndex(probability)];
		return bucket === void 0 ? null : bucket.empiricalAccuracy;
	}
	/** Snapshot of the learned retrieval channel weights.
	* @returns a detached weight record.
	*/
	channelWeightsSnapshot() {
		return { ...this.channelWeights };
	}
	/** Apply one EWMA step to the learned retrieval channel weights.
	* @param weights - the new weights; each must already be clamped.
	*/
	updateChannelWeights(weights) {
		this.channelWeights = { ...weights };
		this.enqueue("channel_weights.json", this.channelWeights);
	}
	/** Snapshot of the exploration state with the current window's usage.
	* @returns the exploration state (used counts reset for a stale date).
	*/
	explorationSnapshot() {
		if (this.explorationState.date !== todayKey()) return {
			date: todayKey(),
			used: 0,
			entries: [...this.explorationState.entries]
		};
		return {
			date: this.explorationState.date,
			used: this.explorationState.used,
			entries: [...this.explorationState.entries]
		};
	}
	/** Record one exploration attempt within the current budget window.
	* @param entry - the exploration entry to append.
	*/
	recordExploration(entry) {
		const current = this.explorationSnapshot();
		this.explorationState = {
			date: current.date,
			used: current.used + 1,
			entries: [...current.entries, entry]
		};
		this.enqueue("exploration.json", this.explorationState);
	}
	/** Mark an exploration entry's scratchpad terminal outcome.
	* @param scratchpadHash - the tracked scratchpad signature hash.
	* @param outcome - 'graduated' or 'expired'.
	*/
	resolveExploration(scratchpadHash, outcome) {
		const current = this.explorationSnapshot();
		const updated = current.entries.map((entry) => entry.scratchpadHash === scratchpadHash && entry.outcome === null ? {
			...entry,
			outcome
		} : entry);
		if (updated.some((entry, index) => entry !== current.entries[index])) {
			this.explorationState = {
				date: current.date,
				used: current.used,
				entries: updated
			};
			this.enqueue("exploration.json", this.explorationState);
		}
	}
	/**
	* Fold one real-world prediction error back into an exploration entry's ROI
	* ledger. Called on every feedback for a prediction that reused the entry's
	* scratchpad: the error (|calibrated − observed| of that reuse) updates the
	* entry's EWMA, and the entry flips validated/refuted once its EWMA clears
	* or crosses the threshold. This is the feedback chain that closes the
	* meta-cognition loop — an exploration is not merely graduated (it became a
	* strategy) but measured (did reusing it actually reduce prediction error).
	* @param scratchpadHash - the scratchpad the resolved prediction reused.
	* @param predictionError - the reuse prediction's absolute error in [0, 1].
	* @param learningRate - EWMA step for the fold.
	* @param errorThreshold - error ceiling: below validates, at/above refutes.
	* @returns the updated entry, or undefined when the hash tracks no entry.
	*/
	validateExploration(scratchpadHash, predictionError, learningRate, errorThreshold) {
		const current = this.explorationSnapshot();
		const target = current.entries.find((entry) => entry.scratchpadHash === scratchpadHash);
		if (target === void 0) return void 0;
		const validatedError = target.validatedError === null ? predictionError : (1 - learningRate) * target.validatedError + learningRate * predictionError;
		const entries = current.entries.map((entry) => entry.scratchpadHash === scratchpadHash ? {
			...entry,
			validatedError,
			validated: validatedError < errorThreshold
		} : entry);
		this.explorationState = {
			date: current.date,
			used: current.used,
			entries
		};
		this.enqueue("exploration.json", this.explorationState);
		return entries.find((entry) => entry.scratchpadHash === scratchpadHash);
	}
	/** Snapshot of every queued exploration task, insertion order.
	* @returns the task list.
	*/
	explorationTasksSnapshot() {
		return [...this.explorationTasks.values()];
	}
	/** Queue one autonomous exploration task.
	* @param goal - the exploration goal a background session will pursue.
	* @returns the new task.
	*/
	addExplorationTask(goal) {
		const task = {
			taskId: `task_${this.nextTaskSeq}`,
			goal,
			status: "pending",
			createdAt: Date.now(),
			pickedUpAt: null,
			result: null
		};
		this.nextTaskSeq += 1;
		this.explorationTasks.set(task.taskId, task);
		this.enqueue("exploration_tasks.json", [...this.explorationTasks.values()]);
		return task;
	}
	/** Transition one task's status, recording pickup time and the result.
	* @param taskId - the task to update.
	* @param patch - the status/pickedUpAt/result fields to apply.
	* @returns the updated task, or undefined when unknown.
	*/
	updateExplorationTask(taskId, patch) {
		const current = this.explorationTasks.get(taskId);
		if (current === void 0) return void 0;
		const next = {
			...current,
			...patch
		};
		this.explorationTasks.set(taskId, next);
		this.enqueue("exploration_tasks.json", [...this.explorationTasks.values()]);
		return next;
	}
	/** Store one loop-execution receipt and enqueue its persistence.
	* @param receipt - the receipt to add (id must be unique).
	*/
	addLoopExecution(receipt) {
		this.loopExecutions.set(receipt.receiptId, receipt);
		this.enqueueLines("loop_executions.jsonl", [...this.loopExecutions.values()]);
	}
	/** Read one loop-execution receipt by id.
	* @param receiptId - the receipt id (`<predictionId>@<target>`).
	* @returns the receipt, or undefined when unknown.
	*/
	getLoopExecution(receiptId) {
		return this.loopExecutions.get(receiptId);
	}
	/** Snapshot of every loop-execution receipt, insertion order.
	* @returns the receipt list.
	*/
	loopExecutionsSnapshot() {
		return [...this.loopExecutions.values()];
	}
	/** Mark one accepted receipt's terminal execution outcome. Refused receipts
	* are terminal by construction and are never settled.
	* @param receiptId - the receipt to settle.
	* @param status - the terminal outcome ('executed' or 'failed').
	* @param outcomeText - what the execution actually produced.
	* @param outcomeQuality - the outcome quality 0–10.
	* @returns the updated receipt, or undefined when unknown.
	*/
	settleLoopExecution(receiptId, status, outcomeText, outcomeQuality) {
		const current = this.loopExecutions.get(receiptId);
		if (current === void 0) return void 0;
		const next = {
			...current,
			status,
			settledAt: Date.now(),
			outcomeText,
			outcomeQuality
		};
		this.loopExecutions.set(receiptId, next);
		this.enqueueLines("loop_executions.jsonl", [...this.loopExecutions.values()]);
		return next;
	}
	/** Allocate the next acceptance-check id.
	* @returns `check_<n>`.
	*/
	nextAcceptanceCheckId() {
		const id = `check_${this.nextAcceptanceSeq}`;
		this.nextAcceptanceSeq += 1;
		return id;
	}
	/** Allocate the next claim-audit id.
	* @returns `audit_<n>`.
	*/
	nextAuditId() {
		const id = `audit_${this.nextAuditSeq}`;
		this.nextAuditSeq += 1;
		return id;
	}
	/** The next solidified-strategy id.
	* @returns `solidified-<n>`.
	*/
	nextSolidifiedStrategyId() {
		const id = `solidified-${this.nextStrategySeq}`;
		this.nextStrategySeq += 1;
		return id;
	}
	/** Store one acceptance criterion and enqueue its persistence.
	* @param check - the criterion to add.
	*/
	addAcceptanceCheck(check) {
		this.acceptance.set(check.checkId, check);
		this.enqueue("acceptance.json", [...this.acceptance.values()]);
	}
	/** Read one acceptance criterion by id.
	* @param checkId - the criterion id.
	* @returns the criterion, or undefined.
	*/
	getAcceptanceCheck(checkId) {
		return this.acceptance.get(checkId);
	}
	/** Snapshot of every acceptance criterion, insertion order.
	* @returns the criterion list.
	*/
	acceptanceSnapshot() {
		return [...this.acceptance.values()];
	}
	/** Apply a partial patch to one acceptance criterion. The domain freeze
	* (retired checks are immutable) is enforced by the service layer; the store
	* applies any patch it receives.
	* @param checkId - the criterion id.
	* @param patch - the fields to replace.
	* @returns the updated criterion.
	*/
	updateAcceptanceCheck(checkId, patch) {
		const current = this.acceptance.get(checkId);
		if (current === void 0) throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`);
		const next = {
			...current,
			...patch
		};
		this.acceptance.set(checkId, next);
		this.enqueue("acceptance.json", [...this.acceptance.values()]);
		return next;
	}
	/** Record one claim audit and enqueue its persistence.
	* @param audit - the audit to add (id must be unique).
	*/
	recordClaimAudit(audit) {
		this.claimAudits.set(audit.auditId, audit);
		this.enqueueLines("claim_audits.jsonl", [...this.claimAudits.values()]);
	}
	/** Snapshot of every claim audit, insertion order.
	* @returns the audit list.
	*/
	claimAuditsSnapshot() {
		return [...this.claimAudits.values()];
	}
	/** Fold one audit's verdict into one criterion's evidence ledger: invoked
	* always increments, and the audit counts as passed (evidence present) or
	* violated (no evidence). Passes backed by a matched external-witness anchor
	* (a session-log tool call or a workspace file state) additionally increment
	* the machine-verified counter, so the ledger separates machine-witnessed
	* satisfaction from self-reported satisfaction.
	* @param checkId - the applied criterion.
	* @param passed - whether the claim carried evidence for it.
	* @param machineVerified - whether that evidence was a matched external anchor.
	* @returns the updated criterion.
	*/
	applyAuditStats(checkId, passed, machineVerified = false) {
		const current = this.acceptance.get(checkId);
		if (current === void 0) throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`);
		const next = {
			...current,
			invokedCount: current.invokedCount + 1,
			passedCount: current.passedCount + (passed ? 1 : 0),
			violatedCount: current.violatedCount + (passed ? 0 : 1),
			machineVerifiedCount: current.machineVerifiedCount + (passed && machineVerified ? 1 : 0)
		};
		this.acceptance.set(checkId, next);
		this.enqueue("acceptance.json", [...this.acceptance.values()]);
		return next;
	}
	/** Fold one resolved prediction's |calibrated − observed| error into a
	* criterion's deviation ledger. Only called for audits that violated the
	* criterion, so the ledger measures "claims made without verification
	* correlate with prediction error" on the same ruler as every prediction.
	* @param checkId - the violated criterion.
	* @param predictionError - the resolved prediction's absolute error in [0, 1].
	* @returns the updated criterion.
	*/
	foldAcceptanceError(checkId, predictionError) {
		const current = this.acceptance.get(checkId);
		if (current === void 0) throw new Error(`cognitive-pipeline: acceptance check "${checkId}" not found`);
		const next = {
			...current,
			cumulativeError: current.cumulativeError + predictionError,
			errorFoldCount: current.errorFoldCount + 1
		};
		this.acceptance.set(checkId, next);
		this.enqueue("acceptance.json", [...this.acceptance.values()]);
		return next;
	}
	/** Upsert one trigger-jump association (keyed by jump word).
	* @param jump - the jump to add or replace.
	*/
	upsertTriggerJump(jump) {
		this.triggerJumps.set(jump.jumpWord, jump);
		this.enqueue("trigger_jumps.json", [...this.triggerJumps.values()]);
	}
	/** Read one trigger jump by jump word.
	* @param jumpWord - the jump word.
	* @returns the jump, or undefined.
	*/
	getTriggerJump(jumpWord) {
		return this.triggerJumps.get(jumpWord);
	}
	/** Snapshot of every trigger jump, insertion order.
	* @returns the jump list.
	*/
	triggerJumpsSnapshot() {
		return [...this.triggerJumps.values()];
	}
	/** Replace the whole trigger-jump table (a rebuild replaces the structure;
	* the service carries citation stats across the rebuild).
	* @param jumps - the new table.
	*/
	replaceTriggerJumps(jumps) {
		this.triggerJumps = new Map(jumps.map((jump) => [jump.jumpWord, jump]));
		this.enqueue("trigger_jumps.json", [...this.triggerJumps.values()]);
	}
	/** Snapshot of every discriminant axis, insertion order.
	* @returns the axis list.
	*/
	discriminantAxesSnapshot() {
		return this.discriminantAxes;
	}
	/** Replace the whole discriminant-axis table (a rebuild replaces the axes
	* together with the clusters they were extracted from).
	* @param axes - the new table.
	*/
	replaceDiscriminantAxes(axes) {
		this.discriminantAxes = [...axes];
		this.enqueue("discriminant_axes.json", this.discriminantAxes);
	}
	/** Allocate the next injection-record id.
	* @returns `inject_<n>`.
	*/
	nextInjectionId() {
		const id = `inject_${this.nextInjectionSeq}`;
		this.nextInjectionSeq += 1;
		return id;
	}
	/** Record one injection event.
	* @param record - the injection to add (id must be unique).
	*/
	recordInjection(record) {
		this.injections.set(record.injectionId, record);
		this.enqueueLines("injections.jsonl", [...this.injections.values()]);
	}
	/** Snapshot of every injection record, insertion order.
	* @returns the injection list.
	*/
	injectionsSnapshot() {
		return [...this.injections.values()];
	}
	/** Settle one injection's citation outcome.
	* @param injectionId - the injection to settle.
	* @param cited - whether a later assistant message referenced an injected expId.
	*/
	settleInjection(injectionId, cited) {
		const current = this.injections.get(injectionId);
		if (current === void 0 || current.cited !== null) return;
		this.injections.set(injectionId, {
			...current,
			cited
		});
		this.enqueueLines("injections.jsonl", [...this.injections.values()]);
	}
	/** Fold one settled injection's citation outcome into the contributing jump
	* words' measured-utility ledger (hitCount always, citedCount when cited).
	* @param jumpWords - the jump words that contributed to the trigger.
	* @param cited - whether the injection was cited.
	*/
	foldJumpCitation(jumpWords, cited) {
		if (jumpWords.length === 0) return;
		let changed = false;
		for (const word of jumpWords) {
			const jump = this.triggerJumps.get(word);
			if (jump === void 0) continue;
			this.triggerJumps.set(word, {
				...jump,
				hitCount: jump.hitCount + 1,
				citedCount: jump.citedCount + (cited ? 1 : 0),
				updatedAt: Date.now()
			});
			changed = true;
		}
		if (changed) this.enqueue("trigger_jumps.json", [...this.triggerJumps.values()]);
	}
	/** Upsert one chain (keyed by chain id).
	* @param chain - the chain to add or replace.
	*/
	upsertChain(chain) {
		this.chains.set(chain.chainId, chain);
		this.enqueue("chains.json", [...this.chains.values()]);
	}
	/** Read one chain by id.
	* @param chainId - the chain id.
	* @returns the chain, or undefined.
	*/
	getChain(chainId) {
		return this.chains.get(chainId);
	}
	/** Snapshot of every chain, insertion order.
	* @returns the chain list.
	*/
	chainsSnapshot() {
		return [...this.chains.values()];
	}
	/** Replace the whole chain table (a rebuild re-projects chains from tagged
	* experiences; the service carries citation stats across the rebuild).
	* @param chains - the new table.
	*/
	replaceChains(chains) {
		this.chains = new Map(chains.map((chain) => [chain.chainId, chain]));
		this.enqueue("chains.json", [...this.chains.values()]);
	}
	/** Fold one settled chain injection's citation outcome into the chain's
	* measured-utility ledger (hitCount always, citedCount when cited).
	* @param chainId - the chain that was injected.
	* @param cited - whether the injection was cited.
	*/
	foldChainCitation(chainId, cited) {
		const chain = this.chains.get(chainId);
		if (chain === void 0) return;
		this.chains.set(chainId, {
			...chain,
			hitCount: chain.hitCount + 1,
			citedCount: chain.citedCount + (cited ? 1 : 0),
			updatedAt: Date.now()
		});
		this.enqueue("chains.json", [...this.chains.values()]);
	}
	/** Read one chain pattern by id (its structural signature).
	* @param patternId - the signature-based pattern id.
	* @returns the pattern, or undefined.
	*/
	getChainPattern(patternId) {
		return this.chainPatterns.get(patternId);
	}
	/** Snapshot of every chain pattern, insertion order.
	* @returns the pattern list.
	*/
	chainPatternsSnapshot() {
		return [...this.chainPatterns.values()];
	}
	/** Replace the whole chain-pattern table (a rebuild re-projects patterns
	* from chains).
	* @param patterns - the new table.
	*/
	replaceChainPatterns(patterns) {
		this.chainPatterns = new Map(patterns.map((pattern) => [pattern.patternId, pattern]));
		this.enqueue("chain_patterns.json", [...this.chainPatterns.values()]);
	}
	/** Recompute one pattern's measured utility from its member chains' current
	* citation stats (called by the pattern kind's measure, so a chain citation
	* settlement refreshes the pattern aggregate).
	* @param patternId - the signature-based pattern id.
	*/
	recomputeChainPatternStats(patternId) {
		const pattern = this.chainPatterns.get(patternId);
		if (pattern === void 0) return;
		let hitCount = 0;
		let citedCount = 0;
		for (const chainId of pattern.chainIds) {
			const chain = this.chains.get(chainId);
			if (chain === void 0) continue;
			hitCount += chain.hitCount;
			citedCount += chain.citedCount;
		}
		this.chainPatterns.set(patternId, {
			...pattern,
			hitCount,
			citedCount,
			updatedAt: Date.now()
		});
		this.enqueue("chain_patterns.json", [...this.chainPatterns.values()]);
	}
	/** Read one solidified strategy by id.
	* @param strategyId - the strategy id.
	* @returns the strategy, or undefined.
	*/
	getSolidifiedStrategy(strategyId) {
		return this.solidifiedStrategies.get(strategyId);
	}
	/** Read the solidified strategy serving one goal domain, if any.
	* @param goalDomain - the goal domain key (e.g. `重启`).
	* @returns the strategy, or undefined.
	*/
	getSolidifiedStrategyByDomain(goalDomain) {
		return [...this.solidifiedStrategies.values()].find((strategy) => strategy.goalDomain === goalDomain);
	}
	/** Snapshot of every solidified strategy, insertion order.
	* @returns the strategy list.
	*/
	solidifiedStrategiesSnapshot() {
		return [...this.solidifiedStrategies.values()];
	}
	/** Add or replace one solidified strategy.
	* @param strategy - the strategy to persist.
	*/
	upsertSolidifiedStrategy(strategy) {
		this.solidifiedStrategies.set(strategy.strategyId, strategy);
		this.enqueue("solidified_strategies.json", [...this.solidifiedStrategies.values()]);
	}
	/** Fold one usage outcome into a strategy's lifecycle ledger: every use
	* increments hitCount; a positive outcome (verification anchor held) also
	* increments positiveCount; a failure (anchor failed or a pre-check tripped)
	* increments violatedCount and flags rework when the deviation gate crosses
	* (≥3 invoked, ≥50% violated — the acceptance-criteria gate shape).
	* @param strategyId - the strategy id.
	* @param positive - whether the use ended with the anchor holding.
	*/
	foldSolidifiedStrategyUsage(strategyId, positive) {
		const strategy = this.solidifiedStrategies.get(strategyId);
		if (strategy === void 0) return;
		const hitCount = strategy.hitCount + 1;
		const positiveCount = strategy.positiveCount + (positive ? 1 : 0);
		const violatedCount = strategy.violatedCount + (positive ? 0 : 1);
		const invoked = hitCount;
		const reworkNeeded = invoked >= 3 && violatedCount / invoked >= .5;
		this.solidifiedStrategies.set(strategyId, {
			...strategy,
			hitCount,
			positiveCount,
			violatedCount,
			reworkNeeded,
			updatedAt: Date.now()
		});
		this.enqueue("solidified_strategies.json", [...this.solidifiedStrategies.values()]);
	}
	/** Allocate the next variant id.
	* @returns `variant-<n>`.
	*/
	nextVariantId() {
		const id = `variant-${this.nextVariantSeq}`;
		this.nextVariantSeq += 1;
		return id;
	}
	/** Snapshot of every variant candidate, insertion order.
	* @returns the candidate list.
	*/
	variantsSnapshot() {
		return [...this.variants.values()];
	}
	/** Add one variant candidate.
	* @param candidate - the candidate to persist.
	*/
	addVariantCandidate(candidate) {
		this.variants.set(candidate.variantId, candidate);
		this.enqueue("variants.json", [...this.variants.values()]);
	}
	/** Replace one variant candidate (lifecycle transition or settlement append).
	* @param candidate - the updated candidate.
	*/
	updateVariantCandidate(candidate) {
		this.variants.set(candidate.variantId, candidate);
		this.enqueue("variants.json", [...this.variants.values()]);
	}
	/** Snapshot of the cluster table.
	* @returns clusters with detached fields.
	*/
	clustersSnapshot() {
		return this.clusterList.map((cluster) => ({ ...cluster }));
	}
	/** Snapshot of the current taxonomy.
	* @returns the taxonomy, or null before the first rebuild.
	*/
	taxonomySnapshot() {
		return this.taxonomyState === null ? null : {
			...this.taxonomyState,
			rules: [...this.taxonomyState.rules]
		};
	}
	/** Allocate the next cluster id.
	* @returns a fresh monotonically increasing id.
	*/
	nextClusterId() {
		const id = this.nextClusterSeq;
		this.nextClusterSeq += 1;
		return id;
	}
	/**
	* Atomically replace the cluster table and taxonomy, and reassign member
	* experiences to their new clusters. One enqueued flush per table keeps the
	* files consistent with each other.
	* @param clusters - the new cluster table.
	* @param taxonomy - the new taxonomy snapshot.
	* @param assignments - per-experience cluster membership to write back.
	*/
	applyTaxonomy(clusters, taxonomy, assignments) {
		this.clusterList = clusters.map((cluster) => ({ ...cluster }));
		this.taxonomyState = {
			...taxonomy,
			rules: [...taxonomy.rules]
		};
		this.enqueue("clusters.json", this.clusterList);
		this.enqueue("taxonomy.json", this.taxonomyState);
		for (const [expId, assignment] of assignments) {
			const exp = this.experiences.get(expId);
			if (exp !== void 0) this.experiences.set(expId, {
				...exp,
				clusterId: assignment.clusterId,
				strategyLabel: assignment.strategyLabel
			});
		}
		this.enqueueLines("experiences.jsonl", [...this.experiences.values()]);
	}
	/** Simple in-memory + disk counts for inspection.
	* @returns experience, prediction, resolved, and settlement-ledger counts.
	*/
	stats() {
		let resolved = 0;
		for (const prediction of this.predictions.values()) if (prediction.resolvedAt !== null) resolved += 1;
		let sampleCount = 0;
		let sampledExperienceCount = 0;
		let multiSampleExperienceCount = 0;
		let disequilibratedExperienceCount = 0;
		let recoveredDisequilibriumCount = 0;
		let citedExperienceCount = 0;
		let zeroCitationExperienceCount = 0;
		for (const exp of this.experiences.values()) {
			const samples = exp.settlements ?? [];
			if (samples.length > 0) {
				sampleCount += samples.length;
				sampledExperienceCount += 1;
				if (samples.length >= 2) multiSampleExperienceCount += 1;
			}
			if (exp.disequilibrium !== void 0) if (exp.disequilibriumRecoveredAt === void 0) disequilibratedExperienceCount += 1;
			else recoveredDisequilibriumCount += 1;
			if ((exp.citationCount ?? 0) > 0) citedExperienceCount += 1;
			else zeroCitationExperienceCount += 1;
		}
		return {
			experienceCount: this.experiences.size,
			predictionCount: this.predictions.size,
			resolvedPredictionCount: resolved,
			settlement: {
				sampleCount,
				sampledExperienceCount,
				multiSampleExperienceCount,
				disequilibratedExperienceCount,
				recoveredDisequilibriumCount
			},
			citation: {
				citedExperienceCount,
				zeroCitationExperienceCount
			}
		};
	}
	/** Allocate the next experience id.
	* @returns `exp_<n>`.
	*/
	nextExpId() {
		const id = `exp_${this.nextExpSeq}`;
		this.nextExpSeq += 1;
		return id;
	}
	/** Allocate the next prediction id.
	* @returns `pred_<n>`.
	*/
	nextPredictionId() {
		const id = `pred_${this.nextPredictionSeq}`;
		this.nextPredictionSeq += 1;
		return id;
	}
	/** Derive a normalized cluster view when the on-disk row predates the new
	* polarity / situationCentroid fields: polarity from the expected utility
	* range, centroid from the supporting experiences' situations.
	* @param raw - the loaded, still-untrusted cluster row.
	* @returns the cluster with both new fields present.
	*/
	normalizeCluster(raw) {
		const polarityRaw = raw.polarity;
		const hasPolarity = polarityRaw === "success" || polarityRaw === "risk";
		const centroidRaw = raw.situationCentroid;
		const hasCentroid = Array.isArray(centroidRaw) && centroidRaw.length > 0;
		if (hasPolarity && hasCentroid) return raw;
		const members = (Array.isArray(raw.supportingEvidenceIds) ? raw.supportingEvidenceIds.filter((id) => typeof id === "string") : []).map((id) => this.experiences.get(id)).filter((exp) => exp !== void 0);
		const rangeLow = typeof raw.expectedUtilityRange === "object" && raw.expectedUtilityRange !== null ? Number(raw.expectedUtilityRange.low) : 0;
		const polarity = hasPolarity ? polarityRaw : Number.isFinite(rangeLow) && rangeLow >= 5 ? "success" : "risk";
		return {
			...raw,
			polarity,
			situationCentroid: members.length === 0 ? new Array(384).fill(0) : centroidOf(members.map((member) => actionVector(member.sar.situation, [])))
		};
	}
};
/** Extract the numeric sequence from an `exp_<n>` id. */
function expSeqOf(expId) {
	const match = /^exp_(\d+)$/.exec(expId);
	return match === null ? 0 : Number(match[1]);
}
/** Extract the numeric sequence from a `pred_<n>` id. */
function predictionSeqOf(predictionId) {
	const match = /^pred_(\d+)$/.exec(predictionId);
	return match === null ? 0 : Number(match[1]);
}
/** Mean of L2-normalized vectors (centroid), re-normalized; zero input stays zero. */
function centroidOf(vectors) {
	const dim = vectors[0]?.length ?? 0;
	if (dim === 0) return [];
	const sum = new Array(dim).fill(0);
	for (const vector of vectors) for (let index = 0; index < dim; index += 1) sum[index] = (sum[index] ?? 0) + (vector[index] ?? 0);
	const mean = sum.map((value) => value / vectors.length);
	let norm = 0;
	for (const value of mean) norm += value * value;
	norm = Math.sqrt(norm);
	return norm < 1e-9 ? mean : mean.map((value) => value / norm);
}
/** Clamp a feedback-derived utility axis into [0, 10] rounded to one decimal. */
function clampLabel(value) {
	return Math.min(10, Math.max(0, Math.round(value * 10) / 10));
}
//#endregion
//#region lib/types/triggers.js
/**
* Trigger lexicon of the injection gate: the static behavior words, the
* SAR-derived keywords weighted by importance, and the co-occurrence jump
* builder that turns "words that appear with a trigger in real experiences"
* into associative jump words. The lexicon is experience-derived knowledge,
* so it lives with the pipeline store (like the taxonomy and the acceptance
* ledger); the inject plugin imports it rather than re-deriving it.
* @module @deepseek-ai/dsh-cognitive-pipeline/triggers
*/
/** Static behavior triggers: words whose presence means the current message
* is asking for help, exploring, or deciding — the situations where humans
* actually consult past experience. A single static hit triggers injection. */
const STATIC_TRIGGERS = new Set([
	"失败",
	"报错",
	"错误",
	"卡住",
	"挂起",
	"超时",
	"崩溃",
	"异常",
	"排查",
	"修复",
	"恢复",
	"怎么",
	"如何",
	"怎样",
	"为什么",
	"试试",
	"尝试",
	"测试",
	"验证",
	"确认",
	"风险",
	"危险",
	"慎重",
	"谨慎",
	"建议",
	"推荐",
	"帮助",
	"求助",
	"以前",
	"之前",
	"曾经",
	"上次",
	"遇到过",
	"经验",
	"参考",
	"回忆",
	"记得",
	"发布",
	"部署",
	"上线",
	"推送",
	"提交",
	"合并",
	"迁移",
	"升级",
	"安装",
	"配置",
	"计划",
	"打算",
	"准备",
	"决定",
	"方案",
	"步骤",
	"流程",
	"检查",
	"诊断"
]);
/** CJK stop words: tokens too common to carry trigger signal. */
const STOP_WORDS = new Set([
	"的",
	"了",
	"在",
	"和",
	"我",
	"你",
	"他",
	"她",
	"它",
	"是",
	"一",
	"个",
	"这",
	"那",
	"到",
	"就",
	"都",
	"也",
	"要",
	"会",
	"能",
	"与",
	"及",
	"或",
	"有",
	"对",
	"从",
	"被",
	"把",
	"让",
	"用",
	"以",
	"为",
	"上",
	"下",
	"中",
	"不",
	"没",
	"很",
	"太",
	"再",
	"又",
	"吗",
	"呢",
	"吧",
	"啊",
	"的",
	"地",
	"得",
	"等",
	"并",
	"而",
	"但",
	"如果",
	"然后"
]);
/** Minimum derived-trigger weight to count as a hit. */
const DERIVED_TRIGGER_MIN = .3;
/**
* Importance of one experience for trigger learning: outcome extremity
* (|utilityScore|/15) plus a high-risk bonus for negative outcomes and a
* frequency bonus for experiences the hot loop has hit before. Experiences
* with no signal (neutral utility, never hit) contribute nothing.
* @param exp - the experience.
* @returns the importance in [0, 1.2].
*/
function importanceOf(exp) {
	const { materialGain: gain, emotionalValence: valence, energyCost: cost } = exp.sar.outcomeUtility;
	const utility = Math.abs(gain - 5 + (valence - 5) - (cost - 5)) / 15;
	if (utility < .01 && exp.hitCount === 0 && gain >= 5 && valence >= 5 && cost <= 5) return 0;
	const risk = gain < 5 ? .3 : 0;
	const frequency = exp.hitCount > 0 ? Math.min(exp.hitCount, 5) * .1 : 0;
	return utility + risk + frequency;
}
/**
* Derive the trigger lexicon from the experience store: multi-char words of
* the situation/action of important experiences (high utility, high-risk, or
* frequently hit) accumulate their importance into per-word weights, the
* top-N survive, normalized to [DERIVED_TRIGGER_MIN, 1].
*
* Vocabulary matches the jump layer (finding #10): single CJK characters were
* noise — the derived table measured 59/60 single chars (行×189, 验×184) that
* let nearly any message cross the 0.6 gate, making injection indiscriminate
* (83% of 126 injections never cited). Only multi-char words (CJK bigrams +
* latin tokens) carry associative specificity.
* @param service - the pipeline service whose store feeds the lexicon.
* @returns the derived trigger map (word → weight).
*/
function deriveTriggerWords(service) {
	const weights = /* @__PURE__ */ new Map();
	for (const exp of service.store.experiencesSnapshot()) {
		const importance = importanceOf(exp);
		if (importance <= 0) continue;
		const tokens = new Set(jumpVocabulary(`${exp.sar.situation} ${exp.sar.action}`));
		for (const token of tokens) {
			if (STOP_WORDS.has(token) || STATIC_TRIGGERS.has(token)) continue;
			weights.set(token, (weights.get(token) ?? 0) + importance);
		}
	}
	const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
	const max = ranked[0]?.[1] ?? 0;
	if (max <= 0) return /* @__PURE__ */ new Map();
	const span = 1 - DERIVED_TRIGGER_MIN;
	return new Map(ranked.map(([token, weight]) => [token, DERIVED_TRIGGER_MIN + weight / max * span]));
}
/** Initialize an empty jump accumulator.
* @returns a fresh empty accumulator.
*/
function emptyJumpAccumulator() {
	return /* @__PURE__ */ new Map();
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
*
* Token vocabulary (finding: the jump layer's single-CJK-character tokens were
* noise — "该/置/目" associate with every generic verb, 89% of the 400-word
* table never fired and 0 were ever cited): a jump word must be a multi-char
* latin token (bundle/bug/dsh) or a CJK bigram from the text (端口/挂起/重启).
* Single CJK characters are dropped — they co-occur with everything and carry
* no associative specificity. The bigrams are extracted locally so the shared
* `tokenize` (which feeds retrieval vectors) is untouched.
* @param service - the pipeline service whose store feeds the accumulation.
* @param accumulator - the accumulator to fold into (fresh from
*   {@link emptyJumpAccumulator} for a rebuild).
* @param derived - the derived trigger lexicon (static triggers are matched
*   as substrings, derived ones as exact tokens).
*/
function accumulateTriggerJumps(service, accumulator, derived) {
	const derivedTokens = new Set(derived.keys());
	for (const exp of service.store.experiencesSnapshot()) {
		const importance = importanceOf(exp);
		if (importance <= 0) continue;
		const text = `${exp.sar.situation} ${exp.sar.action}`;
		const tokens = jumpVocabulary(text);
		const presentTriggers = /* @__PURE__ */ new Set();
		for (const trigger of STATIC_TRIGGERS) if (text.includes(trigger)) presentTriggers.add(trigger);
		for (const token of tokens) if (derivedTokens.has(token)) presentTriggers.add(token);
		for (const trigger of presentTriggers) for (const token of tokens) {
			if (token === trigger || STOP_WORDS.has(token) || STATIC_TRIGGERS.has(token)) continue;
			const byTrigger = accumulator.get(token) ?? /* @__PURE__ */ new Map();
			const prior = byTrigger.get(trigger) ?? {
				evidenceCount: 0,
				importance: 0
			};
			byTrigger.set(trigger, {
				evidenceCount: prior.evidenceCount + 1,
				importance: prior.importance + importance
			});
			accumulator.set(token, byTrigger);
		}
	}
}
/** Whether one character is CJK. */
function isCjkChar(char) {
	const code = char.codePointAt(0) ?? 0;
	return code >= 19968 && code <= 40959;
}
/** The jump-word vocabulary of one text: multi-char latin tokens plus CJK
* bigrams (every adjacent pair inside a CJK run). Single CJK characters are
* excluded — the measured jump layer of 400 words was 89% single-char noise
* (该/置/目) that never fired and never got cited. Exported so the inject
* gate matches messages with the same vocabulary the lexicon was built from.
*/
function jumpVocabulary(text) {
	const tokens = tokenize(text);
	const words = /* @__PURE__ */ new Set();
	for (const token of tokens) if (/[a-zA-Z0-9]/.test(token)) words.add(token);
	let run = "";
	for (const char of text) if (isCjkChar(char)) run += char;
	else {
		if (run.length >= 2) for (let index = 0; index + 1 < run.length; index += 1) words.add(run.slice(index, index + 2));
		run = "";
	}
	if (run.length >= 2) for (let index = 0; index + 1 < run.length; index += 1) words.add(run.slice(index, index + 2));
	return [...words];
}
//#endregion
//#region lib/types/cognition-objects.js
/**
* The derived cognition object abstraction: the special-experience layer
* pattern that has recurred five times (clusters, meta-cognition loops,
* acceptance criteria, trigger jumps, and now goal-anchored chains). A kind
* DECLARES its lifecycle — project / persist / measure / reinforce / expose —
* and the pipeline drives it generically, so a new derived object costs a
* declaration instead of hand-rolled plumbing. The abstraction covers the
* DECISION layer (lifecycle shape, the ruler, the evidence gate); execution
* (per-kind storage, channel wiring, legacy normalization) stays per-kind,
* per the exp_93 boundary lesson.
* @module @deepseek-ai/dsh-cognitive-pipeline/cognition-objects
*/
/** Assemble one goal-anchored chain from its tagged members: the causal
* skeleton keeps failure steps and cross-agent delegation nodes as structural
* steps, collapses routine successes into a bounded summary (memory organizes
* around surprises), and carries the previous chain's measured citation stats.
* @param chainId - the goal trace id.
* @param goal - the goal anchoring the chain (the MOP goal).
* @param anchorSessionId - the session that anchored the chain, when known.
* @param members - the experiences tagged with this chainId (unordered).
* @param previous - the previous chain for the same id, if any (stats carry).
* @param now - the reference timestamp.
* @returns the consolidated chain.
*/
function assembleChain(chainId, goal, anchorSessionId, members, previous, now) {
	const ordered = [...members].sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.timestamp - b.timestamp);
	const steps = [];
	const delegationIds = [];
	const collapsed = [];
	let sequence = 0;
	for (const member of ordered) {
		const polarity = outcomePolarity(member.sar.outcomeUtility);
		const isDelegation = typeof member.parentNodeId === "string" && member.parentNodeId.includes("@");
		if (polarity === "negative" || isDelegation) {
			steps.push({
				nodeId: member.expId,
				text: `${member.sar.action}。${member.sar.outcome}`.slice(0, 200),
				polarity: polarity === "negative" ? "failure" : "success",
				sequence
			});
			sequence += 1;
			if (isDelegation) delegationIds.push(member.parentNodeId);
		} else collapsed.push(`${member.sar.action}。${member.sar.outcome}`);
	}
	const memberExpIds = ordered.map((member) => member.expId);
	const memberSetChanged = previous !== void 0 && (previous.memberExpIds.length !== memberExpIds.length || previous.memberExpIds.some((id, index) => id !== memberExpIds[index]));
	return {
		chainId,
		goal,
		anchorSessionId,
		status: "consolidated",
		steps,
		memberExpIds,
		delegationNodeIds: [...new Set(delegationIds)],
		childChainIds: [],
		collapsedCount: collapsed.length,
		summary: collapsed.slice(0, 4).join("；").slice(0, 500),
		...previous !== void 0 && !memberSetChanged && previous.distilledPrinciple !== void 0 ? { distilledPrinciple: previous.distilledPrinciple } : {},
		...ordered.some((member) => member.selfReflexive === true) ? { selfReflexive: true } : {},
		hitCount: previous?.hitCount ?? 0,
		citedCount: previous?.citedCount ?? 0,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now
	};
}
/**
* The child chains of one chain: chains whose ROOT member derives from this
* chain's delegation receipts (a delegated sub-goal's entry node references
* the parent's receipt). Anchoring on the root breaks the cycle that a shared
* receipt would otherwise create — the delegating chain's own mid-chain
* receipt node is never a root, so it cannot appear as its own child.
* @param chain - the parent chain.
* @param experiences - the full experience snapshot.
* @returns the distinct child chain ids.
*/
function childChainIdsOf(chain, experiences) {
	const receipts = new Set(chain.delegationNodeIds);
	if (receipts.size === 0) return [];
	const roots = /* @__PURE__ */ new Map();
	for (const exp of experiences) {
		if (exp.chainId === void 0 || exp.chainId === chain.chainId) continue;
		const current = roots.get(exp.chainId);
		if (current === void 0 || (exp.sequence ?? Number.MAX_SAFE_INTEGER) < (current.sequence ?? Number.MAX_SAFE_INTEGER)) roots.set(exp.chainId, exp);
	}
	const children = /* @__PURE__ */ new Set();
	for (const [chainId, root] of roots) if (root.parentNodeId !== void 0 && receipts.has(root.parentNodeId)) children.add(chainId);
	return [...children];
}
/**
* The chain kind: the first declarative instance of a derived cognition
* object. It projects the goal-anchored causal skeletons from chain-tagged
* experiences (evidence gate: `chainMinMembers`), persists them to
* `chains.json`, measures them with the chain-level citation rate (an
* injection of a chain is cited when the model references it), and exposes
* them as structured step lists. Reinforcement carries the measured stats
* across rebuilds; chains are goal-scoped, so no chain is pruned by the
* object framework itself.
*/
var ChainObjectKind = class {
	name = "chain";
	description = "goal-anchored causal skeletons from chain-tagged experiences, measured by chain-level citation rate";
	project(store, config) {
		const byChain = /* @__PURE__ */ new Map();
		const experiences = store.experiencesSnapshot();
		for (const exp of experiences) {
			if (exp.chainId === void 0) continue;
			const members = byChain.get(exp.chainId) ?? [];
			members.push(exp);
			byChain.set(exp.chainId, members);
		}
		const now = Date.now();
		const chains = [];
		for (const [chainId, members] of byChain) {
			if (members.length < config.chainMinMembers) continue;
			const previous = store.getChain(chainId);
			const first = members[0];
			const assembled = assembleChain(chainId, previous?.goal ?? (first === void 0 ? chainId : first.sar.situation.slice(0, 80)), previous?.anchorSessionId ?? null, members, previous, now);
			chains.push({
				...assembled,
				childChainIds: childChainIdsOf(assembled, experiences)
			});
		}
		return chains;
	}
	persist(store, build) {
		store.replaceChains(build);
	}
	measure(store, objectId, feedback) {
		store.foldChainCitation(objectId, feedback === true);
	}
	reinforce(_store, _config, build) {
		return build;
	}
	current(store) {
		return store.chainsSnapshot();
	}
};
/** The coarse goal-domain key: the first non-stop character token of the goal. */
function goalDomainKey(goal) {
	for (const token of tokenize(goal)) if (!STOP_WORDS.has(token)) return token;
	return goal.slice(0, 4);
}
/** The structural signature of one chain: coarse goal domain + the step
* polarity sequence + the causal-break-point axis (whether any member
* self-reflexively killed the agent's own host), e.g. `发布:失败,失败,成功` or
* `重启:失败~自反`. The self-reflexive axis is the cross-domain theme
* projector: "self-reflexive interruption → external witnessing" recurs across
* unrelated goal domains, so chains from different domains that both carry the
* break point share a signature suffix and can aggregate into one theme.
* @param chain - the chain to sign.
* @returns the signature string.
*/
function chainSignature(chain) {
	const polaritySeq = chain.steps.map((step) => step.polarity === "failure" ? "失败" : "成功").join(",");
	const suffix = chain.selfReflexive === true ? "~自反" : "";
	return `${goalDomainKey(chain.goal)}:${polaritySeq === "" ? "空" : polaritySeq}${suffix}`;
}
/**
* The chain-pattern kind: the sixth derived cognition object and the
* abstraction's FIRST recursive consumer — patterns project from the chain
* table the way chains project from experiences. Chains sharing a structural
* signature (coarse goal domain + polarity sequence) aggregate into a
* recurring goal-execution pattern (the TOPS analogue: from similar MOPs,
* extract the cross-situation thematic pattern). Measured utility is
* aggregated from the member chains' citation stats; the pattern's cited rate
* retroactively measures whether the grouping was useful.
*/
var ChainPatternObjectKind = class {
	name = "chain-pattern";
	description = "recurring goal-execution patterns aggregated from chains (TOPS analogue), measured by member chain citation";
	project(store, config) {
		const bySignature = /* @__PURE__ */ new Map();
		for (const chain of store.chainsSnapshot()) {
			const signature = chainSignature(chain);
			const group = bySignature.get(signature) ?? [];
			group.push(chain);
			bySignature.set(signature, group);
		}
		const now = Date.now();
		const patterns = [];
		for (const [signature, group] of bySignature) {
			if (group.length < config.chainPatternMinMembers) continue;
			const previous = store.getChainPattern(signature);
			const seen = /* @__PURE__ */ new Set();
			const skeleton = [];
			for (const chain of group) {
				for (const step of chain.steps) {
					if (skeleton.length >= 6) break;
					if (seen.has(step.text)) continue;
					seen.add(step.text);
					skeleton.push(step);
				}
				if (skeleton.length >= 6) break;
			}
			const goalCounts = /* @__PURE__ */ new Map();
			for (const chain of group) {
				const domain = chain.goal.slice(0, 20);
				goalCounts.set(domain, (goalCounts.get(domain) ?? 0) + 1);
			}
			const goalDomain = [...goalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
			patterns.push({
				patternId: signature,
				signature,
				chainIds: group.map((chain) => chain.chainId),
				skeleton,
				goalDomain,
				hitCount: group.reduce((sum, chain) => sum + chain.hitCount, 0),
				citedCount: group.reduce((sum, chain) => sum + chain.citedCount, 0),
				createdAt: previous?.createdAt ?? now,
				updatedAt: now
			});
		}
		return patterns;
	}
	persist(store, build) {
		store.replaceChainPatterns(build);
	}
	measure(store, objectId, _feedback) {
		for (const pattern of store.chainPatternsSnapshot()) if (pattern.chainIds.includes(objectId)) store.recomputeChainPatternStats(pattern.patternId);
	}
	reinforce(_store, _config, build) {
		return build;
	}
	current(store) {
		return store.chainPatternsSnapshot();
	}
};
//#endregion
//#region lib/types/task-restatement.js
/**
* Task-restatement detection shared by the accumulation gate (reject new
* records) and the injection retrieval (skip existing records). A delegated
* task instruction that was auto-accumulated as an experience — its situation
* is the verbatim task text, its action merely re-states the delegation with
* no real tool trace — ranks at the top of every later injection for the same
* task, crowding out the experiences that actually hold the solution (the
* exp_155/168/173 lesson). Deterministic so the gate cannot be talked into
* storing one by an over-eager LLM.
* @module @deepseek-ai/dsh-cognitive-pipeline/task-restatement
*/
/** Whether one candidate is a task-restatement record.
* @param candidate - the experience or extracted SAR to judge.
* @returns true when the action shows no tool-operation trace and the
*   situation reads like a task instruction.
*/
function isTaskRestatement(candidate) {
	const action = candidate.sar.action;
	const situation = candidate.sar.situation;
	if (/调用|pwsh|Start-Process|Stop-Process|glob|grep|read|write|edit|explore|consolidate|remember/i.test(action)) return false;
	const instructionLike = /(任务|需要|请完成|请执行|要求)/.test(situation);
	const restatesDelegation = /(子代理执行|启动子代理|执行.{0,8}任务|按该|按照该|根据任务)/.test(action);
	return instructionLike && restatesDelegation;
}
//#endregion
//#region lib/types/service.js
/**
* CognitivePipelineService: the pipeline's public service. It owns the store
* and both engines, and exposes the online (`remember`/`predict`/`report`),
* offline (`rebuild`), and observational (`inspect`) entry points the tools
* and other plugins call. Extends Cordis `Service`, so loading the plugin
* provides `ctx.cognitivePipeline`.
* @module @deepseek-ai/dsh-cognitive-pipeline/service
*/
/** Meta-experience deduplication: skip recording a routing-failure when an
* action-vector-identical meta experience already exists (default 0.8). */
const META_DEDUP_COSINE = .8;
/** Pure-chat pre-filter: a turn with no tool calls, no failure, and short
* output never reaches the accumulation gate (the per-turn LLM cost guard). */
const ACCUMULATE_MIN_ACTION_CHARS = 160;
/** Config schema for Loader validation and defaulting. */
const Config = z.object({
	root: z.string(),
	provider: z.string(),
	model: z.string(),
	enabled: z.boolean().default(true),
	topK: z.number().step(1).min(1).max(50).default(10),
	oodSimThreshold: z.number().min(0).max(1).default(.65),
	oodFlatThreshold: z.number().min(0).max(1).default(.1),
	oodSiThreshold: z.number().min(0).default(1.5),
	tempStrategyTtlMs: z.number().step(1).min(6e4).default(1440 * 60 * 1e3),
	tempStrategyHitThreshold: z.number().step(1).min(1).default(3),
	tempStrategyPositiveRatio: z.number().min(0).max(1).default(.667),
	tempStrategyMatchThreshold: z.number().min(0).max(1).default(.5),
	exploreDailyBudget: z.number().step(1).min(0).max(100).default(3),
	exploreRiskWords: z.array(z.string()).default([
		"删除",
		"清空",
		"覆盖",
		"发布",
		"推送",
		"rm",
		"移除",
		"迁移",
		"重置",
		"格式化"
	]),
	exploreAutoDispatch: z.boolean().default(false),
	exploreValidationLearningRate: z.number().min(0).max(1).default(.3),
	exploreValidationErrorThreshold: z.number().min(0).max(1).default(.3),
	disequilibriumZThreshold: z.number().min(0).default(2),
	disequilibriumMinSamples: z.number().step(1).min(2).default(3),
	citationRetrievalWeight: z.number().min(0).max(1).default(.05),
	offlineConsolidationIntervalMs: z.number().step(1).min(6e4).default(3600 * 1e3),
	shrinkageAlpha: z.number().min(0).default(50),
	minConfidenceIntervalWidth: z.number().min(0).max(1).default(.2),
	successReferenceThreshold: z.number().min(0).max(1).default(.4),
	coverageThreshold: z.number().min(0).max(1).default(.3),
	retrievalFailureMargin: z.number().min(0).max(1).default(.1),
	channelLearningRate: z.number().min(0).max(1).default(.2),
	channelErrorThreshold: z.number().min(0).max(1).default(.3),
	refineMaxDrops: z.number().step(1).min(0).max(5).default(2),
	decayLambda: z.number().min(0).default(.01),
	minDecayWeight: z.number().min(0).max(1).default(.1),
	predictionErrorThreshold: z.number().min(0).max(1).default(.3),
	successUtilityThreshold: z.number().min(0).max(15).default(3),
	minValidationCount: z.number().step(1).min(1).default(3),
	simulationFastTrackThreshold: z.number().min(0).max(1).default(.8),
	simulationPermanentThreshold: z.number().min(0).default(2),
	simulationTtlMs: z.number().step(1).min(6e4).default(720 * 60 * 60 * 1e3),
	autoAccumulate: z.boolean().default(false),
	acceptanceMinEvidenceCount: z.number().step(1).min(1).default(3),
	acceptanceDeviationThreshold: z.number().min(0).max(1).default(.5),
	acceptanceCommandExecution: z.boolean().default(false),
	acceptanceCommandTimeoutMs: z.number().step(1).min(100).default(3e4),
	triggerJumpEvidenceMin: z.number().step(1).min(1).default(3),
	triggerJumpMaxPerTrigger: z.number().step(1).min(1).default(20),
	triggerJumpTotalCap: z.number().step(1).min(1).default(400),
	triggerJumpLlmFloor: z.number().step(1).min(0).default(120),
	triggerJumpWeightScale: z.number().min(0).max(1).default(.5),
	triggerJumpCitationBoost: z.number().min(0).max(1).default(.2),
	triggerJumpPruneRate: z.number().min(0).max(1).default(.1),
	triggerJumpPruneHits: z.number().step(1).min(1).default(5),
	chainMinMembers: z.number().step(1).min(1).default(3),
	chainPatternMinMembers: z.number().step(1).min(1).default(2),
	maxSampleRatio: z.number().min(.01).max(1).default(.15),
	evidenceMinCount: z.number().step(1).min(1).default(3),
	evidenceMaxDistance: z.number().min(0).max(1).default(.85),
	sandboxImprovement: z.number().min(0).max(1).default(.15),
	validationRatio: z.number().min(.01).max(.5).default(.2),
	reconstructRetries: z.number().step(1).min(0).max(5).default(2),
	clusterMergeCosine: z.number().min(0).max(1).default(.4),
	clusterMatchCosine: z.number().min(0).max(1).default(.3),
	clusterVectorSource: z.union([z.const("outcome"), z.const("embedding")]).default("outcome"),
	emergencyErrorThreshold: z.number().min(0).max(1).default(.8),
	embedding: z.object({
		baseUrl: z.string().default("https://api.deepseek.com"),
		model: z.string().default("deepseek-embedding"),
		apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
		apiKey: z.string()
	})
});
/** Validate an untrusted config object without Loader normalization.
* @param config - untrusted plugin configuration.
* @returns the resolved immutable configuration.
*/
function resolveConfig(config) {
	const route = resolveRoute({
		provider: config.provider,
		model: config.model
	});
	const root = config.root ?? dshHomePath("cognitive-pipeline");
	return Object.freeze({
		root,
		enabled: config.enabled ?? true,
		route,
		hot: Object.freeze({
			topK: config.topK ?? 10,
			oodSimThreshold: config.oodSimThreshold ?? .65,
			oodFlatThreshold: config.oodFlatThreshold ?? .1,
			oodSiThreshold: config.oodSiThreshold ?? 1.5,
			shrinkageAlpha: config.shrinkageAlpha ?? 50,
			minConfidenceIntervalWidth: config.minConfidenceIntervalWidth ?? .2,
			successReferenceThreshold: config.successReferenceThreshold ?? .4,
			coverageThreshold: config.coverageThreshold ?? .3,
			retrievalFailureMargin: config.retrievalFailureMargin ?? .1,
			channelLearningRate: config.channelLearningRate ?? .2,
			channelErrorThreshold: config.channelErrorThreshold ?? .3,
			refineMaxDrops: config.refineMaxDrops ?? 2,
			exploreDailyBudget: config.exploreDailyBudget ?? 3,
			exploreRiskWords: Object.freeze(config.exploreRiskWords ?? [
				"删除",
				"清空",
				"覆盖",
				"发布",
				"推送",
				"rm",
				"移除",
				"迁移",
				"重置",
				"格式化"
			]),
			exploreAutoDispatch: config.exploreAutoDispatch ?? false,
			exploreValidationLearningRate: config.exploreValidationLearningRate ?? .3,
			exploreValidationErrorThreshold: config.exploreValidationErrorThreshold ?? .3,
			disequilibriumZThreshold: config.disequilibriumZThreshold ?? 2,
			disequilibriumMinSamples: config.disequilibriumMinSamples ?? 3,
			citationRetrievalWeight: config.citationRetrievalWeight ?? .05,
			tempStrategyTtlMs: config.tempStrategyTtlMs ?? 1440 * 60 * 1e3,
			tempStrategyMatchThreshold: config.tempStrategyMatchThreshold ?? .5
		}),
		cold: Object.freeze({
			decayLambda: config.decayLambda ?? .01,
			minDecayWeight: config.minDecayWeight ?? .1,
			predictionErrorThreshold: config.predictionErrorThreshold ?? .3,
			successUtilityThreshold: config.successUtilityThreshold ?? 3,
			minValidationCount: config.minValidationCount ?? 3,
			maxSampleRatio: config.maxSampleRatio ?? .15,
			evidenceMinCount: config.evidenceMinCount ?? 3,
			evidenceMaxDistance: config.evidenceMaxDistance ?? .85,
			sandboxImprovement: config.sandboxImprovement ?? .15,
			validationRatio: config.validationRatio ?? .2,
			reconstructRetries: config.reconstructRetries ?? 2,
			clusterMergeCosine: config.clusterMergeCosine ?? .4,
			clusterMatchCosine: config.clusterMatchCosine ?? .3,
			clusterVectorSource: config.clusterVectorSource ?? "outcome"
		}),
		tempStrategyHitThreshold: config.tempStrategyHitThreshold ?? 3,
		tempStrategyPositiveRatio: config.tempStrategyPositiveRatio ?? .667,
		emergencyErrorThreshold: config.emergencyErrorThreshold ?? .8,
		simulationFastTrackThreshold: config.simulationFastTrackThreshold ?? .8,
		simulationPermanentThreshold: config.simulationPermanentThreshold ?? 2,
		simulationTtlMs: config.simulationTtlMs ?? 720 * 60 * 60 * 1e3,
		autoAccumulate: config.autoAccumulate ?? false,
		offlineConsolidationIntervalMs: config.offlineConsolidationIntervalMs ?? 3600 * 1e3,
		acceptanceMinEvidenceCount: config.acceptanceMinEvidenceCount ?? 3,
		acceptanceDeviationThreshold: config.acceptanceDeviationThreshold ?? .5,
		acceptanceCommandExecution: config.acceptanceCommandExecution ?? false,
		acceptanceCommandTimeoutMs: config.acceptanceCommandTimeoutMs ?? 3e4,
		triggerJumpEvidenceMin: config.triggerJumpEvidenceMin ?? 3,
		triggerJumpMaxPerTrigger: config.triggerJumpMaxPerTrigger ?? 20,
		triggerJumpTotalCap: config.triggerJumpTotalCap ?? 400,
		triggerJumpLlmFloor: config.triggerJumpLlmFloor ?? 120,
		triggerJumpWeightScale: config.triggerJumpWeightScale ?? .5,
		triggerJumpCitationBoost: config.triggerJumpCitationBoost ?? .2,
		triggerJumpPruneRate: config.triggerJumpPruneRate ?? .1,
		triggerJumpPruneHits: config.triggerJumpPruneHits ?? 5,
		chainMinMembers: config.chainMinMembers ?? 3,
		chainPatternMinMembers: config.chainPatternMinMembers ?? 2,
		embedding: config.embedding === void 0 ? null : Object.freeze({
			baseUrl: config.embedding.baseUrl ?? "https://api.deepseek.com",
			model: config.embedding.model ?? "deepseek-embedding",
			apiKeyEnv: config.embedding.apiKeyEnv ?? "DEEPSEEK_API_KEY",
			...config.embedding.apiKey === void 0 ? {} : { apiKey: config.embedding.apiKey }
		}),
		exploreDailyBudget: config.exploreDailyBudget ?? 3,
		exploreRiskWords: Object.freeze(config.exploreRiskWords ?? [
			"删除",
			"清空",
			"覆盖",
			"发布",
			"推送",
			"rm",
			"移除",
			"迁移",
			"重置",
			"格式化"
		]),
		exploreAutoDispatch: config.exploreAutoDispatch ?? false,
		exploreValidationLearningRate: config.exploreValidationLearningRate ?? .3,
		exploreValidationErrorThreshold: config.exploreValidationErrorThreshold ?? .3
	});
}
/**
* Registry of named meta-cognition loops ("造新环路"): each loop is a
* special-experience layer over the base SAR memory, exactly like the
* `policy:*` decisions the orchestrator learns. Registering a loop gives it a
* stable identity whose decisions flow through the SAME predict/report
* calibration ruler as every other prediction — the loop's situation carries
* a `loop:<name>` prefix, so its decision history forms its own retrievable
* layer and inspection can aggregate per-loop error. This is the reusable
* abstraction behind the three prior upgrades (policy:* delegation, active
* exploration, exploration validation): declare a decision stream, get the
* calibrated-意志 loop for free.
*/
var CognitiveLoopRegistry = class {
	loops = /* @__PURE__ */ new Map();
	/**
	* Register one meta-cognition loop. Re-registering the same name replaces
	* the description (identity is the name).
	* @param spec - the loop's identity, description, and optional execution sinks.
	* @returns the registry, for chaining.
	*/
	register(spec) {
		if (spec.name.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: loop name must not be empty", "EMPTY_LOOP_NAME");
		if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new CognitivePipelineError("cognitive-pipeline: loop name must match ^[a-z][a-z0-9-]*$ (lowercase, hyphen-separated)", "INVALID_LOOP_NAME");
		this.loops.set(spec.name, {
			name: spec.name,
			description: spec.description,
			...spec.execution === void 0 ? {} : { execution: spec.execution }
		});
		return this;
	}
	/** Whether a loop with this name is registered.
	* @param name - the loop name.
	* @returns true when registered.
	*/
	has(name) {
		return this.loops.has(name);
	}
	/** The registered loop spec, or undefined.
	* @param name - the loop name.
	* @returns the spec, or undefined.
	*/
	get(name) {
		return this.loops.get(name);
	}
	/** Every registered loop, in registration order.
	* @returns the loop specs.
	*/
	list() {
		return [...this.loops.values()];
	}
	/**
	* Submit one decision as an execution request to the loop's sinks (only
	* when the decision approved and the loop declared sinks). Each sink
	* applies its own discipline; a non-null return refuses that sink. Every
	* attempt — accepted or refused — yields one durable receipt whose id
	* (`<predictionId>@<target>`) links the decision to its execution outcome.
	* @param request - the decision to submit.
	* @returns one receipt per declared sink, in declaration order.
	*/
	async requestExecution(request) {
		const spec = this.loops.get(request.loopName);
		if (spec?.execution === void 0 || !request.approved) return [];
		const receipts = [];
		for (const sink of spec.execution) {
			const reason = await sink.apply(request);
			receipts.push({
				receiptId: `${request.predictionId}@${sink.target}`,
				loopName: request.loopName,
				predictionId: request.predictionId,
				target: sink.target,
				decision: request.decision,
				situation: request.situation,
				rejected: reason !== null && reason !== void 0,
				reason: reason === void 0 || reason === null ? null : reason,
				createdAt: Date.now(),
				status: null,
				settledAt: null,
				outcomeText: null,
				outcomeQuality: null
			});
		}
		return receipts;
	}
	/** Per-loop calibration statistics, aggregated from the prediction log.
	* @param predictions - the full prediction snapshot.
	* @param executions - the full loop-execution receipt snapshot.
	* @returns one stats row per registered loop, in registration order.
	*/
	stats(predictions, executions) {
		return [...this.loops.values()].map((spec) => {
			const prefix = `loop:${spec.name} `;
			const own = predictions.filter((prediction) => prediction.situation.startsWith(prefix));
			const resolved = own.filter((prediction) => prediction.resolvedAt !== null && prediction.predictionError !== null);
			const errorSum = resolved.reduce((sum, prediction) => sum + (prediction.predictionError ?? 0), 0);
			const ownExecutions = executions.filter((execution) => execution.loopName === spec.name);
			return {
				name: spec.name,
				description: spec.description,
				predictionCount: own.length,
				resolvedCount: resolved.length,
				avgPredictionError: resolved.length === 0 ? null : errorSum / resolved.length,
				executedCount: ownExecutions.filter((execution) => !execution.rejected && execution.status === "executed").length,
				refusedCount: ownExecutions.filter((execution) => execution.rejected).length,
				failedCount: ownExecutions.filter((execution) => !execution.rejected && execution.status === "failed").length
			};
		});
	}
};
/** The pipeline service. */
var CognitivePipelineService = class extends Service {
	static Config = Config;
	/** Resolved configuration. */
	resolved;
	/** The file-backed store (public for inspection). */
	store;
	/** Hot-loop engine. */
	hot;
	/** Cold-loop engine. */
	cold;
	/** Real-embedding scorer, or null when the seam is disabled. */
	embedder;
	/** Meta-cognition loop registry (the "造新环路" surface). */
	loops;
	/** Derived cognition objects (the special-experience layer registry). */
	objectKinds = /* @__PURE__ */ new Map();
	/** Per-session count of resolved predictions at the last summarizeTurn call,
	* so a turn's resolvedPredictions delta is accurate across sessions. */
	resolvedAtSummarize = /* @__PURE__ */ new Map();
	/** Epoch of the last offline consolidation, or null before the first run.
	* In-memory throttle: repeated idle ticks stay cheap; a restart simply
	* allows the next consolidation to run. */
	lastOfflineConsolidation = null;
	readinessPromise;
	constructor(ctx, config = {}) {
		super(ctx, "cognitivePipeline");
		this.resolved = resolveConfig(config);
		this.store = new CognitiveStore(this.resolved.root);
		this.embedder = this.resolved.embedding === null ? null : new EmbeddingScorer(ctx, this.resolved.embedding);
		this.hot = new HotEngine(ctx, this.store, this.resolved.hot, this.resolved.route, void 0, this.embedder);
		this.cold = new ColdEngine(ctx, this.store, this.resolved.cold, this.resolved.route);
		this.loops = new CognitiveLoopRegistry();
		this.registerCognitionObject(new ChainObjectKind());
		this.registerCognitionObject(new ChainPatternObjectKind());
		this.readinessPromise = this.store.load().catch((error) => {
			this.ctx.logger.warn(`cognitive-pipeline: store load failed, continuing in-memory: ${String(error)}`);
		});
	}
	/** Resolve after the store finished loading (never rejects). */
	async ready() {
		await this.readinessPromise;
	}
	/** Flush all pending persistence writes. */
	async flush() {
		await this.store.flush();
	}
	/** Encode one raw experience into SAR, vectorize, and store it.
	* @param input - the raw experience text.
	* @param call - optional session/signal context.
	* @returns the new experience id and its SAR triplet.
	*/
	async remember(input, call) {
		if (input.rawText.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: rawText must not be empty", "EMPTY_RAW_TEXT");
		const sar = await extractSar(this.ctx, this.resolved.route, input.rawText, {
			sessionId: call?.sessionId,
			signal: call?.signal
		});
		const expId = this.store.nextExpId();
		const embedding = await this.maybeEmbed(sar.action);
		const exp = {
			expId,
			sar,
			actionVector: actionVector(sar.action, sar.actionKeywords),
			outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
			...embedding === void 0 ? {} : { embedding },
			clusterId: null,
			strategyLabel: null,
			timestamp: Date.now(),
			predictionError: null,
			cumulativeError: 0,
			hitCount: 0,
			positiveCount: 0,
			simulated: false,
			verification: "verified",
			evidenceScore: 0,
			...input.chainId === void 0 ? {} : { chainId: input.chainId }
		};
		this.store.addExperience(exp);
		await this.store.flush();
		return {
			expId,
			sar
		};
	}
	/** Embed an action text when the seam is enabled; undefined otherwise.
	* @param action - the action text to embed.
	* @returns the vector, or undefined when disabled or the call failed.
	*/
	async maybeEmbed(action) {
		if (this.embedder === null) return void 0;
		return await this.embedder.embed(action) ?? void 0;
	}
	/**
	* Generate a simulated experience via the LLM route: a retrieval-only,
	* unverified candidate for "if I take this action in this situation, what
	* would happen". It shapes no cluster until real feedback verifies it.
	* @param input - the hypothetical situation and proposed action.
	* @param call - optional session/signal context.
	* @returns the new simulated experience id and its SAR triplet.
	*/
	async simulate(input, call) {
		if (input.situation.trim().length === 0 || input.action.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: situation and action must not be empty", "EMPTY_SIMULATE_INPUT");
		const rawText = `假设情境：${input.situation}。拟采取行动：${input.action}。推演可能的短期与长期结果。`;
		const sar = await extractSar(this.ctx, this.resolved.route, rawText, {
			sessionId: call?.sessionId,
			signal: call?.signal
		});
		const expId = this.store.nextExpId();
		const embedding = await this.maybeEmbed(sar.action);
		const exp = {
			expId,
			sar,
			actionVector: actionVector(sar.action, sar.actionKeywords),
			outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
			...embedding === void 0 ? {} : { embedding },
			clusterId: null,
			strategyLabel: null,
			timestamp: Date.now(),
			predictionError: null,
			cumulativeError: 0,
			hitCount: 0,
			positiveCount: 0,
			simulated: true,
			verification: "unverified",
			evidenceScore: 0
		};
		this.store.addExperience(exp);
		await this.store.flush();
		return {
			expId,
			sar
		};
	}
	/** How many similar history hits anchor one reference derivation. */
	referenceTopK = 5;
	/** Minimum dual-axis similarity for a history hit to anchor a reference. */
	referenceMinSimilarity = .3;
	/**
	* Derive a reference experience from the commonalities of similar history
	* (cold-start online generalization). Retrieves the top similar experiences
	* for the query, asks the LLM route to extract their shared pattern, and
	* writes the result as a retrieval-only simulated candidate that the
	* evidence-replacement lifecycle verifies against real feedback — the same
	* lifecycle as {@link simulate}.
	* @param input - the current situation/action to anchor the derivation.
	* @param call - optional session/signal context.
	* @returns the reference experience id and SAR when derived, or null.
	*/
	async deriveReference(input, call) {
		if (input.situation.trim().length === 0 || input.action.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: situation and action must not be empty", "EMPTY_DERIVE_REFERENCE_INPUT");
		const queryVector = actionVector(input.action, []);
		const similar = this.store.experiencesSnapshot().filter((exp) => !exp.simulated).map((exp) => ({
			expId: exp.expId,
			text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
			similarity: Math.max(cosine(queryVector, exp.actionVector), cosine(queryVector, actionVector(exp.sar.situation, [])))
		})).filter((hit) => hit.similarity >= this.referenceMinSimilarity).sort((a, b) => b.similarity - a.similarity).slice(0, this.referenceTopK);
		if (similar.length === 0) return null;
		const decision = await deriveReference(this.ctx, this.resolved.route, input, similar, {
			sessionId: call?.sessionId,
			signal: call?.signal
		});
		if (!decision.shouldDerive || decision.sar === null) return null;
		const sar = {
			situation: decision.sar.situation,
			action: decision.sar.action,
			outcome: decision.sar.outcome,
			actionKeywords: [...new Set(tokenize(decision.sar.action))].slice(0, 8),
			outcomeUtility: { ...decision.sar.utility }
		};
		const expId = this.store.nextExpId();
		const embedding = await this.maybeEmbed(sar.action);
		this.store.addExperience({
			expId,
			sar,
			actionVector: actionVector(sar.action, sar.actionKeywords),
			outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
			...embedding === void 0 ? {} : { embedding },
			clusterId: null,
			strategyLabel: null,
			timestamp: Date.now(),
			predictionError: null,
			cumulativeError: 0,
			hitCount: 0,
			positiveCount: 0,
			simulated: true,
			verification: "unverified",
			evidenceScore: 0
		});
		await this.store.flush();
		return {
			expId,
			sar
		};
	}
	/** Hot-loop prediction.
	* @param input - the situation/action to predict.
	* @param call - optional session/signal context.
	* @returns the calibrated prediction result.
	*/
	async predict(input, call) {
		if (input.situation.trim().length === 0 || input.action.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: situation and action must not be empty", "EMPTY_PREDICT_INPUT");
		this.store.expireUnverifiedSimulated(Date.now(), this.resolved.simulationTtlMs);
		const result = await this.hot.predict(input, call?.sessionId, call?.signal);
		this.maybeSynthesizeRetrievalFailure(input, result);
		await this.store.flush();
		return result;
	}
	/**
	* Directly record a pipeline-own (meta) observation without LLM extraction —
	* the structured path for automatic retrieval-failure SAR-ization. Meta
	* experiences with a non-neutral utility join the cold-loop sample, so the
	* pipeline can cluster and learn from its own failure modes.
	* @param input - the structured SAR fields for the observation.
	* @returns the new experience id.
	*/
	rememberMeta(input) {
		const sar = {
			situation: input.situation,
			action: input.action,
			outcome: input.outcome,
			actionKeywords: [...new Set(tokenize(input.action))].slice(0, 8),
			outcomeUtility: { ...input.utility }
		};
		const expId = this.store.nextExpId();
		this.store.addExperience({
			expId,
			sar,
			actionVector: actionVector(sar.action, sar.actionKeywords),
			outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
			clusterId: null,
			strategyLabel: null,
			timestamp: Date.now(),
			predictionError: null,
			cumulativeError: 0,
			hitCount: 0,
			positiveCount: 0,
			simulated: false,
			verification: "verified",
			evidenceScore: 0,
			meta: true
		});
		return expId;
	}
	/**
	* SAR-ize one detected retrieval-routing failure: when the taxonomy routed a
	* known-path query to a cluster with a thin margin (best-minus-second-best
	* cosine below `retrievalFailureMargin`), record a meta experience so the
	* calibration layer can reference "this action had an unreliable routing"
	* and the cold loop can cluster the failure pattern. Deduplicated by action
	* similarity so repeated queries do not spam the store.
	* @param input - the query that produced the prediction.
	* @param result - the prediction result carrying the taxonomy context.
	*/
	maybeSynthesizeRetrievalFailure(input, result) {
		const ctx = result.taxonomyContext;
		if (result.isNovel || ctx.coverage !== "covered" || ctx.cluster === null) return;
		if (ctx.margin >= this.resolved.hot.retrievalFailureMargin) return;
		const queryVector = actionVector(input.action, []);
		if (this.store.experiencesSnapshot().some((exp) => exp.meta === true && cosine(queryVector, exp.actionVector) >= META_DEDUP_COSINE)) return;
		this.rememberMeta({
			situation: `检索路由歧义：情境「${input.situation}」与簇「${ctx.cluster.name}」的余弦余量仅 ${ctx.margin.toFixed(3)}，确定性路由置信低`,
			action: input.action,
			outcome: `同样行动的路由余量低于 ${this.resolved.hot.retrievalFailureMargin}，确定性路由不可靠，应改用 LLM 路由或强化前提判别词`,
			utility: {
				materialGain: 3,
				emotionalValence: 4,
				energyCost: 5
			}
		});
	}
	/**
	* Automatic accumulation: judge one completed turn through the LLM gate and
	* write it as an experience when the route deems it worth it. A deterministic
	* pre-filter (pure chat: no tool calls, no failure, short output) never
	* reaches the per-turn LLM call. Without an explicit route the gate rejects.
	* @param episode - the reconstructed turn material.
	* @param call - optional session/signal context.
	* @returns the new experience id when accumulated, or null.
	*/
	async accumulateTurn(episode, call) {
		const actionText = episode.action.trim();
		const outcomeText = episode.outcome.trim();
		if (!(episode.toolCallCount > 0 || episode.failed || actionText.length >= ACCUMULATE_MIN_ACTION_CHARS || outcomeText.length >= ACCUMULATE_MIN_ACTION_CHARS)) return null;
		const material = episode.selfReflexive ? {
			situation: `[自反操作：本轮疑似终止/重启了自身宿主进程，杀进程后的因果链在本会话内不可观测]\n${episode.situation}`,
			action: `[推测性行动：杀进程后的实际动作由外部执行，非本会话记录；如无外部见证（状态文件/日志）请勿断言]\n${episode.action}`,
			outcome: episode.outcome
		} : {
			situation: episode.situation,
			action: episode.action,
			outcome: episode.outcome
		};
		const queryVector = actionVector(material.action, []);
		const similar = this.store.experiencesSnapshot().map((exp) => ({
			expId: exp.expId,
			text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
			similarity: Math.max(cosine(queryVector, exp.actionVector), cosine(queryVector, actionVector(exp.sar.situation, []))),
			polarity: outcomePolarity(exp.sar.outcomeUtility)
		})).sort((a, b) => b.similarity - a.similarity).slice(0, 3).filter((hit) => hit.similarity >= .3);
		const top = similar[0];
		if (top !== void 0 && !episode.failed && top.polarity === "positive") return null;
		const decision = await evaluateAccumulation(this.ctx, this.resolved.route, material, similar, {
			sessionId: call?.sessionId,
			signal: call?.signal
		});
		if (!decision.shouldAccumulate || decision.sar === null) return null;
		if (isTaskRestatement({ sar: decision.sar })) return null;
		const expId = this.store.nextExpId();
		const sar = {
			situation: decision.sar.situation,
			action: decision.sar.action,
			outcome: decision.sar.outcome,
			actionKeywords: [...new Set(tokenize(decision.sar.action))].slice(0, 8),
			outcomeUtility: { ...decision.sar.utility }
		};
		const embedding = await this.maybeEmbed(sar.action);
		this.store.addExperience({
			expId,
			sar,
			actionVector: actionVector(sar.action, sar.actionKeywords),
			outcomeVector: outcomeVector(sar.outcomeUtility, sar.outcome),
			...embedding === void 0 ? {} : { embedding },
			clusterId: null,
			strategyLabel: null,
			timestamp: Date.now(),
			predictionError: null,
			cumulativeError: 0,
			hitCount: 0,
			positiveCount: 0,
			simulated: false,
			verification: "verified",
			evidenceScore: 0,
			...episode.selfReflexive ? { selfReflexive: true } : {}
		});
		return expId;
	}
	/**
	* Aggregate one completed turn's cognition activity into a summary for the
	* GUI bubble: settle the turn's injection citations, accumulate the episode
	* when autoAccumulate is on, and count predictions resolved since the last
	* summarize call for this session. Returns null when the turn produced no
	* activity, so a quiet turn shows no bubble.
	* @param sessionId - the session owning the turn.
	* @param episode - the reconstructed turn material.
	* @returns the summary, or null when nothing happened.
	*/
	async summarizeTurn(sessionId, episode) {
		const citation = await this.settleInjectionCitations(sessionId, episode.outcome);
		let newExperiences = [];
		if (this.resolved.autoAccumulate) {
			const expId = await this.accumulateTurn(episode);
			if (expId !== null) {
				const exp = this.store.getExperience(expId);
				if (exp !== void 0) newExperiences = [{
					expId,
					topic: exp.sar.situation.slice(0, 48)
				}];
			}
		}
		const totalResolved = this.store.predictionsSnapshot().filter((prediction) => prediction.resolvedAt !== null).length;
		const before = this.resolvedAtSummarize.get(sessionId) ?? totalResolved;
		const resolvedPredictions = Math.max(0, totalResolved - before);
		this.resolvedAtSummarize.set(sessionId, totalResolved);
		const summary = {
			turn: episode.turnId,
			newExperiences,
			citationSettlement: citation,
			resolvedPredictions
		};
		return newExperiences.length > 0 || citation.settled > 0 || resolvedPredictions > 0 ? summary : null;
	}
	/** Feedback loop: resolve a prediction, update calibration and scratchpad.
	* @param input - the prediction id and actual outcome.
	* @param call - optional session/signal context.
	* @returns the logged feedback result.
	*/
	async report(input, call) {
		const prediction = this.store.getPrediction(input.predictionId);
		if (prediction === void 0) throw new CognitivePipelineError(`cognitive-pipeline: prediction "${input.predictionId}" not found`, "PREDICTION_NOT_FOUND");
		if (prediction.resolvedAt !== null) throw new CognitivePipelineError(`cognitive-pipeline: prediction "${input.predictionId}" is already resolved`, "PREDICTION_ALREADY_RESOLVED");
		const observed = this.observedOutcome(input);
		const error = Math.abs(prediction.calibratedProbability - observed);
		this.hot.learnFromFeedback(prediction, error);
		this.store.resolvePrediction(input.predictionId, input.actualOutcome, error, input.outcomeQuality, {
			zThreshold: this.resolved.hot.disequilibriumZThreshold,
			minSamples: this.resolved.hot.disequilibriumMinSamples
		});
		this.store.recordCalibration(prediction.calibratedProbability, observed >= .5);
		if (prediction.expId !== null) {
			const bound = this.store.getExperience(prediction.expId);
			if (bound !== void 0 && bound.simulated) {
				const decisiveness = Math.abs(input.outcomeQuality - 5) / 5;
				const contradictory = bound.verification === "provisional" && observed >= .5 !== bound.sar.outcomeUtility.materialGain > 5;
				this.store.applyFeedbackEvidence(prediction.expId, decisiveness, contradictory, this.resolved.simulationFastTrackThreshold, this.resolved.simulationPermanentThreshold);
			}
		}
		let rebuildReason = null;
		if (prediction.usedTempStrategy) this.feedbackTempStrategy(prediction.action, observed);
		if (prediction.exploredActionHash !== null) this.store.validateExploration(prediction.exploredActionHash, error, this.resolved.exploreValidationLearningRate, this.resolved.exploreValidationErrorThreshold);
		const audited = [...this.store.claimAuditsSnapshot()].reverse().find((audit) => audit.predictionId === prediction.predictionId && audit.violatedCheckIds.length > 0);
		if (audited !== void 0) for (const checkId of audited.violatedCheckIds) this.store.foldAcceptanceError(checkId, error);
		await this.foldVariantFeedback(prediction.action, input.outcomeQuality);
		let triggerRebuild = false;
		if (error >= this.resolved.emergencyErrorThreshold) {
			triggerRebuild = true;
			rebuildReason = `预测误差 ${error.toFixed(3)} 超过紧急阈值 ${this.resolved.emergencyErrorThreshold}，触发局部修补`;
			await this.cold.runRebuild("local", call?.sessionId, call?.signal);
		}
		await this.store.flush();
		return {
			status: "logged",
			predictionError: error,
			triggerRebuild,
			rebuildReason
		};
	}
	/** Cold-loop rebuild.
	* @param scope - local or global.
	* @param call - optional session/signal context.
	* @returns the backtested rebuild outcome.
	*/
	async rebuild(scope, call) {
		const result = await this.cold.runRebuild(scope, call?.sessionId, call?.signal);
		if (scope === "global" && result.accepted) await this.extractDiscriminantAxes(call);
		await this.store.flush();
		return result;
	}
	/** Observational snapshot for the inspect tool.
	* @returns counts, clusters, calibration, taxonomy, and recent resolved predictions.
	*/
	inspect() {
		const stats = this.store.stats();
		const recentResolved = this.store.predictionsSnapshot().filter((prediction) => prediction.resolvedAt !== null).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 10);
		const loopExecutions = [...this.store.loopExecutionsSnapshot()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
		const variants = this.store.variantsSnapshot();
		return {
			experienceCount: stats.experienceCount,
			predictionCount: stats.predictionCount,
			resolvedPredictionCount: stats.resolvedPredictionCount,
			settlement: stats.settlement,
			citation: stats.citation,
			variants: {
				proposed: variants.filter((variant) => variant.status === "proposed").length,
				testing: variants.filter((variant) => variant.status === "testing").length,
				adopted: variants.filter((variant) => variant.status === "adopted").length,
				rejected: variants.filter((variant) => variant.status === "rejected").length
			},
			clusterCount: this.store.clustersSnapshot().length,
			activeTempStrategyCount: this.store.tempStrategiesSnapshot().filter((strategy) => strategy.status === "active").length,
			calibrationBuckets: this.store.calibrationBucketsSnapshot(),
			channelWeights: this.store.channelWeightsSnapshot(),
			exploration: this.explorationStats(),
			loops: this.loops.stats(this.store.predictionsSnapshot(), this.store.loopExecutionsSnapshot()),
			loopExecutions,
			acceptance: this.acceptanceStats(),
			recentAudits: this.claimAudits(10),
			taxonomy: this.store.taxonomySnapshot() ?? {
				version: 0,
				summaryShort: "（尚未完成首次重构）",
				rules: [],
				updatedAt: 0
			},
			recentResolved
		};
	}
	/** Queue an autonomous exploration task for a background session to execute
	* silently (scheme 2 cross-session dispatch). The goal text becomes the
	* executing session's task; the result is written back as an experience.
	* @param goal - the exploration goal.
	* @returns the queued task.
	*/
	async explore(goal) {
		if (goal.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: exploration goal must not be empty", "EMPTY_EXPLORE_GOAL");
		const task = this.store.addExplorationTask(goal.trim());
		await this.store.flush();
		return task;
	}
	/** Snapshot of the queued exploration tasks (public for inspection).
	* @returns the task list, insertion order.
	*/
	explorationTasks() {
		return this.store.explorationTasksSnapshot();
	}
	/** Register a meta-cognition loop (declarative "造新环路").
	* @param spec - the loop's identity and description.
	* @returns the service, for chaining.
	*/
	registerLoop(spec) {
		this.loops.register(spec);
		return this;
	}
	/** Registered meta-cognition loops, in registration order.
	* @returns the loop specs.
	*/
	loopList() {
		return this.loops.list();
	}
	/**
	* Build a ready-made execution sink that drives the ACTIVE-EXPLORATION
	* execution layer under its own discipline (reversibility safety gate +
	* daily budget). A loop that attaches this sink truly closes the loop: an
	* approved decision creates a scratchpad and (when configured) queues an
	* autonomous exploration task — 意志批准，执行层按纪律受理.
	* @returns a sink targetable as `hot-engine.explore-create`.
	*/
	createExplorationSink() {
		return {
			target: "hot-engine.explore-create",
			apply: (request) => {
				const action = request.decision;
				if (!!this.resolved.exploreRiskWords.some((word) => action.includes(word))) return "动作不可逆，探索执行被拒（安全闸）";
				const state = this.store.explorationSnapshot();
				const hash = String(signatureHash(action));
				if (state.entries.some((entry) => entry.scratchpadHash === hash)) return null;
				if (state.used >= this.resolved.exploreDailyBudget) return "探索预算已耗尽，探索执行被拒（预算纪律）";
				this.store.recordExploration({
					ts: Date.now(),
					action,
					scratchpadHash: hash,
					reversible: true,
					outcome: null,
					validatedError: null,
					validated: null
				});
				this.store.addTempStrategy({
					signatureHash: hash,
					trialAction: action,
					pendingResult: null,
					hitCount: 1,
					positiveCount: 0,
					createdAt: Date.now(),
					expiresAt: Date.now() + this.resolved.hot.tempStrategyTtlMs,
					status: "active",
					sourceExpId: null
				});
				if (this.resolved.exploreAutoDispatch) this.store.addExplorationTask(`探索行动：${action}\n情境：${request.situation}`);
				return null;
			}
		};
	}
	/**
	* Run one meta-cognition loop decision through the SAME calibration ruler as
	* every prediction. The loop's identity prefixes the situation
	* (`loop:<name> 决策=…`), so the decision's history forms that loop's own
	* special-experience layer — retrievable, aggregable, and calibrated.
	* @param name - the registered loop name.
	* @param decision - what the loop is deciding (becomes the action text).
	* @param situation - the context the decision is made in.
	* @param call - optional session/signal context.
	* @returns the predict result; rejects with INVALID_LOOP_NAME when unregistered.
	*/
	async decideLoop(name, decision, situation, call) {
		if (!this.loops.has(name)) throw new CognitivePipelineError(`cognitive-pipeline: loop "${name}" is not registered (register it first)`, "INVALID_LOOP_NAME");
		return this.predict({
			situation: `loop:${name} 情境=${situation}`,
			action: decision
		}, call);
	}
	/**
	* Feed the actual outcome of a loop decision back for calibration. Same
	* report path as ordinary predictions.
	* @param name - the registered loop name (used for validation only).
	* @param predictionId - the decision's prediction id.
	* @param actualOutcome - the observed outcome text.
	* @param outcomeQuality - the outcome quality 0–10.
	* @param call - optional session/signal context.
	* @returns the feedback result.
	*/
	async feedbackLoop(name, predictionId, actualOutcome, outcomeQuality, call) {
		if (!this.loops.has(name)) throw new CognitivePipelineError(`cognitive-pipeline: loop "${name}" is not registered (register it first)`, "INVALID_LOOP_NAME");
		return this.report({
			predictionId,
			actualOutcome,
			outcomeQuality
		}, call);
	}
	/**
	* Decide through a loop and — when the decision approves and the loop
	* declared execution sinks — submit the decision as an execution request
	* to each sink and persist one durable receipt per sink. This is the
	* closing of the loop: 意志决策，执行层按纪律受理，回执可结算回流.
	* @param name - the registered loop name.
	* @param decision - what the loop is deciding (becomes the action text).
	* @param situation - the context the decision is made in.
	* @param threshold - approval threshold on calibrated probability (default 0.55).
	* @param call - optional session/signal context.
	* @returns the decision result plus one persisted execution receipt per
	*   declared sink (id `<predictionId>@<target>`), which `settleExecution`
	*   later resolves with the actual execution outcome.
	*/
	async decideAndExecute(name, decision, situation, threshold = .55, call) {
		const decisionResult = await this.decideLoop(name, decision, situation, call);
		const approved = decisionResult.calibratedProbability >= threshold;
		const executions = await this.loops.requestExecution({
			loopName: name,
			decision,
			situation: `loop:${name} 情境=${situation}`,
			approved,
			probability: decisionResult.calibratedProbability,
			confidenceLow: decisionResult.confidenceLow,
			confidenceHigh: decisionResult.confidenceHigh,
			predictionId: decisionResult.predictionId
		});
		for (const receipt of executions) this.store.addLoopExecution(receipt);
		await this.store.flush();
		return {
			decision: decisionResult,
			approved,
			executions
		};
	}
	/**
	* Settle one loop-execution receipt with its actual execution outcome. The
	* receipt must exist and must have been accepted (refused receipts are
	* terminal by construction — the sink declined, nothing executed). The
	* outcome feeds back through the SAME report path as every prediction: it
	* resolves the decision's prediction on the |calibrated − observed| ruler,
	* so what the execution actually did calibrates the loop that requested it —
	* 执行结果回流，意志与执行共用同一把尺子.
	* @param receiptId - the receipt id (`<predictionId>@<target>`).
	* @param outcomeText - what the execution actually produced.
	* @param outcomeQuality - the outcome quality 0–10.
	* @param status - the terminal outcome ('executed' or 'failed'; default executed).
	* @param call - optional session/signal context.
	* @returns the settled receipt and the feedback result.
	*/
	async settleExecution(receiptId, outcomeText, outcomeQuality, status = "executed", call) {
		const receipt = this.store.getLoopExecution(receiptId);
		if (receipt === void 0) throw new CognitivePipelineError(`cognitive-pipeline: execution receipt "${receiptId}" not found`, "EXECUTION_RECEIPT_NOT_FOUND");
		if (receipt.rejected) throw new CognitivePipelineError(`cognitive-pipeline: receipt "${receiptId}" was refused by the sink and cannot be settled`, "EXECUTION_RECEIPT_REFUSED");
		if (receipt.settledAt !== null) throw new CognitivePipelineError(`cognitive-pipeline: execution receipt "${receiptId}" is already settled`, "EXECUTION_RECEIPT_ALREADY_SETTLED");
		const settled = this.store.settleLoopExecution(receiptId, status, outcomeText, outcomeQuality);
		if (settled === void 0) throw new CognitivePipelineError(`cognitive-pipeline: execution receipt "${receiptId}" disappeared during settlement`, "EXECUTION_RECEIPT_NOT_FOUND");
		const feedback = await this.report({
			predictionId: receipt.predictionId,
			actualOutcome: outcomeText,
			outcomeQuality
		}, call);
		await this.store.flush();
		return {
			receipt: settled,
			feedback
		};
	}
	/** The dynamic cognition prefix for the system-prompt section.
	* @returns the 附录B prefix text.
	*/
	taxonomyPrefix() {
		return cognitionPrefix(this.store.taxonomySnapshot());
	}
	/**
	* Define one acceptance criterion: a reusable verification norm the agent
	* audits claims against before treating them as settled. The pipeline
	* records evidence PRESENCE, never evidence truth — it cannot verify its own
	* claims; truth is adjudicated by the resolved outcome and the user.
	* @param input - the criterion statement, its trigger marker, and the
	*   evidence hint that satisfies it.
	* @returns the new criterion, active with an empty evidence ledger.
	*/
	async defineAcceptanceCheck(input) {
		const criterion = input.criterion.trim();
		const trigger = input.trigger.trim();
		const evidenceHint = input.evidenceHint.trim();
		if (criterion.length === 0 || trigger.length === 0 || evidenceHint.length === 0) throw new CognitivePipelineError("cognitive-pipeline: criterion, trigger, and evidenceHint must not be empty", "EMPTY_ACCEPTANCE_INPUT");
		const now = Date.now();
		const check = {
			checkId: this.store.nextAcceptanceCheckId(),
			criterion,
			trigger,
			evidenceHint,
			status: "active",
			invokedCount: 0,
			passedCount: 0,
			violatedCount: 0,
			machineVerifiedCount: 0,
			cumulativeError: 0,
			errorFoldCount: 0,
			revision: 1,
			createdAt: now,
			updatedAt: now
		};
		this.store.addAcceptanceCheck(check);
		await this.store.flush();
		return check;
	}
	/**
	* Audit one claim against the active acceptance criteria. Applicable checks
	* are those whose trigger marker appears in the claim or its situation; a
	* claim with no applicable check audits as `not-applicable` and touches no
	* ledger. An applicable check is satisfied when the claim carries evidence
	* (non-empty), violated when it does not — presence, not truth. When the
	* claim carries an external-witness `anchor` (a session-ledger tool call or
	* a workspace file state, mechanically verified by the tool layer), the
	* witness decides instead: a matched anchor satisfies, a missing or
	* mismatched anchor violates regardless of self-reported evidence — the
	* witness is non-self-referential, so an anchored claim cannot be validated
	* by self-report alone. Violated checks accumulate in the criterion's
	* ledger, and a criterion whose invoked count clears the evidence minimum
	* while its deviation rate crosses the threshold flags `reworkNeeded` and
	* records one deviation meta experience so the cold loop can cluster the
	* pipeline's own acceptance-failure patterns.
	* @param input - the claim, its situation, the verification statement (empty
	*   when the claim is made without evidence), an optional prediction the
	*   claim is about, and an optional mechanically-verified external-witness
	*   anchor (computed by the tool layer from the executing session's ledger
	*   or the workspace disk).
	* @returns the recorded audit.
	*/
	async auditClaim(input) {
		const claim = input.claim.trim();
		const situation = input.situation.trim();
		if (claim.length === 0) throw new CognitivePipelineError("cognitive-pipeline: claim must not be empty", "EMPTY_CLAIM");
		const evidence = (input.evidence ?? "").trim();
		const anchor = input.anchor ?? null;
		const anchorVerified = anchor !== null && anchor.matched;
		const haystack = `${situation} ${claim}`;
		const applied = this.store.acceptanceSnapshot().filter((check) => check.status === "active").filter((check) => check.trigger.length > 0 && haystack.includes(check.trigger));
		const now = Date.now();
		const auditId = this.store.nextAuditId();
		const predictionId = input.predictionId ?? null;
		if (applied.length === 0) {
			const audit = {
				auditId,
				claim,
				situation,
				verdict: "not-applicable",
				appliedCheckIds: [],
				satisfiedCheckIds: [],
				violatedCheckIds: [],
				evidence,
				anchor,
				anchorVerified: false,
				predictionId,
				reworkNeeded: false,
				deviationExpId: null,
				createdAt: now
			};
			this.store.recordClaimAudit(audit);
			await this.store.flush();
			return audit;
		}
		const satisfiedCheckIds = [];
		const violatedCheckIds = [];
		const passed = anchor === null ? evidence.length > 0 : anchor.matched;
		const firstCrossingChecks = [];
		for (const check of applied) {
			const updated = this.store.applyAuditStats(check.checkId, passed, anchorVerified);
			if (passed) satisfiedCheckIds.push(check.checkId);
			else violatedCheckIds.push(check.checkId);
			const crossedBefore = check.invokedCount >= this.resolved.acceptanceMinEvidenceCount && check.invokedCount > 0 && check.violatedCount / check.invokedCount >= this.resolved.acceptanceDeviationThreshold;
			if (updated.invokedCount >= this.resolved.acceptanceMinEvidenceCount && updated.violatedCount / updated.invokedCount >= this.resolved.acceptanceDeviationThreshold && !crossedBefore) firstCrossingChecks.push(updated);
		}
		let reworkNeeded = false;
		let deviationExpId = null;
		if (firstCrossingChecks.length > 0) {
			reworkNeeded = true;
			const names = firstCrossingChecks.map((check) => `「${check.criterion}」`).join("、");
			const worst = firstCrossingChecks.reduce((a, b) => a.violatedCount / a.invokedCount >= b.violatedCount / b.invokedCount ? a : b);
			deviationExpId = this.rememberMeta({
				situation: `验收准则持续被违反：${names} 在累计审计中违规率 ≥ ${(this.resolved.acceptanceDeviationThreshold * 100).toFixed(0)}%（证据不足 ${this.resolved.acceptanceMinEvidenceCount} 次），触发重写或退役`,
				action: `重写准则 ${names} 或将其退役（统计账本不可清零，仅可冻结）`,
				outcome: `未验证声明与预测误差同尺累计：${names} 累计误差 ${worst.cumulativeError.toFixed(3)}（${worst.errorFoldCount} 次回流）`,
				utility: {
					materialGain: 2,
					emotionalValence: 4,
					energyCost: 6
				}
			});
		}
		const audit = {
			auditId,
			claim,
			situation,
			verdict: violatedCheckIds.length > 0 ? "violated" : "verified",
			appliedCheckIds: applied.map((check) => check.checkId),
			satisfiedCheckIds,
			violatedCheckIds,
			evidence,
			anchor,
			anchorVerified,
			predictionId,
			reworkNeeded,
			deviationExpId,
			createdAt: now
		};
		this.store.recordClaimAudit(audit);
		await this.store.flush();
		return audit;
	}
	/**
	* Rewrite an active criterion's statement/evidence hint, or retire it. A
	* retired criterion is frozen: its evidence ledger is never reset and audits
	* no longer apply it. The criterion's invoked/passed/violated/error counts
	* cannot be edited by any path — criteria are revisable, their track record
	* is not (the evidence gate of acceptance-criterion change).
	* @param input - the criterion id, optional new statement/evidence hint, and
	*   optional retire flag.
	* @returns the updated criterion.
	*/
	async updateAcceptanceCheck(input) {
		const current = this.store.getAcceptanceCheck(input.checkId);
		if (current === void 0) throw new CognitivePipelineError(`cognitive-pipeline: acceptance check "${input.checkId}" not found`, "ACCEPTANCE_CHECK_NOT_FOUND");
		if (current.status === "retired") throw new CognitivePipelineError(`cognitive-pipeline: acceptance check "${input.checkId}" is retired and frozen`, "ACCEPTANCE_CHECK_RETIRED");
		if (input.retire === true) {
			const retired = this.store.updateAcceptanceCheck(input.checkId, {
				status: "retired",
				updatedAt: Date.now(),
				revision: current.revision + 1
			});
			await this.store.flush();
			return retired;
		}
		const criterion = input.criterion?.trim();
		const evidenceHint = input.evidenceHint?.trim();
		const trigger = input.trigger?.trim();
		if (criterion === void 0 && evidenceHint === void 0 && trigger === void 0) throw new CognitivePipelineError("cognitive-pipeline: update needs criterion, evidenceHint, trigger, or retire", "EMPTY_ACCEPTANCE_UPDATE");
		if (criterion !== void 0 && criterion.length === 0) throw new CognitivePipelineError("cognitive-pipeline: criterion must not be empty", "EMPTY_ACCEPTANCE_UPDATE");
		if (evidenceHint !== void 0 && evidenceHint.length === 0) throw new CognitivePipelineError("cognitive-pipeline: evidenceHint must not be empty", "EMPTY_ACCEPTANCE_UPDATE");
		if (trigger !== void 0 && trigger.length === 0) throw new CognitivePipelineError("cognitive-pipeline: trigger must not be empty", "EMPTY_ACCEPTANCE_UPDATE");
		const updated = this.store.updateAcceptanceCheck(input.checkId, {
			...criterion === void 0 ? {} : { criterion },
			...evidenceHint === void 0 ? {} : { evidenceHint },
			...trigger === void 0 ? {} : { trigger },
			updatedAt: Date.now(),
			revision: current.revision + 1
		});
		await this.store.flush();
		return updated;
	}
	/**
	* Run the acceptance-criterion proposal route: gather the demonstrably
	* failing active criteria (deviation gate crossed) and their evidence
	* ledgers, ask the LLM route to propose rewrites or retirements, and apply
	* only the proposals that pass the experience gate — a proposal must target
	* a failing criterion, carry a rationale, and carry concrete rewrite text.
	* This is how the pipeline amends its own verification norms from
	* experience: the route proposes, the evidence gate disposes. Without a
	* failing criterion or an explicit route, nothing is proposed or applied.
	* @param call - optional session/signal context.
	* @returns the flagged criteria, the route's (ungated) proposals, and the
	*   criteria the gate actually applied.
	*/
	async proposeAcceptanceUpdate(call) {
		const flagged = this.store.acceptanceSnapshot().filter((check) => check.status === "active").filter((check) => check.invokedCount >= this.resolved.acceptanceMinEvidenceCount && check.violatedCount / check.invokedCount >= this.resolved.acceptanceDeviationThreshold);
		if (flagged.length === 0) return {
			flagged: [],
			proposals: [],
			applied: []
		};
		const deviationMeta = this.store.experiencesSnapshot().filter((exp) => exp.meta === true && exp.sar.situation.includes("验收准则持续被违反")).map((exp) => ({
			expId: exp.expId,
			text: exp.sar.situation
		}));
		const decision = await proposeAcceptanceUpdates(this.ctx, this.resolved.route, flagged, deviationMeta, {
			sessionId: call?.sessionId,
			signal: call?.signal
		});
		const flaggedIds = new Set(flagged.map((check) => check.checkId));
		const applied = [];
		for (const proposal of decision.proposals) {
			if (!flaggedIds.has(proposal.checkId)) continue;
			if (proposal.rationale.trim().length === 0) continue;
			if (proposal.action === "rewrite" && (proposal.criterion?.trim().length ?? 0) === 0) continue;
			const updated = proposal.action === "retire" ? await this.updateAcceptanceCheck({
				checkId: proposal.checkId,
				retire: true
			}) : await this.updateAcceptanceCheck({
				checkId: proposal.checkId,
				...proposal.criterion === void 0 ? {} : { criterion: proposal.criterion },
				...proposal.evidenceHint === void 0 ? {} : { evidenceHint: proposal.evidenceHint },
				...proposal.trigger === void 0 ? {} : { trigger: proposal.trigger }
			});
			applied.push(updated);
		}
		return {
			flagged,
			proposals: decision.proposals,
			applied
		};
	}
	/** All acceptance criteria (public for inspection).
	* @returns a detached criterion list, insertion order.
	*/
	acceptanceChecks() {
		return this.store.acceptanceSnapshot();
	}
	/**
	* Run one command through the shell capability seam and settle on its exit
	* code — the exit-code witness for command anchors. The pipeline never
	* spawns processes itself: the composed shell executor owns execution,
	* sandbox policy, and output handling, and the pipeline observes only the
	* exit code (output is discarded). Fail-closed: a timeout or a signal death
	* resolves to null (cannot verify is a violation, never a pass). When no
	* shell executor is mounted the call fails loud rather than silently
	* degrading — a composed deployment without `ctx.shell` cannot run command
	* anchors at all.
	* @param command - the command line to run via the shell executor.
	* @param timeoutMs - hard timeout; on expiry the executor kills the command
	*   and this resolves to null.
	* @returns the exit code, or null when the command could not settle.
	*/
	async runCommandExitCode(command, timeoutMs) {
		const shell = this.ctx.get("shell");
		if (shell === void 0) throw new CognitivePipelineError("cognitive-pipeline: command anchors require the shell capability (ctx.shell) to be mounted in the composition", "SHELL_CAPABILITY_UNAVAILABLE");
		const spec = shell.resolve({
			command,
			timeoutMs
		});
		const result = await shell.run(spec);
		return result.timedOut || result.signal !== null ? null : result.exitCode;
	}
	/**
	* Learn the trigger-jump lexicon from the experience store: the associative
	* layer over the static and derived trigger words. Co-occurrence jumps are
	* built deterministically (a token co-occurring with a trigger across enough
	* distinct important experiences becomes a jump toward that trigger, gated
	* by `triggerJumpEvidenceMin`, capped per trigger and in total, normalized
	* to [0.3, 1]); when an explicit LLM route exists, template 9 additionally
	* proposes synonym-variant jumps (words that never co-occur, like 卡住↔卡壳)
	* which enter with zero evidence and a conservative weight — the citation
	* loop is their evidence gate. The rebuild carries each surviving jump's
	* measured utility (hit/cited counts) and applies reinforcement: a jump
	* whose citation rate clears `triggerJumpPruneHits` hits is boosted toward 1
	* by its rate, and one at/below `triggerJumpPruneRate` is pruned.
	* @param call - optional session/signal context for the LLM enhancement.
	* @returns the build summary.
	*/
	async learnTriggerJumps(call) {
		const now = Date.now();
		const accumulator = emptyJumpAccumulator();
		const derived = deriveTriggerWords(this);
		accumulateTriggerJumps(this, accumulator, derived);
		const existing = new Map(this.store.triggerJumpsSnapshot().map((jump) => [jump.jumpWord, jump]));
		const jumps = /* @__PURE__ */ new Map();
		for (const [jumpWord, byTrigger] of accumulator) {
			const candidates = [...byTrigger.entries()].filter(([, acc]) => acc.evidenceCount >= this.resolved.triggerJumpEvidenceMin).map(([trigger, acc]) => ({
				trigger,
				acc
			}));
			if (candidates.length === 0) continue;
			const maxImportance = Math.max(...candidates.map((candidate) => candidate.acc.importance));
			const kept = [...candidates].sort((a, b) => b.acc.importance - a.acc.importance).slice(0, this.resolved.triggerJumpMaxPerTrigger);
			const prior = existing.get(jumpWord);
			jumps.set(jumpWord, {
				jumpWord,
				triggers: kept.map(({ trigger, acc }) => {
					const reverse = accumulator.get(trigger)?.get(jumpWord);
					const coupling = reverse !== void 0 && reverse.evidenceCount >= this.resolved.triggerJumpEvidenceMin ? Math.min(1, reverse.evidenceCount / Math.max(1, acc.evidenceCount)) : .5;
					return {
						trigger,
						weight: round3(clamp01(.3 + .7 * (acc.importance / maxImportance)) * (.5 + .5 * coupling)),
						evidenceCount: acc.evidenceCount
					};
				}),
				evidenceCount: Math.max(...kept.map((candidate) => candidate.acc.evidenceCount)),
				source: "cooccurrence",
				rationale: "",
				hitCount: prior?.hitCount ?? 0,
				citedCount: prior?.citedCount ?? 0,
				createdAt: prior?.createdAt ?? now,
				updatedAt: now
			});
		}
		let llmAdded = 0;
		if (hasExplicitRoute(this.resolved.route)) {
			const samples = this.store.experiencesSnapshot().filter((exp) => importanceOf(exp) > 0).slice(0, 10).map((exp) => ({
				expId: exp.expId,
				text: `${exp.sar.situation}。${exp.sar.action}`
			}));
			const staticTriggers = [...STATIC_TRIGGERS].slice(0, 15);
			const derivedTriggers = [...derived.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, weight]) => ({
				word,
				weight
			}));
			const focusWords = new Set([...staticTriggers, ...derivedTriggers.map((entry) => entry.word)]);
			const situationsByWord = /* @__PURE__ */ new Map();
			for (const exp of this.store.experiencesSnapshot()) {
				const text = `${exp.sar.situation} ${exp.sar.action}`;
				for (const word of focusWords) {
					if (!text.includes(word)) continue;
					const bucket = situationsByWord.get(word) ?? [];
					if (bucket.length < 2) bucket.push(exp.sar.situation.slice(0, 60));
					situationsByWord.set(word, bucket);
				}
			}
			const decision = await proposeTriggerJumps(this.ctx, this.resolved.route, {
				staticTriggers,
				derived: derivedTriggers,
				samples: samples.slice(0, 3),
				situationsByWord
			}, {
				sessionId: call?.sessionId,
				signal: call?.signal
			});
			for (const proposal of decision.jumps) {
				if (!STATIC_TRIGGERS.has(proposal.trigger) && !derived.has(proposal.trigger)) continue;
				for (const variant of proposal.variants) {
					if (variant === proposal.trigger || STOP_WORDS.has(variant) || jumps.has(variant)) continue;
					if ([...variant].length < 2 && /[\u4e00-\u9fff]/.test(variant)) continue;
					jumps.set(variant, {
						jumpWord: variant,
						triggers: [{
							trigger: proposal.trigger,
							weight: .9,
							evidenceCount: 0
						}],
						evidenceCount: 0,
						source: "llm",
						rationale: proposal.reason,
						hitCount: 0,
						citedCount: 0,
						createdAt: now,
						updatedAt: now
					});
					llmAdded += 1;
				}
			}
		}
		for (const [word, prior] of existing) {
			if (prior.source !== "llm") continue;
			if (jumps.has(word)) continue;
			jumps.set(word, prior);
		}
		let list = [...jumps.values()];
		const cap = this.resolved.triggerJumpTotalCap;
		const llmFloor = this.resolved.triggerJumpLlmFloor;
		if (list.length > cap) {
			const llmJumps = list.filter((jump) => jump.source === "llm").sort((a, b) => maxJumpWeight(b) - maxJumpWeight(a)).slice(0, llmFloor);
			list = [...list.filter((jump) => jump.source !== "llm").sort((a, b) => maxJumpWeight(b) - maxJumpWeight(a)).slice(0, Math.max(0, cap - llmJumps.length)), ...llmJumps];
		}
		let pruned = 0;
		const reinforced = [];
		for (const jump of list) if (jump.hitCount >= this.resolved.triggerJumpPruneHits) {
			const rate = jump.citedCount / jump.hitCount;
			if (rate <= this.resolved.triggerJumpPruneRate) {
				pruned += 1;
				continue;
			}
			const boost = rate * this.resolved.triggerJumpCitationBoost;
			reinforced.push({
				...jump,
				triggers: jump.triggers.map((entry) => ({
					...entry,
					weight: clamp01(entry.weight + boost)
				})),
				updatedAt: now
			});
		} else reinforced.push(jump);
		this.store.replaceTriggerJumps(reinforced);
		return {
			jumpCount: reinforced.length,
			cooccurrenceCount: reinforced.filter((jump) => jump.source === "cooccurrence").length,
			llmAdded,
			pruned
		};
	}
	/** The trigger-jump lexicon (public for the inject plugin's gate).
	* @returns a detached jump list, insertion order.
	*/
	triggerJumps() {
		return this.store.triggerJumpsSnapshot();
	}
	/** The discriminant-axis table (public for the inject plugin's C-form
	* routing): embedding clusters, LLM names the discriminating poles.
	* @returns a detached axis list, insertion order.
	*/
	discriminantAxes() {
		return this.store.discriminantAxesSnapshot();
	}
	/**
	* Record one injection event for citation-rate measurement. The inject
	* plugin calls this after folding the reference block into the step; the
	* jump words that contributed to the trigger are carried so their measured
	* utility can be folded when the citation settles.
	* @param input - the injected expIds, the fired trigger source, the
	*   contributing jump words, and the session id when known.
	* @returns the recorded injection.
	*/
	recordInjection(input) {
		const record = {
			injectionId: this.store.nextInjectionId(),
			createdAt: Date.now(),
			expIds: [...input.expIds],
			triggerSource: input.triggerSource,
			jumpWords: [...input.jumpWords ?? []],
			chainId: input.chainId ?? null,
			strategyId: input.strategyId ?? null,
			sessionId: input.sessionId ?? null,
			cited: null
		};
		this.store.recordInjection(record);
		return record;
	}
	/**
	* Settle every unresolved injection of one session against the turn's
	* assistant text: an injection is cited when the text references any of its
	* expIds, otherwise not. Each settled outcome folds into the contributing
	* jump words' hit/cited ledger — the measured utility that the next
	* {@link learnTriggerJumps} reinforcement uses — and into the chain's
	* citation ledger when the injection carried a chain. Flushes the pending
	* writes so the settlement is durable.
	* @param sessionId - the session whose injections to settle.
	* @param turnText - the turn's assistant/outcome text.
	* @returns how many injections were settled and how many were cited.
	*/
	async settleInjectionCitations(sessionId, turnText) {
		const pending = this.store.injectionsSnapshot().filter((record) => record.sessionId === sessionId && record.cited === null);
		let settled = 0;
		let cited = 0;
		for (const record of pending) {
			const mentioned = record.expIds.some((expId) => turnText.includes(expId)) || record.chainId !== null && turnText.includes(record.chainId);
			this.store.settleInjection(record.injectionId, mentioned);
			this.store.foldJumpCitation(record.jumpWords, mentioned);
			if (record.chainId !== null) {
				this.foldObjectFeedback("chain", record.chainId, mentioned);
				this.foldObjectFeedback("chain-pattern", record.chainId, mentioned);
			}
			if (record.strategyId !== null) {
				const before = this.store.getSolidifiedStrategy(record.strategyId);
				this.store.foldSolidifiedStrategyUsage(record.strategyId, mentioned);
				const after = this.store.getSolidifiedStrategy(record.strategyId);
				if (after !== void 0 && (before?.reworkNeeded === true || after.reworkNeeded)) {
					if (!this.store.variantsSnapshot().some((candidate) => candidate.sourceStrategyId === record.strategyId && (candidate.status === "proposed" || candidate.status === "testing"))) try {
						await this.generateStrategyVariants(record.strategyId);
					} catch (error) {
						this.ctx.logger.warn(`cognitive-pipeline: variant generation for ${record.strategyId} failed: ${String(error)}`);
					}
				}
			}
			settled += 1;
			if (mentioned) {
				cited += 1;
				for (const expId of record.expIds) {
					const exp = this.store.getExperience(expId);
					if (exp !== void 0) this.store.updateExperience(expId, { citationCount: (exp.citationCount ?? 0) + 1 });
				}
			}
		}
		await this.store.flush();
		return {
			settled,
			cited
		};
	}
	/**
	* Fold one piece of feedback into a registered object kind's measured
	* ruler, through the kind's own measure step (the generic feedback
	* dispatch behind the derived-object lifecycle).
	* @param name - the registered kind name.
	* @param objectId - the feedback subject (e.g. a chain id).
	* @param feedback - the kind-specific feedback payload.
	*/
	foldObjectFeedback(name, objectId, feedback) {
		const kind = this.objectKinds.get(name);
		if (kind === void 0) return;
		kind.measure(this.store, objectId, feedback);
	}
	/**
	* Register a derived cognition object kind: a declaration of one
	* special-experience layer (project/persist/measure/reinforce/expose) that
	* the generic driver can rebuild. Re-registering the same name replaces the
	* kind.
	* @param kind - the kind to register.
	* @returns the service, for chaining.
	*/
	registerCognitionObject(kind) {
		if (kind.name.trim().length === 0) throw new CognitivePipelineError("cognitive-pipeline: object kind name must not be empty", "EMPTY_OBJECT_KIND");
		this.objectKinds.set(kind.name, kind);
		return this;
	}
	/** Registered derived cognition object kinds, in registration order.
	* @returns the kind metadata.
	*/
	cognitionObjects() {
		return [...this.objectKinds.values()].map((kind) => ({
			name: kind.name,
			description: kind.description
		}));
	}
	/**
	* Drive one derived cognition object through its lifecycle: project the
	* store into a candidate build, reinforce (carry measured stats, apply the
	* kind's gates), and persist. This is the declarative payoff — a new object
	* kind costs a declaration, and this one driver serves every kind.
	* @param name - the registered kind name.
	* @returns the build summary.
	*/
	async rebuildCognitionObject(name) {
		const kind = this.objectKinds.get(name);
		if (kind === void 0) throw new CognitivePipelineError(`cognitive-pipeline: cognition object kind "${name}" is not registered`, "COGNITION_OBJECT_NOT_FOUND");
		const build = await kind.project(this.store, this.resolved);
		const reinforced = kind.reinforce(this.store, this.resolved, build);
		kind.persist(this.store, reinforced);
		await this.store.flush();
		return {
			kind: name,
			built: reinforced.length,
			pruned: build.length - reinforced.length
		};
	}
	/**
	* Consolidate one goal-anchored chain from its tagged experiences: assemble
	* the causal skeleton (failure steps and delegation nodes structural,
	* routine successes collapsed), carry the previous chain's citation stats,
	* and persist. This is the offline-consolidation analogue: atoms accumulate
	* online, chains form when consolidated.
	* @param chainId - the goal trace id.
	* @param goal - the goal anchoring the chain; falls back to the previous
	*   chain's goal or the first member's situation.
	* @returns the consolidated chain, or null when the evidence gate
	*   (`chainMinMembers`) is not met.
	*/
	async consolidateChain(chainId, goal) {
		const members = this.store.experiencesSnapshot().filter((exp) => exp.chainId === chainId);
		if (members.length < this.resolved.chainMinMembers) return null;
		const previous = this.store.getChain(chainId);
		const first = members[0];
		const chain = assembleChain(chainId, goal?.trim() || previous?.goal || (first === void 0 ? chainId : first.sar.situation.slice(0, 80)), previous?.anchorSessionId ?? null, members, previous, Date.now());
		const withChildren = {
			...chain,
			childChainIds: childChainIdsOf(chain, this.store.experiencesSnapshot())
		};
		const memberSetChanged = previous !== void 0 && (previous.memberExpIds.length !== withChildren.memberExpIds.length || previous.memberExpIds.some((id, index) => id !== withChildren.memberExpIds[index]));
		let distilled = withChildren;
		if (hasExplicitRoute(this.resolved.route) && (previous === void 0 || memberSetChanged)) {
			const memberInput = members.map((exp) => ({
				expId: exp.expId,
				text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`,
				failed: outcomePolarity(exp.sar.outcomeUtility) === "negative"
			})).sort((a, b) => Number(b.failed) - Number(a.failed));
			const result = await distillChainPrinciple(this.ctx, this.resolved.route, {
				goal: withChildren.goal,
				members: memberInput
			}, {});
			if (result.principle !== null) distilled = {
				...withChildren,
				distilledPrinciple: result.principle
			};
		}
		this.store.upsertChain(distilled);
		await this.store.flush();
		return distilled;
	}
	/**
	* Extract discriminant axes from over-broad clusters (template 10, LLM 定轴):
	* for each cluster whose members are semantically near-duplicates but may
	* split behaviorally, ask the LLM which dimension actually drives the
	* difference (e.g. 新手↔资深 inside a git-push cluster). The axes persist as
	* the C-form routing table — embedding clusters, LLM names the discriminating
	* poles. Clusters with < 8 members are skipped (too small to split); the
	* over-broad cluster is the target, not the whole taxonomy.
	* @param call - optional session/signal context.
	* @returns how many axes were extracted and persisted.
	*/
	async extractDiscriminantAxes(call) {
		if (!hasExplicitRoute(this.resolved.route)) return {
			axesCount: 0,
			clustersExamined: 0
		};
		const clusters = this.store.clustersSnapshot();
		const records = [];
		let clustersExamined = 0;
		const now = Date.now();
		for (const cluster of clusters) {
			const members = this.store.experiencesSnapshot().filter((exp) => exp.clusterId === cluster.clusterId);
			if (members.length < 8) continue;
			clustersExamined += 1;
			const result = await proposeDiscriminantAxes(this.ctx, this.resolved.route, {
				clusterLabel: cluster.name,
				members: members.map((exp) => ({
					expId: exp.expId,
					text: `${exp.sar.situation}。${exp.sar.action}。${exp.sar.outcome}`
				}))
			}, {
				sessionId: call?.sessionId,
				signal: call?.signal
			});
			for (const axis of result.axes) records.push({
				clusterId: cluster.clusterId,
				dimension: axis.dimension,
				axisName: axis.axisName,
				terms: axis.terms,
				rationale: axis.rationale,
				createdAt: now
			});
		}
		if (records.length > 0 || clustersExamined > 0) {
			this.store.replaceDiscriminantAxes(records);
			await this.store.flush();
		}
		return {
			axesCount: records.length,
			clustersExamined
		};
	}
	/**
	* Solidify a repeated successful operation into a reusable, self-verifying
	* strategy. A chain that repeatedly converged on the same concrete action
	* with a machine-checkable acceptance (the restart chain's selfPerformed
	* script is the canonical case) is promoted from SAR memory to a strategy:
	* action + verification anchor (the drift sensor) + invoked/violated
	* lifecycle + pre-checks. The goal domain becomes the injection key, so a
	* later executor facing the same goal gets the STRATEGY (short, verifiable)
	* instead of scattered experiences (long, unverified).
	* @param input - the strategy definition.
	* @returns the created strategy.
	*/
	solidifyStrategy(input) {
		const strategy = {
			strategyId: this.store.nextSolidifiedStrategyId(),
			goalDomain: input.goalDomain,
			action: input.action,
			verificationAnchor: input.verificationAnchor,
			preChecks: [...input.preChecks ?? []],
			sourceChainId: input.sourceChainId ?? "",
			hitCount: 0,
			positiveCount: 0,
			violatedCount: 0,
			reworkNeeded: false,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
		this.store.upsertSolidifiedStrategy(strategy);
		return strategy;
	}
	/** The solidified strategy serving one goal domain, if any.
	* @param goalDomain - the goal domain key (e.g. `重启`).
	* @returns the strategy, or undefined.
	*/
	solidifiedStrategyFor(goalDomain) {
		return this.store.getSolidifiedStrategyByDomain(goalDomain);
	}
	/** All solidified strategies (public for inspection).
	* @returns the strategy list.
	*/
	solidifiedStrategies() {
		return this.store.solidifiedStrategiesSnapshot();
	}
	/**
	* Record one use of a solidified strategy and fold its outcome into the
	* lifecycle ledger. Every use re-checks the environment through the
	* verification anchor — the drift sensor — so a strategy that no longer
	* matches the environment accumulates violations and is flagged for rework
	* instead of failing silently.
	* @param strategyId - the strategy id.
	* @param positive - whether the verification anchor held on this use.
	*/
	recordSolidifiedStrategyUsage(strategyId, positive) {
		this.store.foldSolidifiedStrategyUsage(strategyId, positive);
	}
	/** All chains (public for inspection and consumers).
	* @returns a detached chain list, insertion order.
	*/
	chains() {
		return this.store.chainsSnapshot();
	}
	/**
	* Generate variant candidates for a solidified strategy whose deviation gate
	* flagged rework: the LLM route perturbs one step or parameter of the action
	* while keeping the verification anchor unchanged, and each proposal becomes
	* a `proposed` candidate in the variant table (the driver framework's
	* accommodation: the anchor is the test, the variant is the revised
	* procedure). Without an explicit route no candidates are generated — no
	* model, no invented variants.
	* @param strategyId - the strategy to revise.
	* @returns the created candidates (empty when the route is absent or the
	* generation degrades).
	*/
	async generateStrategyVariants(strategyId) {
		const strategy = this.store.getSolidifiedStrategy(strategyId);
		if (strategy === void 0) return [];
		const candidates = (await generateVariants(this.ctx, this.resolved.route, {
			baseAction: strategy.action,
			verificationAnchor: strategy.verificationAnchor,
			preChecks: strategy.preChecks,
			reason: `偏离门触发：策略已使用 ${strategy.hitCount} 次，其中 ${strategy.violatedCount} 次未通过验收锚点`
		}, {
			sessionId: void 0,
			signal: void 0
		})).map((proposal) => {
			const now = Date.now();
			return {
				variantId: this.store.nextVariantId(),
				sourceStrategyId: strategy.strategyId,
				sourceExpId: null,
				baseAction: strategy.action,
				variantAction: proposal.variantAction,
				verificationAnchor: strategy.verificationAnchor,
				perturbedAspect: proposal.perturbedAspect,
				rationale: proposal.rationale,
				status: "proposed",
				settlements: [],
				createdAt: now,
				updatedAt: now
			};
		});
		for (const candidate of candidates) this.store.addVariantCandidate(candidate);
		if (candidates.length > 0) await this.store.flush();
		return candidates;
	}
	/** All variant candidates (public for inspection and consumers).
	* @returns the candidate list, insertion order.
	*/
	variantCandidates() {
		return this.store.variantsSnapshot();
	}
	/**
	* Forget experiences the evidence gate deems worthless: zero citations and
	* older than the retention age. The machine-checkable value signal
	* (constraint 2) gates retention (constraint 4's pruning) — an experience
	* never adopted by any decision and past its age is forgotten, not kept
	* forever. Conservative: anything with a citation, or younger than the
	* retention window, is never pruned.
	* @param zeroCitationRetentionMs - age beyond which a zero-citation
	* experience is prunable (default 30 days).
	* @returns the removed experience ids.
	*/
	async pruneExperiences(zeroCitationRetentionMs = 720 * 60 * 60 * 1e3) {
		const now = Date.now();
		const removed = [];
		for (const exp of this.store.experiencesSnapshot()) {
			if ((exp.citationCount ?? 0) > 0) continue;
			if (now - exp.timestamp < zeroCitationRetentionMs) continue;
			if (this.store.removeExperience(exp.expId)) removed.push(exp.expId);
		}
		if (removed.length > 0) await this.store.flush();
		return removed;
	}
	/**
	* Offline consolidation (the sleep-phase integration of the self-sustaining
	* design): consolidate every goal-anchored chain whose tagged members have
	* reached the threshold, then refresh the trigger-jump lexicon. Throttled by
	* `offlineConsolidationIntervalMs` (in-memory), so repeated idle ticks from
	* the orchestrator stay cheap. Runs at an idle cadence — the online loop
	* accumulates, this pass turns the accumulation into structure.
	* @returns the consolidation outcome (throttled runs return null).
	*/
	async offlineConsolidation() {
		const now = Date.now();
		const last = this.lastOfflineConsolidation;
		if (last !== null && now - last < this.resolved.offlineConsolidationIntervalMs) return null;
		this.lastOfflineConsolidation = now;
		const consolidatedChains = [];
		const chainIds = /* @__PURE__ */ new Set();
		for (const exp of this.store.experiencesSnapshot()) if (exp.chainId !== void 0) chainIds.add(exp.chainId);
		for (const chainId of chainIds) {
			const chain = await this.consolidateChain(chainId);
			if (chain !== null) consolidatedChains.push(chain.chainId);
		}
		const jumps = await this.learnTriggerJumps();
		return {
			consolidatedChains,
			jump: {
				added: jumps.llmAdded,
				pruned: jumps.pruned,
				total: jumps.jumpCount
			}
		};
	}
	/**
	* Settle one real-use result of a variant candidate (driver framework,
	* mechanism 4 — iterative convergence): append the quality sample, move the
	* candidate into `testing`, and run the convergence gate. A terminal
	* candidate (adopted/rejected) is immutable and ignores further settles.
	* @param variantId - the candidate to settle.
	* @param outcomeQuality - the real-use result quality 0–10.
	* @returns the updated candidate, or null when unknown.
	*/
	async settleVariant(variantId, outcomeQuality) {
		const candidate = this.store.variantsSnapshot().find((item) => item.variantId === variantId);
		if (candidate === void 0) return null;
		if (candidate.status === "adopted" || candidate.status === "rejected") return candidate;
		const settlements = [...candidate.settlements, {
			ts: Date.now(),
			quality: outcomeQuality
		}];
		const verdict = variantConvergence(settlements);
		const status = verdict === "adopt" ? "adopted" : verdict === "reject" ? "rejected" : "testing";
		const next = {
			...candidate,
			settlements,
			status,
			updatedAt: Date.now()
		};
		this.store.updateVariantCandidate(next);
		await this.store.flush();
		return next;
	}
	/**
	* Best-effort automatic variant feedback: when a reported action matches a
	* non-terminal variant candidate's action (hash-bag cosine at/above the
	* temp-strategy match threshold), the report's quality settles that
	* candidate — a variant is tested by being actually executed, not by fiat.
	* Only the BEST-matching candidate is settled: same-family variants share
	* their base action text, so settling every candidate above the threshold
	* would stamp one real execution's quality onto siblings that were never
	* run (real-data lesson from the restart-domain candidates).
	* @param action - the reported action text.
	* @param outcomeQuality - the report's result quality.
	*/
	async foldVariantFeedback(action, outcomeQuality) {
		const vector = actionVector(action, []);
		const threshold = this.resolved.hot.tempStrategyMatchThreshold;
		let best;
		let bestScore = threshold;
		for (const candidate of this.store.variantsSnapshot()) {
			if (candidate.status !== "proposed" && candidate.status !== "testing") continue;
			const score = cosine(vector, actionVector(candidate.variantAction, []));
			if (score >= bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		if (best !== void 0) await this.settleVariant(best.variantId, outcomeQuality);
	}
	/**
	* Render one chain as structured, model-visible steps — the causal skeleton
	* the injection path would present (goal anchor, failure steps marked, the
	* routine summary collapsed).
	* @param chainId - the chain to render.
	* @returns the structured text, or null when the chain is unknown.
	*/
	chainExpose(chainId) {
		const chain = this.store.getChain(chainId);
		if (chain === void 0) return null;
		const lines = chain.steps.map((step) => `  ${step.sequence + 1}. ${step.text}${step.polarity === "failure" ? "（失败→回退）" : ""}`);
		return [
			`【经验链 ${chain.chainId}】目标：${chain.goal}`,
			...lines,
			...chain.summary.length > 0 ? [`  摘要（例行 ${chain.collapsedCount} 步坍缩）：${chain.summary}`] : [],
			...chain.distilledPrinciple !== void 0 ? [`  原则：${chain.distilledPrinciple}`] : []
		].join("\n");
	}
	/**
	* The child chains of one chain (tree edges derived at consolidation: a
	* delegated sub-goal's chain hangs under the delegating chain's receipt).
	* @param chainId - the parent chain.
	* @returns the child chain ids, or [] when the chain is unknown.
	*/
	chainChildren(chainId) {
		const chain = this.store.getChain(chainId);
		return chain === void 0 ? [] : chain.childChainIds;
	}
	/**
	* Render one chain and its goal-structure subtree as structured,
	* model-visible text: each node's causal skeleton, children indented. This
	* is the goal-structured-diffusion surface — a hit on the parent can walk
	* down to sub-goal outcomes.
	* @param chainId - the root chain.
	* @param depth - how many levels below the root to include (default 3).
	* @returns the tree text, or null when the root chain is unknown.
	*/
	chainTreeExpose(chainId, depth = 3) {
		const root = this.store.getChain(chainId);
		if (root === void 0) return null;
		const lines = [];
		const walk = (chain, level) => {
			const indent = "  ".repeat(level);
			lines.push(`${indent}【经验链 ${chain.chainId}】目标：${chain.goal}`);
			for (const step of chain.steps) lines.push(`${indent}  ${step.sequence + 1}. ${step.text}${step.polarity === "failure" ? "（失败→回退）" : ""}`);
			if (chain.summary.length > 0) lines.push(`${indent}  摘要（例行 ${chain.collapsedCount} 步坍缩）：${chain.summary}`);
			if (chain.distilledPrinciple !== void 0) lines.push(`${indent}  原则：${chain.distilledPrinciple}`);
			if (level >= depth) return;
			for (const childId of chain.childChainIds) {
				const child = this.store.getChain(childId);
				if (child !== void 0) walk(child, level + 1);
			}
		};
		walk(root, 0);
		return lines.join("\n");
	}
	/**
	* Explore the upstream/downstream neighbors of one experience across the
	* scattered store — the inferred-chain discovery that complements explicit
	* chain_id tagging (exp_73's other half: when atoms were never tagged, the
	* causal承接 structure can still be recovered from text). A neighbor is an
	* experience whose OUTCOME semantically continues into this experience's
	* SITUATION (upstream: the previous step's result opened this step's
	* situation) or whose SITUATION is continued by this experience's OUTCOME
	* (downstream: this step's result opened the next step's situation). The
	* hash-bag cosine over outcome/situation text is the承接 signal; the
	* candidates are suggestions for the caller to tag and consolidate into a
	* chain — exploration, never silent labeling.
	* @param expId - the anchor experience.
	* @param minCosine - the承接-cosine threshold (default 0.3; below it a
	*   "neighbor" is too semantically distant to suggest a causal edge).
	* @param limit - how many candidates per direction (default 5).
	* @returns the anchor plus its upstream/downstream candidates with their
	*  承接 cosines, or null when the anchor is unknown.
	*/
	exploreChainNeighbors(expId, minCosine = .3, limit = 5) {
		const anchor = this.store.getExperience(expId);
		if (anchor === void 0) return null;
		const anchorSituation = actionVector(anchor.sar.situation, []);
		const anchorOutcome = actionVector(anchor.sar.outcome, []);
		const upstream = [];
		const downstream = [];
		for (const exp of this.store.experiencesSnapshot()) {
			if (exp.expId === expId) continue;
			const up = cosine(actionVector(exp.sar.outcome, []), anchorSituation);
			if (up >= minCosine) upstream.push({
				expId: exp.expId,
				cosine: up,
				text: `${exp.sar.action}。${exp.sar.outcome}`.slice(0, 120)
			});
			const down = cosine(anchorOutcome, actionVector(exp.sar.situation, []));
			if (down >= minCosine) downstream.push({
				expId: exp.expId,
				cosine: down,
				text: exp.sar.situation.slice(0, 120)
			});
		}
		upstream.sort((a, b) => b.cosine - a.cosine);
		downstream.sort((a, b) => b.cosine - a.cosine);
		return {
			anchor: expId,
			upstream: upstream.slice(0, limit),
			downstream: downstream.slice(0, limit)
		};
	}
	/** Recent claim audits (public for inspection).
	* @param limit - how many audits, newest first (default 10).
	* @returns the most recent audits.
	*/
	claimAudits(limit = 10) {
		return [...this.store.claimAuditsSnapshot()].reverse().slice(0, limit);
	}
	/** Acceptance-criteria statistics for inspection.
	* @returns the verification-norm ledger and rewrite/retire candidates.
	*/
	acceptanceStats() {
		const checks = this.store.acceptanceSnapshot();
		const active = checks.filter((check) => check.status === "active");
		const invokedCount = checks.reduce((sum, check) => sum + check.invokedCount, 0);
		const passedCount = checks.reduce((sum, check) => sum + check.passedCount, 0);
		const violatedCount = checks.reduce((sum, check) => sum + check.violatedCount, 0);
		return {
			checkCount: checks.length,
			activeCount: active.length,
			retiredCount: checks.length - active.length,
			invokedCount,
			passedCount,
			violatedCount,
			deviationRate: invokedCount === 0 ? null : violatedCount / invokedCount,
			reworkCheckIds: active.filter((check) => check.invokedCount >= this.resolved.acceptanceMinEvidenceCount && check.violatedCount / check.invokedCount >= this.resolved.acceptanceDeviationThreshold).map((check) => check.checkId)
		};
	}
	/** All clusters (public for inspection).
	* @returns a detached cluster list.
	*/
	clusters() {
		return this.store.clustersSnapshot();
	}
	/** All calibration buckets (public for inspection).
	* @returns a detached bucket table.
	*/
	calibrationBuckets() {
		return this.store.calibrationBucketsSnapshot();
	}
	/** Current taxonomy (public for inspection).
	* @returns the taxonomy, or null before the first rebuild.
	*/
	taxonomy() {
		return this.store.taxonomySnapshot();
	}
	/** Active + graduated scratchpad strategies (public for inspection).
	* @returns a detached strategy list.
	*/
	tempStrategies() {
		return this.store.tempStrategiesSnapshot();
	}
	/** Map an actual outcome to a 0–1 observed value. */
	observedOutcome(input) {
		if (!Number.isFinite(input.outcomeQuality)) throw new CognitivePipelineError("cognitive-pipeline: outcomeQuality must be a finite number", "INVALID_OUTCOME_QUALITY");
		return Math.min(1, Math.max(0, input.outcomeQuality / 10));
	}
	/** Record scratchpad feedback and graduate qualifying strategies. */
	feedbackTempStrategy(action, observed) {
		const strategies = this.store.tempStrategiesSnapshot().filter((strategy) => strategy.status === "active" && strategy.trialAction === action);
		for (const strategy of strategies) {
			const positiveCount = strategy.positiveCount + (observed >= .5 ? 1 : 0);
			const hitCount = strategy.hitCount;
			const ratio = hitCount === 0 ? 0 : positiveCount / hitCount;
			const graduated = hitCount >= this.resolved.tempStrategyHitThreshold && ratio >= this.resolved.tempStrategyPositiveRatio;
			this.store.updateTempStrategy(strategy.signatureHash, {
				positiveCount,
				pendingResult: observed >= .5 ? "positive" : "negative",
				...graduated ? { status: "graduated" } : {}
			});
			if (graduated) {
				this.ctx.logger.info(`cognitive-pipeline: 临时策略 ${strategy.signatureHash} 晋升为主库种子（命中${hitCount}次，正反馈率${(ratio * 100).toFixed(0)}%）`);
				this.store.resolveExploration(strategy.signatureHash, "graduated");
			}
		}
	}
	/** Active-exploration statistics for inspection.
	* @returns budget window usage, terminal-outcome counts, and validation ROI.
	*/
	explorationStats() {
		const state = this.store.explorationSnapshot();
		const graduated = state.entries.filter((entry) => entry.outcome === "graduated").length;
		const expired = state.entries.filter((entry) => entry.outcome === "expired").length;
		const validated = state.entries.filter((entry) => entry.validated === true).length;
		const refuted = state.entries.filter((entry) => entry.validated === false).length;
		const measured = state.entries.filter((entry) => entry.validatedError !== null);
		const errorSum = measured.reduce((sum, entry) => sum + (entry.validatedError ?? 0), 0);
		const tasks = this.store.explorationTasksSnapshot();
		return {
			budget: this.resolved.exploreDailyBudget,
			used: state.used,
			total: state.entries.length,
			graduated,
			expired,
			validated,
			refuted,
			avgValidationError: measured.length === 0 ? null : errorSum / measured.length,
			tasks: {
				pending: tasks.filter((task) => task.status === "pending").length,
				running: tasks.filter((task) => task.status === "running").length,
				completed: tasks.filter((task) => task.status === "completed").length,
				failed: tasks.filter((task) => task.status === "failed").length
			}
		};
	}
};
/** Round to three decimals (jump weights stay compact in the persisted table). */
function round3(value) {
	return Math.round(value * 1e3) / 1e3;
}
/** Clamp into [0, 1]. */
function clamp01(value) {
	return Math.min(1, Math.max(0, value));
}
/** The highest trigger weight of one jump (used for the total-cap ordering). */
function maxJumpWeight(jump) {
	let max = 0;
	for (const entry of jump.triggers) if (entry.weight > max) max = entry.weight;
	return max;
}
//#endregion
//#region lib/types/command-evidence.js
/**
* Command exit-code evidence: the third external-witness class for claim
* audits (alongside session-ledger tool calls and workspace file states).
* The command is actually RUN at audit time through the shell capability
* seam (`ctx.shell`), so the verdict comes from the process exit code, never
* from the model's memory of what it ran. This is how "the tests really
* pass" becomes machine-decidable instead of a state. The pipeline never
* spawns processes itself — the shell executor owns execution.
* @module @deepseek-ai/dsh-cognitive-pipeline/command-evidence
*/
/**
* Verify one exit-code expectation against the exit code the runner settled
* on. Fail-closed: a null exit code (spawn error, timeout, or signal death)
* never matches — cannot verify is a violation, never a pass.
* @param input - the command, expectation, and timeout.
* @param run - the exit-code provider (the service routes it through the
*   shell capability seam).
* @returns the input plus the observed exit code and whether it matched.
*/
async function verifyCommandAnchor(input, run) {
	const exitCode = await run(input.command, input.timeoutMs);
	const matched = exitCode !== null ? input.expect === "exit-zero" ? exitCode === 0 : exitCode !== 0 : false;
	return {
		...input,
		exitCode,
		matched
	};
}
//#endregion
//#region lib/types/file-evidence.js
/**
* Workspace file-state evidence: the second external-witness class for claim
* audits (alongside session-ledger tool calls). The check reads the file at
* audit time, so the verdict comes from the disk, never from the model's
* memory of what it wrote.
* @module @deepseek-ai/dsh-cognitive-pipeline/file-evidence
*/
/**
* Verify one file-state expectation against the current disk. Fail-closed: an
* unreadable path resolves to `matched: false` (cannot verify is a violation,
* never a pass), except that `missing` matches exactly when the file is
* absent.
* @param input - the path, expectation, and expectation parameters.
* @returns the input plus whether the file state matched.
*/
async function verifyFileAnchor(input) {
	const filePath = isAbsolute(input.path) ? input.path : resolve(process.cwd(), input.path);
	if (input.expect === "missing") try {
		await stat(filePath);
		return {
			...input,
			matched: false
		};
	} catch {
		return {
			...input,
			matched: true
		};
	}
	let content;
	try {
		content = await readFile(filePath);
	} catch {
		return {
			...input,
			matched: false
		};
	}
	switch (input.expect) {
		case "exists": return {
			...input,
			matched: true
		};
		case "matches-hash": {
			const digest = createHash("sha256").update(content).digest("hex");
			return {
				...input,
				matched: digest === (input.hash ?? "")
			};
		}
		case "contains": {
			const needle = input.text ?? "";
			return {
				...input,
				matched: needle.length > 0 && content.toString("utf8").includes(needle)
			};
		}
	}
}
//#endregion
//#region lib/types/log-evidence.js
/**
* Session-ledger tool-call evidence: the non-self-referential witness for
* claim audits. Reading the harness-written log means the verdict about what
* a tool call actually did comes from the ledger, never from the model's
* memory of the call.
* @module @deepseek-ai/dsh-cognitive-pipeline/log-evidence
*/
/**
* Locate the most recent `tool/call` with the given name in the session ledger
* and read its terminal result. This is the non-self-referential witness for
* claim audits: the verdict comes from the harness-written log, never from the
* model's memory of the call. A call whose result is still pending (or that
* never happened) resolves to null.
* @param session - the session whose ledger holds the tool events.
* @param toolName - the tool name to match; the most recent call wins.
* @returns the call id and success flag, or null when no settled matching call exists.
*/
function findToolCallEvidence(session, toolName) {
	const events = session.events;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event === void 0 || event.type !== "tool/call") continue;
		const call = event.data;
		if (typeof call.name !== "string" || call.name !== toolName) continue;
		const callId = typeof call.callId === "string" ? call.callId : "";
		for (let resultIndex = index + 1; resultIndex < events.length; resultIndex += 1) {
			const resultEvent = events[resultIndex];
			if (resultEvent === void 0 || resultEvent.type !== "tool/result") continue;
			const message = resultEvent.data.message;
			if (message === void 0) return null;
			const sourceCallId = message.source?.callId;
			const blockCallId = message.content?.[0]?.toolCallId;
			if (callId !== "" && sourceCallId !== callId && blockCallId !== callId) continue;
			return {
				callId,
				succeeded: !(message.content?.some((block) => block?.isError === true) === true)
			};
		}
		return null;
	}
	return null;
}
//#endregion
//#region lib/types/tools.js
/**
* Model-facing tools over the cognitive pipeline: `remember_experience`,
* `simulate_experience`, `reference_experience`, `predict_outcome`,
* `report_outcome`, `rebuild_taxonomy`, `inspect_memory`, `register_loop`,
* `define_acceptance_check`, `verify_claim`, and `update_acceptance_check`.
* Every tool returns one canonical JSON value; `output.render` mirrors it into
* model-facing text.
* @module @deepseek-ai/dsh-cognitive-pipeline/tools
*/
/** Build the model-call context from the executing agent's session. */
function callContext(exec) {
	return exec.agent === void 0 ? {} : { sessionId: exec.agent.session.id };
}
/** One canonical text renderer shared by all tools. */
function renderJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/** Register the fifteen pipeline tools.
* @param ctx - context with the tool registry.
* @param service - the pipeline service backing the tools.
*/
function registerPipelineTools(ctx, service) {
	ctx.tools.register(defineTool({
		name: "remember_experience",
		description: "Encode one raw experience (a past situation, the action taken, and its outcome) into the cognitive pipeline SAR memory. The pipeline extracts situation/action/outcome, scores the outcome utility (material gain, emotional valence, energy cost 0-10), and vectorizes both the action and the outcome for later retrieval and utility-space clustering. Call this when the user shares a completed experience that should inform future predictions. Optionally tag the experience with a chain_id (the goal trace id of the goal execution it belongs to) so the offline consolidation can assemble the goal-anchored chain from its members.",
		parameters: {
			raw_text: {
				type: "string",
				required: true,
				description: "The raw experience text describing situation, action, and result."
			},
			chain_id: {
				type: "string",
				description: "Optional goal trace id (chainId) this experience belongs to; consolidates into a goal-anchored chain when at least chainMinMembers tagged experiences accumulate."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					exp_id: {
						type: "string",
						required: true
					},
					situation: {
						type: "string",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					outcome: {
						type: "string",
						required: true
					},
					outcome_utility: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							material_gain: {
								type: "number",
								required: true
							},
							emotional_valence: {
								type: "number",
								required: true
							},
							energy_cost: {
								type: "number",
								required: true
							}
						}
					},
					chain_id: { type: "string" }
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const { expId, sar } = await service.remember({
				rawText: args.raw_text,
				...args.chain_id === void 0 ? {} : { chainId: args.chain_id }
			}, {
				...callContext(exec),
				signal: exec.signal
			});
			return {
				exp_id: expId,
				situation: sar.situation,
				action: sar.action,
				outcome: sar.outcome,
				outcome_utility: {
					material_gain: sar.outcomeUtility.materialGain,
					emotional_valence: sar.outcomeUtility.emotionalValence,
					energy_cost: sar.outcomeUtility.energyCost
				},
				...args.chain_id === void 0 ? {} : { chain_id: args.chain_id }
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Remember experience",
			kind: "other",
			rawInput: args.raw_text
		})
	}));
	ctx.tools.register(defineTool({
		name: "simulate_experience",
		description: "Generate a simulated experience via the LLM route: given a hypothetical situation and a proposed action, produce a predicted outcome as a retrieval-only candidate. The simulation shapes no cluster until real feedback through report_outcome verifies it (a decisive single feedback fast-tracks, cumulative evidence upgrades, contradiction rolls back, and unverified simulations expire after the fallback TTL). Use this when real testing is costly or impossible and a reasoned projection would help prediction.",
		parameters: {
			situation: {
				type: "string",
				required: true,
				description: "The hypothetical situation to reason about."
			},
			action: {
				type: "string",
				required: true,
				description: "The proposed action whose outcome is to be simulated."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					exp_id: {
						type: "string",
						required: true
					},
					situation: {
						type: "string",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					outcome: {
						type: "string",
						required: true
					},
					simulated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const { expId, sar } = await service.simulate({
				situation: args.situation,
				action: args.action
			}, {
				...callContext(exec),
				signal: exec.signal
			});
			return {
				exp_id: expId,
				situation: sar.situation,
				action: sar.action,
				outcome: sar.outcome,
				simulated: true
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Simulate experience",
			kind: "other",
			rawInput: args.action
		})
	}));
	ctx.tools.register(defineTool({
		name: "reference_experience",
		description: "Derive a reference experience from the commonalities of similar history (cold-start online generalization): given the current situation and proposed action, retrieve the most similar past experiences, ask the LLM route to extract their shared pattern, and write it as a retrieval-only simulated candidate. It shapes no cluster until real feedback through report_outcome verifies it (the same evidence-replacement lifecycle as simulate_experience). Use this when the store has only a few similar experiences and a generalized \"how these situations usually resolve\" reference would help prediction.",
		parameters: {
			situation: {
				type: "string",
				required: true,
				description: "The current situation to anchor the reference derivation."
			},
			action: {
				type: "string",
				required: true,
				description: "The proposed action whose similar-history pattern to generalize."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					exp_id: {
						type: "string",
						required: true
					},
					situation: {
						type: "string",
						required: true
					},
					action: {
						type: "string",
						required: true
					},
					outcome: {
						type: "string",
						required: true
					},
					simulated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const result = await service.deriveReference({
				situation: args.situation,
				action: args.action
			}, {
				...callContext(exec),
				signal: exec.signal
			});
			if (result === null) throw new Error("reference_experience: no common pattern derivable from similar history");
			return {
				exp_id: result.expId,
				situation: result.sar.situation,
				action: result.sar.action,
				outcome: result.sar.outcome,
				simulated: true
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Derive reference experience",
			kind: "other",
			rawInput: args.action
		})
	}));
	ctx.tools.register(defineTool({
		name: "predict_outcome",
		description: "Hot-loop prediction: given a situation and a proposed action, retrieve similar past actions, detect distribution shift (OOD), and produce a calibrated success probability with an 80% confidence interval. Novel actions trigger a scratchpad trial strategy instead of reusing old categories. When the situation matches a proven success cluster, success_reference returns that strategy to reuse. The returned prediction_id must be reported back through report_outcome once the actual result is known so the pipeline can learn from the error.",
		parameters: {
			situation: {
				type: "string",
				required: true,
				description: "The current situation context."
			},
			action: {
				type: "string",
				required: true,
				description: "The proposed action to predict the outcome of."
			},
			context: {
				type: "string",
				description: "Optional extra context folded into the calibration prompt."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					prediction_id: {
						type: "string",
						required: true
					},
					advice: {
						type: "string",
						required: true
					},
					raw_probability: {
						type: "number",
						required: true
					},
					calibrated_probability: {
						type: "number",
						required: true
					},
					confidence_interval_low: {
						type: "number",
						required: true
					},
					confidence_interval_high: {
						type: "number",
						required: true
					},
					is_novel: {
						type: "boolean",
						required: true
					},
					ood_signal: {
						type: "string",
						required: true,
						enum: [
							"none",
							"low-similarity",
							"flat-top",
							"high-strangeness"
						]
					},
					top_hit_count: {
						type: "number",
						required: true
					},
					used_temp_strategy: {
						type: "boolean",
						required: true
					},
					cluster_id: {
						required: true,
						oneOf: [{ type: "number" }, { type: "null" }]
					},
					success_reference: {
						required: true,
						oneOf: [{
							type: "object",
							additionalProperties: false,
							properties: {
								cluster_id: {
									type: "number",
									required: true
								},
								cluster_name: {
									type: "string",
									required: true
								},
								decision_rule: {
									type: "string",
									required: true
								},
								utility_range: {
									type: "object",
									additionalProperties: false,
									required: true,
									properties: {
										low: {
											type: "number",
											required: true
										},
										high: {
											type: "number",
											required: true
										}
									}
								}
							}
						}, { type: "null" }]
					},
					taxonomy_context: {
						required: true,
						type: "object",
						additionalProperties: false,
						properties: {
							coverage: {
								type: "string",
								required: true,
								enum: [
									"covered",
									"gap",
									"no-taxonomy"
								]
							},
							similarity: {
								type: "number",
								required: true
							},
							margin: {
								type: "number",
								required: true
							},
							cluster: {
								required: true,
								oneOf: [{
									type: "object",
									additionalProperties: false,
									properties: {
										cluster_id: {
											type: "number",
											required: true
										},
										name: {
											type: "string",
											required: true
										},
										decision_rule: {
											type: "string",
											required: true
										},
										polarity: {
											type: "string",
											required: true,
											enum: ["success", "risk"]
										}
									}
								}, { type: "null" }]
							}
						}
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const input = {
				situation: args.situation,
				action: args.action,
				...args.context === void 0 || args.context.length === 0 ? {} : { context: args.context }
			};
			const result = await service.predict(input, {
				...callContext(exec),
				signal: exec.signal
			});
			return {
				prediction_id: result.predictionId,
				advice: result.advice,
				raw_probability: result.rawProbability,
				calibrated_probability: result.calibratedProbability,
				confidence_interval_low: result.confidenceLow,
				confidence_interval_high: result.confidenceHigh,
				is_novel: result.isNovel,
				ood_signal: result.oodSignal,
				top_hit_count: result.topHitCount,
				used_temp_strategy: result.usedTempStrategy,
				cluster_id: result.clusterId,
				success_reference: result.successReference === null ? null : {
					cluster_id: result.successReference.clusterId,
					cluster_name: result.successReference.clusterName,
					decision_rule: result.successReference.decisionRule,
					utility_range: { ...result.successReference.utilityRange }
				},
				taxonomy_context: {
					coverage: result.taxonomyContext.coverage,
					similarity: result.taxonomyContext.similarity,
					margin: result.taxonomyContext.margin,
					cluster: result.taxonomyContext.cluster === null ? null : {
						cluster_id: result.taxonomyContext.cluster.clusterId,
						name: result.taxonomyContext.cluster.name,
						decision_rule: result.taxonomyContext.cluster.decisionRule,
						polarity: result.taxonomyContext.cluster.polarity
					}
				}
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Predict outcome",
			kind: "other",
			rawInput: args.action
		})
	}));
	ctx.tools.register(defineTool({
		name: "report_outcome",
		description: "Feedback callback: report the actual outcome of a previous predict_outcome call. The pipeline computes the prediction error, updates lifetime calibration statistics, feeds the scratchpad when a trial strategy was used, and triggers an emergency local taxonomy repair when the error is extreme. outcome_quality (0-10) is required so every resolved prediction carries a real utility signal; a neutral baseline is never inferred from the outcome text.",
		parameters: {
			prediction_id: {
				type: "string",
				required: true,
				description: "The prediction_id returned by predict_outcome."
			},
			actual_outcome: {
				type: "string",
				required: true,
				description: "The observed result text."
			},
			outcome_quality: {
				type: "number",
				required: true,
				description: "Actual outcome quality 0-10 (5 = neutral). Required for a real utility signal."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						enum: ["logged"]
					},
					prediction_error: {
						type: "number",
						required: true
					},
					trigger_rebuild: {
						type: "boolean",
						required: true
					},
					rebuild_reason: {
						required: true,
						oneOf: [{ type: "string" }, { type: "null" }]
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const result = await service.report({
				predictionId: args.prediction_id,
				actualOutcome: args.actual_outcome,
				outcomeQuality: args.outcome_quality
			}, {
				...callContext(exec),
				signal: exec.signal
			});
			return {
				status: result.status,
				prediction_error: result.predictionError,
				trigger_rebuild: result.triggerRebuild,
				rebuild_reason: result.rebuildReason
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Report outcome",
			kind: "other",
			rawInput: args.prediction_id
		})
	}));
	ctx.tools.register(defineTool({
		name: "rebuild_taxonomy",
		description: "Cold-loop taxonomy rebuild: sample decay-weighted high-error experiences, re-cluster them in utility space, anchor new clusters with evidence (≥3 distinct experience ids, backend-verified), backtest the proposal on the newest slice, and write it back only when it cuts validation error by at least 15%. Use scope \"global\" for a full rebuild or \"local\" to repair only the worst cluster. The resulting taxonomy summary is injected into the session system prompt.",
		parameters: { scope: {
			type: "string",
			enum: ["local", "global"],
			description: "Rebuild scope; default global."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					scope: {
						type: "string",
						required: true,
						enum: ["local", "global"]
					},
					accepted: {
						type: "boolean",
						required: true
					},
					deferred: {
						type: "boolean",
						required: true
					},
					old_error: {
						required: true,
						oneOf: [{ type: "number" }, { type: "null" }]
					},
					new_error: {
						required: true,
						oneOf: [{ type: "number" }, { type: "null" }]
					},
					delta_error: {
						required: true,
						oneOf: [{ type: "number" }, { type: "null" }]
					},
					cluster_count: {
						type: "number",
						required: true
					},
					rejected_clusters: {
						type: "number",
						required: true
					},
					sample_count: {
						type: "number",
						required: true
					},
					reason: {
						type: "string",
						required: true
					},
					taxonomy_version: {
						type: "number",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			const result = await service.rebuild(args.scope ?? "global", {
				...callContext(exec),
				signal: exec.signal
			});
			return {
				scope: result.scope,
				accepted: result.accepted,
				deferred: result.deferred,
				old_error: result.oldError,
				new_error: result.newError,
				delta_error: result.deltaError,
				cluster_count: result.clusterCount,
				rejected_clusters: result.rejectedClusters,
				sample_count: result.sampleCount,
				reason: result.reason,
				taxonomy_version: result.taxonomyVersion
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Rebuild taxonomy (${args.scope ?? "global"})`,
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "inspect_memory",
		description: "Read the cognitive pipeline state: stored experience and prediction counts, clusters, calibration buckets, active scratchpad strategies, the current taxonomy summary, and the most recent resolved predictions. Use it to understand what the pipeline has learned and how calibrated it is.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					experience_count: {
						type: "number",
						required: true
					},
					prediction_count: {
						type: "number",
						required: true
					},
					resolved_prediction_count: {
						type: "number",
						required: true
					},
					settlement: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							sample_count: {
								type: "number",
								required: true
							},
							sampled_experience_count: {
								type: "number",
								required: true
							},
							multi_sample_experience_count: {
								type: "number",
								required: true
							},
							disequilibrated_experience_count: {
								type: "number",
								required: true
							},
							recovered_disequilibrium_count: {
								type: "number",
								required: true
							}
						}
					},
					citation: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							cited_experience_count: {
								type: "number",
								required: true
							},
							zero_citation_experience_count: {
								type: "number",
								required: true
							}
						}
					},
					variants: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							proposed: {
								type: "number",
								required: true
							},
							testing: {
								type: "number",
								required: true
							},
							adopted: {
								type: "number",
								required: true
							},
							rejected: {
								type: "number",
								required: true
							}
						}
					},
					cluster_count: {
						type: "number",
						required: true
					},
					active_temp_strategy_count: {
						type: "number",
						required: true
					},
					channel_weights: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							semantic: {
								type: "number",
								required: true
							},
							situational: {
								type: "number",
								required: true
							},
							symptom: {
								type: "number",
								required: true
							},
							outcome: {
								type: "number",
								required: true
							}
						}
					},
					taxonomy: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							version: {
								type: "number",
								required: true
							},
							summary_short: {
								type: "string",
								required: true
							},
							updated_at: {
								type: "number",
								required: true
							}
						}
					},
					exploration: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							budget: {
								type: "number",
								required: true
							},
							used: {
								type: "number",
								required: true
							},
							total: {
								type: "number",
								required: true
							},
							graduated: {
								type: "number",
								required: true
							},
							expired: {
								type: "number",
								required: true
							},
							validated: {
								type: "number",
								required: true
							},
							refuted: {
								type: "number",
								required: true
							},
							avg_validation_error: {
								type: "number",
								required: true
							},
							tasks: {
								type: "object",
								additionalProperties: false,
								required: true,
								properties: {
									pending: {
										type: "number",
										required: true
									},
									running: {
										type: "number",
										required: true
									},
									completed: {
										type: "number",
										required: true
									},
									failed: {
										type: "number",
										required: true
									}
								}
							}
						}
					},
					loops: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								description: {
									type: "string",
									required: true
								},
								prediction_count: {
									type: "number",
									required: true
								},
								resolved_count: {
									type: "number",
									required: true
								},
								avg_prediction_error: {
									type: "number",
									required: true
								},
								executed_count: {
									type: "number",
									required: true
								},
								refused_count: {
									type: "number",
									required: true
								},
								failed_count: {
									type: "number",
									required: true
								}
							}
						}
					},
					loop_executions: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								receipt_id: {
									type: "string",
									required: true
								},
								loop_name: {
									type: "string",
									required: true
								},
								target: {
									type: "string",
									required: true
								},
								decision: {
									type: "string",
									required: true
								},
								rejected: {
									type: "boolean",
									required: true
								},
								reason: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								},
								outcome_quality: {
									type: "number",
									required: true
								}
							}
						}
					},
					acceptance: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							check_count: {
								type: "number",
								required: true
							},
							active_count: {
								type: "number",
								required: true
							},
							retired_count: {
								type: "number",
								required: true
							},
							invoked_count: {
								type: "number",
								required: true
							},
							passed_count: {
								type: "number",
								required: true
							},
							violated_count: {
								type: "number",
								required: true
							},
							deviation_rate: {
								type: "number",
								required: true
							},
							rework_check_ids: {
								type: "array",
								required: true,
								items: { type: "string" }
							}
						}
					},
					recent_audits: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								audit_id: {
									type: "string",
									required: true
								},
								claim: {
									type: "string",
									required: true
								},
								verdict: {
									type: "string",
									required: true,
									enum: [
										"verified",
										"violated",
										"not-applicable"
									]
								},
								rework_needed: {
									type: "boolean",
									required: true
								},
								deviation_exp_id: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: renderJson
		},
		execute(_args, _exec) {
			const result = service.inspect();
			return Promise.resolve({
				experience_count: result.experienceCount,
				prediction_count: result.predictionCount,
				resolved_prediction_count: result.resolvedPredictionCount,
				settlement: {
					sample_count: result.settlement.sampleCount,
					sampled_experience_count: result.settlement.sampledExperienceCount,
					multi_sample_experience_count: result.settlement.multiSampleExperienceCount,
					disequilibrated_experience_count: result.settlement.disequilibratedExperienceCount,
					recovered_disequilibrium_count: result.settlement.recoveredDisequilibriumCount
				},
				citation: {
					cited_experience_count: result.citation.citedExperienceCount,
					zero_citation_experience_count: result.citation.zeroCitationExperienceCount
				},
				variants: {
					proposed: result.variants.proposed,
					testing: result.variants.testing,
					adopted: result.variants.adopted,
					rejected: result.variants.rejected
				},
				cluster_count: result.clusterCount,
				active_temp_strategy_count: result.activeTempStrategyCount,
				channel_weights: {
					semantic: result.channelWeights.semantic,
					situational: result.channelWeights.situational,
					symptom: result.channelWeights.symptom,
					outcome: result.channelWeights.outcome
				},
				taxonomy: {
					version: result.taxonomy.version,
					summary_short: result.taxonomy.summaryShort,
					updated_at: result.taxonomy.updatedAt
				},
				exploration: {
					budget: result.exploration.budget,
					used: result.exploration.used,
					total: result.exploration.total,
					graduated: result.exploration.graduated,
					expired: result.exploration.expired,
					validated: result.exploration.validated,
					refuted: result.exploration.refuted,
					avg_validation_error: result.exploration.avgValidationError === null ? -1 : Number(result.exploration.avgValidationError.toFixed(3)),
					tasks: {
						pending: result.exploration.tasks.pending,
						running: result.exploration.tasks.running,
						completed: result.exploration.tasks.completed,
						failed: result.exploration.tasks.failed
					}
				},
				loops: result.loops.map((loop) => ({
					name: loop.name,
					description: loop.description,
					prediction_count: loop.predictionCount,
					resolved_count: loop.resolvedCount,
					avg_prediction_error: loop.avgPredictionError === null ? -1 : Number(loop.avgPredictionError.toFixed(3)),
					executed_count: loop.executedCount,
					refused_count: loop.refusedCount,
					failed_count: loop.failedCount
				})),
				loop_executions: result.loopExecutions.map((receipt) => ({
					receipt_id: receipt.receiptId,
					loop_name: receipt.loopName,
					target: receipt.target,
					decision: receipt.decision,
					rejected: receipt.rejected,
					reason: receipt.reason ?? "",
					status: receipt.status ?? "submitted",
					outcome_quality: receipt.outcomeQuality ?? -1
				})),
				acceptance: {
					check_count: result.acceptance.checkCount,
					active_count: result.acceptance.activeCount,
					retired_count: result.acceptance.retiredCount,
					invoked_count: result.acceptance.invokedCount,
					passed_count: result.acceptance.passedCount,
					violated_count: result.acceptance.violatedCount,
					deviation_rate: result.acceptance.deviationRate === null ? -1 : Number(result.acceptance.deviationRate.toFixed(3)),
					rework_check_ids: [...result.acceptance.reworkCheckIds]
				},
				recent_audits: result.recentAudits.map((audit) => ({
					audit_id: audit.auditId,
					claim: audit.claim,
					verdict: audit.verdict,
					rework_needed: audit.reworkNeeded,
					deviation_exp_id: audit.deviationExpId ?? ""
				}))
			});
		},
		presentCall: () => ({
			card: "generic",
			title: "Inspect cognitive memory",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "register_loop",
		description: "Register a named meta-cognition loop (造新环路): a special-experience layer whose decisions flow through the SAME predict/report calibration ruler as every other prediction. Registering a loop gives it a stable identity — its decision history is retrievable under a `loop:<name>` prefix and aggregated per-loop in inspect_memory. Use this to make a new recurring decision (e.g. \"when to compact\", \"when to retry\", \"when to ask the user\") learnable instead of hard-coded: register once, then drive it with predict_outcome/report_outcome on `loop:<name> 情境=…` situations.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Stable loop identity, lowercase with hyphens (e.g. \"when-to-compact\")."
			},
			description: {
				type: "string",
				required: true,
				description: "One line describing what this loop decides."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						type: "string",
						required: true
					},
					registered: {
						type: "boolean",
						required: true
					}
				}
			},
			render: renderJson
		},
		execute(args) {
			service.registerLoop({
				name: args.name,
				description: args.description
			});
			return Promise.resolve({
				name: args.name,
				registered: true
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Register cognitive loop ${args.name}`,
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "define_acceptance_check",
		description: "Define one acceptance criterion: a reusable verification norm the agent audits claims against before treating them as settled, e.g. \"claims of completion must cite evidence\". The pipeline records evidence PRESENCE, never evidence truth — it cannot verify its own claims; truth is adjudicated by the resolved outcome and the user. The criterion is active immediately with an empty evidence ledger; its track record (invoked/passed/violated/error) can never be reset.",
		parameters: {
			criterion: {
				type: "string",
				required: true,
				description: "The norm as a testable statement, e.g. \"声称完成前必须给出证据来源\"."
			},
			trigger: {
				type: "string",
				required: true,
				description: "Situation marker selecting this check: an audit applies it when the marker appears in the claim or its situation text."
			},
			evidence_hint: {
				type: "string",
				required: true,
				description: "What evidence a claim must carry to satisfy the criterion."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					check_id: {
						type: "string",
						required: true
					},
					criterion: {
						type: "string",
						required: true
					},
					trigger: {
						type: "string",
						required: true
					},
					evidence_hint: {
						type: "string",
						required: true
					},
					revision: {
						type: "number",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args) {
			const check = await service.defineAcceptanceCheck({
				criterion: args.criterion,
				trigger: args.trigger,
				evidenceHint: args.evidence_hint
			});
			return {
				check_id: check.checkId,
				criterion: check.criterion,
				trigger: check.trigger,
				evidence_hint: check.evidenceHint,
				revision: check.revision
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Define acceptance check",
			kind: "other",
			rawInput: args.criterion
		})
	}));
	ctx.tools.register(defineTool({
		name: "verify_claim",
		description: "Audit one claim against the active acceptance criteria before treating it as settled. Applicable checks are those whose trigger marker appears in the claim or its situation; a claim with no applicable check audits as not-applicable. An applicable check is satisfied when the claim carries evidence (non-empty), violated when it does not — presence, not truth. When an external-witness anchor is supplied (log_anchor for the session ledger, file_anchor for the workspace disk, command_anchor for a command's actual exit code), the witness mechanically decides instead: log_anchor reads the executing session's log for the most recent tool/call of that name and checks its tool/result against the expectation; file_anchor reads the file at audit time and checks the stated file-state expectation (exists/missing/matches-hash/contains, fail-closed on unreadable). A missing or mismatched anchor violates the claim regardless of self-reported evidence — the witness is non-self-referential, so an anchored claim cannot be validated by self-report alone. Violated checks accumulate in the criterion ledger, and a criterion whose invoked count clears the evidence minimum while its deviation rate crosses the threshold flags rework_needed and records one deviation meta experience. Pass prediction_id when a predict_outcome exists for the claim: its report_outcome feedback then folds the prediction error into the violated criteria, measuring \"claims without verification\" on the same ruler as every prediction.",
		parameters: {
			claim: {
				type: "string",
				required: true,
				description: "The claim being made, e.g. \"管线已学会验收标准\"."
			},
			situation: {
				type: "string",
				required: true,
				description: "The context the claim is made in."
			},
			evidence: {
				type: "string",
				description: "The verification statement backing the claim; omit or leave empty when the claim is made without evidence."
			},
			prediction_id: {
				type: "string",
				description: "Optional prediction_id from predict_outcome that this claim is about; its feedback folds into violated criteria."
			},
			log_anchor: {
				type: "object",
				additionalProperties: false,
				properties: {
					tool_name: {
						type: "string",
						required: true,
						description: "The tool name whose most recent call in this session's ledger is the witness."
					},
					expect_succeeded: {
						type: "boolean",
						required: true,
						description: "Whether the claim asserts the call succeeded (true) or failed (false)."
					}
				},
				description: "Anchor the claim to the session ledger: the ledger's tool/result mechanically decides the audit instead of self-reported evidence. Set it when the verification is a tool call that happened in this session."
			},
			file_anchor: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true,
						description: "The workspace file path the claim asserts about; relative paths resolve against the working directory."
					},
					expect: {
						type: "string",
						required: true,
						enum: [
							"exists",
							"missing",
							"matches-hash",
							"contains"
						],
						description: "The file-state expectation the claim asserts."
					},
					hash: {
						type: "string",
						description: "Expected sha256 hex digest; required when expect is matches-hash."
					},
					text: {
						type: "string",
						description: "Searched substring; required when expect is contains."
					}
				},
				description: "Anchor the claim to the workspace disk: the file state read at audit time mechanically decides the audit instead of self-reported evidence (fail-closed: an unreadable file never passes). Set it when the verification is a file the agent actually produced."
			},
			command_anchor: {
				type: "object",
				additionalProperties: false,
				properties: {
					command: {
						type: "string",
						required: true,
						description: "The command line to run via the shell; only its exit code is observed."
					},
					expect: {
						type: "string",
						required: true,
						enum: ["exit-zero", "exit-nonzero"],
						description: "The exit-code expectation the claim asserts."
					}
				},
				description: "Anchor the claim to a command's actual exit code: the command is RUN at audit time through the shell capability seam (ctx.shell, so sandbox policy and output handling belong to the composed executor) and only its exit code is observed (output discarded). Fail-closed on timeout or signal death; requires the shell capability to be mounted and acceptanceCommandExecution: true in the plugin config — command execution is OFF by default."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					audit_id: {
						type: "string",
						required: true
					},
					verdict: {
						type: "string",
						required: true,
						enum: [
							"verified",
							"violated",
							"not-applicable"
						]
					},
					applied_check_ids: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					satisfied_check_ids: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					violated_check_ids: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					anchor_verified: {
						type: "boolean",
						required: true,
						description: "True when the audit was backed by a matched external-witness anchor (session ledger or workspace disk — the non-self-referential witness), false for self-reported evidence or no anchor."
					},
					rework_needed: {
						type: "boolean",
						required: true
					},
					deviation_exp_id: {
						type: "string",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args, exec) {
			let anchor = null;
			if (args.log_anchor !== void 0 && exec.agent !== void 0) {
				const evidence = findToolCallEvidence(exec.agent.session, args.log_anchor.tool_name);
				anchor = {
					kind: "log",
					toolName: args.log_anchor.tool_name,
					callId: evidence?.callId ?? "",
					expectedSucceeded: args.log_anchor.expect_succeeded,
					matched: evidence !== null && evidence.succeeded === args.log_anchor.expect_succeeded
				};
			} else if (args.file_anchor !== void 0) {
				const result = await verifyFileAnchor({
					path: args.file_anchor.path,
					expect: args.file_anchor.expect,
					...args.file_anchor.hash === void 0 || args.file_anchor.hash.length === 0 ? {} : { hash: args.file_anchor.hash },
					...args.file_anchor.text === void 0 || args.file_anchor.text.length === 0 ? {} : { text: args.file_anchor.text }
				});
				anchor = {
					kind: "file",
					path: result.path,
					expect: result.expect,
					...result.hash === void 0 ? {} : { hash: result.hash },
					...result.text === void 0 ? {} : { text: result.text },
					matched: result.matched
				};
			} else if (args.command_anchor !== void 0) {
				if (!service.resolved.acceptanceCommandExecution) throw new Error("verify_claim: command anchors are disabled — enable acceptanceCommandExecution in the cognitive-pipeline plugin config before anchoring claims to a command exit code");
				const result = await verifyCommandAnchor({
					command: args.command_anchor.command,
					expect: args.command_anchor.expect,
					timeoutMs: service.resolved.acceptanceCommandTimeoutMs
				}, (command, timeoutMs) => service.runCommandExitCode(command, timeoutMs));
				anchor = {
					kind: "command",
					command: result.command,
					expect: result.expect,
					exitCode: result.exitCode,
					matched: result.matched
				};
			}
			const audit = await service.auditClaim({
				claim: args.claim,
				situation: args.situation,
				...args.evidence === void 0 || args.evidence.length === 0 ? {} : { evidence: args.evidence },
				...args.prediction_id === void 0 || args.prediction_id.length === 0 ? {} : { predictionId: args.prediction_id },
				...anchor === null ? {} : { anchor }
			});
			return {
				audit_id: audit.auditId,
				verdict: audit.verdict,
				applied_check_ids: [...audit.appliedCheckIds],
				satisfied_check_ids: [...audit.satisfiedCheckIds],
				violated_check_ids: [...audit.violatedCheckIds],
				anchor_verified: audit.anchorVerified,
				rework_needed: audit.reworkNeeded,
				deviation_exp_id: audit.deviationExpId ?? ""
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Verify claim",
			kind: "other",
			rawInput: args.claim
		})
	}));
	ctx.tools.register(defineTool({
		name: "update_acceptance_check",
		description: "Rewrite an active acceptance criterion's statement or evidence hint, or retire it. A retired criterion is frozen: its evidence ledger is never reset and audits no longer apply it — criteria are revisable, their track record is not (the evidence gate of acceptance-criterion change).",
		parameters: {
			check_id: {
				type: "string",
				required: true,
				description: "The acceptance criterion id from define_acceptance_check."
			},
			criterion: {
				type: "string",
				description: "New criterion statement."
			},
			evidence_hint: {
				type: "string",
				description: "New evidence hint."
			},
			retire: {
				type: "boolean",
				description: "Set true to freeze the criterion as retired (terminal; cannot be un-retired)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					check_id: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						required: true,
						enum: ["active", "retired"]
					},
					criterion: {
						type: "string",
						required: true
					},
					evidence_hint: {
						type: "string",
						required: true
					},
					revision: {
						type: "number",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args) {
			const check = await service.updateAcceptanceCheck({
				checkId: args.check_id,
				...args.criterion === void 0 || args.criterion.length === 0 ? {} : { criterion: args.criterion },
				...args.evidence_hint === void 0 || args.evidence_hint.length === 0 ? {} : { evidenceHint: args.evidence_hint },
				...args.retire === void 0 ? {} : { retire: args.retire }
			});
			return {
				check_id: check.checkId,
				status: check.status,
				criterion: check.criterion,
				evidence_hint: check.evidenceHint,
				revision: check.revision
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Update acceptance check ${args.check_id}`,
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "propose_acceptance_update",
		description: "Run the acceptance-criterion proposal route: gather the demonstrably failing active criteria (deviation rate at/above the threshold with enough invoked audits) and their evidence ledgers, ask the LLM route to propose rewrites or retirements, and apply ONLY the proposals that pass the experience gate — a proposal must target a failing criterion, carry a rationale, and carry concrete rewrite text. This is how the pipeline amends its own verification norms from experience: the route proposes, the evidence gate disposes. Without a failing criterion or an explicit LLM route, nothing is proposed or applied. Applied rewrites bump the criterion revision; the evidence ledger is never reset.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					flagged_checks: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								check_id: {
									type: "string",
									required: true
								},
								criterion: {
									type: "string",
									required: true
								},
								invoked_count: {
									type: "number",
									required: true
								},
								violated_count: {
									type: "number",
									required: true
								},
								deviation_rate: {
									type: "number",
									required: true
								},
								machine_verified_count: {
									type: "number",
									required: true
								},
								cumulative_error: {
									type: "number",
									required: true
								}
							}
						}
					},
					proposals: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								check_id: {
									type: "string",
									required: true
								},
								action: {
									type: "string",
									required: true,
									enum: ["rewrite", "retire"]
								},
								criterion: {
									type: "string",
									required: true
								},
								rationale: {
									type: "string",
									required: true
								}
							}
						}
					},
					applied_checks: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								check_id: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true,
									enum: ["active", "retired"]
								},
								revision: {
									type: "number",
									required: true
								},
								criterion: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: renderJson
		},
		async execute(_args, exec) {
			const result = await service.proposeAcceptanceUpdate({
				...callContext(exec),
				signal: exec.signal
			});
			return {
				flagged_checks: result.flagged.map((check) => ({
					check_id: check.checkId,
					criterion: check.criterion,
					invoked_count: check.invokedCount,
					violated_count: check.violatedCount,
					deviation_rate: Number((check.violatedCount / check.invokedCount).toFixed(3)),
					machine_verified_count: check.machineVerifiedCount,
					cumulative_error: Number(check.cumulativeError.toFixed(3))
				})),
				proposals: result.proposals.map((proposal) => ({
					check_id: proposal.checkId,
					action: proposal.action,
					criterion: proposal.criterion ?? "",
					rationale: proposal.rationale
				})),
				applied_checks: result.applied.map((check) => ({
					check_id: check.checkId,
					status: check.status,
					revision: check.revision,
					criterion: check.criterion
				}))
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "Propose acceptance update",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "learn_trigger_jumps",
		description: "Learn the trigger-jump lexicon from the experience store: the associative layer over the injection trigger words. Co-occurrence jumps are built deterministically (a token that appears with a trigger across enough distinct important experiences becomes a jump toward it), and when an explicit LLM route exists, synonym-variant jumps (卡住↔卡壳) are proposed additionally — those enter with zero co-occurrence evidence and are validated by the citation loop instead. The rebuild carries each surviving jump's measured utility and applies reinforcement: jumps whose injections were actually cited are boosted, and jumps that never pay off are pruned. Call it after meaningful new experiences accumulate, so the injection gate keeps learning which words should open it.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					jump_count: {
						type: "number",
						required: true
					},
					cooccurrence_count: {
						type: "number",
						required: true
					},
					llm_added: {
						type: "number",
						required: true
					},
					pruned: {
						type: "number",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(_args, exec) {
			const result = await service.learnTriggerJumps({
				...callContext(exec),
				signal: exec.signal
			});
			return {
				jump_count: result.jumpCount,
				cooccurrence_count: result.cooccurrenceCount,
				llm_added: result.llmAdded,
				pruned: result.pruned
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "Learn trigger jumps",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "consolidate_chain",
		description: "Consolidate one goal-anchored chain from its tagged experiences: assemble the causal skeleton (failure steps and cross-agent delegation nodes kept as structural steps, routine successes collapsed into a bounded summary), carry the previous chain's citation stats, and persist. This is the offline-consolidation analogue — atoms accumulate online, chains form when consolidated. Requires at least chainMinMembers tagged experiences (evidence gate); returns the structured chain or a not-ready marker. Call it when a goal execution that was tagged with a chainId completes.",
		parameters: {
			chain_id: {
				type: "string",
				required: true,
				description: "The goal trace id (chainId) the experiences were tagged with."
			},
			goal: {
				type: "string",
				description: "The goal anchoring the chain; falls back to the previous chain's goal or the first member's situation."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					chain_id: {
						type: "string",
						required: true
					},
					status: {
						type: "string",
						required: true,
						enum: ["consolidated", "not-ready"]
					},
					member_count: {
						type: "number",
						required: true
					},
					step_count: {
						type: "number",
						required: true
					},
					delegation_count: {
						type: "number",
						required: true
					},
					summary: {
						type: "string",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args) {
			const chain = await service.consolidateChain(args.chain_id, args.goal);
			if (chain === null) return {
				chain_id: args.chain_id,
				status: "not-ready",
				member_count: 0,
				step_count: 0,
				delegation_count: 0,
				summary: ""
			};
			return {
				chain_id: chain.chainId,
				status: "consolidated",
				member_count: chain.memberExpIds.length,
				step_count: chain.steps.length,
				delegation_count: chain.delegationNodeIds.length,
				summary: chain.summary
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Consolidate chain ${args.chain_id}`,
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "explore_chain",
		description: "Explore the upstream/downstream neighbors of one experience across the scattered experience store — the inferred-chain discovery that complements explicit chain_id tagging. A neighbor is an experience whose outcome semantically continues into this experience's situation (upstream: the previous step's result opened this step's situation) or whose situation is continued by this experience's outcome (downstream). Candidates are suggestions for tagging and consolidation into a goal-anchored chain — exploration, never silent labeling: nothing is written unless you tag and consolidate. Call it to find which scattered experiences plausibly belong to one goal execution.",
		parameters: {
			exp_id: {
				type: "string",
				required: true,
				description: "The anchor experience id."
			},
			min_cosine: {
				type: "number",
				description: "The承接-cosine threshold (default 0.3); below it a candidate is too distant to suggest a causal edge."
			},
			limit: {
				type: "number",
				description: "How many candidates per direction (default 5)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					anchor: {
						type: "string",
						required: true
					},
					upstream: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								exp_id: {
									type: "string",
									required: true
								},
								cosine: {
									type: "number",
									required: true
								},
								text: {
									type: "string",
									required: true
								}
							}
						}
					},
					downstream: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								exp_id: {
									type: "string",
									required: true
								},
								cosine: {
									type: "number",
									required: true
								},
								text: {
									type: "string",
									required: true
								}
							}
						}
					}
				}
			},
			render: renderJson
		},
		execute(args) {
			const result = service.exploreChainNeighbors(args.exp_id, args.min_cosine, args.limit);
			if (result === null) return Promise.resolve({
				anchor: args.exp_id,
				upstream: [],
				downstream: []
			});
			return Promise.resolve({
				anchor: result.anchor,
				upstream: result.upstream.map((hit) => ({
					exp_id: hit.expId,
					cosine: Number(hit.cosine.toFixed(3)),
					text: hit.text
				})),
				downstream: result.downstream.map((hit) => ({
					exp_id: hit.expId,
					cosine: Number(hit.cosine.toFixed(3)),
					text: hit.text
				}))
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Explore chain neighbors of ${args.exp_id}`,
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "rebuild_cognition_object",
		description: "Drive one derived cognition object through its lifecycle generically: project the experience store into the kind's candidate build, reinforce (carry measured stats, apply the kind's evidence gate), and persist. Registered kinds include \"chain\" (goal-anchored causal skeletons). This is the declarative payoff of the derived-object abstraction: a new kind costs a declaration, and this one driver serves every kind. Call it after meaningful tagged experiences accumulate.",
		parameters: { kind: {
			type: "string",
			required: true,
			description: "The registered object kind name, e.g. \"chain\"."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true
					},
					built: {
						type: "number",
						required: true
					},
					pruned: {
						type: "number",
						required: true
					}
				}
			},
			render: renderJson
		},
		async execute(args) {
			const result = await service.rebuildCognitionObject(args.kind);
			return {
				kind: result.kind,
				built: result.built,
				pruned: result.pruned
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Rebuild cognition object ${args.kind}`,
			kind: "read"
		})
	}));
}
//#endregion
//#region lib/types/index.js
/**
* Prediction-error-driven dynamic cognition (DCA-PED) as a harness plugin:
* SAR experience memory, a hot-loop online predictor with OOD detection and
* five-layer confidence calibration, a temp-strategy scratchpad, simulated
* experience generation, a cold-loop taxonomy rebuild gated by sandbox
* backtesting, meta-cognition loops, acceptance-criteria claim audits, and
* derived cognition objects (goal-anchored chains).
* The plugin exposes fifteen model-facing tools, the
* `ctx.cognitivePipeline` service, and a dynamic `cognition:taxonomy`
* system-prompt section.
*
* @module @deepseek-ai/dsh-cognitive-pipeline
*/
/** Stable Cordis plugin name. */
const name = "cognitive-pipeline";
/** Services required before the pipeline can mount. */
const inject = [
	"llm",
	"tools",
	"systemPrompt"
];
/** Reconstruct one completed turn into candidate accumulation material.
* Reads the turn's events back from the session ledger: the genuine user
* request (source kind 'user') becomes the situation, tool calls become the
* action, the final assistant text and the end reason become the outcome.
* @param session - the session whose ledger holds the turn's events.
* @param endEvent - the turn/end event that closes the turn.
* @returns the reconstructed episode.
*/
function reconstructTurn(session, endEvent) {
	const turn = endEvent.data.turn;
	const events = session.events;
	const texts = [];
	const actions = [];
	const outcomes = [];
	let toolCallCount = 0;
	let failed = false;
	let selfReflexive = false;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "turn/start" && event.data.turn === turn) break;
		const data = event.data;
		switch (event.type) {
			case "user/message": {
				if (data.source?.kind !== "user") break;
				const text = data.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ");
				if (text !== void 0 && text.trim().length > 0) texts.push(text);
				break;
			}
			case "assistant/message": {
				const text = data.message?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ");
				if (text !== void 0 && text.trim().length > 0) outcomes.push(text);
				break;
			}
			case "tool/call": {
				toolCallCount += 1;
				const name = typeof data.name === "string" ? data.name : "?";
				actions.push(`调用 ${name}`);
				if (selfReflexiveArguments(name, typeof data.arguments === "string" ? data.arguments : "")) selfReflexive = true;
				break;
			}
			case "tool/result":
				if (data.message?.content?.some((block) => block.isError === true) === true || data.error !== void 0) failed = true;
				break;
			default: break;
		}
	}
	const reason = endEvent.data.reason?.kind ?? "unknown";
	const outcome = [...outcomes, `轮次结束（${reason}）`].join(" ").trim();
	return {
		situation: texts.reverse().join(" ").slice(0, 800),
		action: actions.reverse().join("；").slice(0, 800) || outcome.slice(0, 300),
		outcome: outcome.slice(0, 800),
		toolCallCount,
		failed,
		turnId: turn,
		selfReflexive
	};
}
/** Whether one tool call plausibly terminates or restarts the agent's own host
* process — the self-reflexive operations after which this session's ledger
* cannot observe what actually happened (the causal chain is broken at the
* kill point; any later "restart" was done by an external actor). Checks the
* tool arguments (the JSON string) for process-termination signatures, since
* the tool NAME alone (e.g. `pwsh`) is shared with countless benign calls. */
function selfReflexiveArguments(name, argumentsJson) {
	if (name === "pwsh" || name === "shell" || name === "bash") return /Stop-Process|kill\b|taskkill|net stop|restart.*service|Restart-|sc stop/i.test(argumentsJson);
	return /(^|_)(stop|kill|restart|terminate)(_|$)/i.test(name);
}
/**
* Mount the pipeline: construct the service (its `Service` base registers
* `ctx.cognitivePipeline` on this fiber's context), wait for the store, then
* register the dynamic taxonomy prompt section and (unless disabled) the
* model tools. When `autoAccumulate` is enabled, also listen for completed
* turns and run each through the accumulation gate.
* @param ctx - plugin context carrying llm/tools/systemPrompt.
* @param config - pipeline configuration; every field optional.
*/
async function apply(ctx, config = {}) {
	const service = new CognitivePipelineService(ctx, config);
	await service.ready();
	ctx.systemPrompt.section({
		name: "cognition:taxonomy",
		order: 300,
		text: () => service.taxonomyPrefix()
	});
	if (service.resolved.enabled) registerPipelineTools(ctx, service);
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		const reason = event.data.reason?.kind;
		if (reason !== "completed" && reason !== "error") return;
		const episode = reconstructTurn(session, event);
		if (episode.situation.trim().length === 0) return;
		service.summarizeTurn(session.id, episode).then((summary) => {
			if (summary !== null) session.append("cognition/turn-summary", summary);
		}).catch((error) => {
			ctx.logger.warn(`cognitive-pipeline: turn summary failed: ${String(error)}`);
		});
	});
}
//#endregion
export { ACTION_VECTOR_DIM, CognitiveLoopRegistry, CognitivePipelineService, Config, DEFAULT_DISEQUILIBRIUM_MIN_SAMPLES, DEFAULT_DISEQUILIBRIUM_Z, OUTCOME_VECTOR_DIM, SYMPTOM_MARKERS, UTILITY_SLOTS, actionVector, apply, cosine, disequilibriumOf, findToolCallEvidence, hashToken, inject, isPositiveOutcome, isTaskRestatement, name, normalize, outcomePolarity, outcomeVector, reconstructTurn, refineRetrieval, refineRetrievalFallback, signatureHash, situationVector, symptomOverlap, tokenize, utilityScore, variantConvergence };
