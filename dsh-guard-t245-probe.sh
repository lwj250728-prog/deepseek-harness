#!/usr/bin/env bash
# dsh-guard-t245-probe.sh — T245「测量写回路径」的开火探针(**双臂**)
# 变异臂: 造一份检查器副本, 把「先扫残留再写回」那行**抹掉** ⇒ 写回块引用未赋值的 leaks
#   ⇒ 复现 cl-334 的 UnboundLocalError(写回整条路径崩), T245 必红。
# 干净臂(DSH_PROBE_CLEAN=1): 用真检查器 ⇒ T245 必绿。
set -uo pipefail
NAME="测量写回路径必须真的走通: 隔离登记簿下 --only 写回 rc=0 且字段落盘"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
CHK="$HOME/dsh-fork/dsh-probe-arms-check.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T245 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

TMPD=$(mktemp -d); MUT="$TMPD/arms-check-mutant.py"
cp -p "$CHK" "$MUT" || exit 3
python3 - "$MUT" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = "    leaks = _leak_scan()   # **先扫残留, 再写回**"
assert s.count(old) == 1, "结构变了, 探针自身失效"
new = "    pass  # MUTANT: 残留扫描被抹掉 ⇒ leaks 未赋值(复现 cl-334 的 UnboundLocalError)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 残留扫描被抹掉" in open(p, encoding="utf8").read(), "变异没落盘"
MK
DSH_ARMS_CHECK="$MUT" python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
rm -rf "$TMPD"
if [ "$rc" -eq 0 ]; then echo "抹掉写回前的残留扫描后判据仍判绿 —— 写回路径崩了没人管" >&2; exit 4; fi
if [ "$rc" -eq 3 ]; then echo "变异臂拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
echo "[guard-fire] FIRED T245: 写回前少了残留扫描(UnboundLocalError 那一类)被判据抓住" >&2
exit 1
