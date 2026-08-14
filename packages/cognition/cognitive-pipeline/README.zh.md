# @deepseek-ai/dsh-cognitive-pipeline

[English](README.md) | 中文

预测误差驱动的动态认知架构（DCA-PED）的 DeepSeek Harness 插件实现。它赋予智能体一套不断演化的经验记忆：经历被编码为**情境-行动-结果（SAR）**三元组，按行动相似度检索，以**五层校准的置信区间**预测，由**真实反馈**修正，并定期在**效用空间**中重新聚类——只有当沙盒回测证明误差下降 ≥15% 时，重建才会胜出并被回写。

本包实现了 DCA-PED 设计文档——`01-计划书.md`（技术计划书）、`02-技术报告.md`（TR-2026-08-11-V2.0）与提示词库 `03-提示词模板库.md`，以自包含的 Cordis 插件形式落地；每一步模型辅助都有确定性降级方案。

## 插件做什么

```
输入(新经验) → remember_experience → SAR提取 → 向量化(action + outcome)
拟行动       → predict_outcome → 热环路: OOD检测 → 熟路(校准) / 陌路(临时工作区)
实际结果     → report_outcome → 误差计算 → 校准统计 / 临时策略反馈 / 紧急局部修补
离线         → rebuild_taxonomy → 冷环路: 采样 → 效用聚类 → 因果锚定 → 沙盒回测 → 回写
会话         → cognition:taxonomy prompt section (认知框架摘要动态注入)
```

- **热环路 (hot loop)** — `predict_outcome`：检索 Top-K 相似历史行动，计算 OOD 信号（`Top1 相似度 < 0.65`、`Top1-Top3 方差 < 0.1`（模糊，且非近完美匹配）、`Strangeness Index > 1.5`），路由到熟路（五层校准）或陌路（临时工作区试探策略，带 `⚠️ 全新现象` 标记）。
- **五层校准 (five-layer calibration)** — 频次先验注入、样本量收缩 `P_cal = (k/(k+50))·P_raw + (50/(k+50))·0.5`、最小宽度 80% 置信区间、对抗性风险因素列举、以及对照经验准确率的终身校准桶修正。
- **临时工作区 (episodic scratchpad)** — OOD 行动创建带 24 小时 TTL 的 `temp_strategies`；命中即复用；命中 ≥3 次且正反馈率 ≥66.7% 时晋升为下轮重建的标签种子。
- **冷环路 (cold loop)** — `rebuild_taxonomy`：时间衰减加权采样 `W = e^(−λ·Δt)`（≤15% 样本量，另有 32 条下限），在**结果效用向量**上做层次凝聚聚类（效用优先于语义），LLM 因果锚定并施加 ≥3 条证据的硬约束（后端核验两两距离 ≤ 0.85，幻觉簇被驳回），对最新 20% 做沙盒回测，要求 `Δerr ≤ −0.15` 才原子回写。
- **动态认知摘要** — 通过验收的重建会压缩为分类法摘要注入会话 System Prompt（附录B），使热环路建议反映流水线已学到的规律。

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

模型即可使用五个工具：

- `remember_experience` — 把原始经历编码进 SAR 记忆。
- `predict_outcome` — 带 80% 区间的校准预测；返回 `prediction_id`。
- `report_outcome` — 回填实际结果（可选 `outcome_quality` 0–10），更新校准统计，极端误差触发紧急局部修补。
- `rebuild_taxonomy` — 运行冷环路（`scope: local | global`）。
- `inspect_memory` — 查看经验、簇、校准桶与分类法摘要。

## 服务 API

加载插件后提供 `ctx.cognitivePipeline`：

```ts ignore-check
ctx.cognitivePipeline.remember({ rawText })                       // → { expId, sar }
ctx.cognitivePipeline.predict({ situation, action, context? })   // → PredictResult
ctx.cognitivePipeline.report({ predictionId, actualOutcome, outcomeQuality? }) // → FeedbackResult
ctx.cognitivePipeline.rebuild('local' | 'global')                // → RebuildResult
ctx.cognitivePipeline.inspect()                                  // → InspectResult
ctx.cognitivePipeline.taxonomyPrefix()                           // → prompt prefix text
ctx.cognitivePipeline.store                                      // → CognitiveStore (public)
```

每个方法接受可选的 `{ sessionId?, signal? }` 调用上下文，用于模型辅助步骤。所有持久化状态位于 `root` 下（`experiences.jsonl`、`predictions.jsonl`、`temp_strategies.jsonl`、`clusters.json`、`calibration.json`、`taxonomy.json`）。

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
| `decayLambda` | `0.01` | 冷环路时间衰减（每天） |
| `minDecayWeight` | `0.1` | 参与采样的最小衰减权重 |
| `predictionErrorThreshold` | `0.3` | 进入重建样本所需的预测误差 |
| `maxSampleRatio` | `0.15` | 冷环路采样上限（32 条下限） |
| `evidenceMinCount` | `3` | 证据硬约束最小条数 |
| `evidenceMaxDistance` | `0.85` | 证据两两距离上限 |
| `sandboxImprovement` | `0.15` | 要求的验证误差降幅 |
| `validationRatio` | `0.2` | 采样集中的验证切片比例 |
| `clusterMergeCosine` | `0.4` | 凝聚聚类合并余弦 |
| `clusterMatchCosine` | `0.3` | 簇归属余弦 |
| `emergencyErrorThreshold` | `0.8` | 触发局部修补的反馈误差 |

## 确定性降级

每一步 LLM 都是尽力而为的增强（设计附录C）：

- **SAR 提取** — 未配置路由或调用失败时按句切分、效用取中性值。
- **OOD 复核** — 信任纯数学判定。
- **校准** — 纯频次先验加宽区间。
- **重构** — 由效用均值确定性命名簇。

失败以 `warn` 级别记录；模型故障不会让流水线抛错。

## Model Experience

### 五个模型工具

#### What the model sees

`remember_experience`、`predict_outcome`、`report_outcome`、`rebuild_taxonomy`、`inspect_memory` 通过 `ctx.tools.register` + `defineTool` 注册，其 schema 自动进入 System Prompt 工具目录；每个工具返回一个规范 JSON 值，由 `output.render` 镜像为模型可见文本；定义于 `src/tools.ts` 的工具描述是本包唯一的静态提示词文本（在生成的 [tool catalog](../../../docs/tool-catalog.md) 中展示）。

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

- **哈希向量而非学习型向量** — 行动/结果向量是确定性的词袋哈希，无法像设计中的 `all-MiniLM-L6-v2` / `text-embedding-3-small` 那样理解同义词；真实嵌入模型的 provider 接缝留待后续。
- **簇级累计误差未在线跟踪** — `cumPredictionError` 在回写时由成员误差重算；设计中的"簇生命周期内触发局部修补"仅由紧急反馈阈值近似。
- **无定时冷环路** — 设计中的每日/每周调度目前是手动 `rebuild_taxonomy` 调用；基于 `@deepseek-ai/cordis-plugin-timer` 的定时行留待后续。
- **无 PostgreSQL/pgvector 后端** — 存储为 JSONL+JSON 文件；设计中的 pgvector 单库方案在出现规模需求前不做。
- **单流水线实例** — 每次插件挂载一个存储；不支持多租户或按智能体分库。
- **观测结果质量** — 反馈依赖模型给出的 `outcome_quality` 或 LLM SAR 提取；两者皆缺时观测值回落到中性 0.5 基线，会低估误差。
