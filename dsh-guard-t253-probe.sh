#!/usr/bin/env bash
# dsh-guard-t253-probe.sh — T253「链就绪状态机」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红(都对应"跳步即误判"):
#   A 把"载体未加载"当成已加载 ⇒ 未生效就开始谈效果(状态从 built-stale 跳到 live-warming)
#   B 跳过产物可用性校验       ⇒ 产物坏了也报"在累积样本"(blocked 被吞成 live-warming)
set -uo pipefail
NAME="链就绪状态机: 未构建/未加载/样本不足/通过/不通过/观测不成立 六档不许跳步"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-readiness.py"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T253 干净臂: 未变异时判绿(应然)" >&2; exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2; exit 3
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
    "A": [("        elif carrier_stale:\n            state = 'built-stale'",
           "        elif carrier_stale:\n            state = 'live'  # MUTANT A: 未加载也当成已加载")],
    "B": [("        step('产物层端到端可用', ok, 'passed=%s/%s' % (passed, total))\n        if not ok:\n            state = 'blocked'",
           "        step('产物层端到端可用', ok, 'passed=%s/%s' % (passed, total))\n        if False:\n            state = 'blocked'  # MUTANT B: 跳过可用性校验")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s)" % which
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read(), "变异没落盘"
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效" >&2; exit 3; fi
done
if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 判据无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T253: 未加载当已加载 / 跳过产物校验 都被判据抓住" >&2
exit 1
