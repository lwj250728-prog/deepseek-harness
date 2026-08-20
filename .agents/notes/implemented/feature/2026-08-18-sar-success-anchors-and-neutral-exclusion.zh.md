# Agent Note：SAR 记忆的成功锚点与中性经验排除

Status: implemented

[English](2026-08-18-sar-success-anchors-and-neutral-exclusion.md) | 中文

## 问题

认知流水线的 SAR 记忆只在预测误差上产生学习信号，而实际上只有 bug 级失败会积累高误差并进入冷环路，这由两个机制共同造成。其一，`isPositiveOutcome` 是二值的 `utilityScore > 0` 判定，中性 5/5/5 提取被静默计入**负向**——热环频次先验（`samples.length - positive`）、冷环基准率与回测标签全部如此，"无信号"伪装成了"失败"。其二，冷环采样（`sample()`）只准入有误差的经验（`predictionError >= threshold || cumulativeError > 0`），已证实的成功经验永远成不了簇，尽管设计的效用空间聚类轴本就偏向它们。记忆在退化为 bug 库，成功策略对预测不可见。

## 决策

**结果极性改为三态。** `outcomePolarity(utility)` 按复合分符号返回 `'positive' | 'neutral' | 'negative'`；零分（含 5/5/5）为 `neutral`。热环 M/N 先验只统计正、负经验；冷环基准率、回测标签与回滚失败晋升全部跳过中性经验，不再把"无信号"计为失败。

**冷环路也采样成功经验。** `sample()` 在经验有误差**或**其 `utilityScore` 达到新配置 `successUtilityThreshold`（默认 3）时准入。被验收的簇新增 `polarity: 'success' | 'risk'` 字段（由候选簇平均效用判定）与 `situationCentroid`（成员情境向量的归一化质心）。分类法规则继承极性，`cognition:taxonomy` 提示词前缀以 `✅成功` / `⚠️风险` 标记渲染规则。store 加载路径对缺少新字段的旧行做归一化。

**预测返回成功参照。** `predict_outcome` 把当前情境与成功簇的情境质心匹配（`successReferenceThreshold`，默认 0.4），返回最近的命中作为 `success_reference`（簇 id/名称/规则/效用区间），并同时追加到建议文本。回答"该情境最接近哪个已验证策略"，而不只是"这次会不会失败"。

**反馈质量必填、提取从严。** `report_outcome` 要求提供 `outcome_quality`（0–10）；流水线不再从结果文本推断中性 0.5 基线。SAR 提取要求三个效用字段齐全且有限；部分评分降级为确定性兜底（带 warn），而非静默产出假 5/5/5。

## 备选方案

**保留二值极性、调低采样阈值。** 否决：调低 `predictionErrorThreshold` 引入的是噪声而非成功经验，不构成正向锚定轴；三态拆分是让中性记录不再污染先验与回测的最小改动。

**用独立的"锚点表"记成功。** 否决：设计本就在效用空间聚类，成功经验应进同一张簇表并带极性字段；第二张表会复制冷环路。

**只返回概率，让模型自行推理成功。** 否决：检索轴是行动相似度，无法浮现情境级成功模式；显式 `success_reference` 才让记忆在陌生情境中可执行。

**保留 `outcome_quality` 可选与 LLM 提取兜底。** 否决：兜底对常规任务产出中性 5/5/5，正是本次要修复的信号塌缩；必填质量让成功反馈在工具边界上响亮可见。

## 后果

中性经验不再压低校准先验或虚增回测误差；已证实的成功经验进入聚类并成为可参照的策略；分类法摘要区分成功规则与风险规则。`predict_outcome` 新增 `success_reference` 字段，`report_outcome` 缺 `outcome_quality` 时响亮失败。磁盘上的 `clusters.json` 与 `taxonomy.json` 新增 `polarity` / `situationCentroid` 字段，加载时对旧行归一化；invariant 新增情境质心维度检查。`successUtilityThreshold` 与 `successReferenceThreshold` 遵循无硬编码可调参规则，可在部署时配置。保留的已知限制：哈希词袋向量、无定时冷环路、单存储实例。
