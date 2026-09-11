#!/usr/bin/env bash
# dsh-guard-t153-probe.sh — T153「孵化体检告警闭环」的开火探针
# 语义: 合成一份"改写后 6 次唤醒全无采纳"的数据, 体检必须 exit 1 且写出账本告警。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(违规却没告警)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MKGEN'
import json, sys, datetime, os
d = sys.argv[1]; tz = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(tz)
open(os.path.join(d, "dormant-goals.jsonl"), "w", encoding="utf8").write(json.dumps(
    {"id": "goal-probe", "status": "active", "lastActionAt": (now - datetime.timedelta(hours=5)).isoformat()},
    ensure_ascii=False) + "\n")
with open(os.path.join(d, "goal-trigger-log.jsonl"), "w", encoding="utf8") as f:
    for i in range(6):
        f.write(json.dumps({"ts": (now - datetime.timedelta(hours=4) + datetime.timedelta(minutes=i)).isoformat(),
                            "goalId": "goal-probe", "adopted": False}, ensure_ascii=False) + "\n")
MKGEN
DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-incubation-checkup.py >/dev/null 2>&1
CODE=$?
LED="$TMP/claims-ledger.jsonl"
if [ "$CODE" -eq 1 ] && [ -f "$LED" ] && grep -q '"id": "cl-incubation-stall"' "$LED"; then
  echo "[guard-fire] FIRED T153: 合成违规写出账本告警并 exit 1" >&2
  exit 1
fi
echo "判据未开火(exit=$CODE, 告警文件存在=$([ -f "$LED" ] && echo 是 || echo 否))" >&2
exit 4
