#!/usr/bin/env bash
# dsh-guard-t217-probe.sh — T217「引用率消费方必须按引用时代过滤」的开火探针(**双臂**)
# 语义: 把消费方变异回**跨时代混算**的旧口径(即"时代"变成一句注释而非被行为消费的过滤),
#       判据必须抓到它 —— 否则 T217 只是一条永远绿的文本声明(T202/T212 家族的同一个坑)。
# 双臂约定(2026-09-12 20:0x 补): 只跑变异臂的探针只能证明"判据会红", 不能证明"判据会红在变异上"
#   —— 一条常退 1 的假探针同样能骗过只看出场码的核验。故:
#     · 变异臂(默认): 喂**变异件** ⇒ 判据必须红 ⇒ 退出 1(期望值)
#     · 干净臂(DSH_PROBE_CLEAN=1): 喂**原件** ⇒ 判据必须绿 ⇒ 退出 0
#   两臂合起来才说明"这条判据区分得出对错"。
#   exit 1 = FIRED(变异被抓) / exit 4 = 漂移(变异版仍被判绿) / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
CLEAN="${DSH_PROBE_CLEAN:-}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ "$CLEAN" = "1" ]; then
  TOOL="$HOME/dsh-fork/dsh-citation-by-trigger.py"
  ARM="干净件"
else
  python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-citation-by-trigger.py"), encoding="utf8").read()
marker = "    rows = [r for r in all_rows if (r.get('createdAt') or 0) >= era_ms]"
assert src.count(marker) == 1, "找不到时代过滤行(结构变了, 探针自身失效)"
mut = src.replace(marker, "    rows = list(all_rows)   # 变异: 忽略时代, 跨时代混算")
open(os.path.join(T, "mutant-cbt.py"), "w", encoding="utf8").write(mut)
MK
  TOOL="$TMP/mutant-cbt.py"
  ARM="变异件"
fi
if DSH_CBT_TOOL="$TOOL" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "引用率消费方必须按时代过滤且缺时代拒出数" >/dev/null 2>&1; then
  if [ "$CLEAN" = "1" ]; then
    echo "[guard-fire] T217 干净臂: 原件被判绿(应然)" >&2
    exit 0
  fi
  echo "变异版(跨时代混算)仍被判绿 —— 时代没被行为消费, 死亡通道会被误判" >&2
  exit 4
fi
if [ "$CLEAN" = "1" ]; then
  echo "原件被判据判红 —— 判据在干净件上就红, 它对变异毫无区分力" >&2
  exit 3
fi
echo "[guard-fire] FIRED T217: 跨时代混算的消费方被判据抓住($ARM)" >&2
exit 1
