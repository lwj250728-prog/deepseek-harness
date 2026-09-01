# @deepseek-ai/dsh-situational-state

[English](README.md) | 中文

自决情景状态链表：主会话 agent 定期提交情景快照并自决下一次更新时间；每个 agent pre-step 注入最近节点作为持续模型上下文。

这是 [`@deepseek-ai/dsh-cognitive-inject`](../cognitive-inject/README.md) 被动预热（prewarm）机制的**主动**对应物：agent 自己维护一条持久链表记录"本会话正在做什么"，模型在每一步看到最近提交的节点——短小的后续消息得以对照真实进行中的上下文判断，而非孤立看待。

## 插件行为

```
主会话 agent 调用 situational_state_commit
  → 追加链表节点 { nodeId, seq, prevNodeId, createdAt, situation, sessionId, nextUpdateAfterMs }
  → 持久化到 $DSH_HOME/situational-state/chain.json
  → 若自决了 next_update_seconds：定时唤醒（agent 空闲时 followup 提醒）
  → 每个 agent pre-step：注入最近节点为【情景状态参考】上下文（每节点一次）
```

- **自决调度** — agent 提交时传入 `next_update_seconds`；插件按该间隔武装一次维护唤醒（`agent.runMaintenance` + `followup`，与 `dsh-schedule` 同一模式），到点打开一个普通后续轮次，绝不打断当前对话。agent 在每次检查点自决是否再次提交、改期或忽略。
- **持久链表** — 每个节点携带时间戳、情景文本、前驱指针（`prevNodeId`）、来源会话（`sessionId`）与自决延迟。文档位于 `$DSH_HOME/situational-state/chain.json`，重启后仍在——"会话在做什么"比进程活得更久。
- **每步注入** — 每个 `agent/pre-step`，插件读取链表头，若该节点尚未为本 agent 注入过，则追加一条带来源的 `user/message`【情景状态参考】块。模型看到带年龄标签（刚刚 / N 分钟前 / N 小时前）与来源会话的已提交情景。当链头过期（超过 `staleUpdateGuideMs`），块内附带显式更新引导，提示调用 `situational_state_commit`。
- **检查点唤醒** — 提交的 `nextUpdateAfterMs` 武装一个维护定时器；到点时 agent 收到【情景状态检查点】后续消息，自决情景是否仍值得更新。
- **详情轨迹账本** — 每次提交与每次（冷却抑制后的）注入都追加到 `$DSH_HOME/situational-state/trace.jsonl`，记录会话、会话位置（`seq:`）、节点 id、类型（`inject`/`commit`）、情景摘录与时间戳。`situational_state_trace` 按会话/节点/类型查询账本或返回最近 N 条——"哪个情景状态在哪个会话哪一步被注入/提交"可回溯，而非一条笼统概括。

## 快速开始

```yaml
- id: situational-state
  name: '@deepseek-ai/dsh-situational-state'
  config:
    # root: 默认 $DSH_HOME/situational-state
    # minUpdateDelayMs: 60000
    # busyRetryMs: 60000
    # injectEnabled: true
```

插件需要 `fs`（链表持久化）、`agents`（唤醒路由）、`tools`（工具注册）；在装配中置于这些之前。

## 服务 API（`ctx.situationalState`）

| 成员 | 语义 |
|---|---|
| `head(): Promise<SituationalStateNode \| undefined>` | 最近提交的节点；空链表返回 undefined。 |
| `list(): Promise<readonly SituationalStateNode[]>` | 全部已提交节点，从旧到新。 |
| `activationStats(now?): Promise<ActivationStats>` | 每个节点作为链头的激活区间（提交起至被替换/至今）与累计激活时长。 |
| `commit(agent, situation, nextUpdateAfterMs?): Promise<SituationalStateCommitResult>` | 追加一个节点；带延迟时武装唤醒定时器。低于 `minUpdateDelayMs` 会向上钳制。 |

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `root` | `$DSH_HOME/situational-state` | `chain.json` 存储目录。 |
| `minUpdateDelayMs` | `60000` | 自决下一次更新的最短间隔；更短的请求向上钳制。 |
| `busyRetryMs` | `60000` | 唤醒时 agent 正忙的重试延迟。 |
| `injectEnabled` | `true` | false 关闭 pre-step 注入，保留工具与服务。 |
| `staleUpdateGuideMs` | `3600000`（1 小时） | 链头年龄超过该值时，注入上下文附带显式"考虑更新"引导（见每步注入）。 |

## 提交工具

`situational_state_commit` 注册一个模型工具；其 schema 自动进入系统提示工具目录。执行会追加一个链表节点并返回 `{ ok, nodeId, seq, prevNodeId, chainLength, nextUpdateScheduled }`。节点自动携带提交者的会话 id（`sessionId`），供共享链上的来源标注与归属审计。

## 轨迹查询工具

`situational_state_trace` 查询轨迹账本（`trace.jsonl`）。可按 `session_id`、`node_id`、`kind`（`inject`/`commit`）过滤，或用 `limit` 限制条数（默认 20，最大 100）；结果最新在前，含 `traceId`、`seq`、`nodeId`、`kind`、`sessionId`、`situation`、`createdAt` 与 `position`（事件发生的会话 `seq:`）。

## 模型体验

### 注入的参考块

#### 模型看到什么

在符合条件的步骤，模型收到一条额外的插件来源 `user/message`：

##### 参考块

```markdown
【情景状态参考】当前会话最近提交的情景状态（刚刚）［会话 session-abc］：正在验证 DSH 情景状态链表机制
```

节点来自旧格式链文档（无 `sessionId` 字段）时省略会话标注。

#### Token 影响

每个提交节点每个 agent 注入一次（由 per-agent 最近注入映射守卫）。链表为空时零 token。

#### KV Cache 影响

块是步骤局部的 `user/message`，追加在已认领提示之后；不影响前缀复用。

## 已知限制与待办

- **注入是模型可见上下文，而非检索输入** — 提交节点以 `user/message` 块到达模型；尚未折入 `cognitive-inject` 的情境向量检索作为查询轴。双向打通后，检索获得长时程情境（exp_123 的长情境缺口），模型获得短消息。
- **唤醒是提醒而非强制提交** — agent 可忽略检查点；不再次调用 `situational_state_commit` 就不会写状态。
- **per-agent 唤醒，共享链表（带来源标注）** — 链表文档对部署根目录全局；agent 按 id 键控自己的唤醒定时器，但共享节点列表，每个节点携带提交者 `sessionId` 以便归属。按会话或按工作区隔离留待后续。
- **无链表压缩** — 节点无限累积；有界尾部或摘要化（复用压缩接缝）留待后续。
