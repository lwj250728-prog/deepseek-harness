# Agent Note：否决先于策略提升——固化策略的注入准确性

Status: implemented

[English](2026-08-26-veto-before-strategy-promotion.md) | 中文

## 问题

认知注入预热路径在模板7否决门**之前**就提升固化策略，且提升规则只信任链成员资格。两个缺陷在线上 `web` 部署中同时触发，产出一条无关注入。

观测到的痕迹（`injections.jsonl` 的 `inject_75`）：用户问"为什么经验注入还不准确"——消息含静态触发词"错误"，检索命中 `exp_69`（同一次噪声注入问题的记录）与 `exp_182`（一次先前固化策略实跑验证的记录），`solidifiedStrategyForHits` Channel 1 看到 `exp_182.chainId === 'chain-restart'`，匹配该链固化的策略（`solidified-1`，目标域"重启"）并返回它。插件随即注入【固化策略 重启】块并返回——下方的否决门从未运行。按设计应收到预热会话情境的 LLM 精排官根本没被咨询。正确的检索结果（两条直接相关的经验）被一条无关的重启策略替换。

两个根因：

1. **提升绕过了否决门。** 策略分支（链匹配 → 注入 STRATEGY → 返回）位于 `vetoTopCandidates` **之上**，LLM 路由（存在时）从未判定策略是否真正适用。链链接被视为自证的、可迁移的。
2. **Channel 1 只信任链成员资格。** 任一命中的 `chainId` 匹配 `sourceChainId` 即返回策略，不校验策略目标域是否与当前情境相关。仅"记录该链过往验证"的经验（其情境关于策略本身、而非任务）也会把策略提升出上下文。

## 决策

`packages/context/cognitive-inject/src/index.ts` 两处修改：

- **否决先于提升（B2）。** 策略分支移到 `vetoTopCandidates` 之下。否决门现在先对每个检索候选运行；提升只考虑**通过否决**的命中。全部否决的步骤与普通参考注入一样完全抑制策略注入，`recordInjection` 在两个分支都记录 accepted 的 `expIds`。
- **Channel 1 的目标域闸门（B1）。** `solidifiedStrategyForHits` Channel 1 现在除链链接外还要求 `strategy.goalDomain.length > 0 && situation.includes(strategy.goalDomain)`——Channel 2 早已应用的同一相关性闸门。情境未携带目标域的链链接命中落入普通参考块，而非提升策略。

新顺序：触发门 → 检索 → 否决（带预热上下文）→ 对 accepted 命中做策略提升 → 参考块。

## 备选方案

**在检索层排除链成员。** 否决：链链接经验（`exp_69`、`exp_182`）对用户的问题确实是正确的召回；缺陷在*提升*，不在*检索*。过滤它们会在扔掉错误答案的同时扔掉正确答案。

**仅当存在链链接时运行否决。** 否决：否决是一般适用性判定；让它以链链接为条件，会为所有非链提升路径重新引入绕过，并维持两套平行的准入标准。

## 后果

- 情境匹配策略目标域且通过否决的链链接命中，仍注入 STRATEGY 块（收敛形态在真正适用时胜出）；其余链链接命中落入普通参考块；被否决的链命中不注入任何内容。
- LLM 精排官的预热增强情境（`【当前会话正在进行】…【当前消息】…`）现在同样管辖策略提升，闭合了让"验证记录"经验提升重启策略的设计缺口。
- 成本：一个分支重排加 `solidifiedStrategyForHits` 一个条件；两个新包测试（`does not promote a strategy when the chain-linked hit lacks the goal domain`、`vetoes a chain-linked candidate before any strategy promotion`），既有策略优先测试仍通过（24 个测试）。README（EN/ZH）流程更新为 否决 → 提升 → 参考。
- 同类缺陷现在以线上观察到的精确失败形态被测试覆盖：仅记录链的链链接命中、以及被路由否决的目标域匹配命中。

## 验证

`pnpm vitest run packages/context/cognitive-inject` — 24 通过。`tsc -p packages/context/cognitive-inject` 与变更文件的 `oxlint` — 干净。`web` 部署的线上确认待 DSH 宿主重启（profile patch 在宿主平面挂载管线）。
