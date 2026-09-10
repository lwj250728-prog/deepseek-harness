#!/usr/bin/env bash
# dsh-guard-t146-probe.sh — T146「已到点的日期型等待不得再被标 skipped」的开火探针(cl-198/tp-124)
#
# 语义: 合成一份"唤醒被标 skipped:waiting, 但该目标的 nextAction 指向的时刻早已过去"的数据,
# 判据必须判红(那正是 cl-198 的缺陷形态: 永久跳过)。
#   exit 1 = 开火(抓住违规)   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据没开火)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP/trigger.jsonl" "$TMP/goals.jsonl" <<'MKGEN'
import datetime, json, sys
now = datetime.datetime.now().astimezone()
past = (now - datetime.timedelta(hours=3)).isoformat()
with open(sys.argv[1], "w", encoding="utf8") as f:
    f.write(json.dumps({"ts": now.isoformat(), "goalId": "goal-probe",
                        "adopted": False, "skipped": "waiting"}, ensure_ascii=False) + "\n")
# nextAction 指向 3 小时前 —— 按已部署判据已不等待, 却被标 skipped:waiting
stamp = (now - datetime.timedelta(hours=3)).strftime("%m-%d %H:%M")
with open(sys.argv[2], "w", encoding="utf8") as f:
    f.write(json.dumps({"id": "goal-probe", "status": "active",
                        "nextAction": "待 %s 复核(等待型, 合成)" % stamp}, ensure_ascii=False) + "\n")
MKGEN

python3 /home/ubuntu/dsh-fork/dsh-waiting-expiry-lint.py \
  --trigger-log "$TMP/trigger.jsonl" --goals "$TMP/goals.jsonl" \
  --after "$(( $(date +%s) * 1000 - 600000 ))" 2>"$TMP/err"
CODE=$?
if [ "$CODE" -eq 1 ]; then
  echo "[guard-fire] FIRED T146: $(tail -1 "$TMP/err")" >&2
  exit 1
fi
echo "判据未开火(exit=$CODE): $(tail -1 "$TMP/err" 2>/dev/null)" >&2
exit 4
