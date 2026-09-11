#!/usr/bin/env bash
# dsh-guard-t147-probe.sh — T147「部署后审计须真带 preTop」的开火探针(cl-200)
# 语义: 合成"部署后有 injected 行、但一行都不带 preTop"的审计, 判据必须判红。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(没带 preTop 却判绿)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/audit.jsonl" <<'MKGEN'
import json, sys, time
now = int(time.time() * 1000)
with open(sys.argv[1], "w", encoding="utf8") as f:
    for i in range(5):
        f.write(json.dumps({"t": now - i * 1000, "stage": "injected", "path": "raw",
                            "candidateScores": [{"expId": "exp_a", "similarity": 0.9}]}) + "\n")
MKGEN
python3 - "$TMP/audit.jsonl" <<'CHECK'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf8") if l.strip()]
injected = [r for r in rows if r.get("stage") == "injected"]
withpre = [r for r in injected if r.get("preTop")]
assert withpre, "部署后没有任何一条带 preTop —— 埋点没生效"
CHECK
CODE=$?
if [ "$CODE" -ne 0 ]; then
  echo "[guard-fire] FIRED T147: 合成审计(有 injected 无 preTop)被判红" >&2
  exit 1
fi
echo "判据对缺 preTop 的审计判绿了(应红)" >&2
exit 4
