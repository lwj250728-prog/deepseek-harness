# Agent Note：多层 SAR 经验注入

Status: implemented

[English](2026-08-18-multi-layer-sar-experience-injection.md) | 中文

## 问题

认知流水线的 SAR 记忆在最需要经验复用的场景下没有可用的召回路径。orchestrator 的一次性子任务前 `retrieve()` 用任务文本匹配每条经验的行动向量（`minSimilarity 0.3`）；对真实 bug 经验实测，典型子任务文本的相似度为 0.00–0.27——全部低于阈值。于是即使子任务恰好撞上存储经验描述的同一个 bug，也没有任何东西把它浮出来。更糟的是，执行中完全没有召回点：`start()` 在委派前注入一次，`settle()` 只回写，中途失败时没有任何通道把相关经验拉进模型的下一步。人类记忆按情境连锁唤起，不靠关键词；而系统按行动措辞召回，且只在任务边界召回。

## 决策

**检索改为情境-行动双轴。** orchestrator 的 `retrieve()` 现在以 `max(cosine(task, actionVector), cosine(task, situationVector))` 为每条经验打分并取较高者。"测试突然挂起"这样的任务文本，能召回*情境*为"测试突然挂起"的 bug 经验，即使修复措辞完全不同。

**新增 opt-in 插件 `dsh-cognitive-inject`，在每个 agent 的 pre-step 预热。** 它提取即将进入模型请求的步骤的尾部消息块，从共享流水线存储检索情境相关经验，并把最近命中 fold 进 `decision.messages`，作为 `cognitive-inject` source 的参考块。由于主对话与子任务都走同一个 `agent/pre-step` waterfall，一个监听器同时覆盖两层。

**失败步骤唤起更激进。** `tools/result` 监听记录每个 agent 最近一次工具结果；若为错误，下一次 pre-step 将 `minSimilarity` 乘以 `failureThresholdFactor`（默认 0.6），把上限从 `topK`（1）提高到 `failureTopK`（3），并给块加"上一步执行失败"前缀。这是记忆连锁唤起思想的对应物：失败是最强的情境线索。

**注入持久且带 source 归属。** 参考块随步骤的 `decision.messages` 进入请求，由 agent loop 作为 `user/message` 事件落盘——模型可见与已记录同步，符合"模型可见 ⟺ logged"不变式。本包的 invariant 伴生插件校验每条 `cognitive-inject` 事件都精确携带其写入时的 snapshot source 与前缀。

## 备选方案

**只通过 `predict_outcome` 召回。** 否决：它依赖模型在任务中途记得调用工具，且检索偏行动加权；对 bug 经验实测命中率接近零。

**只做任务前注入（只修 orchestrator 检索轴，不加别的）。** 否决：仍然没有执行中召回点，而 bug 恰恰在首次出现时最需要它。

**在 agent-loop 层注入（改 `agent-loop`）。** 否决：loop 已暴露 `agent/pre-step` waterfall 并持久化 `decision.messages`；在现有扩展点上做插件即可覆盖所有 agent，无需改 loop（遵循"插件而非 loop 变更"）。

**每步无条件预热、无 token 防护。** 否决：无条件注入会膨胀每个请求。默认 `topK: 1`、`minSimilarity: 0.4` 与 context 深度上限让大多数步骤零注入；只有失败路径放宽召回。

## 后果

bug 经验现在在三个层面浮现：任务前（orchestrator，情境感知）、任务中（每个 agent 的步骤预热）、失败后（放宽阈值）。注入是 opt-in 的（`cognitive-inject` 默认不在 `web` profile 中），不挂载它的产品零成本。`context` 包组新增一个 opt-in 成员及其 invariant 伴生。保留的已知限制：哈希词袋向量（同义词不命中）、失败标记按 agent 而非按步、父与子任务飞行中无跨 agent 召回。
