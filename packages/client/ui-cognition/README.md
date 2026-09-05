# @deepseek-ai/dsh-client-ui-cognition

English | [中文](README.zh.md)

Web learning-area feature owner: contributes the `sidebar.learning` occupant — a collapsible sidebar section, between the workspace/session browsing region and the foot, listing the [cognitive pipeline's](../../cognition/cognitive-pipeline/README.md) autonomous exploration task queue. This is the human-readable face of the same queue the [`cognitive-orchestration`](../../cognition/cognitive-orchestration/README.md) scheduler executes silently: pending, learning, completed, and failed tasks with their goals and results, so a person can see what the agent is learning without reaching into the store or the model tool.

Data arrives on demand through the `cognition.list` RPC: the first expand fetches once, and a manual refresh button re-fetches. There is no polling, so an idle browser costs nothing. The section header shows the task count and a running-task badge; the body offers status filters (全部/待执行/学习中/已完成/已失败) with per-filter counts, and each row expands to reveal the full goal, the outcome text, and the creation time. While the sidebar is collapsed to its rail, the learning area becomes a lone icon trigger with a running-count badge that expands the column.

Read-only by design: the queue is fed by the pipeline's `explore()` / `exploreAutoDispatch` and settled by the orchestrator's scheduler, so the browser has no mutation verbs. A composition without the cognitive pipeline answers an empty learning area rather than an error. Copy lives in the package's own `cognition` locale namespace.

## Model Experience

None, as this package renders host-computed queue state for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same queue stays with the pipeline's `inspect_memory` tool and the exploration RPC.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Manual refresh only** — the area fetches on open and on the refresh button; live-running tasks do not auto-update while the section stays open. A future tick or frame push could close that gap.
- **No per-task cancellation** — the queue settles through the orchestrator's scheduler; cancelling a running exploration from the UI is deferred (the scheduler owns that lifecycle).
