# Agent Note: snapshot-suite stability — process deadlines, Windows JSON escaping, and bash-less platform skips

Status: implemented

English | [中文](2026-08-19-snapshot-suite-stability.zh.md)

## Problem

The keyless snapshot suite (`vitest.snapshot.config.ts`) is unstable in three distinct ways, each surfacing only in specific conditions:

1. **Concurrent subprocess deadline exhaustion.** Snapshot files run in parallel (default `maxConcurrency` 5). Every assembled-headless scenario boots a real DSH subprocess under tsx (`src` mode), which takes 26–31s on this machine. Alone, a scenario finishes under the shared 30s `runLoaderSmoke` subprocess deadline (`DEFAULT_PROCESS_TIMEOUT_MS`); under concurrency the resource contention pushes every scenario past it. The signature is a failure at exactly ~30.5s — the deadline plus processing margin — and the same test passes in isolation.
2. **Windows `{{cwd}}` tokenization corrupts JSONL.** `sdk.snapshot.ts` hydrates its replay fixtures by `replaceAll('{{cwd}}', cwd)`. On Windows the real cwd carries backslashes, so the token inside a JSON string value (`"cwd":"{{cwd}}"`) becomes `"cwd":"C:\Users\…"` — an illegal JSON escape. `llm-replay`'s `parseSessionHeader` then fails with `Bad escaped character in JSON at position 95`. POSIX cwds use `/`, which is JSON-safe, so CI stays green.
3. **Bash-dependent scenarios cannot run on Windows.** Mock adapters (e.g. `cli-mock-llm.ts`) drive one real `bash` tool call; Windows has no bash to spawn, so the recorded tool result (`CLI_TOOL_ROUND_TRIP`) is replaced by `unknown tool "bash"` / `ENOENT` and the session diff fails.

## Decision

Three targeted fixes, each at the owning layer:

- **Per-call process deadlines.** The assembled-headless and CLI snapshots pass `processTimeoutMs` to `runLoaderSmoke` (already supported), sized to the launch weight and always below the vitest deadline so the failure diagnostic stays the subprocess's: 40s for the one-shot headless scenarios, 80s for the full `--profile headless` CLI boot (whose wall time fluctuates between ~60s idle and ~70s under concurrency). Every `runLoaderSmoke` call in the headless suite carries the override — including the sibling scenario files (`subagent-*`, `semantic-checkpoint`, `session-format-guard`, `workspace-context-resume`), which were initially missed because only the primary file was patched.
- **Mode-aware default concurrency.** `vitest.snapshot.config.ts` now defaults `DSH_SNAPSHOT_MAX_CONCURRENCY` by example mode: `lib` keeps 5-way file parallelism (CI, built bundles boot in seconds), `src` defaults to 1 (fully serial replay). Even two concurrent tsx boots contended unpredictably into the per-launch deadlines (observed 80s+), so source mode trades speed for determinism; the env knob still overrides.
- **JSON-escape the hydrated cwd.** `hydrateReplayFixtures` replaces `{{cwd}}` with `cwd.replaceAll('\\', '\\\\')`, keeping the hydrated JSONL valid on every platform. POSIX cwds pass through unchanged.
- **Platform skips for bash-dependent scenarios.** `sdk.snapshot.ts` gains a `skipOn` field on its scenario table and `headless.snapshot.ts` skips the bash-driving scenarios with `it.skipIf(process.platform === 'win32')`. Windows replays the scenarios that do not need bash and skips the rest instead of failing; CI (Linux) runs everything.

## Alternatives considered

**Raise the global `DEFAULT_PROCESS_TIMEOUT_MS`.** Rejected: it changes the failure budget for every `runLoaderSmoke` consumer (including e2e tests) and doubles the wait on genuine hangs; the deadline is a per-launch cost, so the override belongs on the call.

**Replace the cwd token with forward slashes.** Rejected: Windows APIs accept `/`, but the comparison side (`tokenizeSessionFixtureCwd`) would need to match the spelling change, widening the blast radius; JSON-escaping the existing spelling is a one-line fix that keeps both sides byte-identical.

**Make the whole snapshot suite serial.** Rejected as the global default: it would slow `lib`-mode CI, where five-way parallelism is safe. The mode-aware default (serial only under `src`) gets the determinism without the CI cost.

## Consequences

- The snapshot suite now passes reliably under default concurrency and on Windows for the scenarios the platform can run; bash-driving scenarios skip instead of failing, and CI keeps full coverage.
- The `{{cwd}}` JSONL corruption — a Windows-only latent bug masked by POSIX-safe paths — is fixed at its source, so any future fixture hydration is safe on all platforms.
- Costs: two test files changed (deadline constants + skips), one JSON-escape line, and the `skipOn` scenario field. No runtime code changed.
- Why the `{{cwd}}` corruption went unnoticed for three weeks (introduced 2026-07-29, fixed 2026-08-24): three layers masked it. CI runs Linux/macOS, where a cwd is `/` — JSON-safe, so the hydrated JSONL always parsed; only `sdk.snapshot` embeds `{{cwd}}` inside JSON string values (session headers, tool arguments) where backslashes are illegal escapes; and few developers run `test:snapshot` on Windows. Notably the read side was correct all along — `tokenizeSessionFixtureCwd` re-serializes with `JSON.stringify`, which escapes backslashes — only the write side (`hydrateReplayFixtures`) lacked the escape. A single-platform CI structurally cannot see this class of bug; it surfaced here only because the suite was repeatedly re-run on Windows and the concurrency-timeout signal drew attention to the file.
- Known outstanding: `apps/cli/tests/dsh-badge.snapshot.ts` hangs past 90s on Windows — the subprocess tree keeps stdout open after the parent is killed, so `execa` never settles; this is a distinct process-tree/stdio problem, not a deadline issue, and is not addressed here.
