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
    age = (now - datetime.datetime.fromisoformat(str(v.get("ts"))[:19]).replace(tzinfo=tz)).total_seconds() / 3600.0
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

echo "无豁免 exit=$NO_WAIVER (期望非 0=判红) | 有效豁免 exit=$WITH_WAIVER (期望 0=放行)" >&2

if [ "$NO_WAIVER" -ne 0 ] && [ "$WITH_WAIVER" -eq 0 ]; then
  exit 1   # 开火: 判据既抓得住停滞, 也认得有效豁免
fi
echo "判据行为不符(无豁免 exit=$NO_WAIVER / 有豁免 exit=$WITH_WAIVER)" >&2
exit 4
