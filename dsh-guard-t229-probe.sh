#!/usr/bin/env bash
# dsh-guard-t229-probe.sh — T229「阶段总结三个口径」的开火探针(**双臂**)
# 变异臂: 把 dsh-stage-summary.py 的失败身份窗口改回**固定 400 行**、并去掉尾部"失败项:"块解析
#   (= 复现外部评审抓到的那版缺陷) ⇒ T229 必须判红(合成日志里那条 ✗ 落在 400 行之外)。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T229 必须判绿(证明变异臂的红不是"判据本来就红")。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="阶段总结: 失败身份须与裁决一致 + 新入账按首次出现 + 换血须披露"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-stage-summary.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T229 干净臂: 未变异时判绿(应然)" >&2
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
a_old = """        _blk_start = _marks[-2] if len(_marks) >= 2 else 0
        tail = lines[_blk_start: (_marks[-1] + 1 if _marks else len(lines))]"""
a_new = """        tail = lines[max(0, len(lines) - 400):]  # MUTANT: 回到固定 400 行窗口"""
b_old = """        after = lines[_marks[-1]:] if _marks else []"""
b_new = """        after = []  # MUTANT: 不再解析尾部失败项块"""
assert s.count(a_old) == 1 and s.count(b_old) == 1, "结构变了, 探针自身失效"
s = s.replace(a_old, a_new).replace(b_old, b_new)
open(p, "w", encoding="utf8").write(s)
back = open(p, encoding="utf8").read()
assert "MUTANT: 回到固定 400 行窗口" in back and "MUTANT: 不再解析尾部失败项块" in back, "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "回到固定窗口 + 不解析尾部块后判据仍判绿 —— 少列身份不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T229: 固定 400 行窗口(少列失败身份)被判据抓住" >&2
exit 1
