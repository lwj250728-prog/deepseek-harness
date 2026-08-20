# @deepseek-ai/dsh-cognitive-inject

English | [中文](README.zh.md)

Step-level SAR experience priming for the cognitive pipeline. At every agent pre-step it extracts the current situation from the messages about to enter the model request, retrieves situation-related experiences from the pipeline store, and injects the closest hits as reference context. After a failed step it recalls more aggressively — the "memory chaining" analogue: a failure is the strongest situation cue, so the previous setback surfaces related past experience for faster matching on the retry step.

## What the plugin does

```
主对话 / 子任务 每步开始前
  → agent/pre-step → 提取当前情境文本（最近 N 条消息块）
  → 情境向量检索经验库（行动轴 ∪ 情境轴，取 max）
  → 命中超阈值 → 注入【认知经验参考】块（source: cognitive-inject）
  → 上一步工具失败 → 阈值放宽 + 注入条数提升 + "上一步执行失败"标记
```

- **步骤级预热 (step-level priming)** — unlike the orchestrator's one-shot pre-task injection, this plugin recalls at every step of every agent, so an experience is surfaced exactly when the current situation resembles it — including mid-task, when a bug first appears.
- **双轴检索 + 症状通道 (dual-axis retrieval plus symptom channel)** — the situation text is matched against both the experience's action vector and its situation vector, and the higher similarity wins. A task text like "tests suddenly hang" recalls the bug experience whose *situation* was "tests suddenly hang", even when the repair wording differs. A third exact-substring channel scores the query's failure-symptom markers (挂起/超时/编译失败…) against the experience text, so a short symptom query that dilutes in the hashed vectors still hits.
- **失败强启动 (failure priming)** — when the most recent tool result for an agent was an error, the similarity threshold is multiplied by `failureThresholdFactor` and up to `failureTopK` experiences are injected, prefixed with an "上一步执行失败" marker.
- **模型可见 ⟺ 已记录 (model-visible ⟺ logged)** — the reference block rides the step's `decision.messages`, so the agent loop appends it as a durable `user/message` event; replay and dispatch observe exactly what the model saw.

## Quick start

Compose the plugin next to the cognitive pipeline:

```yaml
- id: cognitive-inject
  name: '@deepseek-ai/dsh-cognitive-inject'
  config:
    topK: 1
    minSimilarity: 0.4
```

The `web` profile does not mount it by default; add it to your profile patch or bundle to enable step-level priming.

## Configuration

All fields optional; defaults are conservative to avoid context noise.

| Field | Default | Meaning |
| --- | --- | --- |
| `topK` | `1` | How many related experiences to inject at most |
| `minSimilarity` | `0.4` | Minimum situation-vector similarity to consider a memory related |
| `failureThresholdFactor` | `0.6` | After a failed step, multiply `minSimilarity` by this factor |
| `failureTopK` | `3` | After a failed step, how many experiences to inject at most |
| `contextDepth` | `4` | How many trailing message blocks feed the situation extraction |
| `enabled` | `true` | False keeps the listener mounted but skips injection |

## Model Experience

### The injected reference block

#### What the model sees

At an eligible step the model receives one additional `user/message` reference block:

```
【认知经验参考】以下是与当前情境相关的历史经验，供参考借鉴（不要虚构为当前事实）：
- [exp_8] (相关度 0.52) 深夜出现了一个会死循环的浮点 bug。紧急修复了该浮点 bug。测试全部恢复…
```

The block is source-attributed to `cognitive-inject` and injected only when a hit clears the threshold, so most steps carry no extra tokens.

#### Token effect

Conditional: zero tokens on a miss, roughly 60–120 tokens per injected block on a hit. The failure path injects up to `failureTopK` blocks but only after an actual tool failure.

#### KV Cache effect

The injected block is a step-local `user/message`, not a system-prompt section; it does not affect prefix reuse. Retrieval reads the same hashed bag-of-words vectors as the pipeline, so the store and rebuilds stay reproducible.

## Known Limitations and Deferred Work

- **Hash-vector situation matching** — situation text is matched with the pipeline's deterministic bag-of-words vectors, so synonyms do not match; a real embedding seam is the pipeline's deferred work, and this plugin inherits it.
- **Failure marker is per-agent, not per-step** — the plugin tracks only the most recent tool outcome per agent; a successful step between the failure and the next pre-step is not distinguished from an immediate retry.
- **No cross-agent recall** — priming reads the shared store, but an experience is injected only for the agent whose step is running; a parent does not automatically see a child's freshly written experience until its next step.
