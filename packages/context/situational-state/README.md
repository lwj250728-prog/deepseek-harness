# @deepseek-ai/dsh-situational-state

English | [中文](README.zh.md)

Self-scheduled situational state chain: the main-session agent commits periodic situation snapshots and decides the next update time; the latest node is injected at every agent pre-step as ongoing model context.

This is the **active** counterpart of the passive prewarm mechanism in [`@deepseek-ai/dsh-cognitive-inject`](../cognitive-inject/README.md): the agent itself maintains a persisted linked list of "what this session is doing", and the model sees the latest committed node at every step — so short follow-up messages are judged against the real ongoing context rather than in isolation.

## What the plugin does

```
主会话 agent 调用 situational_state_commit
  → 追加链表节点 { nodeId, seq, prevNodeId, createdAt, situation, sessionId, nextUpdateAfterMs }
  → 持久化到 $DSH_HOME/situational-state/chain.json
  → 若自决了 next_update_seconds：定时唤醒（agent 空闲时 followup 提醒）
  → 每个 agent pre-step：注入最近节点为【情景状态参考】上下文（每节点一次）
```

- **自决调度 (self-decided scheduling)** — the agent passes `next_update_seconds` when it commits; the plugin arms a maintenance wake that opens a normal later turn (`agent.runMaintenance` + `followup`, the same pattern `dsh-schedule` uses) after the delay, never steering or interrupting the current conversation. The agent decides at each checkpoint whether to commit again, reschedule, or ignore.
- **持久链表 (persisted linked list)** — each node carries its timestamp, situation text, a back pointer (`prevNodeId`), the source session (`sessionId`), and the self-decided delay. The document lives at `$DSH_HOME/situational-state/chain.json` and survives restarts, so "what the session was doing" outlives the process.
- **每步注入 (per-step injection)** — at every `agent/pre-step`, the plugin reads the chain head and, if it has not already injected that node for this agent, appends one sourced `user/message` `【情景状态参考】` block. The model sees the committed situation with an age label (刚刚 / N 分钟前 / N 小时前) and its source session. When the head is stale (older than `staleUpdateGuideMs`), the block carries an explicit update guide prompting `situational_state_commit`.
- **检查点唤醒 (checkpoint wakes)** — a committed `nextUpdateAfterMs` arms a maintenance timer; at wake time the agent receives a `【情景状态检查点】` follow-up and decides whether the situation still warrants an update.
- **详情轨迹账本 (situational trace ledger)** — every commit and every (cooldown-suppressed) injection is appended to `$DSH_HOME/situational-state/trace.jsonl` with the session, session position (`seq:`), node id, kind (`inject`/`commit`), situation excerpt, and timestamp. `situational_state_trace` queries the ledger by session/node/kind or returns the newest N, so "which situational state was surfaced where in which session" is traceable instead of a single vague summary.

## Quick start

```yaml
- id: situational-state
  name: '@deepseek-ai/dsh-situational-state'
  config:
    # root: 默认 $DSH_HOME/situational-state
    # minUpdateDelayMs: 60000
    # busyRetryMs: 60000
    # injectEnabled: true
```

The plugin needs `fs` (chain persistence), `agents` (wake routing), and `tools` (tool registration); mount those before it in the composition.

## Service API (`ctx.situationalState`)

| Member | Semantics |
|---|---|
| `head(): Promise<SituationalStateNode \| undefined>` | The latest committed node, or undefined for an empty chain. |
| `list(): Promise<readonly SituationalStateNode[]>` | Every committed node, oldest first. |
| `activationStats(now?): Promise<ActivationStats>` | Each node's activation span as chain head (from its commit until replaced / until now) plus the cumulative active time. |
| `commit(agent, situation, nextUpdateAfterMs?): Promise<SituationalStateCommitResult>` | Append one node; with a delay, arm the wake timer. Clamps below `minUpdateDelayMs`. |

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | `$DSH_HOME/situational-state` | Storage directory for `chain.json`. |
| `minUpdateDelayMs` | `60000` | Minimum self-decided next-update delay; shorter requests clamp up. |
| `busyRetryMs` | `60000` | Retry delay when a wake finds the agent busy. |
| `injectEnabled` | `true` | False disables pre-step injection while keeping the tool and service. |
| `staleUpdateGuideMs` | `3600000` (1h) | When the chain head is older than this, the injected context carries an explicit "consider updating" guide (see per-step injection). |

## The commit tool

`situational_state_commit` registers one model tool; its schema flows into the system-prompt tool catalog. Executing it appends a chain node and returns `{ ok, nodeId, seq, prevNodeId, chainLength, nextUpdateScheduled }`. The node automatically carries the committing session id (`sessionId`) for source attribution and ownership audit on the shared chain.

## The trace tool

`situational_state_trace` queries the trace ledger (`trace.jsonl`). Filter by `session_id`, `node_id`, `kind` (`inject`/`commit`), or cap with `limit` (default 20, max 100); entries come back newest-first with `traceId`, `seq`, `nodeId`, `kind`, `sessionId`, `situation`, `createdAt`, and `position` (session `seq:` where the event happened).

## Model Experience

### The injected reference block

#### What the model sees

At an eligible step the model receives one additional plugin-sourced `user/message`:

##### Reference block

```markdown
【情景状态参考】当前会话最近提交的情景状态（刚刚）［会话 session-abc］：正在验证 DSH 情景状态链表机制
```

Nodes read from a legacy chain document (no `sessionId` field) omit the session label.

#### Token effect

One short block per committed node per agent (each node injects once, guarded by a per-agent last-injected map). Zero tokens when the chain is empty.

#### KV Cache effect

The block is a step-local `user/message` appended after the claimed prompt; it does not affect prefix reuse.

## Known Limitations and Deferred Work

- **Injection is model-visible context, not retrieval input** — the committed node reaches the model as a `user/message` block; it is not yet folded into `cognitive-inject`'s situation-vector retrieval as a query axis. Wired both ways would give the retrieval the long-horizon situation (the `exp_123` long-situation gap) and the model the short message.
- **Wake is a reminder, not a forced commit** — the agent may ignore a checkpoint; no state is written unless `situational_state_commit` runs again.
- **Per-agent wakes, shared chain (with source attribution)** — the chain document is global to the deployment root; agents key their wake timers by id but share the node list, and every node carries its committing `sessionId` for attribution. Per-session or per-workspace chains are deferred.
- **No chain compaction** — nodes accumulate forever; a bounded tail or summarization (reusing the compaction seam) is deferred.
