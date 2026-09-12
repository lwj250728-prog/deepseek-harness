#!/usr/bin/env bash
# dsh-guard-t208-probe.sh — T208「账本时间戳必须可解析」的开火探针
# 语义: 造一本**含占位符时间戳**的合成账本(`2026-09-09T12:5x:00+08:00`, 真账本里实测出现过 10 条),
#       判据必须判红 —— 不可解析的字段会被停滞判据静默跳过, 等于给条目开了个停滞黑洞。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
ok = {"id": "cl-ok", "ts": "2026-09-09T12:50:00+08:00", "tsApprox": True, "status": "in-progress"}
bad = {"id": "cl-bad", "ts": "2026-09-09T12:5x:00+08:00", "status": "in-progress"}
with open(os.path.join(T, "claims.jsonl"), "w", encoding="utf8") as f:
    for r in (ok, bad):
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
open(os.path.join(T, "tests.jsonl"), "w", encoding="utf8").write(
    json.dumps({"id": "tp-ok", "ts": "2026-09-12T12:50:00+08:00"}, ensure_ascii=False) + "\n")
MK
if DSH_COG_LEDGER="$TMP/claims.jsonl" DSH_COG_TESTPENDING="$TMP/tests.jsonl" python3 -c '
import datetime, json, os
CLAIMS, TESTS = os.environ["DSH_COG_LEDGER"], os.environ["DSH_COG_TESTPENDING"]
FIELDS = ("ts", "createdTs", "tsBackfilled", "reviewBy", "doneAt", "generatedAt")
def bad(v):
    if not v: return False
    try:
        datetime.datetime.fromisoformat(str(v)[:19]); return False
    except Exception: return True
def scan(path, key):
    latest = {}
    for line in open(path, encoding="utf8"):
        if line.strip():
            r = json.loads(line)
            if r.get(key): latest[r[key]] = r
    return [(k, f, str(v.get(f))) for k, v in latest.items() for f in FIELDS if bad(v.get(f))]
badc = scan(CLAIMS, "id")
assert not badc, "言行账本里含不可解析时间戳(停滞判据会静默跳过该字段): %s" % badc[:5]
' 2>/dev/null; then
  echo "含占位符时间戳的合成账本被判绿了 —— 停滞判据会出现静默黑洞" >&2
  exit 4
fi
echo "[guard-fire] FIRED T208: 占位符时间戳(12:5x)被 T208 判红" >&2
exit 1
