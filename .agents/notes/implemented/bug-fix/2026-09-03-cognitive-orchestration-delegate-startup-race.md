# Agent Note: cognitive-orchestration delegate startup race

Status: implemented

English | [中文](2026-09-03-cognitive-orchestration-delegate-startup-race.zh.md)

## Problem

Web-profile restarts intermittently failed to boot: `cognitive-orchestration` threw `delegate provider "spawn" is not registered; place the delegate provider row before this plugin in the composition`, the whole plugin tree failed to load, and systemd's `Restart=on-failure` had to retry. Measured twice in one deployment round — 08:39:20 and 08:39:28 failed, 08:39:31 succeeded — the same composition that loads cleanly most of the time. Row order in the composition is correct (the spawn provider's row precedes the orchestration row), so the failure is a race, not a misconfiguration: provider registration is runtime state inside `ctx.subagents` (`registerProvider`), not a ctx service, so the loader has no dependency edge between the two rows and may apply them concurrently under parallelism. `cognitive-orchestration` declared `inject = ['subagents', 'cognitivePipeline', 'sessions', 'timer', 'tools']`, which orders services, not provider registrations — the delegate lookup at apply time could run before the spawn provider's apply finished.

## Decision

`cognitive-orchestration`'s apply is now asynchronous and resolves its delegate provider with a bounded wait (`waitForProvider`, `DELEGATE_WAIT_MS = 3000`): it polls `ctx.subagents.getProvider(name)` every 25 ms until the provider appears or the wait elapses, and only a delegate that stays absent past the wait throws the original ordering error. A single process now survives the loader-parallelism race instead of failing the whole tree and waiting for systemd to retry. The helper is exported for tests; the mount otherwise behaves identically.

## Verification

`orchestrator.spec.ts` (27 green, 2 new): `waitForProvider` resolves as soon as the provider appears within the wait, and returns undefined when the provider never appears before the wait elapses. The package typechecks; the next web-profile restart loads on the first attempt (observed in deployment after this fix).

## Alternatives considered

- **Declare the delegate in `inject`**: make the loader order the rows. Rejected — `inject` names ctx services, and the delegate is a provider registered inside `ctx.subagents`; there is no service key for it. The loader cannot order what it cannot see.
- **Emit a provider-registered event and re-run apply on it**: subscribe to a new `subagents` event and register the wrapper when the delegate lands. Rejected — more surface (a new event plus lifecycle bookkeeping) than the bounded poll needs; the race window is milliseconds.
- **Keep the throw and rely on systemd retries**: the observed behavior before the fix. Rejected — every deployment round burned two failed boot attempts and ~11 s of downtime; a retry budget could exhaust on a slow machine.

## Consequences

The fix costs up to 3 s of mount latency only in the rare case the delegate is late (normally it resolves on the first poll, sub-millisecond). The original ordering error still surfaces loudly when the delegate row is genuinely missing or misordered, so the diagnostic value of the throw is preserved. systemd no longer needs to rescue the boot from a race the process could absorb itself.
