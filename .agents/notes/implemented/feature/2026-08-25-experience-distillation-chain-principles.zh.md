# Agent Note: 经验蒸馏——从经验到一条可复用规则

Status: implemented

[English](2026-08-25-experience-distillation-chain-principles.md) | 中文

## Problem

EvolveR 对照（外部调研，[SAR 原则审视](../../proposed/architecture/2026-08-19-sar-principle-review.md) 语境）指出我们最缺的高价值借鉴点：EvolveR 从积累的经验中蒸馏出可复用的决策原则，而我们的链只把成员经验折叠成结构摘要（`assembleChain` 坍缩例行成功、保留失败步）。一条已巩固的链回答的是"这段目标执行发生了什么"，从不回答"下次我应该遵循什么规则"——从原子到原则的跳跃留给了每次检索时的模型，每次都用原始素材重新推导同一课。

## Decision

链巩固新增蒸馏步：存在显式 LLM 路由时，`consolidateChain` 请路由从链成员中提炼**一条**可复用决策规则——失败优先，再成功——存为 `ChainExperience.distilledPrinciple`（模板 9，`DISTILL_SYSTEM_PROMPT` + `frameDistillInput`，`distillChainPrinciple` 辅助函数）。原则比折叠摘要更短、可直接作为指引复用；`chainExpose` 与 `chainTreeExpose` 以 `原则：…` 呈现，使注入路径能浮出该规则。

"宁缺毋滥"纪律在四点生效：

- **无路由 → 不蒸馏。** 无显式路由时链保持为折叠摘要，绝不产生编造规则（与变体生成、跳转词提议相同的安全降级）。
- **尊重 null 判定。** 提示词要求路由在成员过少或无共同模式时输出 `principle: null`；null 结果存为"无原则"，而非占位符。
- **成员集门控。** `assembleChain` 仅在成员集未变（成员 id 相同、顺序相同）时携带上一版 `distilledPrinciple`；成员集变化即丢弃过期规则，让调用方从新原子重新蒸馏——绝不用旧原则对抗已变化的证据。`consolidateChain` 只在首次巩固或成员集变化时运行蒸馏，未变链保留其规则（或已判定的"无共同模式"结论）而不在每个空闲周期产生新的 LLM 调用。
- **有界。** 路由产出的原则读取时截断至 120 字符、推理截断至 200 字符；提示词本身要求 ≤ 60 字。

## Alternatives considered

**在冷环路分类法重建内蒸馏。** 拒绝：分类法簇是效用空间分组，不是目标锚定的序列；原则属于链——链已携带因果骨架与目标锚点，正是规则可迁移意义的来源。

**每次巩固都重新蒸馏。** 拒绝：离线巩固以空闲节奏运行；未变链会为相同原子每周期烧一次 LLM 调用。成员集门控让廉价路径确定性化、昂贵路径由证据驱动。

**每条链存多条原则（每失败模式一条）。** 拒绝：EvolveR 类比是每段经历一条蒸馏课；列表会模糊原则与已存在的步骤列表的边界。一链一原则保持注入面锐利。

## Consequences

- `ChainExperience` 新增 `distilledPrinciple?`；本改动前写入的 `chains.json` 行加载时无此字段（旧行缺席）。
- 新增一个提示模板（模板 9，与跳转词提议模板共享编号——两者都是 `prompts.ts`/`llm.ts` 的第九模板槽）、一个带确定性无路由回退的 llm 辅助函数，以及两条巩固路径（`consolidateChain` 与 `chain` 对象种类投影）共享的 `assembleChain` 成员集携带逻辑。
- 模型可见的链面现在携带蒸馏规则（`chainExpose`/`chainTreeExpose`），检索到的链直接教导原则，而非只叙述发生了什么。
- 中英 `ChainExperience` type-equiv 文档与两个包 README 在同一次改动中更新；既有 158 条测试外加五条新蒸馏测试覆盖路由/无路由、成员集携带、成员集重蒸馏与离线巩固路径。
