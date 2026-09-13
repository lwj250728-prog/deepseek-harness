#!/usr/bin/env bash
# dsh-guard-t232-probe.sh — T232「变异体泄漏闸门」的开火探针(**双臂**)
# 变异臂: 让闸门**不记录**泄漏(`leaks.append({...})` → `pass`) ⇒ 空清单下它不再报泄漏 ⇒ T232 判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T232 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="变异体不得被提交: 干净放行 + 清单确被消费 + 植入即判泄漏并指名"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-mutant-gate.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T232 干净臂: 未变异时判绿(应然)" >&2
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
old = "            leaks.append({'file': p, 'why': '含 %s 标记但不在合法容器清单里 ⇒ 疑似变异体泄漏' % MARK})"
new = "            pass  # MUTANT: 不记录泄漏(闸门变成睁眼瞎)"
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 不记录泄漏" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "闸门变成睁眼瞎后判据仍判绿 —— 泄漏不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T232: 闸门不记录泄漏被判据抓住" >&2
exit 1
