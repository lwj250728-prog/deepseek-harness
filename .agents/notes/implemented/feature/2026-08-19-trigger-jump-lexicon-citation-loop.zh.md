# Agent Note: 跳转词表与引用率强化环

Status: implemented

[English](2026-08-19-trigger-jump-lexicon-citation-loop.md) | 中文

## 问题

注入门（cognitive-inject）只按字面触发词开门：静态行为词与 SAR 派生关键词。字面匹配漏掉同义表达——"卡壳"不触发"卡住"、"发版"不触发"发布"——用户用不同措辞描述同一情境时，检索根本不会发生（门在检索前就关了）。用自由语义相似度放宽门，又会重新打开 exp_69 关上的噪声之门（0.41 弱字面命中）。需要的是一个联想层，其每一条都有账可查：从经验中的真实共现习得、以"它帮助触发的注入是否真被引用"度量、未被引用即被剪除。

## 决策

管线新增**跳转词表**与**引用率强化环**：

- **触发词表下沉到管线**（`src/triggers.ts`）：`STATIC_TRIGGERS`、`STOP_WORDS`、`importanceOf`、`deriveTriggerWords` 改为管线所有（词表是与分类法、验收账本同类的经验派生知识）；cognitive-inject 导入之。
- **`learn_trigger_jumps`**（工具 + 服务方法）确定性构建跳转表：对每条重要经验，文本中出现的每个触发词都与文本中其他非触发、非停用 token 关联——有方向（共现 token 指向触发词）。跳转须有 ≥ `triggerJumpEvidenceMin` 条不同经验背书，权重归一化到 [0.3, 1]，按触发词（`triggerJumpMaxPerTrigger`）与总量（`triggerJumpTotalCap`）设上限。派生触发 token **不**被排除在跳转候选之外：它们与跳转词共享经验词汇，跳转是在该 token 自身派生权重之上叠加指向更诊断性触发词的关联强度。有显式 LLM 路由时，模板 9 额外提出同义变体（卡住↔卡壳），零证据、保守权重入表——引用环就是它们的证据闸门。
- **引用率环（B）**：每次注入都被记录（`recordInjection`：expIds、触发来源、贡献的跳转词、会话），轮次结束时结算（`settleInjectionCitations`：该轮 assistant 文本引用了注入的 expId 即 cited）。结果折回贡献跳转词的 hit/cited 账本（`foldJumpCitation`）。
- **重建时强化**：`learn_trigger_jumps` 携带每条存活跳转的实测统计并强化——命中 ≥ `triggerJumpPruneHits` 且引用率 ≤ `triggerJumpPruneRate` 的跳转被剪除；引用率高的按 `rate × triggerJumpCitationBoost` 加权。跳转表持久化于 `trigger_jumps.json`，注入记录于 `injections.jsonl`。
- **门集成**：注入门新增跳转路由——跳转词按子串匹配（单字共现 token 与多字 LLM 变体一致处理），每条贡献按 `triggerJumpWeightScale`（默认 0.5）缩放，单条弱跳转永不单独开门（≥2 佐证）。`triggeredBy` 导出供测试与观测。

## 备选方案

**用自由语义相似度放宽门。** 否决：会重新打开 exp_69 的噪声之门——0.41 弱字面命中会进入触发侧，下游检索/否决门就成了替触发门干活。每条跳转必须携带证据（共现条数、重要性、或 LLM 理由）与实测效用。

**只靠 LLM 学习跳转。** 否决：无路由时门永远学不会（违反管线确定性兜底纪律）；共现免费、可测、永远可用。LLM 层只是其上的可选增强。

**把派生触发 token 排除出跳转候选。** 实现后否决：派生触发与跳转词共享经验词汇，排除规则在派生词表非空时把共现层清空（死代码）。派生 token 可作跳转词；跳转叠加关联强度而非复制派生路由。

**门中用 token 匹配跳转。** 否决：CJK 分词按字切分，多字 LLM 变体（卡壳）永远匹配不上；子串匹配对单字与多字跳转词统一处理。

## 后果

- 十三个模型工具（原十二）；两个新持久化表；注入门通过带证据权重与保守缩放的联想词开门。
- 引用率环让注入门可度量：hit/cited 账本是强化背后的真值，门学习哪些词真正有效、剪除其余——与预测校准、验收准则同一把证据尺子。
- 词表迁入管线包，cognitive-inject 不再自持触发词汇；深导入 `@deepseek-ai/dsh-cognitive-pipeline/src/triggers.ts` 是跨越点（包的 `./src/*` 导出覆盖它）。
- LLM 来源的跳转以零共现证据入表：其合法性是临时的，直到引用环验证（加权）或剪除。
