#!/usr/bin/env bash
# dsh-guard-t231-probe.sh — T231「合成世界非退化自证」的开火探针(**双臂**)
# 变异臂: 让 dsh-degeneracy-check.py **不施加**变异(把 `mutated = src.replace(...)` 改成 `mutated = src`)
#   ⇒ 判据不变红 ⇒ 检查必须报告"没被抓住/变异没落盘"并判红 ⇒ T231 必须红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T231 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="合成世界判据必须自证非退化: 退化变异须翻红 + 新增须登记 + 判别量非零"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-degeneracy-check.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T231 干净臂: 未变异时判绿(应然)" >&2
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
old = "            mutated = src.replace(e['old'], e['new'])"
new = "            mutated = src  # MUTANT: 不施加变异(退化变异变成空操作)"
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 不施加变异" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "把退化变异变成空操作后判据仍判绿 —— 假绿不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T231: 退化变异变成空操作(假绿路径)被判据抓住" >&2
exit 1
