#!/usr/bin/env bash
# dsh-guard-t148-probe.sh — T148「账本时间戳必须同形」的开火探针(cl-202)
# 语义: 合成一个"末条为 UTC(Z)"的账本目录, 判据必须判红。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据没开火)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MKGEN'
import json, os, sys
d = sys.argv[1]
for n in ("a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl", "e.jsonl"):
    open(os.path.join(d, n), "w", encoding="utf8").write(
        json.dumps({"ts": "2026-09-11T08:00:00.000000+08:00"}, ensure_ascii=False) + "\n")
open(os.path.join(d, "bad.jsonl"), "w", encoding="utf8").write(
    json.dumps({"ts": "2026-09-10T23:55:00.973Z"}) + "\n")
MKGEN
OUT=$(DSH_COG_DIR="$TMP" python3 -c '
import json, os, re
D = os.environ["DSH_COG_DIR"]
EPOCH_ALLOW = {"quiet-driver-frames.jsonl", "quiet-driver-heartbeat.jsonl"}
pat = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?\+08:00$")
bad, checked = [], 0
for name in sorted(os.listdir(D)):
    if not name.endswith(".jsonl") or name in EPOCH_ALLOW: continue
    rows = [l for l in open(os.path.join(D, name), encoding="utf8") if l.strip()]
    if not rows: continue
    r = json.loads(rows[-1]); v = r.get("ts") or r.get("doneAt")
    if not v: continue
    checked += 1
    if not pat.match(str(v)): bad.append(name)
assert not bad, "不同形: " + repr(bad)
print("checked=%d" % checked)
' 2>&1) && { echo "判据对 UTC 账本判绿了(应红)" >&2; exit 4; }
echo "[guard-fire] FIRED T148: $OUT" >&2
exit 1
