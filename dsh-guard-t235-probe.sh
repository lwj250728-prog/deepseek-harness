#!/usr/bin/env bash
# dsh-guard-t235-probe.sh — T235「编辑→锚点检查接线」的开火探针(**双臂**)
# 变异臂: 让接线**短路**(`if [ "$hit" -eq 1 ]; then` → `if [ "$hit" -eq 1 ] && false; then`)
#   ⇒ 漂移时不再跑锚点检查 ⇒ T235 的④必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T235 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="编辑被变异的目标文件后必须自动跑锚点检查: 集合取自登记簿 + 漂移必红 + 非目标不触发"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-edit-check.sh"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T235 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$SRC" "$BAK" || exit 3
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = 'if [ "$hit" -eq 1 ]; then'
new = 'if [ "$hit" -eq 1 ] && false; then  # MUTANT: 接线短路'
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 接线短路" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "接线短路后判据仍判绿 —— 锚点漂移不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T235: 接线短路(编辑目标文件后不跑锚点检查)被判据抓住" >&2
exit 1
