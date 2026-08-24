# Agent Note：快照套件稳定性——进程期限、Windows JSON 转义与无 bash 平台跳过

Status: implemented

[English](2026-08-19-snapshot-suite-stability.md) | 中文

## 问题

keyless 快照套件（`vitest.snapshot.config.ts`）在三种特定条件下不稳定：

1. **并发子进程期限耗尽。** 快照文件并行运行（默认 `maxConcurrency` 5）。每个装配式 headless 场景都在 tsx（`src` 模式）下启动真实 DSH 子进程，本机耗时 26–31 秒。单独运行时场景能在共享的 30 秒 `runLoaderSmoke` 子进程期限（`DEFAULT_PROCESS_TIMEOUT_MS`）内完成；并发时资源竞争把每个场景推过期限。特征是失败精确在 ~30.5 秒——期限加处理余量——且同一测试单独跑通过。
2. **Windows 的 `{{cwd}}` 令牌化破坏 JSONL。** `sdk.snapshot.ts` 用 `replaceAll('{{cwd}}', cwd)` 水合回放 fixture。Windows 上真实 cwd 含反斜杠，于是 JSON 字符串值里的令牌（`"cwd":"{{cwd}}"`）变成 `"cwd":"C:\Users\…"`——非法 JSON 转义。`llm-replay` 的 `parseSessionHeader` 随之报 `Bad escaped character in JSON at position 95`。POSIX cwd 用 `/`，JSON 安全，所以 CI 保持绿。
3. **依赖 bash 的场景无法在 Windows 运行。** mock 适配器（如 `cli-mock-llm.ts`）驱动一次真实 `bash` 工具调用；Windows 没有 bash 可 spawn，于是记录的 `CLI_TOOL_ROUND_TRIP` 结果被 `unknown tool "bash"` / `ENOENT` 取代，会话 diff 失败。

## 决策

三处精准修复，各落在所属层：

- **逐调用进程期限。** 装配式 headless 与 CLI 快照向 `runLoaderSmoke`（已支持）传 `processTimeoutMs`，按启动重量定尺寸，始终低于 vitest 期限以保持失败诊断来自子进程：one-shot headless 场景 40s，完整 `--profile headless` CLI 启动 80s（其墙钟时间在空闲 ~60s 与并发下 ~70s 之间波动）。headless 套件的每个 `runLoaderSmoke` 调用都带覆盖——包括兄弟场景文件（`subagent-*`、`semantic-checkpoint`、`session-format-guard`、`workspace-context-resume`），它们最初因只修补了主文件而被漏掉。
- **按模式感知的默认并发。** `vitest.snapshot.config.ts` 现在按示例模式默认 `DSH_SNAPSHOT_MAX_CONCURRENCY`：`lib` 保持 5 路文件并行（CI，构建后的包秒级启动），`src` 默认 1（完全串行回放）。即使两个并发 tsx 启动也会不可预测地争入逐启动期限（观察到 80s+），所以源模式用速度换确定性；环境旋钮仍可覆盖。
- **JSON 转义水合 cwd。** `hydrateReplayFixtures` 用 `cwd.replaceAll('\\', '\\\\')` 替换 `{{cwd}}`，让水合后的 JSONL 在所有平台合法。POSIX cwd 原样通过。
- **依赖 bash 场景的平台跳过。** `sdk.snapshot.ts` 的场景表新增 `skipOn` 字段，`headless.snapshot.ts` 用 `it.skipIf(process.platform === 'win32')` 跳过驱动 bash 的场景。Windows 重放无需 bash 的场景、跳过其余而不失败；CI（Linux）全跑。

## 备选方案

**全局提高 `DEFAULT_PROCESS_TIMEOUT_MS`。** 否决：它改变所有 `runLoaderSmoke` 用户（含 e2e 测试）的失败预算，并让真实 hang 的等待翻倍；期限是逐启动成本，覆盖应落在调用上。

**把 cwd 令牌换成正斜杠。** 否决：Windows API 接受 `/`，但比较端（`tokenizeSessionFixtureCwd`）需匹配拼写变化，扩大爆炸半径；JSON 转义现有拼写是一行修复，让两端保持逐字节一致。

**整个快照套件串行。** 否决作为全局默认：它会拖慢 `lib` 模式 CI，那里 5 路并行是安全的。按模式感知的默认（仅 `src` 下串行）在不付 CI 成本的前提下获得确定性。

## 后果

- 快照套件现在在默认并发下可靠通过，Windows 上平台可运行的场景也通过；驱动 bash 的场景跳过而不失败，CI 保持完整覆盖。
- `{{cwd}}` JSONL 损坏——被 POSIX 安全路径掩盖的 Windows 专属潜在 bug——在源头修复，未来任何 fixture 水合在所有平台安全。
- 成本：两个测试文件改动（期限常量 + 跳过）、一行 JSON 转义、`skipOn` 场景字段。无运行时代码改动。
- `{{cwd}}` 损坏为何三周未被发现（2026-07-29 引入，2026-08-24 修复）：三层掩盖。CI 跑 Linux/macOS，cwd 是 `/`——JSON 安全，水合后的 JSONL 总能解析；只有 `sdk.snapshot` 把 `{{cwd}}` 嵌在 JSON 字符串值里（session header、工具参数），反斜杠在那里是非法转义；且极少有人在 Windows 跑 `test:snapshot`。值得注意的是读取端一直是对的——`tokenizeSessionFixtureCwd` 用 `JSON.stringify` 重新序列化（自动转义反斜杠）——只有写入端（`hydrateReplayFixtures`）漏了转义。单平台 CI 结构性看不见这类 bug；它之所以在此暴露，是因为套件在 Windows 上被重复运行，并发超时信号把注意力引到了该文件。
- 已知遗留：`apps/cli/tests/dsh-badge.snapshot.ts` 在 Windows 上挂起超 90 秒——父进程被杀后子进程树仍持有 stdout，`execa` 永不结算；这是独立的进程树/stdio 问题，不是期限问题，本 Note 未处理。
