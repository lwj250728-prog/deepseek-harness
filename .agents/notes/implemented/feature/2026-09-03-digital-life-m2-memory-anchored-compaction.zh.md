# Agent Note: 数字生命 M2——记忆锚定上下文近似

Status: implemented

[English](2026-09-03-digital-life-m2-memory-anchored-compaction.md) | 中文

## 问题

上下文近似只是原始的 token 机制。当 `compaction-basic` 在 token 压力下替换被挤出的 surface 区间时，摘要器只往会话 surface 写一条摘要节点，没有任何东西把被挤出的线索写进记忆基质：情景链保留着旧的链头（往往是长弧段之前的过期节点），经验库没从弧段学到任何东西，压缩后的连续性只靠上下文里那条静态摘要。挤出与未来任何写入之间的崩溃，或摘要本身被后续压缩挤掉，线索便永久丢失。

## 决策

压缩现在按[数字生命路线提案](../../proposed/feature/2026-09-03-digital-life-agent.md)的里程碑 M2，在两个记忆平面锚定进基质。两个监听器都订阅会话的 `compaction/summary` 事件——这条仅记账的计量事件携带摘要文本，且契约上紧跟着执行 surface 替换的 `user/message`——两者每个压缩 id 至多写入一次。

- `situational-state` 提交一个链节点，其情景文本即压缩摘要（上限 320 字符），轨迹 `origin: 'compaction'`。pre-step 注入随后在下一步把刷新后的链头呈现给模型，节点也为后续会话留存——压缩后的恢复走链，而非被挤出的 surface。配置 `compactionWriteBack`（默认 true）可关闭。
- `cognitive-pipeline` 把被摘要的弧段提交给积累闸门一次（`accumulateTurn`），但仅在 `autoAccumulate` 开启时，构造 outcome 为摘要的回合素材。闸门自行裁决价值——substantial 预过滤、预测缺口同化、LLM 判定、任务复述拒绝——被拒的弧段什么都不写，长会话也无法淹没经验库（每个压缩 id 至多一条经门控的经验）。

写入在 `compaction/summary` 追加之后异步发生；摘要文本本身是持久会话事件，因此写回前的崩溃只丢失基质节点，绝不丢失弧段内容（会话日志保留摘要与替换消息）。

## 验证

`situational-state` 测试（28 绿）新增：`compaction/summary` 事件提交一个携带摘要文本、`origin: 'compaction'` 的节点；重复压缩 id 不写第二个节点；`compactionWriteBack: false` 什么都不写。`cognitive-pipeline` 新增 `compaction-accumulation.spec.ts`（4 绿）：`autoAccumulate` 开启且有显式路由时，一条经门控的经验从压缩摘要落地；同一压缩 id 恰好消耗一次 LLM 门调用（幂等性通过适配器调用计数断言）；无路由时闸门拒绝、什么都不写；`autoAccumulate` 关闭时什么都不写。两包 README 配对已更新并重录。

## 备选方案

- **写回放进压缩后端**：教 `compaction-basic` 在替换时调用记忆插件。否决——后端拥有 token 策略，不拥有记忆；基质监听器响应任何后端都会发出的持久 `compaction/summary` 事件，接缝保持单向。
- **从会话日志重推导来恢复**：摘要留在日志里就跳过链节点。否决——链才是在反复压缩中幸存、并跨会话传递的东西；纯日志恢复需要一趟没人跑的回放。
- **无条件合成经验**：每次压缩不经门控写一条经验。否决——自动积累存在的意义就是保持经验库有门控；未经裁决的合成入流会污染检索。

## 后果

长工作弧段现在能在 token 压力下于两个记忆平面幸存：链头跟踪摘要后的状态（下一步与后续会话皆可恢复），弧段在闸门判定值得时升入经验库。代价：每次压缩可能花费一次 LLM 门调用（pipeline 侧，仅在自动积累下）与一个链节点加一条轨迹条目（situational 侧）；两者都按压缩 id 有界。写回相对事件流是异步的，因此"挤出前即持久化"并非字面成立——摘要安全保存在会话日志中，基质节点在下次压缩前尽力落盘。
