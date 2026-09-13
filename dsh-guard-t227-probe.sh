#!/usr/bin/env bash
# dsh-guard-t227-probe.sh — T227「池压实不得吃掉并发写入」的开火探针(**双臂**)
# 变异臂: 把压实工具的并发指纹复核去掉(等价于回到"读后直接落盘"的缺陷版) ⇒ T227 必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改工具 ⇒ T227 必须判绿(证明变异臂的红不是"判据本来就红")。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="池压实遇到并发写入必须拒绝且不得吃掉末行"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-goal-pool-compact.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T227 干净臂: 未变异时判绿(应然)" >&2
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
old = """        if (_st2.st_mtime_ns, _st2.st_size) != _fingerprint:"""
new = """        if False:  # MUTANT: 去掉并发指纹复核"""
assert s.count(old) == 1, "找不到并发复核行(结构变了, 探针自身失效)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 去掉并发指纹复核" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "去掉并发指纹复核后判据仍判绿 —— 并发的门声明会被静默回退而没人抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T227: 去掉并发复核的压实工具被判据抓住" >&2
exit 1
