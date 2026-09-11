# @deepseek-ai/dsh-client-ui-goal-tree

[English](README.md) | 中文

侧边栏目标轨迹功能所有者：贡献 `sidebar.footer.action` 席位——侧边栏脚部的一行紧凑触发器，加一个浮动面板，把[认知流水线](../../cognition/cognitive-pipeline/README.md)目标库里的每个目标铺成一棵轨迹树，三态一眼可见：已完成 / 执行中 / 规划。每条轨道承载当前落在其中的目标；每个目标行给出轨道徽标、生命周期状态、三项计数、`nextAction`（限两行）、唤醒与采纳数、最近账本时间戳与步数。展开目标列出其账本步骤——账本 id（`cl-201`）、种类徽标、时间戳与认领文本；展开某步显示原始账本状态、`reviewBy` 期限、完整认领文本与已记录证据。

面板刻意紧凑：这是轨迹树，不是报告。轨道分组与行上徽标取自同一组每轨计数，因此目标不会出现在它没有步骤的轨道下。

## 数据通路

node 半边在自己的 Connection RPC 通道上注册一个只读端点——`POST /goal-tree/trajectory/overview`——返回由仓库外生成器 `dsh-goal-trajectory.py` 写入 `$DSH_HOME/cognitive-pipeline/goal-trajectory.json` 的快照。之所以自建通道而不用共享的 `/api`：Connection 每个通道只允许一个 interceptor，而 Typert 网关已占用 `/api`；私有通道是纯增量的，不改动任何共享包。端点限定 loopback，并对文档做最低限度校验：截断或畸形文件会报错，而不是渲染成空面板。

browser 半边经 `ctx.connection.rpc.call` 调用该端点：首次展开拉一次，刷新按钮重跑生成器再拉一次，无轮询——面板闲置时零请求。面板在构造上只读：两侧都不提供变更动词，文件归生成器所有（不归 harness）。

面板浮动在用户拖到的侧边栏边缘旁，因此宽列与 56px rail 都可用；侧边栏折叠时触发器仅省略文字，保留图标与目标数。

## Model Experience

无。本包为人渲染宿主读取的文件，不触碰任何提示、消息、schema、流或工具结果。模型侧对同一批目标的视图仍属于目标工具与流水线检查面。

#### KV Cache effect

无；本包从不组装或发送供应商请求。

## Known Limitations and Deferred Work

- **经 profile patch 装配** — 本包必须注册为 loader 条目，并且能从 dsh 安装目录与 profile 目录双向解析（`~/.dsh/node_modules` 链接）。profile 层有 watcher，追加条目会在运行中的服务里重载插件树与 boot graph；但已打开的浏览器标签页仍持旧 graph，需要刷新一次。
- **席位是脚部 action** — `sidebar.life` 与 `sidebar.learning` 都是 single 基数席位且已被 ui-cognition 占用，而动态注册条目会赢得单选席位，注册进去会遮蔽已发布 UI。脚部是 list 席位：纯增量、安全。更合适的是新增一个多占用者的侧边栏分区，或把某个分区席位改成 `list` 基数。
- **文件归生成器所有** — 快照的新鲜度只等于最近一次生成或刷新；面板用浏览器时钟标注陈旧度，而不自行调度再生成。
- **无逐步筛选** — 展开的目标会渲染其全部步骤；大目标会形成长滚动，按种类筛选留待后续。
