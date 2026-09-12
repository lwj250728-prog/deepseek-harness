#!/usr/bin/env bash
# dsh-guard-t200-probe.sh — T200「提醒门: 有 checker 时以 checker 为准」的开火探针
# 语义: 把 reminder-gate.ts **变异**成"忽略 checker, 只看文本启发式"(这正是 2026-09-12 v1 的真实缺陷),
#       再用**同一条断言**(经 DSH_REMINDER_GATE 注入点)审它 —— 必须转红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/reminder-gate.ts"), encoding="utf8").read()
marker = "  if (wc !== '') return !runChecker(wc)\n  return waitingFallback(String(goal.nextAction ?? ''))"
assert src.count(marker) == 1, "reminder-gate 结构变了(探针自身失效)"
mut = src.replace(marker, "  void runChecker\n  return waitingFallback(String(goal.nextAction ?? ''))   // 变异: 忽略 checker")
open(os.path.join(T, "mutant-gate.ts"), "w", encoding="utf8").write(mut)
MK
NAME="提醒门: 有 checker 时以它为准(未满足即跳过), 无 checker 时才看文本"
if DSH_REMINDER_GATE="$TMP/mutant-gate.ts" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
  echo "忽略 checker 的变异门被判绿 —— v1 的缺陷会原样复发" >&2
  exit 4
fi
echo "[guard-fire] FIRED T200: 忽略 checker 的变异门被同一条断言判红" >&2
exit 1
