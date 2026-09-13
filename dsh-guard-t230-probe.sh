#!/usr/bin/env bash
# dsh-guard-t230-probe.sh — T230「探针有效性绑定」的开火探针(**双臂**)
# 变异臂: 把 dsh-probe-binding.py 的**锚点检查**关掉(等价于"锚点漂移不报警") ⇒ T230 的锚点漂移那步必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T230 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="双臂探针的有效性绑定: 锚点漂移/判据体过期/干净臂红 必须判红"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-probe-binding.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T230 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$SRC" "$BAK" || exit 3
trap 'cp -p "$BAK" "$SRC"; rm -f "$BAK"' EXIT   # -p 保留 mtime: 复原推新时间戳会污染 mtime 类判据
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = """            n = f(body, frag)
            if n != 1:"""
new = """            n = f(body, frag)
            if n != 1 and False:  # MUTANT: 锚点漂移不报警"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 锚点漂移不报警" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "关掉锚点检查后判据仍判绿 —— 锚点漂移不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T230: 关掉锚点检查(锚点漂移不报警)被判据抓住" >&2
exit 1
