#!/usr/bin/env bash
# dsh-guard-t149-probe.sh — T149「active 目标不得停在不可解析的等待」的开火探针(cl-206)
# 语义: 合成一个 active 目标, nextAction 是"待事件(...)"且无 waitChecker —— 判据必须判红。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(不可解析的等待却判绿)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/goals.jsonl" <<'MKGEN'
import json, sys
with open(sys.argv[1], "w", encoding="utf8") as f:
    f.write(json.dumps({"id": "goal-probe", "status": "active",
                        "nextAction": "待事件(样本≥30 自动可判)"}, ensure_ascii=False) + "\n")
MKGEN
OUT=$(python3 /home/ubuntu/dsh-fork/dsh-goal-wait-lint.py --goals "$TMP/goals.jsonl" 2>&1)
CODE=$?
if [ "$CODE" -eq 1 ] && printf '%s' "$OUT" | grep -q "无法解析"; then
  echo "[guard-fire] FIRED T149: 合成的不可解析等待被判红" >&2
  exit 1
fi
echo "判据未开火(exit=$CODE): $(printf '%s' "$OUT" | tail -1 | head -c 100)" >&2
exit 4
