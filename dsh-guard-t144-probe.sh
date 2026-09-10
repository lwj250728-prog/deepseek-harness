#!/usr/bin/env bash
# dsh-guard-t144-probe.sh — T144「保活不得架空退避」的开火探针(cl-195)
# 语义: 合成两条相隔 5 分钟的保活放行, 判据必须判红。
#   exit 1 = 开火(抓住违规)  ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(放过了违规)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP/audit.jsonl" <<'PY'
import json, sys
now = 1_800_000_000_000
rows = [{"t": now, "sessionId": "s1", "backoffAdmitted": "exp_a", "backoffDropped": 1},
        {"t": now + 5 * 60 * 1000, "sessionId": "s1", "backoffAdmitted": "exp_b", "backoffDropped": 1}]
rows += [{"t": now + i * 60 * 1000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1} for i in range(30)]
open(sys.argv[1], "w", encoding="utf8").write("\n".join(json.dumps(r) for r in rows) + "\n")
PY
python3 /home/ubuntu/dsh-fork/dsh-keepalive-lint.py --audit "$TMP/audit.jsonl" --after $((1800000000000 - 1)) 2>"$TMP/err"
CODE=$?
if [ "$CODE" -eq 1 ]; then
  echo "[guard-fire] FIRED T144: $(tail -1 "$TMP/err")" >&2
  exit 1
fi
echo "判据未开火(exit=$CODE): $(tail -1 "$TMP/err" 2>/dev/null)" >&2
exit 4
