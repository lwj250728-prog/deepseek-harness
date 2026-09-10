#!/usr/bin/env bash
# dsh-guard-t144-probe.sh — T144「保活不得架空退避」的开火探针(cl-195)
#
# 两条开火路径都必须现场成立:
#   ① 保活间隔违规: 合成两条相隔 5 分钟的保活放行 → 判据须判红;
#   ② 宽限到期: lib 构建已 3 小时而部署后遥测只有 2 条 → 判据不得继续以"样本不足"豁免(豁免须自己到期)。
#   exit 1 = 开火(两条都成立)   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据没开火)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
LINT=/home/ubuntu/dsh-fork/dsh-keepalive-lint.py

# —— 路径①: 保活间隔违规 ——
python3 - "$TMP/audit.jsonl" "$TMP/thin.jsonl" <<'MKGEN'
import json, sys, time
now = 1_800_000_000_000
rows = [{"t": now, "sessionId": "s1", "backoffAdmitted": "exp_a", "backoffDropped": 1},
        {"t": now + 5 * 60 * 1000, "sessionId": "s1", "backoffAdmitted": "exp_b", "backoffDropped": 1}]
rows += [{"t": now + i * 60 * 1000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1}
         for i in range(30)]
open(sys.argv[1], "w", encoding="utf8").write("\n".join(json.dumps(r) for r in rows) + "\n")

# 只有 2 条遥测(样本不足), 供路径②使用
real = int(time.time() * 1000)
thin = [{"t": real - 2000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1},
        {"t": real - 1000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1}]
open(sys.argv[2], "w", encoding="utf8").write("\n".join(json.dumps(r) for r in thin) + "\n")
MKGEN

python3 "$LINT" --audit "$TMP/audit.jsonl" --after $((1800000000000 - 1)) 2>"$TMP/err1"
CODE1=$?
if [ "$CODE1" -ne 1 ]; then
  echo "判据未开火(保活间隔违规, exit=$CODE1): $(tail -1 "$TMP/err1" 2>/dev/null)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T144(保活间隔): $(tail -1 "$TMP/err1")" >&2

# —— 路径②: 样本不足的宽限到期 ——
STALE=$(( $(date +%s) * 1000 - 3 * 3600 * 1000 ))
python3 "$LINT" --audit "$TMP/thin.jsonl" --after "$STALE" 2>"$TMP/err2"
CODE2=$?
if [ "$CODE2" -ne 1 ]; then
  echo "判据未开火(宽限已过仍豁免, exit=$CODE2): $(tail -1 "$TMP/err2" 2>/dev/null)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T144(宽限到期): $(tail -1 "$TMP/err2")" >&2
exit 1
