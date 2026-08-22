# @deepseek-ai/dsh-cognitive-pipeline

[English](README.md) | 中文

预测误差驱动的动态认知架构（DCA-PED）的 DeepSeek Harness 插件实现。它赋予智能体一套不断演化的经验记忆：经历被编码为**情境-行动-结果（SAR）**三元组，按行动相似度检索，以**五层校准的置信区间**预测，由**真实反馈**修正，并定期在**效用空间**中重新聚类——只有当沙盒回测证明误差下降 ≥15% 时，重建才会胜出并被回写。

本包实现了 DCA-PED 设计文档——`01-计划书.md`（技术计划书）、`02-技术报告.md`（TR-2026-08-11-V2.0）与提示词库 `03-提示词模板库.md`，以自包含的 Cordis 插件形式落地；每一步模型辅助都有确定性降级方案。

## 插件做什么

```
输入(新经验) → remember_experience → SAR提取 → 向量化(action + outcome)
拟行动       → predict_outcome → 热环路: OOD检测 → 熟路(校准) / 陌路(临时工作区)
实际结果     → report_outcome → 误差计算 + 标签回填 → 校准统计 / 临时策略反馈 / 紧急局部修补
离线         → rebuild_taxonomy → 冷环路: 采样 → 效用聚类 → 因果锚定 → 沙盒回测 → 回写
会话         → cognition:taxonomy prompt section (认知框架摘要动态注入)
```

- **热环路 (hot loop)** — `predict_outcome`：按**多通道融合**检索 Top-K 相似历史行动（语义行动余弦 + 情境结构余弦 + 症状签名子串重叠 + 失败标记查询下的结果极性优先），通道权重由**反馈误差驱动学习**（持久化于 `channel_weights.json`；按 `|calibrated − observed|` 做 EWMA——"什么样的相似才可迁移"从反馈中长出，而非固定代理）。新颖性判定看每条命中的**最强通道分**（`channelMax`）：语义余弦被稀释时，情境或症状通道强命中不会把历史误判为无关。计算 OOD 信号（`Top1 相似度 < 0.65`、`Top1-Top3 方差 < 0.1`（模糊，且非近完美匹配）、`Strangeness Index > 1.5`），路由到熟路（五层校准）或陌路（临时工作区试探策略，带 `⚠️ 全新现象` 标记）。当确定性路由低置信（情境路由余量薄或 OOD 呈 flat-top）时，**LLM 精排**（模板7）阅读融合候选、剔除真正不适用的 top 命中（有界 `refineMaxDrops` 条，建议文本标注 `检索复核`），不再裸信余弦排序。两条分支都会把当前情境与已证实的成功簇匹配，最近的命中以 `success_reference` 策略返回。检索还会**咨询分类体系**（`taxonomy_context`）：查询情境对每个簇的情境质心打分，报告 SAR 在该处是否有覆盖（`covered` / `gap` / `no-taxonomy`）、命中的簇、以及路由余量（最佳减次佳余弦）。余量过薄时建议文本会提示 `路由置信低`，告诉模型确定性路由不可靠——管线的结构层自我认知参与检索决策。
- **五层校准 (five-layer calibration)** — 频次先验注入、样本量收缩 `P_cal = (k/(k+50))·P_raw + (50/(k+50))·0.5`、最小宽度 80% 置信区间、对抗性风险因素列举、以及对照经验准确率的终身校准桶修正。先验只统计净效用为正或为负的经验；中性 5/5/5 经验不计入任何一边。
- **临时工作区 (episodic scratchpad)** — OOD 行动创建带 24 小时 TTL 的 `temp_strategies`；命中即复用；命中 ≥3 次且正反馈率 ≥66.7% 时晋升为下轮重建的标签种子。**主动探索 (active exploration, scheme 2)** 为其加上纪律：novel 试探创建 scratchpad 时，只有**动作可逆**（安全闸：`exploreRiskWords` 中的删除/发布/推送等不可逆标记永不消耗预算）且当日预算（`exploreDailyBudget`）未耗尽才计入探索配额，建议文本标注预算（`主动探索（今日预算 n/N）`，或 `探索预算已耗尽` / `动作不可逆`），并在 `exploration.json` 追踪结果：晋升的 scratchpad 是成功探索、过期的是失败——形成 inspect 可见的 ROI 账本。账本随后被**实战验证**：之后每次复用该 scratchpad 的预测，都会把真实的 `|calibrated − observed|` 误差按 EWMA（`exploreValidationLearningRate`）折回条目的 `validatedError`；一旦该 EWMA 低于或越过 `exploreValidationErrorThreshold`，条目翻转为 `validated`/`refuted`。晋升说明一个策略**成为了记忆**；验证说明复用它**确实降低了预测误差**——用与所有其他预测相同的尺子闭合元认知环路。
- **模拟经验 (simulated experiences)** — `simulate_experience` 在真实测试成本高或不可行时，经 LLM 路由生成仅检索、未验证的候选经验。在真实反馈按**证据替代模型**验证前不塑造任何簇：一次决定性反馈快速晋升为临时 verified，累计证据升级为永久 verified，临时态遇矛盾回滚，未验证模拟在兜底 TTL 后过期。这镜像人类的现实监控——心理预演只提供建议，真做过后才成为记忆。
- **参考经验 (reference experiences)** — `reference_experience` 是第二个冷启动来源：不推演假设结果，而是检索最相似的既有历史，请 LLM 路由归纳其**共同模式**（"这类情境通常如何解决"），并把该泛化写为仅检索的模拟候选，走与 `simulate_experience` 相同的证据替代生命周期。它从已发生的事泛化而非猜测可能发生的事；当没有锚点通过过滤器（低于 `referenceMinSimilarity`，或仅有模拟经验）时，派生被确定性拒绝（不调用 LLM）——参考经验绝不无中生有。
- **验收清单 (acceptance criteria)** — `define_acceptance_check` / `verify_claim` / `update_acceptance_check` / `propose_acceptance_update`：可复用的验证规范，智能体在把声明当作既成事实前对其执行审计。审计应用 trigger 标记出现在声明或其情境文本中的活跃准则；声明携带证据（非空）即满足、否则违规——管线判断的是证据的**存在性**，而非证据的**真伪**（它无法验证自己的声明；真伪由解析结果与用户裁决）。当声明携带外部见证者锚点时，改由**见证者机械裁决**：`log_anchor` 读取执行会话日志中该工具的最近一次调用，把 `tool/result` 与期望比对；`file_anchor` 在审计时读取工作区文件并核验声明的文件状态期望（`exists`/`missing`/`matches-hash`/`contains`，不可读即失败关闭）；`command_anchor` 经 shell 能力接缝（`ctx.shell`）运行所给命令并按退出码结算（`exit-zero`/`exit-nonzero`，超时或信号终止即失败关闭，只观测退出码——需装配 shell 能力并配置 `acceptanceCommandExecution: true`，默认关闭，因为模型提供的命令是真实的执行面）。缺失或失配即违规，与自述证据无关，锚定到见证者的声明无法仅凭自述过关（见证者是非自指见证）。准则持有只增不减的证据账本（`acceptance.json`）：invoked/passed/violated 计数，外加把见证者背书的通过与自述通过分开的 `machineVerifiedCount`，以及 `cumulativeError`/`errorFoldCount`——任何被审计且违规的已解析预测，其 `|calibrated − observed|` 都会折入对应准则——"未经验证的声明"与所有预测用同一把尺子计量（验收回流）。准则通过经验自我修订：`propose_acceptance_update` 请 LLM 路由为证据证明失败的准则（偏离闸门已越过）提出重写或退役提案，**经验闸门**只应用那些指向失败准则、携带理由且携带具体重写文本的提案——路由提出，经验闸门裁决；没有失败准则或没有显式路由时，什么都不提案、不应用。准则的 invoked 计数越过 `acceptanceMinEvidenceCount` 且违规率越过 `acceptanceDeviationThreshold` 时标记 `rework_needed` 并记录一条偏离元经验，让冷环路能聚类管线自身的验收失败模式。准则可改写（`revision` 递增）但账本不可清零；退役即冻结——审计不再应用它，账本永不重置。`inspect_memory` 报告账本与改写/退役候选。
- **元认知环路 (meta-cognition loops, 造新环路)** — 此前三层特殊经验层（policy:* 委派决策、主动探索、探索验证）背后的可复用抽象：**具名环路**是一条声明式决策流，其选择与所有预测走**同一把** `predict`/`report` 校准尺子。注册一个环路（`register_loop` 工具或 `ctx.cognitivePipeline.registerLoop`），再用 `decideLoop`/`feedbackLoop` 驱动——环路的 situation 带 `loop:<name>` 前缀，其决策历史自成可检索、可聚合的特殊经验层。`inspect_memory` 按环路报告预测/已解析计数与平均 `|calibrated − observed|` 误差，使新声明的"何时 X"决策（压缩、重试、询问用户）可学习而非硬编码——第三层的意志与第一层用同一把尺子度量。环路还可以更进一步**真正行动**：注册 `MetaLoopSpec.execution`（一组 `LoopExecutionSink`）即把环路变成决策到执行的桥梁。sink 是执行层的端点，接收 `LoopExecutionRequest` 并**按自己的纪律**受理——环路只批准，执行与否由 sink 决定（预算、安全闸、可逆性），拒绝时返回理由字符串。`decideAndExecute(name, decision, situation, threshold?)` 执行一次决策：校准概率越过阈值时，把决策提交给每个已声明的 sink，并**为每个 sink 持久化一条回执**（id 为 `<predictionId>@<target>`——决策与执行之间的审计链接）。执行结果随后**回流**：`settleExecution(receiptId, outcomeText, outcomeQuality, status?)` 标记终态（executed/failed；未知、被拒、重复结算的回执全部响亮报错），并**经由同一 report 路径解析该决策预测**——执行层实际做了什么，就用同一把 |calibrated − observed| 尺子校准当初请求它的环路。`inspect_memory` 暴露完整的 决策→申请→受理/拒绝→结算 链条（近期回执）与按环路的执行计数（executed/refused/failed），使环路不仅作为被校准的决策流可观测，更作为真实执行的驱动者可观测。内置的 `createExplorationSink()`（`hot-engine.explore-create`）是现成范例：它执行主动探索的安全闸与每日预算纪律，受理时创建 scratchpad 与探索条目（对 predict 调用自身 novel 分支可能已创建的条目做去重优先），可选入队自主任务——**意志提交申请，执行层按纪律受理，回执结算回流**，新环路真正驱动执行，而不只是给建议。
- **冷环路 (cold loop)** — `rebuild_taxonomy`：时间衰减加权采样 `W = e^(−λ·Δt)`（≤15% 样本量，另有 32 条下限）**叠加已证实的成功经验**（效用分 ≥ `successUtilityThreshold`），在**结果效用向量**上做层次凝聚聚类（效用优先于语义），LLM 因果锚定并施加 ≥3 条证据的硬约束（后端核验两两距离 ≤ 0.85，幻觉簇被驳回；确定性回退分组在写回前必须通过**同一道**证据闸门——被驳回的簇绝不会被复活），对最新 20% 做沙盒回测。重构提示词锚定**情境-策略配对的重现模式**，因此前提分化（例如同一行动在"新手教学"前提 vs "资深直推"前提下的不同策略）**随经验累积自动涌现**，无需任何硬编码的行动者/环境字段——一个模式需在训练切片内累积 ≥3 条实例才能自成簇。重构路由是随机的，产出无验证簇的抽样会按 `reconstructRetries` 有界重试。验收度量**连续 materialGain 轴**——分类法预测的效用对每条经验真实收益（归一化到 [0,1]）——使验收度量对齐流水线第一性原理的 `|calibrated − observed|` 误差，而非 0/1 极性分桶。验收分**两个区间**：首次建簇（无已存簇）以空视图 baseRate 基线为参照，只要未被测得"更差"（`Δerr ≤ 0`）即被接受——因为 15% 余量在年轻 store 的 2-3 条验证切片上统计上无意义、只会阻塞冷启动；迭代保持相对既有分类的 `Δerr ≤ −0.15` 门槛。当带标签的验证切片低于 `minValidationCount` 时，重建**暂缓**并给出可诊断的原因，而非按优劣拒绝。携带真实 materialGain 标签的经验（反馈回填后的已反馈经验）参与分母；未验证模拟经验永不进入采样——只有 verified 或 provisional 样本可塑造簇。每个被验收的簇携带 `success`/`risk` 极性，以及**由证据经验推导的情境质心**（而非全部结果相似成员——那会把前提分化簇的质心稀释成混合物），分类法规则也带有极性标注。结构化 LLM 模板调用（SAR/OOD/校准/重构）显式请求 `reasoningEffort: off`——思维链会耗尽小型 token 预算并饿死 JSON 答案。
- **动态认知摘要** — 通过验收的重建会压缩为分类法摘要注入会话 System Prompt（附录B），使热环路建议反映流水线已学到的规律。
- **跳转词 (trigger-jump lexicon)** — 注入触发词之上的联想层：`learn_trigger_jumps` 从经验库构建"命中即开门"的关联词（发版 → 发布）。共现跳转是确定性的——与某触发词在 ≥ `triggerJumpEvidenceMin` 条不同重要经验中共现的 token 成为指向它的跳转，归一化到 [0.3, 1]，按触发词与总量设上限；有显式 LLM 路由时模板 9 额外提出同义变体（卡住↔卡壳），零证据保守权重入表。每条跳转携带其证据与实测效用（引用环：注入时 `recordInjection`、轮次结束时 `settleInjectionCitations` 把"注入经验是否真被引用"折回跳转的 hit/cited 账本），重建时强化——被引用的跳转加权、从未被引用的剪枝。门中每条跳转的贡献按 `triggerJumpWeightScale`（默认 0.5）缩放，单条弱跳转永不单独开门。
- **经验链 (goal-anchored chains)** — 第五个派生认知对象，也是**派生对象抽象**（`CognitionObjectKind`：project/persist/measure/reinforce/expose——新增特殊经验层只需一次声明，通用驱动 `rebuild_cognition_object` 服务所有种类）的首个声明式实例。`consolidate_chain` 从打上链标签的经验（经验上的 `chainId`/`parentNodeId`/`sequence`）组装目标锚定的因果骨架：失败步与跨 agent 委派节点（回执）保持结构步，例行成功步坍缩为有界摘要（记忆组织在惊喜周围），链级引用率（注入链被模型引用即 cited）度量整段目标执行是否值得记忆。链在离线时巩固（目标完成/agent 空闲——巩固的工程对应），由 `chainMinMembers` 证据闸门把关，持久化于 `chains.json`，经 `chainExpose` 以结构化步骤呈现给注入路径。链构成**目标树**：委派子目标的链挂在委派链之下（其根成员引用父链回执），`chainChildren`/`chainTreeExpose` 暴露该结构以支持目标结构化扩散——命中父链时可下钻到子目标结果。
- **链模式 (chain patterns)** — 第六个派生认知对象，也是该抽象的首个**递归**消费者：模式从链表投影，正如链从经验投影。共享结构签名（粗粒度目标域 + 步极性序列，如 `发布:失败,失败,成功`）的链聚合为一种周期性目标执行模式（TOPS 类比：从相似 MOP 提炼跨情境主题模式），由 `chainPatternMinMembers` 闸门把关，持久化于 `chain_patterns.json`。度量效用从成员链的引用统计经同一通用 measure 分派聚合，因此模式的引用率可追溯地度量分组是否有用。用 `rebuild_cognition_object('chain-pattern')` 重建。
- **上下游探索 (chain-neighbor exploration)** — `explore_chain` 从散落、从未打标签的经验仍在文本中携带的因果承接结构里恢复链条：给定一条经验，找出上游邻居（其 OUTCOME 语义延续进该经验的 SITUATION）与下游邻居（其 SITUATION 被该经验的 OUTCOME 延续）。这是对显式 `chain_id` 标签的补充性推断链发现（exp_73 的另一半）：当原子从未打标签时，目标结构仍可从文本中被建议出来。探索永不写入——候选只是供调用方打标签并巩固的建议。

## 快速开始

装配该插件（`web` profile 已内置）：

```yaml
- id: cognitive-pipeline
  name: '@deepseek-ai/dsh-cognitive-pipeline'
  config:
    root: !!js dshHomePath('cognitive-pipeline')
    # Optional LLM assists: SAR extraction, OOD review, calibration,
    # reconstruction. When omitted (or when the route is unreachable), every
    # step degrades to deterministic math.
    provider: deepseek
    model: deepseek-v4-flash
```

模型即可使用十五个工具：

- `remember_experience` — 把原始经历编码进 SAR 记忆（效用字段必填；提取不完整时降级为兜底，而非伪造中性分）。可选 `chain_id` 标签——所属目标执行的目标追踪号——使离线巩固能据此组装目标锚定链。
- `simulate_experience` — 在真实测试成本高或不可行时，经 LLM 路由生成仅检索的模拟经验。
- `reference_experience` — 把最相似历史经验的共同模式泛化为仅检索的参考候选（冷启动在线泛化）；无相似锚点时拒绝派生。
- `predict_outcome` — 带 80% 区间的校准预测；返回 `prediction_id`，当情境命中已证实的成功簇时附带 `success_reference` 策略。
- `report_outcome` — 回填实际结果并**必须提供** `outcome_quality`（0–10），更新校准统计、把质量回填为绑定经验的效用标签、驱动模拟经验验证，极端误差触发紧急局部修补。
- `rebuild_taxonomy` — 运行冷环路（`scope: local | global`）。
- `inspect_memory` — 查看经验、簇、校准桶与分类法摘要。
- `register_loop` — 注册具名元认知环路，其决策与所有预测走同一把 predict/report 校准尺子。
- `define_acceptance_check` — 定义可复用验证规范（准则 + 触发标记 + 证据提示），账本为空且不可清零。
- `verify_claim` — 用活跃准则审计一条声明；提供 `log_anchor`（会话日志）、`file_anchor`（工作区磁盘）或 `command_anchor`（真实退出码）可让外部见证者机械裁决而非依赖自述证据。
- `update_acceptance_check` — 改写活跃准则或将其退役（退役即冻结）。
- `propose_acceptance_update` — 请 LLM 路由为证据证明失败的准则提出重写/退役提案，只应用通过经验闸门的提案（准则从证据中自我修订）。
- `learn_trigger_jumps` — 从经验库学习触发跳转词表（共现 + 可选 LLM 同义变体）并按引用率强化；积累有意义的新经验后调用。
- `consolidate_chain` — 从打上链标签的经验组装一条目标锚定的链为因果骨架（失败步与委派节点结构步、例行坍缩）；带标签的目标执行完成时调用。
- `rebuild_cognition_object` — 通用驱动任意已注册的派生认知对象生命周期（当前为 `chain` 与 `chain-pattern`）；新种类只需一次声明，此驱动服务所有种类。
- `explore_chain` — 按 outcome→situation 承接探索一条经验的上下游邻居（为散落经验库准备的推断链发现）；探索永不写入——打标签并巩固才成链。

## 服务 API

加载插件后提供 `ctx.cognitivePipeline`：

```ts ignore-check
ctx.cognitivePipeline.remember({ rawText })                       // → { expId, sar }
ctx.cognitivePipeline.simulate({ situation, action })            // → { expId, sar } (simulated)
ctx.cognitivePipeline.deriveReference({ situation, action })     // → { expId, sar } (simulated) | null
ctx.cognitivePipeline.predict({ situation, action, context? })   // → PredictResult
ctx.cognitivePipeline.report({ predictionId, actualOutcome, outcomeQuality }) // → FeedbackResult
ctx.cognitivePipeline.rebuild('local' | 'global')                // → RebuildResult
ctx.cognitivePipeline.inspect()                                  // → InspectResult
ctx.cognitivePipeline.taxonomyPrefix()                           // → prompt prefix text
ctx.cognitivePipeline.store                                      // → CognitiveStore (public)
// meta-cognition loops
ctx.cognitivePipeline.registerLoop(spec)                         // → void (spec may declare execution: LoopExecutionSink[])
ctx.cognitivePipeline.decideLoop(name, decision, situation)      // → PredictResult (decision only)
ctx.cognitivePipeline.feedbackLoop(name, predictionId, actualOutcome, outcomeQuality) // → FeedbackResult
ctx.cognitivePipeline.decideAndExecute(name, decision, situation, threshold?) // → { decision, approved, executions }
ctx.cognitivePipeline.settleExecution(receiptId, outcomeText, outcomeQuality, status?) // → { receipt, feedback }
ctx.cognitivePipeline.createExplorationSink()                    // → LoopExecutionSink ('hot-engine.explore-create')
ctx.cognitivePipeline.loopList()                                 // → readonly MetaLoopSpec[]
// acceptance criteria
ctx.cognitivePipeline.defineAcceptanceCheck({ criterion, trigger, evidenceHint }) // → AcceptanceCheck
ctx.cognitivePipeline.auditClaim({ claim, situation, evidence?, predictionId? })  // → ClaimAudit
ctx.cognitivePipeline.updateAcceptanceCheck({ checkId, criterion?, evidenceHint?, retire? }) // → AcceptanceCheck
ctx.cognitivePipeline.acceptanceChecks()                         // → readonly AcceptanceCheck[]
ctx.cognitivePipeline.claimAudits(limit?)                        // → readonly ClaimAudit[]
// chains + chain patterns
ctx.cognitivePipeline.consolidateChain(chainId, goal?)           // → ChainExperience | null
ctx.cognitivePipeline.chainExpose(chainId)                       // → string | null
ctx.cognitivePipeline.chainChildren(chainId)                     // → readonly string[]
ctx.cognitivePipeline.chainTreeExpose(chainId, depth?)           // → string | null
ctx.cognitivePipeline.rebuildCognitionObject(name)               // → { kind, built, pruned }
```

每个方法接受可选的 `{ sessionId?, signal? }` 调用上下文，用于模型辅助步骤。所有持久化状态位于 `root` 下（`experiences.jsonl`、`predictions.jsonl`、`temp_strategies.jsonl`、`clusters.json`、`calibration.json`、`taxonomy.json`、`acceptance.json`、`claim_audits.jsonl`、`chains.json`、`chain_patterns.json`）。

## 配置

全部字段可选；引擎默认值遵循设计文档。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | `<dshHome>/cognitive-pipeline` | 存储目录 |
| `provider` / `model` | 未设置 | 显式 LLM 路由（须成对设置） |
| `enabled` | `true` | 为 false 时保留服务但不注册工具 |
| `topK` | `10` | 热环路检索深度 |
| `oodSimThreshold` | `0.65` | OOD 低相似度阈值 |
| `oodFlatThreshold` | `0.1` | OOD 平坦度（Top1-Top3）阈值 |
| `oodSiThreshold` | `1.5` | OOD 陌生指数阈值 |
| `tempStrategyTtlMs` | `86_400_000` | 临时策略 TTL |
| `tempStrategyHitThreshold` | `3` | 晋升所需命中次数 |
| `tempStrategyPositiveRatio` | `0.667` | 晋升所需正反馈率 |
| `tempStrategyMatchThreshold` | `0.5` | 临时策略模糊匹配余弦 |
| `shrinkageAlpha` | `50` | 第二层无知先验强度 |
| `minConfidenceIntervalWidth` | `0.2` | 80% 区间最小宽度 |
| `successReferenceThreshold` | `0.4` | 返回成功簇参照所需的情境余弦阈值 |
| `coverageThreshold` | `0.3` | 情境质心余弦低于此值视为分类覆盖缺口（taxonomy_context） |
| `retrievalFailureMargin` | `0.1` | 熟路预测路由余量低于此值即自动 sar 化为检索失败元经验 |
| `decayLambda` | `0.01` | 冷环路时间衰减（每天） |
| `minDecayWeight` | `0.1` | 参与采样的最小衰减权重 |
| `predictionErrorThreshold` | `0.3` | 进入重建样本所需的预测误差 |
| `successUtilityThreshold` | `3` | 成功经验进入重建样本所需的效用分 |
| `maxSampleRatio` | `0.15` | 冷环路采样上限（32 条下限） |
| `evidenceMinCount` | `3` | 证据硬约束最小条数 |
| `evidenceMaxDistance` | `0.85` | 证据两两距离上限 |
| `sandboxImprovement` | `0.15` | 相对既有分类（迭代）重建所需的验证误差降幅；无已存簇的首次构建以"不劣于基线"（`Δerr ≤ 0`）验收 |
| `validationRatio` | `0.2` | 采样集中的验证切片比例 |
| `reconstructRetries` | `2` | 单次随机 LLM 重构抽样无验证簇时的额外抽样次数 |
| `minValidationCount` | `3` | 验收重建所需的最小带标签验证样本数；低于此值重建暂缓而非拒绝 |
| `clusterMergeCosine` | `0.4` | 凝聚聚类合并余弦 |
| `clusterMatchCosine` | `0.3` | 簇归属余弦 |
| `emergencyErrorThreshold` | `0.8` | 触发局部修补的反馈误差 |
| `simulationFastTrackThreshold` | `0.8` | 单次反馈使模拟快速晋升为临时 verified 所需的证据权重 |
| `simulationPermanentThreshold` | `2` | 永久 verified 所需的累计证据分 |
| `simulationTtlMs` | `2_592_000_000` | 未验证模拟过期的兜底 TTL（30 天） |
| `autoAccumulate` | `false` | 完成的轮次自动沉淀为经验，由 LLM 路由判断是否值得（纯聊天不进入门） |
| `acceptanceMinEvidenceCount` | `3` | 准则违规率可触发重写并记录偏离元经验所需的最小审计次数 |
| `acceptanceDeviationThreshold` | `0.5` | 违规率（violated/invoked）达到或超过此值即在该次审计标记重写 |
| `acceptanceCommandExecution` | `false` | `verify_claim` 的命令锚点是否允许真实运行所给命令并按退出码结算；模型提供的命令是真实执行面，默认关闭 |
| `acceptanceCommandTimeoutMs` | `30000` | 单个命令锚点的硬超时；未结算的命令失败关闭 |
| `triggerJumpEvidenceMin` | `3` | 共现跳转所需的最小不同经验条数 |
| `triggerJumpMaxPerTrigger` | `20` | 单个触发词最多保留的跳转数 |
| `triggerJumpTotalCap` | `400` | 跳转表总量上限；权重最低者被丢弃 |
| `triggerJumpWeightScale` | `0.5` | 门中单条跳转贡献的缩放；单条弱跳转永不单独开门 |
| `triggerJumpCitationBoost` | `0.2` | 强化时按引用率加到跳转权重的增量 |
| `triggerJumpPruneRate` | `0.1` | 达到剪枝门槛后引用率低于此值的跳转被剪除 |
| `triggerJumpPruneHits` | `5` | 跳转可被剪枝所需的最少命中次数 |
| `chainMinMembers` | `3` | 目标锚定链可被巩固所需的最少不同成员经验数 |
| `chainPatternMinMembers` | `2` | 结构链模式可被投影所需的最少成员链数 |
| `exploreDailyBudget` | `3` | 主动探索每日预算（scheme 2）：每天有多少次可逆的 novel 试探计入探索配额 |
| `exploreRiskWords` | `['删除','清空','覆盖','发布','推送','rm','移除','迁移','重置','格式化']` | 不可逆动作标记；含任一标记的 novel 试探永不纳入主动探索预算（安全闸） |
| `exploreAutoDispatch` | `false` | 每次计入预算的可逆 novel 试探都入队一条自主探索任务（`exploration_tasks.json`）；调度会话拾取任务并把结果回写为经验（保守默认：仅显式开启才入队） |
| `exploreValidationLearningRate` | `0.3` | 将复用 scratchpad 的实战预测误差折回探索条目 `validatedError` 的 EWMA 步长 |
| `exploreValidationErrorThreshold` | `0.3` | 预测误差上限：复用误差低于它则验证探索有效（实战证明），达到或超过则判定无效 |
| `embedding` | 未设置 | 真实嵌入接缝（路线图 R3）：OpenAI 兼容 `/embeddings` 对象 `{ baseUrl?, model?, apiKeyEnv?, apiKey? }`（默认 `https://api.deepseek.com` / `deepseek-embedding` / `DEEPSEEK_API_KEY`）。启用后经验写入时存储行动嵌入，语义检索通道优先用嵌入余弦；无向量的查询/经验回退哈希余弦——端点不可达只是降级相似度，绝不破坏管线 |
| `referenceTopK` | `5` | 一次参考派生锚定的相似历史命中数 |
| `referenceMinSimilarity` | `0.3` | 历史命中作为参考派生锚点所需的最小双轴相似度；低于此值（或仅有模拟命中）时派生不调用 LLM 直接拒绝 |
| `channelLearningRate` | `0.2` | 反馈驱动的多通道检索权重 EWMA 步长 |
| `channelErrorThreshold` | `0.3` | 反馈误差低于此值奖励主通道、高于则惩罚 |
| `refineMaxDrops` | `2` | 单次低置信预测中 LLM 精排的有界剔除上限 |

## 确定性降级

每一步 LLM 都是尽力而为的增强（设计附录C）：

- **SAR 提取** — 未配置路由或调用失败时按句切分、效用取中性值；LLM 提示词与兜底路径都会把可观测的失败症状（挂起/超时/编译失败等）写进情境，使后续相似失败可按其症状签名被检索到。
- **OOD 复核** — 信任纯数学判定。
- **校准** — 纯频次先验加宽区间。
- **重构** — 由效用均值确定性命名簇。

失败以 `warn` 级别记录；模型故障不会让流水线抛错。

## Model Experience

### 十五个模型工具

#### What the model sees

`remember_experience`、`simulate_experience`、`reference_experience`、`predict_outcome`、`report_outcome`、`rebuild_taxonomy`、`inspect_memory`、`register_loop`、`define_acceptance_check`、`verify_claim`、`update_acceptance_check`、`propose_acceptance_update`、`learn_trigger_jumps`、`consolidate_chain`、`rebuild_cognition_object`、`explore_chain` 通过 `ctx.tools.register` + `defineTool` 注册，其 schema 自动进入 System Prompt 工具目录；每个工具返回一个规范 JSON 值，由 `output.render` 镜像为模型可见文本；定义于 `src/tools.ts` 的工具描述是本包唯一的静态提示词文本（在生成的 [tool catalog](../../../docs/tool-catalog.md) 中展示）。

#### Token effect

条件性、由模型调用触发：注册后工具 schema 与描述为每个请求增加固定 token，模型调用工具时返回的 JSON 追加进该轮，且 `predict_outcome` 还会发起不进入会话提示词的辅助 LLM 调用（SAR/OOD/校准）。

#### KV Cache effect

工具 schema/描述前缀在两次重建之间保持稳定——通过验收的重建会重写下方 `cognition:taxonomy` 小节，这是本包可能使前缀复用失效的唯一变更。

### `cognition:taxonomy` System Prompt 小节

#### What the model sees

一个动态 System Prompt 小节（order 300），由当前分类法渲染：首次重建前声明系统处于冷启动，通过验收后渲染摘要与 Top-5 决策规则（附录B 前缀）；完整字面量由 `src/prompts.ts` 的 `cognitionPrefix()` 生成。

#### Token effect

条件性、小而有限：约 150–400 token（规则最多 5 条），随挂载该插件的每个会话、每个请求出现。

#### KV Cache effect

替换式：小节文本每次装配时按存储状态重渲染，`rebuild_taxonomy` 验收新分类法（版本递增）时变化，会使宿主缓存的前缀复用失效；工具目录小节不受影响。

## Known Limitations and Deferred Work

- **嵌入接缝仅限行动文本、写入时计算** — 真实嵌入通道（路线图 R3）在写入时嵌入行动文本，检索时优先用嵌入余弦；接缝启用前已写入的经验无向量（回退哈希），情境/症状/结果通道仍为哈希。旧经验惰性回填留待后续。
- **簇级累计误差未在线跟踪** — `cumPredictionError` 在回写时由成员误差重算；设计中的"簇生命周期内触发局部修补"仅由紧急反馈阈值近似。
- **无定时冷环路** — 设计中的每日/每周调度目前是手动 `rebuild_taxonomy` 调用；基于 `@deepseek-ai/cordis-plugin-timer` 的定时行留待后续。
- **无 PostgreSQL/pgvector 后端** — 存储为 JSONL+JSON 文件；设计中的 pgvector 单库方案在出现规模需求前不做。
- **单流水线实例** — 每次插件挂载一个存储；不支持多租户或按智能体分库。
- **验收准则只判证据存在性、不判真伪** — `verify_claim` 在声明携带证据时标记满足；管线刻意无法验证自己的声明，证据质量由解析结果与用户下游裁决。执行是观测式的：审计被记录、违规被计数，但声明是否被审计，取决于智能体是否选择调用 `verify_claim`。
- **命令锚点经 shell 能力接缝运行** — `command_anchor` 经 `ctx.shell`（组合中的 shell 执行器负责执行、沙箱策略与输出处理；管线只观测退出码）运行所给命令，由 `acceptanceCommandExecution`（默认 false）门控、`acceptanceCommandTimeoutMs` 限时。接缝必须已装配：组合中没有 shell 执行器时工具响亮失败（`SHELL_CAPABILITY_UNAVAILABLE`），绝不静默降级。
- **观测结果质量** — 反馈现在要求模型提供 `outcome_quality`（0–10）；流水线不再从结果文本推断中性基线，未提供质量分是响亮的工具错误，而非静默的 0.5。
