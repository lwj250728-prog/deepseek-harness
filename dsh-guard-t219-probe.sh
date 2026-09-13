#!/usr/bin/env bash
# dsh-guard-t219-probe.sh — T219「干预恢复腿」判据的开火探针(**双臂**)
# 语义: 把恢复判据的核心检测变异成**永不判红**(still_off 恒 False), 判据必须抓住它 —— 那正是 2026-09-13
#       那次事故的形态: 池子里留着 waitChecker=/bin/false, 而没有任何判据说它不对。
# 双臂: 变异臂喂变异件 ⇒ 判据必须红 ⇒ 退出 1; 干净臂(DSH_PROBE_CLEAN=1)喂原件 ⇒ 必须绿 ⇒ 退出 0。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
CLEAN="${DSH_PROBE_CLEAN:-}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ "$CLEAN" = "1" ]; then
  TOOL="$HOME/dsh-fork/dsh-intervention-restore-check.py"
  ARM="干净件"
else
  python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-intervention-restore-check.py"), encoding="utf8").read()
marker = "            if still_off:"
assert src.count(marker) == 1, "找不到 still_off 判定行(结构变了, 探针自身失效)"
mut = src.replace(marker, "            if False:   # 变异: 永不判红(池子留着干预态也不报)")
open(os.path.join(T, "mutant-restore-check.py"), "w", encoding="utf8").write(mut)
MK
  TOOL="$TMP/mutant-restore-check.py"
  ARM="变异件"
fi
if DSH_RESTORE_CHECK="$TOOL" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "干预恢复腿: 窗口结束后池不得仍留干预态, 且恢复须有记录" >/dev/null 2>&1; then
  if [ "$CLEAN" = "1" ]; then
    echo "[guard-fire] T219 干净臂: 原件被判绿(应然)" >&2
    exit 0
  fi
  echo "变异版(永不判红)仍被判绿 —— 恢复腿失效会再次被静默放行" >&2
  exit 4
fi
if [ "$CLEAN" = "1" ]; then
  echo "原件被判红 —— 判据在干净件上就是红的, 对变异没有区分力" >&2
  exit 3
fi
echo "[guard-fire] FIRED T219: 永不判红的恢复判据被抓($ARM)" >&2
exit 1
