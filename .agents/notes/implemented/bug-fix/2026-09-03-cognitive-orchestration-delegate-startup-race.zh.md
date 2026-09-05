# Agent Note: cognitive-orchestration 委托 provider 启动竞态

Status: implemented

[English](2026-09-03-cognitive-orchestration-delegate-startup-race.md) | 中文

## 问题

web profile 重启会间歇性启动失败：`cognitive-orchestration` 抛出 `delegate provider "spawn" is not registered; place the delegate provider row before this plugin in the composition`，整棵插件树加载失败，只能靠 systemd 的 `Restart=on-failure` 重试。同一轮部署中实测两次——08:39:20 与 08:39:28 失败，08:39:31 成功——同样的装配大多数时候能干净加载。装配中的行序是正确的（spawn provider 行在编排行之前），因此这是竞态而非配置错误：provider 注册是 `ctx.subagents` 内部的运行时状态（`registerProvider`），不是 ctx 服务，loader 在两行之间没有依赖边，可能在其并行机制下并发应用。`cognitive-orchestration` 声明的 `inject = ['subagents', 'cognitivePipeline', 'sessions', 'timer', 'tools']` 只排服务顺序，排不了 provider 注册——apply 时的委托查找可能跑在 spawn provider 的 apply 完成之前。

## 决策

`cognitive-orchestration` 的 apply 现为异步，并以有界等待解析委托 provider（`waitForProvider`，`DELEGATE_WAIT_MS = 3000`）：每 25 ms 轮询 `ctx.subagents.getProvider(name)`，直到 provider 出现或等待耗尽；只有等待过后仍缺席的委托才抛出原有的顺序错误。单个进程现在能扛过 loader 并行竞态，不再整树失败、坐等 systemd 重试。该辅助函数导出供测试；其余挂载行为完全不变。

## 验证

`orchestrator.spec.ts`（27 绿，2 新）：`waitForProvider` 在等待期内一旦 provider 出现即解析；等待耗尽仍不出现时返回 undefined。包类型检查通过；本修复后的下一次 web profile 重启首次尝试即加载成功（部署中已观察到）。

## 备选方案

- **把委托写进 `inject`**：让 loader 排序两行。否决——`inject` 指名 ctx 服务，而委托是注册在 `ctx.subagents` 内部的 provider，没有对应的服务键；loader 排不了它看不见的东西。
- **发出 provider 注册事件并在事件上重跑 apply**：订阅新的 `subagents` 事件，委托落地时再注册包装。否决——比有界轮询需要更多表面（新事件加生命周期簿记）；竞态窗口只有毫秒级。
- **保留抛错并依赖 systemd 重试**：即修复前观察到的行为。否决——每次部署轮次烧掉两次失败启动与约 11 秒宕机；重试预算在慢机器上可能耗尽。

## 后果

修复仅在委托确实迟到的罕见情况下花费至多 3 秒挂载延迟（正常时首次轮询即解析，亚毫秒级）。当委托行真正缺失或错序时，原有顺序错误仍会响亮地暴露，抛错的诊断价值得以保留。systemd 不再需要从一个进程本可自行吸收的竞态中救活启动。
