# @deepseek-ai/dsh-client-ui-goal-tree

English | [中文](README.zh.md)

Sidebar goal-trajectory feature owner: contributes the `sidebar.footer.action` occupant — a compact trigger row in the sidebar foot plus a floating panel that lays every goal of the [cognitive pipeline's](../../cognition/cognitive-pipeline/README.md) goal store out as one trajectory tree per goal, with three lanes visible at a glance: 已完成 / 执行中 / 规划. Each lane carries the goals whose work currently sits there, and each goal row shows its lane badge, lifecycle status, the three per-step counts, `nextAction` (clamped to two lines), the wake and adopted-experience counts, the last ledger timestamp, and its step count. Expanding a goal lists its ledger steps — claim id (`cl-201`), kind badge, timestamp, and the claim text; expanding one step reveals the raw ledger status, its `reviewBy` deadline, the full claim, and the recorded evidence.

The panel is deliberately dense: this is a trajectory tree, not a report. Lane grouping is derived from the same per-lane counts the row badges show, so a goal cannot appear under a lane it holds no steps for.

## Data path

The node half registers one read-only endpoint on its own Connection RPC channel — `POST /goal-tree/trajectory/overview` — and answers with the snapshot written by the out-of-tree generator `dsh-goal-trajectory.py` at `$DSH_HOME/cognitive-pipeline/goal-trajectory.json`. Its own channel rather than the shared `/api` one because Connection permits a single interceptor per channel and the Typert gateway already owns `/api`; a private channel is additive and touches no shared package. The endpoint is fenced to loopback and validates the document just enough to report a truncated or malformed file instead of rendering an empty panel.

The browser half calls that endpoint through `ctx.connection.rpc.call`: the first open fetches once, the refresh button re-runs the generator and re-fetches, and nothing polls — an idle panel costs no requests. The panel is read-only by construction: neither face offers a mutation verb, and the generator (not the harness) owns the file.

The panel floats beside whichever sidebar edge the user has dragged to, so it works in both the wide column and the 56px rail; the trigger row itself is hidden while the sidebar is collapsed only in the sense that its label is dropped, leaving the glyph and the goal count.

## Model Experience

None, as this package renders a host-read file for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same goals stays with the goal tools and the pipeline's inspection surfaces.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Composed through the profile patch** — the package must be registered as a loader entry and be resolvable from both the dsh installation and the profile directory (a `~/.dsh/node_modules` link). The profile layer is watched, so appending the entry reloads the plugin tree and the boot graph in a running server; a browser tab that was already open keeps its older graph and needs one reload.
- **The seat is a footer action** — `sidebar.life` and `sidebar.learning` are single-cardinality seats already occupied by ui-cognition, and a dynamically registered entry wins a single seat, so registering there would hide the shipped UI. The footer is a list seat: additive and safe. A dedicated multi-occupant sidebar section, or a `list`-cardinality section seat, would suit this panel better than the foot.
- **Generator, not harness, owns the file** — the snapshot is only as fresh as the last generator run or refresh; the panel labels staleness against the browser clock instead of scheduling regeneration.
- **No per-step filtering** — every step of an expanded goal renders; a large goal makes a long scroll, and kind filtering is deferred.
