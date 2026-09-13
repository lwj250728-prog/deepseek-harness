#!/usr/bin/env bash
# dsh-guard-t220-probe.sh — T220「停驱须被行为消费」判据的开火探针(**双臂**)
# 语义: 把停驱声明变异成"声明的是**驱动器当前目标**"(= 声明与事实相反, 正是"口头停驱、实际还在驱动"的形态),
#       判据必须抓住它。双臂: 变异件 ⇒ 判据必须红(退出 1); 干净件(DSH_PROBE_CLEAN=1) ⇒ 必须绿(退出 0)。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
CLEAN="${DSH_PROBE_CLEAN:-}"
D="$HOME/.dsh/cognitive-pipeline"
NAME="被显式停驱的会话不得再成为驱动目标, 且此后不得再收到帧"
if [ "$CLEAN" = "1" ]; then
  if python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T220 干净臂: 真声明被判绿(应然)" >&2
    exit 0
  fi
  echo "真声明被判红 —— 判据在干净件上就是红的, 对变异没有区分力" >&2
  exit 3
fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" "$D" <<'MK' || exit 3
import json, os, sys, datetime
T, D = sys.argv[1], sys.argv[2]
src = os.path.join(D, "quiet-driver-exclusions.json")
assert os.path.exists(src), "缺停驱声明(判据前提不成立)"
decl = json.load(open(src, encoding="utf8"))
eff = ""
tgt = os.path.join(D, "quiet-driver-target.txt")
if os.path.exists(tgt):
    eff = (open(tgt, encoding="utf8").read() or "").strip()
assert eff, "读不到驱动器目标(探针自身失效)"
assert decl.get("exclusions"), "声明里没有条目"
decl["exclusions"][0]["sessionId"] = eff          # 变异: 声明"停驱"的正是驱动器当前目标 ⇒ 应判红
json.dump(decl, open(os.path.join(T, "mutated-exclusions.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
if DSH_QD_EXCLUSIONS="$TMP/mutated-exclusions.json" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "$NAME" >/dev/null 2>&1; then
  echo "变异版(声明的是当前驱动目标)仍被判绿 —— 停驱只是口头状态" >&2
  exit 4
fi
echo "[guard-fire] FIRED T220: 与事实相反的停驱声明被判据抓住" >&2
exit 1
