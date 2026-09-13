#!/usr/bin/env bash
# dsh-guard-t150-probe.sh — T150「等待判据失败必须显式降级」的开火探针
# 语义: 给判据一份 waitingEvaluated=false 的合成数据, 它必须判红(而不是把那当成正常输出)。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(降级输出却判绿)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/t.json" <<'MKGEN'
import json, sys
payload = {"generatedAt": "2026-09-11T09:50:00+08:00", "waitingEvaluated": False,
           "legend": {}, "goals": [{"id": "g", "title": "t", "lane": "executing", "waiting": False,
                                    "nextAction": "x", "counts": {"completed": 0, "executing": 0, "planned": 0, "blocked": 0},
                                    "steps": [], "wakes": 0, "adopted": 0}]}
open(sys.argv[1], "w", encoding="utf8").write(json.dumps(payload, ensure_ascii=False))
MKGEN
if DSH_GOAL_TRAJECTORY="$TMP/t.json" python3 -c '
import json, os
p = os.environ["DSH_GOAL_TRAJECTORY"]
d = json.load(open(p, encoding="utf8"))
assert "waitingEvaluated" in d
assert d["waitingEvaluated"] is True, "等待判据未跑成(降级输出)"
' 2>/dev/null; then
  echo "判据对降级输出判绿了(应红)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T150: waitingEvaluated=false 被判红" >&2
exit 1
