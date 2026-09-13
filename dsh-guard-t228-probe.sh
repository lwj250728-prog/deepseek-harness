#!/usr/bin/env bash
# dsh-guard-t228-probe.sh — T228「三个门的时限五条路径」的开火探针(**双臂**)
# 变异臂: 让冻结门的 `_deadline_release` **永不成立**(等价于"时限声明是装饰, 到点也不放行") ⇒ T228 的④必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T228 必须判绿(证明变异臂的红不是"判据本来就红")。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="三个门的时限五条路径(读不到世界不得靠时限放行)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-wait-check-retrieval-freeze.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T228 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$SRC" "$BAK" || exit 3
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = """    if not passed:
        return False"""
new = """    if True:  # MUTANT: 时限声明变装饰(到点也不放行)
        return False"""
assert s.count(old) == 1, "找不到 _deadline_release 的取值行(结构变了, 探针自身失效)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 时限声明变装饰" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "把时限声明改成装饰后判据仍判绿 —— 装饰性时限不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T228: 把时限声明改成装饰(到点不放行)被判据抓住" >&2
exit 1
