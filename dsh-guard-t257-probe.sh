#!/usr/bin/env bash
# dsh-guard-t257-probe.sh — T257「增长闸门」开火探针(**双臂**)
# 三个变异体(对应当前闸门的三个失效方向):
#   A 只比数量不比成员 ⇒ 替换(数量相同成员不同)漏掉
#   B 从不写回棘轮     ⇒ "修好之后又坏回去"再也抓不住
#   C 基线不存在时把当前所有红当新红(不做引导) ⇒ 首次运行必然判红、基线永远建不起来
set -uo pipefail
NAME="新增判据不得抬高套件红数: 新红必判红 + 缩小必棘轮 + 比成员不比数量"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-suite-baseline.py"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T257 干净臂: 未变异时判绿(应然)" >&2; exit 0
  fi
  echo "干净臂: 未变异时就判红" >&2; exit 3
fi
BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
restore() { cp -p "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT
survived=""
for M in A B C; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("    new_reds = sorted(cur_failing - base_failing)",
           "    new_reds = sorted(cur_failing - base_failing) if len(cur_failing) > len(base_failing) else []  # MUTANT A: 只比数量")],
    "B": [("        base['failing'] = sorted(cur_failing)",
           "        pass  # MUTANT B: 不写回棘轮")],
    "C": [("    if base.get('createdAt') is None and not base_failing:",
           "    if False:  # MUTANT C: 不做引导")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s)" % which
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read()
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效" >&2; exit 3; fi
done
if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 判据无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T257: 只比数量 / 不写回棘轮 / 不做引导 都被判据抓住" >&2
exit 1
