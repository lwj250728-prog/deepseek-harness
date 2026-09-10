#!/usr/bin/env bash
# dsh-guard-fire-run-selftest.sh — 开火判定器的自测(tp-119 / cl-191)
#
# 判定器 dsh-guard-fire-run.sh 自己也是机制：它必须能把"真开火 / 探针崩溃 / 没开火 / 退出码漂移"
# 四种情况分开。本自测用四个合成命令逐一对号，任一不符即以非零退出(套件 T119 会判红)。
# 自测**通过**时 exit 0(这不是"开火探针"，而是"判定器功能自证")。
set -uo pipefail
RUNNER=/home/ubuntu/dsh-fork/dsh-guard-fire-run.sh
fail=0

check() { # check <期望判定器退出码> <说明> <命令>
  local want="$1" desc="$2" cmd="$3" got
  bash "$RUNNER" SELFTEST 1 "$cmd" >/dev/null 2>&1
  got=$?
  if [ "$got" -ne "$want" ]; then
    echo "✗ $desc: 期望判定器退出 $want, 实得 $got" >&2
    fail=1
  else
    echo "  ✓ $desc (判定器退出 $got)"
  fi
}

check 1 "真开火(AssertionError)" "python3 -c 'assert False, \"守卫开火\"'"
check 3 "以坏充火(IndexError 崩溃)" "python3 -c 'x=[];print(x[-1])'"
check 3 "以坏充火(SyntaxError)" "python3 -c 'def ('"
check 0 "没开火(exit 0)" "true"
check 4 "退出码漂移(exit 2 而申报 1)" "exit 2"

exit "$fail"
