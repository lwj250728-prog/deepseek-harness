#!/usr/bin/env bash
# dsh-guard-t228-probe.sh — T228「三个门的时限五条路径(读不到世界不得靠时限放行)」的开火探针(**双臂**)
#
# tp-196 的要求是两条变异: ①删掉门的时限消费 ⇒ "过期放行"那条必须转红; ②把坏时限那条改成 pass ⇒
# "fail-closed"那条必须转红。本探针再加第三条, 因为它钉的正是 tp-196 执行中**真抓到的那个洞**:
#   ③δ 门"活配置读不到"这一支当年会靠时限放行(DSH_WEB_CONFIG=/nonexistent + 过去时限 ⇒ exit 0),
#     把 `if not readable:` 去掉 ⇒ 第⑤条(读不到状态却靠时限放行)必须转红。
#
#   exit 1 = FIRED(每个变异臂都被判据抓住) / exit 4 = 漂移(某臂变异后判据仍绿) /
#   exit 3 = 探针自身失效(找不到待变异的行、或变异没落盘) / exit 0 = 干净臂(未变异时判绿)
set -uo pipefail
NAME="三个门的时限五条路径(读不到世界不得靠时限放行)"
RUNNER="$HOME/dsh-fork/dsh-assert-runner.py"
FREEZE="$HOME/dsh-fork/dsh-wait-check-retrieval-freeze.py"
DIVER="$HOME/dsh-fork/dsh-wait-check-diversity-arm.py"

judge() { python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; }

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if judge; then
    echo "[guard-fire] T228 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

A_BAK=$(mktemp); B_BAK=$(mktemp); C_BAK=$(mktemp)
cp "$FREEZE" "$A_BAK" || exit 3
cp "$FREEZE" "$B_BAK" || exit 3
cp "$DIVER"  "$C_BAK" || exit 3
# 注意: restore **只还原、不删备份** —— 备份必须活到 EXIT。实测: 初版让 restore 顺手 rm 备份, 于是第二次
# 还原时 cp 失败, 第二个变异留在文件里被带出了探针(探针自己污染了世界)。还原后还要复核没有 MUTANT- 残留。
restore() { cp "$A_BAK" "$FREEZE"; cp "$B_BAK" "$FREEZE"; cp "$C_BAK" "$DIVER"; }
cleanup() { restore; rm -f "$A_BAK" "$B_BAK" "$C_BAK"; }
trap cleanup EXIT

check_clean() {
  if grep -q "MUTANT-" "$FREEZE" "$DIVER"; then
    echo "还原失败: 变异残留在门里 ⇒ 探针污染了世界" >&2
    exit 3
  fi
}

mutate() {
python3 - "$1" <<'MK' || exit 3
import os, sys
mid = sys.argv[1]
home = os.path.expanduser("~")
M = {
  "A": (home + "/dsh-fork/dsh-wait-check-retrieval-freeze.py",
        "    if _deadline_release(_dl_passed, 'retrieval-freeze'):",
        "    if False:  # MUTANT-A 时限消费被删"),
  "B": (home + "/dsh-fork/dsh-wait-check-retrieval-freeze.py",
        "    if _dl_state == 'bad':",
        "    if False:  # MUTANT-B 坏时限不再 fail-closed"),
  "C": (home + "/dsh-fork/dsh-wait-check-diversity-arm.py",
        "    if not readable:",
        "    if False:  # MUTANT-C 读不到活配置也允许走到时限放行"),
}
path, old, new = M[mid]
s = open(path, encoding="utf8").read()
assert s.count(old) == 1, "找不到待变异的行(" + mid + "): 结构变了, 探针自身失效"
open(path, "w", encoding="utf8").write(s.replace(old, new, 1))
assert "MUTANT-" + mid in open(path, encoding="utf8").read(), "变异没落盘"
print("mutated " + mid + " in " + os.path.basename(path))
MK
}

DRIFT=""
for M in A B C; do
  mutate "$M" || exit 3
  if judge; then
    DRIFT="$DRIFT $M"
  fi
  restore
  check_clean
done

if [ -n "$DRIFT" ]; then
  echo "变异臂$DRIFT 之后判据仍判绿 —— 门的时限路径可以静默退化而没人抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T228: 三处变异(时限消费被删/坏时限不再 fail-closed/读不到活配置仍放行)全部被判据抓住" >&2
exit 1
