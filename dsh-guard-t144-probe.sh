#!/usr/bin/env bash
# dsh-guard-t144-probe.sh — T144「保活不得架空退避」的开火探针(cl-195)
#
# 两条开火路径都必须现场成立:
#   ① 保活间隔违规: 合成两条相隔 5 分钟的保活放行 → 判据须判红;
#   ② 遥测链断: 部署后有 25 次注入, 而带 backoff 遥测的审计只有 2 条 → 判据不得继续以"样本不足"豁免。
#   exit 1 = 开火(两条都成立)   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据没开火)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LINT=/home/ubuntu/dsh-fork/dsh-keepalive-lint.py

python3 - "$TMP/audit.jsonl" "$TMP/broken" <<'MKGEN'
import json, os, sys, time
now = 1_800_000_000_000
rows = [{"t": now, "sessionId": "s1", "backoffAdmitted": "exp_a", "backoffDropped": 1},
        {"t": now + 5 * 60 * 1000, "sessionId": "s1", "backoffAdmitted": "exp_b", "backoffDropped": 1}]
rows += [{"t": now + i * 60 * 1000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1}
         for i in range(30)]
open(sys.argv[1], "w", encoding="utf8").write("\n".join(json.dumps(r) for r in rows) + "\n")

# 路径②: 有注入、无遥测
bd = sys.argv[2]
os.makedirs(bd, exist_ok=True)
real = int(time.time() * 1000)
with open(os.path.join(bd, "injections.jsonl"), "w", encoding="utf8") as f:
    for i in range(25):
        f.write(json.dumps({"createdAt": real - i * 60000, "sessionId": "s1", "expIds": ["e1"]}) + "\n")
with open(os.path.join(bd, "retrieval-audit.jsonl"), "w", encoding="utf8") as f:
    for i in range(2):
        f.write(json.dumps({"t": real - i * 1000, "sessionId": "s1",
                            "backoffAdmitted": None, "backoffDropped": 1}) + "\n")
MKGEN

python3 "$LINT" --audit "$TMP/audit.jsonl" --after $((1800000000000 - 1)) 2>"$TMP/err1"
CODE1=$?
if [ "$CODE1" -ne 1 ]; then
  echo "判据未开火(保活间隔违规, exit=$CODE1): $(tail -1 "$TMP/err1" 2>/dev/null)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T144(保活间隔): $(tail -1 "$TMP/err1")" >&2

STALE=$(( $(date +%s) * 1000 - 3 * 3600 * 1000 ))
python3 "$LINT" --audit "$TMP/broken/retrieval-audit.jsonl" --after "$STALE" 2>"$TMP/err2"
CODE2=$?
if [ "$CODE2" -ne 1 ]; then
  echo "判据未开火(遥测链断, exit=$CODE2): $(tail -1 "$TMP/err2" 2>/dev/null)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T144(遥测链断): $(tail -1 "$TMP/err2")" >&2
exit 1
