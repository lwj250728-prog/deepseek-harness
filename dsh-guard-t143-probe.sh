#!/usr/bin/env bash
# dsh-guard-t143-probe.sh — T143「最老未关单项不得 3 天不动」的开火探针(cl-192)
#
# 语义：合成一本只有一条"96 小时前开单、至今未关"的账本，判据必须判红。
#   exit 1 = 开火(判据抓住了停滞)  ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据放过了停滞) ← T119 的统一判定器会判红
# 同时对照一次"有有效豁免"的情形：同一本账本 + 未过期豁免 → 判据必须放行(exit 0)，
# 否则豁免机制是假的(要么永不生效, 要么永远生效)。
set -uo pipefail
TMP=/tmp/t143-probe
rm -rf "$TMP"; mkdir -p "$TMP"
OLD=$(python3 -c 'import datetime;print((datetime.datetime.now()-datetime.timedelta(hours=96)).astimezone().isoformat())')
printf '{"id":"cl-probe","ts":"%s","status":"open","claim":"合成的停滞项","disposition":"无"}\n' "$OLD" > "$TMP/claims-ledger.jsonl"

# 自 2026-09-12 02:2x 起判据口径 = min(ts, createdTs, tsBackfilled): 自愈/回填换新 ts **不是**推进。
# 第三例就是守这一点: ts 刚换新、createdTs 在 96h 前的未关项, 必须仍然判红 —— 否则"自愈"自身
# 会把停滞洗白(cl-052 实测: ts 1.1h / 真实 73.1h)。
run() { # run <waivers-json>  → 打印判据退出码
  printf '%s' "$1" > "$TMP/stall-waivers.json"
  DSH_COG_LEDGER="$TMP/claims-ledger.jsonl" DSH_STALL_WAIVERS="$TMP/stall-waivers.json" \
    python3 -c '
import json, os, datetime
lp = os.environ["DSH_COG_LEDGER"]; wp = os.environ["DSH_STALL_WAIVERS"]
WINDOW_H = 72
lat = {}
for line in open(lp, encoding="utf8"):
    if line.strip():
        r = json.loads(line)
        if r.get("id"): lat[r["id"]] = r
T = {"done", "retired", "closed"}
tz = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(tz)
oldest = []
for k, v in lat.items():
    if v.get("status") in T or not k.startswith("cl-"): continue
    cands = []
    for f in ("ts", "createdTs", "tsBackfilled"):
        t = v.get(f)
        if t:
            try: cands.append(datetime.datetime.fromisoformat(str(t)[:19]).replace(tzinfo=tz))
            except Exception: pass
    if not cands: continue
    age = (now - min(cands)).total_seconds() / 3600.0
    oldest.append((age, k))
oldest.sort(reverse=True)
assert oldest, "前提不成立"
waivers = {}
if os.path.exists(wp):
    for w in json.load(open(wp, encoding="utf8")).get("waivers", []):
        waivers[w["id"]] = w
bad = []
for a, k in [(x, y) for x, y in oldest if x > WINDOW_H]:
    w = waivers.get(k)
    if not w or not w.get("reason"): bad.append(k); continue
    until = w.get("until")
    if not (until and datetime.datetime.fromisoformat(until).replace(tzinfo=tz) > now): bad.append(k)
assert not bad, "停滞: " + repr(bad)
'
}

run '{"waivers":[]}';           NO_WAIVER=$?
FUTURE=$(python3 -c 'import datetime;print((datetime.datetime.now()+datetime.timedelta(days=7)).date().isoformat())')
run "{\"waivers\":[{\"id\":\"cl-probe\",\"reason\":\"合成的证据型等待\",\"until\":\"$FUTURE\"}]}"; WITH_WAIVER=$?

# 第三例: ts 是"刚刚"(自愈/回填换新), 而 createdTs 在 96h 前 ⇒ 判据必须仍然判红(不得被自愈洗白)
NOW_TS=$(python3 -c 'import datetime;print(datetime.datetime.now().astimezone().isoformat())')
printf '{"id":"cl-probe2","ts":"%s","createdTs":"%s","status":"open","claim":"自愈换新 ts 的停滞项"}\n' "$NOW_TS" "$OLD" > "$TMP/claims-ledger.jsonl"
run '{"waivers":[]}'; HEALED_STALE=$?

echo "无豁免 exit=$NO_WAIVER (期望非 0=判红) | 有效豁免 exit=$WITH_WAIVER (期望 0=放行) | 自愈换新 ts exit=$HEALED_STALE (期望非 0=判红)" >&2

if [ "$NO_WAIVER" -ne 0 ] && [ "$WITH_WAIVER" -eq 0 ] && [ "$HEALED_STALE" -ne 0 ]; then
  exit 1   # 开火: 抓得住停滞, 认得有效豁免, 且不被自愈换新的 ts 洗白
fi
echo "判据行为不符(无豁免 exit=$NO_WAIVER / 有豁免 exit=$WITH_WAIVER / 自愈换新 ts exit=$HEALED_STALE)" >&2
exit 4
