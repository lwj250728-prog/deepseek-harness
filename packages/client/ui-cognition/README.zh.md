# @deepseek-ai/dsh-client-ui-cognition

[English](README.md) | 中文

Web 学习会话区功能所有者：贡献 `sidebar.learning` 席位——侧边栏中工作区/会话浏览区与脚部之间可折叠的学习区，展示[认知流水线](../cognitive-pipeline/README.md)的自主探索任务队列。这是 [cognitive-orchestration](../cognitive-orchestration/README.md) 调度器静默执行的那条队列的人类可读面：待执行、学习中、已完成、已失败任务及其目标与结果，让人能看到代理正在学什么，无需翻存储或模型工具。

数据按需通过 `cognition.list` RPC 到达：首次展开拉取一次，手动刷新按钮重新拉取。无轮询，空闲浏览器零开销。区块头部显示任务总数与学习中徽标；正文提供状态筛选（全部/待执行/学习中/已完成/已失败）与各状态计数，每行可展开查看完整目标、结果文本与创建时间。侧边栏折叠为 rail 时，学习区变为带学习计数徽标的单图标触发器，点击展开整列。

只读设计：队列由流水线的 `explore()` / `exploreAutoDispatch` 填充、由编排器调度器落定，浏览器侧没有变更动词。未装配认知流水线的组合返回空学习区而非报错。文案位于本包自有的 `cognition` locale 命名空间。

## Model Experience

无——本包仅为人类渲染宿主计算的队列状态，不触及任何提示词、消息、schema、流或工具结果。模型侧对同一队列的视图仍由流水线的 `inspect_memory` 工具与探索 RPC 提供。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## Known Limitations and Deferred Work

- **仅手动刷新** — 区域在展开与点击刷新按钮时拉取；区块保持打开时运行中任务不会自动更新。未来的 tick 或帧推送可补齐这一缺口。
- **无按任务取消** — 队列由编排器调度器落定；从 UI 取消运行中的探索留待后续（调度器持有该生命周期）。
