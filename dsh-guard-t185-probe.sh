#!/usr/bin/env bash
# dsh-guard-t185-probe.sh — T185「--write --show 必须真的写入」的开火探针(**双臂**)
# 语义: 把写入方变异回**静默空操作**的旧形态(--show 在写入之前 return 0), 判据必须抓住它 —— 这正是
#       2026-09-13 那次"以为恢复了、其实没写"的形态: 打印正常、exit 0, 而池子没变。
# 双臂约定: 变异臂喂**变异件** ⇒ 判据必须红 ⇒ 退出 1; 干净臂(DSH_PROBE_CLEAN=1)喂**原件** ⇒ 必须绿 ⇒ 退出 0。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
CLEAN="${DSH_PROBE_CLEAN:-}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ "$CLEAN" = "1" ]; then
  TOOL="$HOME/dsh-fork/dsh-goal-pool-write.py"
  ARM="干净件"
else
  python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-goal-pool-write.py"), encoding="utf8").read()
marker = "    if args.show and not args.write:"
assert src.count(marker) == 1, "找不到 --show 短路行(结构变了, 探针自身失效)"
mut = src.replace(marker, "    if args.show:   # 变异: 恢复静默空操作(写入前就 return)")
open(os.path.join(T, "mutant-pool-write.py"), "w", encoding="utf8").write(mut)
MK
  TOOL="$TMP/mutant-pool-write.py"
  ARM="变异件"
fi
if DSH_POOL_WRITE_TOOL="$TOOL" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "--write --show 必须真的写入(不得静默空操作), 纯 --show 必须只读" >/dev/null 2>&1; then
  if [ "$CLEAN" = "1" ]; then
    echo "[guard-fire] T185 干净臂: 原件被判绿(应然)" >&2
    exit 0
  fi
  echo "变异版(--show 静默空操作)仍被判绿 —— 写入方会继续吃掉恢复动作" >&2
  exit 4
fi
if [ "$CLEAN" = "1" ]; then
  echo "原件被判红 —— 判据在干净件上就是红的, 对变异没有区分力" >&2
  exit 3
fi
echo "[guard-fire] FIRED T185: --show 静默空操作的变异版被判据抓住($ARM)" >&2
exit 1
