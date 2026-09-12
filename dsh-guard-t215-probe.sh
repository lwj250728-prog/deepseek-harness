#!/usr/bin/env bash
# dsh-guard-t215-probe.sh — T215「账本体积/行数守卫」的开火探针
# 语义: 造一本**超阈**的合成账本(行数与体积都超), 判据必须判红并提示压缩。
#   exit 1 = FIRED / exit 4 = 漂移(超阈却判绿) / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
# 造 3200 行、每行约 1.5KB ⇒ 行数与体积都超阈
row = {"id": "cl-x", "ts": "2026-09-12T10:00:00+08:00", "status": "open",
       "claim": "填充" + "x" * 1200, "reviewBy": "2026-09-20"}
with open(os.path.join(T, "ledger.jsonl"), "w", encoding="utf8") as f:
    for i in range(3200):
        r = dict(row, id="cl-%d" % i)
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
MK
if DSH_COG_LEDGER="$TMP/ledger.jsonl" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "账本体积与行数须在阈值内(超阈提示压缩)" >/dev/null 2>&1; then
  echo "超阈账本被判绿 —— 增长无人拦" >&2
  exit 4
fi
echo "[guard-fire] FIRED T215: 超阈账本被同一条判据判红" >&2
exit 1
