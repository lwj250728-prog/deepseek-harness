# Agent Note: 数字生命复习调度器 v1——激活簿记 + 漂移复核

Status: implemented

[English](2026-09-03-review-scheduler-v1-activation-drift.md) | 中文

## 问题

记忆程序没有复习调度器：经验与固化策略写一次后从不被刻意重新浮现，基础性或高代价条目可能衰减到无用（"没人好好评估遗忘"——agent 记忆综述的缺口）；而环境已漂移的策略，可能以满激活持续自动注入过时、现已错误的步骤。

## 决策

v1 复习调度器随 `cognitive-pipeline` 交付，实现激活调节器规则（见[激活调节器提案](../../proposed/architecture/2026-09-03-review-scheduling-activation-regulator.md)）：

- 簿记：`Experience` 与 `SolidifiedStrategy` 记录携带可选 `lastReviewedAt`/`reviewCount`；`store.recordExperienceReview`/`recordStrategyReview` 刷新激活钟并拉长下一间隔。
- 到期判定（`review-schedule.ts`，已导出）：间隔 = baseMs × 2^reviewCount（封顶 30 天）；高代价负经验（materialGain ≥ 6 且 energyCost ≥ 5）提前复习（×0.5）；rework 标记的策略**恒到期**——有效性轴与激活正交。
- 漂移复核（`runStrategyReviewPass`，挂离线巩固空闲节拍）：到期的策略（每次至多 3 条、单策略 ≥10 分钟冷却）对其 `verificationAnchor` 重验——仅当 `acceptanceCommandExecution` 开启且锚点是 ASCII 命令行时才真实执行命令；否则本次重验记为"未验证"（只刷新时钟，绝不误判"锚点成立"）。`store.foldStrategyRecheck` 折叠判定：失败的重验记一次违规并**立即**标记 rework（锚点此刻已不成立——与历史使用比例无关）；通过的重验清除 rework 而不动计数；`hitCount` 永不被抬高——重验不是使用。
- 召回即复习接线：cognitive-inject 对每条**真正注入**模型的经验（原始路径与预输入回顾路径）记录一次复习——一次真实检索并浮现就是激活模型里的"使用"，因此调度器不再重复调度仍在被上下文使用的条目（被用条目的时钟刷新；到期集自然变成那些未被使用的条目）。

## 验证

`review-schedule.spec.ts`（12 绿）：间隔增长封顶、last-review 回退、高代价提前、久/新到期、复习后间隔拉长、rework 恒到期，以及 pass 行为——失败重验 → rework+违规且 hitCount 不动、通过重验清除 rework、pass 复核到期策略并刷新时钟而冷却挡住紧接的第二趟。管线全量套件除运营者既有 WIP spec 外保持全绿。

## 备选方案

- **按人类复习类别排日历课表**：提案中已否决——激活规则解释间隔，而非引进类别。
- **空闲时无条件执行锚点命令**：否决——命令执行保持在 `acceptanceCommandExecution` 门后；无法验证的重验只记录复习不给判定，不冒险误判通过。

## 后果

基础/高代价记忆现在有了感知衰减的再复习路径；坏掉的策略会被重验，而不是以满激活自动注入过时步骤。代价：pass 跑在巩固节拍上（默认至多每小时）；在部署开启命令执行前，重验判定多为"未验证"；经验级提取练习式复习（无匹配输入时的主动回想）仍是未来工作——召回即复习覆盖的是上下文仍够得着的经验，而非空闲练习。
