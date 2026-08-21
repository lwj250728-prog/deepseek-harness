# @deepseek-ai/dsh-cognitive-inject

English | [中文](README.zh.md)

Step-level SAR experience priming for the cognitive pipeline. At every agent pre-step it extracts the current situation from the messages about to enter the model request, and **only when the situation carries a trigger** (a failed step, a help/explore/decide behavior word, or a keyword derived from important stored experiences) does it retrieve situation-related experiences and inject the closest hits as reference context. After a failed step it recalls more aggressively — the "memory chaining" analogue: a failure is the strongest situation cue, so the previous setback surfaces related past experience for faster matching on the retry step.

## What the plugin does

```
主对话 / 子任务 每步开始前
  → agent/pre-step → 提取当前情境文本（最近 N 条消息块）
  → 触发门：上一步失败？或 消息含触发词？（静态行为词 / SAR 派生关键词）
  → 触发才检索经验库（行动轴 ∪ 情境轴，取 max；失败标记重叠按语义加成）
  → 否决门：模板7精排判定 top 候选是否真正适用（LLM 路由存在时）
  → 通过 → 注入【认知经验参考】块（source: cognitive-inject）
  → 上一步工具失败 → 阈值放宽 + 注入条数提升 + "上一步执行失败"标记
```

- **步骤级预热 (step-level priming)** — unlike the orchestrator's one-shot pre-task injection, this plugin recalls at every step of every agent, so an experience is surfaced exactly when the current situation resembles it — including mid-task, when a bug first appears.
- **触发式注入 (trigger-gated injection)** — humans consult past experience when they fail, face something new, or make a high-stakes decision — not on routine small talk. Injection is gated the same way: after a failed step it always primes; otherwise the incoming messages must carry a trigger. **Static behavior triggers** (失败/报错/卡住/排查/怎么/如何/试试/风险/以前/遇到过/发布/部署/计划…) match as substrings; **SAR-derived triggers** are keywords of important stored experiences — tokens of the situation/action of high-utility, high-risk, or frequently-hit experiences accumulate their importance (|utilityScore|/15 + risk + frequency) into per-token weights, the top 60 survive normalized, and a summed trigger weight ≥ 0.6 primes injection. A message like "重启一下" (routine) never injects even when retrieval would find a literal weak hit; "帮我排查测试挂起" (help) and "打包插件到GitHub" (derived keywords of a failed-push experience) both prime.
- **双轴检索 + 症状加成 (dual-axis retrieval with symptom bonus)** — the situation text is matched against both the experience's action vector and its situation vector, and the higher similarity wins. A task text like "tests suddenly hang" recalls the bug experience whose *situation* was "tests suddenly hang", even when the repair wording differs. A failure-symptom overlap (挂起/超时/编译失败… in both the query and the experience text) adds a capped bonus (`SYMPTOM_BONUS = 0.3`) **proportional to the semantic score** on top of it — it sharpens recall for the current setback, but a literal marker match can never drag an unrelated experience across the threshold (measured: semantic 0.11 + marker 1.0 scored 0.41 under a flat bonus; proportional scoring drops it to 0.14, below the 0.4 floor, while a genuinely relevant 0.47 situational hit keeps a 0.61 score).
- **视角覆盖 (viewpoint coverage)** — retrieval does not blindly take the top-K most similar experiences: when both a failure experience (negative outcome utility) and a success experience (positive outcome utility) clear the threshold, at least one of each is injected — the model sees both the cautionary tale (上次怎么栽的) and the workable approach (成功时怎么做的), not just the single most similar memory. Coverage is a floor, not a reshuffle: the highest-scoring hit of each polarity is kept plus the next best to fill `topK` (floor 2), and the selection stays similarity-ranked; when only one polarity exists, the plain top-K is injected unchanged.
- **否决门 (LLM veto gate)** — an over-threshold candidate is not automatically injected: when the pipeline has an LLM route, the template-7 refine route reads the situation and each candidate and judges whether it truly applies (a literal hit is not transferability). Every candidate the route accepts is injected (viewpoint coverage survives the veto — a failure + success pair both reach the model when both are judged transferable); each rejection records a note (bounded, `INJECT_VETO_MAX = 2`; the injected block notes how many were vetoed), and all-rejected suppresses injection entirely. Without a route the gate degrades to the threshold-only behavior.
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

The `web` profile mounts it after the cognitive pipeline (see its `cordis.patch.yml`); other profiles can add it to their patch or bundle to enable step-level priming.

## Configuration

All fields optional; defaults are conservative to avoid context noise.

| Field | Default | Meaning |
| --- | --- | --- |
| `topK` | `1` | How many related experiences to inject at most (viewpoint coverage may add a second when both polarities exist) |
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
