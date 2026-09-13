#!/usr/bin/env bash
# dsh-guard-t252-probe.sh — T252「链检索键余量策略」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红(两个方向都要防):
#   A 策略里忽略余量(链自身语义键按裸阈值) ⇒ 薄边重新被放行 ⇒ "余量足够大时不许放行"失败
#   B 把余量也加到**成员**路上                ⇒ 成员命中的链被误杀 ⇒ "成员路不受余量影响"失败
set -uo pipefail
NAME="链检索键的余量策略: 加余量只许更严不许更宽 + 成员路不受余量影响"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-key-audit.mjs"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T252 干净臂: 未变异时判绿(应然)" >&2; exit 0
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
    "A": [("      policyHit: memberScore >= threshold || Math.max(goalScore, principleScore) >= threshold + goalMargin,",
           "      policyHit: memberScore >= threshold || Math.max(goalScore, principleScore) >= threshold, /* MUTANT A: 忽略余量 */")],
    "B": [("      policyHit: memberScore >= threshold || Math.max(goalScore, principleScore) >= threshold + goalMargin,",
           "      policyHit: memberScore >= threshold + goalMargin || Math.max(goalScore, principleScore) >= threshold + goalMargin, /* MUTANT B: 余量也加到成员路 */")],
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
echo "[guard-fire] FIRED T252: 忽略余量 / 余量误伤成员路 都被判据抓住" >&2
exit 1
