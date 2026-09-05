# Agent Note: 数字生命 M1——情景状态链自行持续

Status: implemented

[English](2026-09-03-digital-life-m1-situational-self-sustain.md) | 中文

## 问题

情景状态链无法自行启动或推进。pre-step 注入钩子在链空时短路，而唯一能创建首节点的 `situational_state_commit` 工具没有注册进运行中的部署：插件在 `apply` 内注册工具，但经过一道在 `ctx.get('tools')` 为 undefined 时静默返回的守卫，且插件未声明任何 `inject` 依赖来保证挂载时工具注册表已存在。首节点因此只能手写进 `chain.json`（2026-09-02 的验证是手工播种 `sstate-1`）。即便已有链头，推进链表也依赖模型记得主动调用提交工具——正是曾让链表冻结四天的同一弱点。

## 决策

`situational-state` 现在端到端地自行维持线索，对应[数字生命路线提案](../../proposed/feature/2026-09-03-digital-life-agent.md)的里程碑 M1。`packages/context/situational-state` 内交付三处机制：

- 插件声明 `inject = ['agents', 'tools']`，加载器在代理注册表与工具注册表之后挂载它。`situational_state_commit` 与 `situational_state_trace` 因此无条件注册；静默跳过注册的缺口已关闭，并由回归测试钉住。
- 空链自举（`autoBootstrap`，默认 true）：当 pre-step 发现链表为空时，插件把会话开场情景——进入该步消息的尾部文本块，上限 220 字符——作为首节点提交，轨迹 `origin: 'bootstrap'`。注入钩子不再于空链上静默失效；对话无需手工调用工具或手工编辑文档即可启动自己的状态链。
- 回合末自检（`selfCheckEnabled`，默认 true；`selfCheckMinHeadAgeMs`，默认 5 分钟；`selfCheckMinToolCalls`，默认 1）：每次 `turn/end` 且成因为 completed 或 error 时，若链头年龄超过下限、且刚结束的回合记录了至少下限次数的工具调用，插件提交一个节点，文本取该回合最新的自述内容（最后一条 assistant 文本，否则最后一条真实 user 请求——`extractTurnActivity`，上限 220 字符），轨迹 `origin: 'turn-end'`。

提交来源随轨迹账本记录：每条 commit 条目携带可选的 `origin`（`'tool'`——模型工具提交的默认值；`'bootstrap'`；`'turn-end'`；该字段出现前写入的旧条目缺省），`situational_state_trace` 返回它。

## 验证

`packages/context/situational-state/tests/situational-state.spec.ts` 的单元测试现在把插件挂载在其声明的服务（agents、tools、prompt 运行时）之后，并断言：两个工具均已注册；提交工具可执行并记录 `origin: 'tool'`；空链的首个 pre-step 创建 `sstate-1` 且 `origin: 'bootstrap'`，第二个 pre-step 注入它；`autoBootstrap: false` 时链表保持为空；覆盖旧链头的已完成"有工作"回合提交 `sstate-2`，携带回合自身文本与 `origin: 'turn-end'`；年龄低于下限的新链头被跳过；`extractTurnActivity` 能读出工具调用数与最新自述文本。全套 25 个测试绿灯；双语包 README（配对已重录）记录了五个新配置字段。

## 备选方案

- **只提示不自举**：注入一条"尚无已提交状态"的引导，等模型自己调用工具。否决——模型不会可靠地自发提交（已实测四天冻结），首节点不能依赖模型配合；确定性的开场节点提交无论如何都闭合了回路。
- **用 LLM 判定阶段切换再做回合末提交**：先问管线的 LLM 路由是否真发生了转换再提交。推迟——每次过期链头都要花费一次补全，而确定性代理（年龄下限加真实工具工作加回合自身的词句）已按工作节奏推进链；若节点质量需要，日后再叠 LLM 判定。
- **在首个 pre-step 惰性注册工具**：等工具注册表出现时再重试注册，从而免去 `inject` 声明。否决——`inject` 是加载器自有的排序机制；惰性注册会让会话首个请求差一步才见到工具。

## 后果

链现在随对话工作自动增长：开场自举、工作回合后自检提交（节奏由五分钟年龄下限约束）、模型工具保留用于刻意提交。代价：链不再默认保持为空，琐碎开场（如"你好"）会产生低价值根节点；只想记录刻意提交的运营者可设 `autoBootstrap: false`。不同会话的并发首个 pre-step 可能竞争共享链文档——读写是首写者胜，进程内 `bootstrapPending` 标志抑制进程内双自举；轨迹 `origin` 字段让每个节点的来源可审计。自动提交不携带自决唤醒，检查点提醒仍是模型工具的特性。
