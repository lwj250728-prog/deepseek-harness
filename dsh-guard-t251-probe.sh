#!/usr/bin/env bash
# dsh-guard-t251-probe.sh — T251「链注入判定仪表」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红:
#   A 把"不可判"当成"通过"(rc 恒 0)          ⇒ 三态塌成一态: 没生效也会报通过
#   B 把一次性会话也算进"可引用样本"           ⇒ 只有一次性会话的夹具会从"不可判"翻成"不通过"(quie-frame 按设计永不被引用)
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T251 必绿。
set -uo pipefail
NAME="链注入判定仪表: 不可判/通过/不通过三态必须分开(含一次性会话不污染)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-inject-report.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T251 干净臂: 未变异时判绿(应然)" >&2
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
    "A": [("    if outcome in ('not-yet', 'insufficient'):\n        return 2",
           "    if False:  # MUTANT A: 不可判也当通过\n        return 2")],
    "B": [("    chain_normal = [r for r in chain if not is_one_shot(r.get('sessionId'))]",
           "    chain_normal = list(chain)  # MUTANT B: 一次性会话也算可引用样本")],
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
echo "[guard-fire] FIRED T251: 不可判当通过 / 一次性会话污染样本 都被判据抓住" >&2
exit 1
