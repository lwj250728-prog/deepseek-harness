#!/usr/bin/env bash
# dsh-guard-t191-probe.sh — T191「裁决须消费预注册期望」的开火探针
# 语义: 把门限扫描工具**变异**成"永不报告不符"(preregMismatch 恒 False)。这正是 T191 要拦的形态 ——
#       预注册只是摆设(事后怎么做都算一致)。用**同一条断言**(经 DSH_THRESHOLD_SWEEP 注入点)审变异工具 ⇒ 必须转红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, re, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-threshold-sweep.py"), encoding="utf8").read()
m = re.search(r"('preregMismatch':\s*)([^,\n]+)", src)
assert m, "找不到 preregMismatch 字段(结构变了, 探针自身失效)"
mut = src[:m.start(2)] + "False   # 变异: 永不报告不符" + src[m.end(2):]
assert mut != src
open(os.path.join(T, "mutant-sweep.py"), "w", encoding="utf8").write(mut)
MK
NAME="裁决须消费预注册期望: 一致则标注, 不符则要求代表性复核(不得直接采信)"
if DSH_THRESHOLD_SWEEP="$TMP/mutant-sweep.py" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
  echo "永不报告不符的变异工具被判绿 —— 预注册成了摆设" >&2
  exit 4
fi
echo "[guard-fire] FIRED T191: 不消费预注册的变异工具被同一条断言判红" >&2
exit 1
