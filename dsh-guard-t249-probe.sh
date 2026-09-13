#!/usr/bin/env bash
# dsh-guard-t249-probe.sh — T249「部署滞后见证」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红:
#   A `build-stale` 分支被抹掉(源码比产物新也不报) ⇒ 四档判定错 ⇒ "忘了构建"重新变成静默
#   B 退出码恒 0(有滞后也说"没问题")          ⇒ "需要动作"与"全部生效"同码, 正是本工具要消灭的那种含糊
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T249 必绿。
set -uo pipefail
NAME="部署滞后见证: 源码/产物/载体三者任一旧了都必须可见"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-deploy-lag.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T249 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
restore() { cp -p "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT

survived=""
for M in A B; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("    if src is not None and src > lib + TOLERANCE_S:",
           "    if False:  # MUTANT A: 源码比产物新也不报")],
    "B": [("    return 1 if stale else 0",
           "    return 0  # MUTANT B: 有滞后也说没问题")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s): %r" % (which, old[:50])
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read(), "变异没落盘"
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
done

if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 判据对这些缺陷无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T249: 漏报 build-stale / 退出码恒 0 都被判据抓住" >&2
exit 1
