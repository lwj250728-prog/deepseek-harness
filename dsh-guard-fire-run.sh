#!/usr/bin/env bash
# dsh-guard-fire-run.sh — 开火命令的统一执行器(tp-119 / cl-191)
#
# 为什么需要它：T119 原先只要求登记的 must-fire 命令 `exit != 0`。可是**探针自己崩了**也满足
# 这一条——2026-09-11 04:1x 我给 T139(b) 写的第一版开火命令把中文写成 \u 转义, 正则不匹配,
# 以 `IndexError: list index out of range` 退出 1: 在 T119 眼里"守卫开火了", 实际什么都没测。
# 非零退出同时覆盖了三种完全不同的东西: 真开火 / 探针崩溃 / 退出码漂移。
#
# 用法: dsh-guard-fire-run.sh <guardId> <expectedExit> <command>
#
# 本执行器自己的退出码(这就是"可判别的开火"):
#   1 = FIRED    真开火: 实际退出码 == 申报码, 且不是探针自身崩溃
#   0 = NOFIRE   命令 exit 0: 登记的"开火路径"是死的
#   3 = CRASH    以坏充火: 非零退出, 但异常类型是探针自身坏了(SyntaxError/IndexError/…)
#   4 = OFFCODE  退出码漂移: 非零, 但不是申报码(约定没人守)
set -uo pipefail
GID="${1:?用法: dsh-guard-fire-run.sh <guardId> <expectedExit> <command>}"
WANT="${2:?缺 expectedExit}"
CMD="${3:?缺 command}"

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

bash -lc "$CMD" >/dev/null 2>"$ERR"
CODE=$?

LAST="$(grep -v '^[[:space:]]*$' "$ERR" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//')"
EXC="$(printf '%s' "$LAST" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_.]*\).*/\1/p' | sed 's/.*\.//')"

# 探针自身崩溃的签名(AssertionError/SystemExit 不算: 那是守卫按设计开火)
case "$EXC" in
  SyntaxError|NameError|IndexError|KeyError|TypeError|AttributeError|ModuleNotFoundError|ImportError|FileNotFoundError|ValueError|UnboundLocalError|ZeroDivisionError)
    echo "[guard-fire] CRASH $GID exc=$EXC: ${LAST:0:140}" >&2
    exit 3 ;;
esac

if [ "$CODE" -eq 0 ]; then
  echo "[guard-fire] NOFIRE $GID: 命令 exit 0, 登记的守卫没开火" >&2
  exit 0
fi
if [ "$CODE" -eq "$WANT" ]; then
  echo "[guard-fire] FIRED $GID exit=$CODE" >&2
  exit 1
fi
echo "[guard-fire] OFFCODE $GID exit=$CODE want=$WANT: ${LAST:0:120}" >&2
exit 4
