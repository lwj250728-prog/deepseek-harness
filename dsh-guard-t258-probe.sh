#!/usr/bin/env bash
# dsh-guard-t258-probe.sh — T258「被直接调用脚本的执行位」开火探针(**双臂**)
# 两个变异体: A 忽略执行位(把不可执行也算过) / B 只扫 `test -x` 而漏掉 `bash -c "…'脚本'…"` 这种调用形态
set -uo pipefail
NAME="被套件按路径直接调用的脚本必须存在且可执行(不许只有一个文件靠运气被测)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-script-exec-check.py"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T258 干净臂: 未变异时判绿(应然)" >&2; exit 0
  fi
  echo "干净臂: 未变异时就判红" >&2; exit 3
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
    "A": [("        elif not os.access(p, os.X_OK):",
           "        elif False:  # MUTANT A: 忽略执行位")],
    "B": [("        for m in list(PATTERNS[1].finditer(line)) + list(PATTERNS[2].finditer(line)):",
           "        for m in []:  # MUTANT B: 漏掉 bash -c 形态")],
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
echo "[guard-fire] FIRED T258: 忽略执行位 / 漏掉 bash -c 形态 都被判据抓住" >&2
exit 1
