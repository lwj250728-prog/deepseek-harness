# Agent Note: 验收准则验证规范

Status: implemented

[English](2026-08-19-acceptance-criteria-verification-norms.md) | 中文

## 问题

管线的在线环路（`predict`/`report`）与离线环路（`rebuild`）校准预测、聚类经验，但没有任何机制把验证规范制度化：模型可以在没有证据的情况下把一条声明当作既成事实，而管线既不记录该声明的审计，也不计数违规，更不计量跳过验证的代价。自指边界使这件事比表面更难——管线无法判断自己声明的真伪，因此规范层只能观察证据的**存在性**，永远无法观察证据的**质量**（法官不能给自己的证词打分）。仓库自身对制度化验证的答案是可执行 gate（`AGENTS.md`：`test:coverage`、`verify-cordis-config`、`verify-agent-note-format`）；管线缺少对等的持久规范层。事实上，本包的文档 gate 在多个早期功能上线后就没有再跑过：生成的 cordis 目录仍显示 12 方法的服务，type-equivalence 块也早于当前的 `InspectResult`。

## 决策

管线新增验收准则能力：`define_acceptance_check` / `verify_claim` / `update_acceptance_check` 三个工具，加上服务方法 `defineAcceptanceCheck`、`auditClaim`、`updateAcceptanceCheck`、`acceptanceChecks`、`claimAudits`，持久化于两个新表（`acceptance.json`、`claim_audits.jsonl`）。

- 审计应用 trigger 标记出现在声明或其情境文本中的活跃准则；无适用准则的声明审计为 `not-applicable`，不触碰任何账本。声明携带证据（非空）即满足、否则违规——判定的是证据存在性，而非真伪。
- 准则持有只增不减的证据账本（invoked/passed/violated 外加 `cumulativeError`/`errorFoldCount`）。`report()` 把任何被审计且违规的已解析预测的 `|calibrated − observed|` 折入对应准则——"未经验证的声明"与所有预测用同一把尺子计量（验收回流）。
- 外部见证者锚点打破自述天花板：`verify_claim` 接受 `log_anchor`（`tool_name` + 期望成败）、`file_anchor`（路径 + `exists`/`missing`/`matches-hash`/`contains` 文件状态期望）与 `command_anchor`（命令行 + `exit-zero`/`exit-nonzero`）。工具层机械解析见证者——`findToolCallEvidence` 读取执行会话日志中该名字最近一次已结算的调用（`tool/result` 载荷形状与 `reconstructTurn` 一致），`verifyFileAnchor` 在审计时读取工作区文件（不可读即失败关闭），`verifyCommandAnchor` 经 shell 能力接缝（`ctx.shell`；组合中的执行器负责执行、沙箱策略与输出处理，管线只观测退出码，接缝缺失时以 `SHELL_CAPABILITY_UNAVAILABLE` 响亮失败——超时或信号终止即失败关闭，由默认关闭的 `acceptanceCommandExecution` 门控、`acceptanceCommandTimeoutMs` 限时）——由见证者裁决：锚点匹配即满足，缺失或失配即违规，与自述证据无关。审计记录锚点（统一为 `ClaimAnchor` 的 `anchor`）与是否由见证者背书（`anchorVerified`），准则另持 `machineVerifiedCount` 把见证者背书的通过与自述通过分开——管线现在可以度量自己的验收有多少建立在外部见证者之上。
- 准则通过经验自我修订（回答"管线能否自己设置验收标准"）：`propose_acceptance_update` 收集证据证明失败的活跃准则（偏离闸门已越过）及其证据账本、相关偏离元经验，请 LLM 路由（模板8）提出重写或退役提案，只应用**通过经验闸门**的提案——提案必须指向失败准则、携带理由、且重写必须携带具体文本。路由提出，经验闸门裁决；没有失败准则或没有显式路由时什么都不提案、不应用。应用的重写递增 revision；证据账本永不重置。
- 准则的 invoked 计数越过 `acceptanceMinEvidenceCount`（默认 3）且违规率越过 `acceptanceDeviationThreshold`（默认 0.5）时，在该次越过审计上标记 `reworkNeeded` 并记录一条偏离元经验，让冷环路能聚类管线自身的验收失败模式。
- 准则可改写（`revision` 递增）但账本不可清零；退役即冻结——审计不再应用它，账本永不重置（镜像已冻结的归档 Agent Note）。
- `inspect_memory` 报告账本（`checkCount`/`activeCount`/`retiredCount`/`invokedCount`/`passedCount`/`violatedCount`/`deviationRate`/`reworkCheckIds`）与近期审计。

## 备选方案

**用 LLM 复核判断证据质量。** 否决：管线给自己的声明真伪打分正是自指陷阱——第二次模型调用仍是同一 agent 家族在为自己作证。只有存在性可观测；真伪由解析结果与用户下游裁决。

**让 `report_outcome` 强制审计（拒绝未验证的反馈）。** 否决：`report_outcome` 不携带声明上下文（预测不是声明），硬性强制属于执行 agent 的纪律——管线的职责是记录、计数、回流，而不是拒绝。执行是观测式的，已记录为局限。

**把准则并入分类法重建。** 否决：准则是带有不可清零账本的规范，不是效用空间簇。分类法由重建整体替换，而验收账本必须在准则改写（`revision` 递增）后依然存在；独立只增表是唯一能保留证据的形态。

**只复用环路机制（`register_loop`）。** 否决：环路在 predict/report 尺子上校准*决策*，但不持久化任何规范工件；验收层需要带审计计数的持久清单，环路注册表提供不了。

## 后果

- 新增三个模型工具（共十一个）；两个新持久化表；`report()` 把预测误差折入违规准则；偏离闸门把偏离元经验喂给冷环路。
- 本包的文档 gate 重新跑通：重新生成 cordis 目录暴露并修复了既有的缺类型标注（`hot-engine.retrieveTopK`、`service.decideAndExecute`）与七个此前未登记的类型的文档缺失（`TurnEpisode`、`ExplorationTask`、`MetaLoopSpec`、`LoopExecutionSink`、`LoopExecutionReceipt`，外加 `AcceptanceCheck` 与 `ClaimAudit`），现已登记进类型链接映射与 type-equivalence 清单，并在子系统页记录。
- 执行保持观测式：声明只有在 agent 选择调用 `verify_claim` 时才会被审计；管线会计数并为跳过验证标价，但无法强制。有了外部见证者锚点，agent *选择*锚定的声明由日志或磁盘而非自述裁决——验收中机器见证的子集不再自指；未锚定的证据质量仍由结果与用户裁决，而非管线。
