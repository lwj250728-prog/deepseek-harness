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

- **逐调用进程期限。** 装配式 headless 与 CLI 快照向 `runLoaderSmoke`（已支持）传 `processTimeoutMs`，按启动重量定尺寸，始终低于 vitest 期限以保持失败诊断来自子进程：one-shot headless 场景 40s，完整 `--profile headless` CLI 启动 70s（其墙钟时间在 60s 附近波动）。每个文件在启动旁命名自己的常量，预算局部可检。
- **JSON 转义水合 cwd。** `hydrateReplayFixtures` 用 `cwd.replaceAll('\\', '\\\\')` 替换 `{{cwd}}`，让水合后的 JSONL 在所有平台合法。POSIX cwd 原样通过。
- **依赖 bash 场景的平台跳过。** `sdk.snapshot.ts` 的场景表新增 `skipOn` 字段，`headless.snapshot.ts` 用 `it.skipIf(process.platform === 'win32')` 跳过驱动 bash 的场景。Windows 重放无需 bash 的场景、跳过其余而不失败；CI（Linux）全跑。

## 备选方案

**全局提高 `DEFAULT_PROCESS_TIMEOUT_MS`。** 否决：它改变所有 `runLoaderSmoke` 用户（含 e2e 测试）的失败预算，并让真实 hang 的等待翻倍；期限是逐启动成本，覆盖应落在调用上。

**把 cwd 令牌换成正斜杠。** 否决：Windows API 接受 `/`，但比较端（`tokenizeSessionFixtureCwd`）需匹配拼写变化，扩大爆炸半径；JSON 转义现有拼写是一行修复，让两端保持逐字节一致。

**整个快照套件串行。** 否决：它治症状（竞争）却放弃 config 刻意启用的并行回放；真正的修复是匹配启动重量的逐启动预算。

## 后果

- 快照套件现在在默认并发下可靠通过，Windows 上平台可运行的场景也通过；驱动 bash 的场景跳过而不失败，CI 保持完整覆盖。
- `{{cwd}}` JSONL 损坏——被 POSIX 安全路径掩盖的 Windows 专属潜在 bug——在源头修复，未来任何 fixture 水合在所有平台安全。
- 成本：两个测试文件改动（期限常量 + 跳过）、一行 JSON 转义、`skipOn` 场景字段。无运行时代码改动。
- 已知遗留：`apps/cli/tests/dsh-badge.snapshot.ts` 在 Windows 上挂起超 90 秒——父进程被杀后子进程树仍持有 stdout，`execa` 永不结算；这是独立的进程树/stdio 问题，不是期限问题，本 Note 未处理。
