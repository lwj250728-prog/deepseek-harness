# @deepseek-ai/dsh-cognitive-orchestration

[English](README.md) | 中文

DeepSeek Harness 的任务级认知编排。它包装一个子任务 provider（默认 `spawn`），在任务开始前把认知流水线中**相关的 SAR 经验注入子任务提示词**，在子任务结束后把**结果回写为新经验**。启用策略层后，"是否注入"与"是否入库"这两个决策本身也会作为 `policy:*` 经验被预测与校准 —— 系统学习何时该使用记忆，而不是硬编码触发规则。

这是 [`@deepseek-ai/dsh-cognitive-pipeline`](../cognitive-pipeline/README.md) 的任务执行端：流水线是记忆，本包是任务边界上的记忆消费者/生产者。主对话提示词保持干净——不做每轮注入。

## 工作原理

```
主对话(调度器)                子任务(只做任务本身)
   │  ctx.subagents.start('cognitive', …)
   ▼
cognitive provider ──注入相关SAR经验──▶ delegate provider → child
   │                                          │
   └──────────child settles (run.result)──────┘
              ▼
        决策 policy:update → remember/report → 认知流水线
```

- **注入（start 前）** — wrapper 从子任务提示词概括任务，按行动向量相似度检索相关经验，并把 `【认知经验参考】` 块前置到子任务提示词。策略模式下注入决策先经 `policy:inject` 预测，达到 `policyDecisionThreshold` 才放行。
- **回写（settle 后）** — 子任务的输出与停止原因成为一条新经验（任务调度/子任务执行/结果）。策略模式下是否入库由 `policy:update` 预测决定；随后用观测到的结果质量校准该预测。
- **决策学习** — `policy:*` 预测就是流水线中的普通预测：积累足够后，`rebuild_taxonomy` 会把它们重聚类成学到的"何时注入 / 何时入库"策略。

## 安装

```yaml
# in a dsh profile cordis.patch.yml, AFTER the delegate provider row
- insert:
    - id: cognitive-orchestration
      name: '@deepseek-ai/dsh-cognitive-orchestration'
      config:
        delegate: spawn        # wrap the spawn provider
        providerName: cognitive
        policyEnabled: true
```

子任务通过 wrapper 名称启动：

```ts ignore-check
ctx.subagents.start('cognitive', { prompt, parent, signal })
```

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `delegate` | `spawn` | 被包装的 delegate provider 名；须已注册 |
| `providerName` | `cognitive` | wrapper provider 的注册名 |
| `topK` | `3` | 最多注入多少条相关经验 |
| `minSimilarity` | `0.3` | 判定经验相关的最小行动向量相似度 |
| `policyEnabled` | `true` | 是否对注入/入库决策做预测与校准 |
| `policyDecisionThreshold` | `0.55` | 策略预测批准动作所需的最低概率 |

## Model Experience

### wrapper provider 与策略预测

#### What the model sees

插件在 `ctx.subagents` 上注册一个 `SubagentProvider`（默认名 `cognitive`）；经它启动的子任务在注入决策批准时会收到一个 `【认知经验参考】` 用户提示块，列出最多 `topK` 条相关历史经验。子任务看不到策略层——注入与入库决策是引擎侧的 `ctx.cognitivePipeline.predict` 预测，经 `report_outcome` 校准。本包不改变主对话的 System Prompt。

#### Token effect

条件性：每次批准的注入会给子任务提示词增加约 100–300 token；父对话无每轮成本。策略预测不增加提示词 token（属引擎侧调用）。

#### KV Cache effect

父请求前缀不受影响（本包不注册任何 prompt 小节）。子任务提示词随任务与注入内容变化，子任务侧前缀复用依赖任务本身；本包不拥有独立稳定的 prompt 小节。

## Known Limitations and Deferred Work

- **仅一次性委派** — 可延续子任务（`startContinuable`）不经包装：其注入点在 continuation 管理器而非 provider，因此会绕过本层。接线延续路径留待后续。
- **确定性检索** — 经验检索使用流水线的哈希行动向量；同义词感知检索（真实 embedding）随流水线自身的 embedding 接缝一并延后。
- **无 LLM 路由时策略决策向 0.5 收缩** — 没有模型路由时 `policy:*` 预测使用频次基线，早期决策偏保守；配置 LLM 路由（在认知流水线上）会使其更敏锐。
- **无按会话记忆隔离** — 经验对流水线存储是全局的；按智能体/按会话的命名空间留待后续。
