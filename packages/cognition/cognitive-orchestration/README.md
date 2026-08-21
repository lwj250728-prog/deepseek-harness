# @deepseek-ai/dsh-cognitive-orchestration

English | [中文](README.zh.md)

Task-level cognition orchestration for DeepSeek Harness. It wraps a subagent provider (default `spawn`) so that related SAR experiences from the cognitive pipeline are **injected into child prompts** before a task starts, and each settled child outcome is **written back** as a new experience. With the policy layer enabled, the *inject* and *record* decisions are themselves predicted and calibrated as `policy:*` experiences — the system learns when to use its memory, instead of hard-coding a trigger rule.

This is the task-execution counterpart of [`@deepseek-ai/dsh-cognitive-pipeline`](../cognitive-pipeline/README.md): the pipeline is the memory, this package is the memory consumer/producer at task boundaries. Main-conversation prompts stay clean — no per-turn injection.
## How it works

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

- **注入（start 前）** — the wrapper summarizes the task from the child prompt, retrieves related experiences by action-vector similarity, and prepends a `【认知经验参考】` block to the child prompt. In policy mode the inject decision is first predicted (`policy:inject`) and only approved at/above `policyDecisionThreshold`.
- **回写（settle 后）** — the child's output and stop reason become a new experience (`任务调度/子任务执行/结果`). In policy mode whether to record is predicted (`policy:update`); the prediction is then calibrated with the observed outcome quality. When the child session reports token accounting, the experience's outcome carries a one-line **token summary** (`token：输入 / 输出 / 缓存命中 / 缓存写入 / 推理`) summed from the child session's `assistant/message` usage — the cost of a delegation is remembered alongside the pattern.
- **委派捕获（tools/result）** — subagent tool calls that bypass the wrapped provider (the tool names in `delegationToolNames`, default `['subagent']`) are captured at `tools/result`: a `policy:delegate` prediction ("is delegating this task worth it") is calibrated against the actual outcome, and a `委派决策` experience (task, execution summary, outcome) is written back — including the token summary when the child session can be located (the newest session whose `parentSession` is the delegating agent). This gives **ordinary subagent delegations** the same learnable "when to delegate" strategy the wrapped provider already has, without requiring the cognitive provider.
- **委派执行环（loop-driven delegation）** — `createDelegationSink()` builds a ready-made `LoopExecutionSink` (`orchestration.delegate-create`) that turns a meta-cognition loop into a REAL delegator: when the loop's `decideAndExecute` approves, the sink enforces its own discipline — a daily budget (`delegateDailyBudget`), a concurrency cap (`delegateMaxConcurrent`), and an irreversible-operation safety gate (`delegateRiskWords`) — and on acceptance actually spawns a cognitive child with the decision as its task. When the child settles, the execution outcome flows back through `settleExecution` on the SAME `|calibrated − observed|` ruler (receipt `executed`/`failed`), and the delegation pattern is written back as a `委派决策` experience — the loop's 意志 submits the application, the execution layer admits it under discipline and truly executes. Attach it to a loop with `execution: [orchestrator.createDelegationSink()]` (a dedicated anchor session `cognitive-explorer` parents the child).
- **决策学习** — `policy:*` predictions are ordinary predictions in the pipeline: with enough of them, `rebuild_taxonomy` re-clusters them into learned "when to inject / when to record / when to delegate" strategies.
- **自主探索调度（跨会话执行）** — with `exploreEnabled` (default true), a timer polls `exploration_tasks.json` (the pipeline's autonomous task queue, fed by the pipeline's `explore()` API or `exploreAutoDispatch`) on `exploreIntervalMs`. Pending tasks are picked up — at most `exploreMaxConcurrent` at a time — marked `running`, and executed as **silent cognitive children** of a dedicated exploration anchor session (`cognitive-explorer`): the child prompt asks the model to complete the goal without asking the user, the outcome is written back as an experience (`探索目标/探索执行/结果`), and the task settles `completed`/`failed`. The queue and its status counts are visible through the pipeline's `inspect`. This is the cross-session execution loop behind scheme-2 active exploration: a session auto-starts and silently completes the exploration.

## Install

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

Children are then started through the wrapper name:

```ts ignore-check
ctx.subagents.start('cognitive', { prompt, parent, signal })
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `delegate` | `spawn` | Delegate provider name to wrap; must already be registered |
| `providerName` | `cognitive` | Registry name of the wrapper provider |
| `topK` | `3` | How many related experiences to inject at most |
| `minSimilarity` | `0.3` | Minimum action-vector similarity to consider a memory related |
| `policyEnabled` | `true` | Whether inject/record decisions are predicted and calibrated |
| `policyDecisionThreshold` | `0.55` | Probability at/above which a policy prediction approves the action |
| `delegationToolNames` | `['subagent']` | Tool names captured at `tools/result` as tool-level delegations (predict `policy:delegate`, write back a `委派决策` experience). The cognitive-wrapped tool is excluded by default because its children already write back through the provider's settle path |
| `exploreEnabled` | `true` | Whether the timer-driven exploration dispatcher runs (polls pending tasks and executes them silently) |
| `exploreIntervalMs` | `3600000` | Polling interval for pending exploration tasks, in milliseconds |
| `exploreMaxConcurrent` | `1` | Maximum exploration tasks executing concurrently |
| `delegateDailyBudget` | `5` | Daily delegation budget enforced by the loop-driven delegation sink |
| `delegateMaxConcurrent` | `2` | Maximum delegations executing concurrently through the sink |
| `delegateRiskWords` | `['删除','清空','覆盖','发布','推送','rm','移除','迁移','重置','格式化']` | Irreversible-operation markers; a delegation decision containing one is refused by the sink's safety gate |

## Model Experience

### The wrapper provider and policy predictions

#### What the model sees

The plugin registers a `SubagentProvider` (default name `cognitive`) on `ctx.subagents`; children started through it receive an injected `【认知经验参考】` user-prompt block listing up to `topK` related historical experiences when the inject decision approves. The child never sees the policy layer — inject and record decisions are engine-side predictions through `ctx.cognitivePipeline.predict`, and their calibrations through `report_outcome`. The main-conversation system prompt is unchanged by this package.

#### Token effect

Conditional: an injected block adds roughly 100–300 tokens to the child's prompt per approved injection; no per-turn cost is added to the parent conversation. Policy predictions add no prompt tokens (they are engine-side calls).

#### KV Cache effect

The parent request prefix is unaffected (no sections registered). Child prompts vary per task and injection, so child-side prefix reuse is task-dependent; this package registers no stable prompt section of its own.

## Known Limitations and Deferred Work

- **One-shot delegation only** — continuable children (`startContinuable`) are not wrapped: their injection point lives in the continuation manager, not the provider, so they bypass this layer. Wiring the continuation path is deferred.
- **Deterministic retrieval** — experience retrieval uses the pipeline's hashed action vectors; synonym-aware retrieval (real embeddings) is deferred with the pipeline's own embedding seam.
- **Policy decisions shrink toward 0.5 without an LLM route** — with no model route, `policy:*` predictions use the frequency baseline, so early decisions are conservative; an LLM route (as configured on the cognitive pipeline) sharpens them.
- **No per-session memory separation** — experiences are global to the pipeline store; per-agent or per-session namespacing is deferred.
