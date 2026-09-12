#!/usr/bin/env bash
# dsh-guard-t199-probe.sh — T199「饱和必须点明 + 并列报告均候选」的开火探针
# 语义: 把门限扫描工具**变异**成"不再点明饱和"(saturated 恒 False) —— 这正是 T199 要拦的形态:
#       判据没有开火空间却不说, 会被读成"找过了, 没空间"(与"no-effect 被构造成出来"同型)。
#       用**同一条断言**(经 DSH_THRESHOLD_SWEEP 注入点)审变异工具 ⇒ 必须转红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-threshold-sweep.py"), encoding="utf8").read()
marker = "saturated = cur['rankableShare'] >= 1.0"
assert src.count(marker) == 1, "找不到饱和判定(结构变了, 探针自身失效)"
open(os.path.join(T, "mutant-sweep.py"), "w", encoding="utf8").write(
    src.replace(marker, "saturated = False   # 变异: 不再点明饱和"))
MK
NAME="占比饱和时须点明, 且表里须有平均候选数(决策相关维)"
if DSH_THRESHOLD_SWEEP="$TMP/mutant-sweep.py" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
  echo "不再点明饱和的变异工具被判绿 —— 判据没有开火空间却不说" >&2
  exit 4
fi
echo "[guard-fire] FIRED T199: 不点明饱和的变异工具被同一条断言判红" >&2
exit 1
