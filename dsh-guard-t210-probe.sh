#!/usr/bin/env bash
# dsh-guard-t210-probe.sh — T210「新判据必须可隔离」的开火探针
# 语义: 造一份**合成套件**, 里面有一条"新"断言(不在冻结基线里)且它**不读世界根**(空世界下照样绿),
#       判据必须判红。判绿则说明"不可隔离"拦不住。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/suite.sh" <<'SUITE'
t "老判据(冻结)" python3 -c '
print("old")
'
t "新判据(不读世界根, 空世界下也会绿)" python3 -c '
import os
print("ok", bool(os.environ.get("DSH_COG_DIR")))
'
SUITE
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
json.dump({"at": "2026-09-12T13:00:00+08:00", "names": ["老判据(冻结)"], "reason": "合成基线"},
          open(os.path.join(T, "baseline.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
if python3 /home/ubuntu/dsh-fork/dsh-assert-isolation-check.py --suite "$TMP/suite.sh" --baseline "$TMP/baseline.json" >/dev/null 2>&1; then
  echo "不读世界根的新判据被判绿 —— '不可隔离'拦不住" >&2
  exit 4
fi
echo "[guard-fire] FIRED T210: 不可隔离的新判据被同一条判据拦下" >&2
exit 1
