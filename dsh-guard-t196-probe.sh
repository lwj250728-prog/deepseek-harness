#!/usr/bin/env bash
# dsh-guard-t196-probe.sh — T196「条件门不得依赖行动帧」的开火探针
# 语义: 用**同一条断言**(经 DSH_COG_POOL 注入点)审一份**缺陷池** —— 池里的门脚本读了行动帧日志。
#       判据必须转红; 判绿则说明这条守卫是死的。
#   exit 1 = FIRED / exit 4 = 漂移(缺陷池被判绿) / exit 3 = 探针自身失效(断言取不到)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/frame-reading-checker.py" <<'CHK'
# 缺陷: 门挂在**行动帧产出**上(全部门挂上时会互相饿死)
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-frames.jsonl")
print("读过行动帧:", os.path.exists(p))
CHK
cat > "$TMP/pool.jsonl" <<'POOL'
{"id": "goal-x", "status": "active", "nextAction": "x", "waitChecker": "python3 REPLACE/frame-reading-checker.py"}
POOL
sed -i "s|REPLACE|$TMP|" "$TMP/pool.jsonl"
NAME="池内条件门不得依赖行动帧产出, 且必须挂在外部产物上"
if DSH_COG_POOL="$TMP/pool.jsonl" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
  echo "读了行动帧的条件门被判绿 —— 饿死风险无人拦" >&2
  exit 4
fi
echo "[guard-fire] FIRED T196: 读行动帧的门被同一条断言判红" >&2
exit 1
