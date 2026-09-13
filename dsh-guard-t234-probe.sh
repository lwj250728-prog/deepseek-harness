#!/usr/bin/env bash
# dsh-guard-t234-probe.sh — T234「池写者检查器可判别」的开火探针(**双臂**)
# 变异臂: 让检查器**只认 flock 不认 LOCK_EX**(`if 'LOCK_EX' in src: return 'ex'` 之下再加"有 flock 就算 ex")
#   ⇒ 只请求共享锁的合成写者不再被抓 ⇒ T234 判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T234 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="池写者检查器可判别: 漏锁与只请求共享锁必被抓 + 真世界写者名单可数且行为等锁"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-pool-writer-lock-check.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T234 干净臂: 未变异时判绿(应然)" >&2
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
old = """    if 'LOCK_SH' in src:
        return 'shared'"""
new = """    if 'flock' in src:
        return 'ex'  # MUTANT: 只认 flock 不认 LOCK_EX(共享锁被当成互斥)"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 只认 flock 不认 LOCK_EX" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "共享锁被当成互斥后判据仍判绿 —— 静态撒谎不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T234: 只认 flock 不认 LOCK_EX(共享锁冒充互斥)被判据抓住" >&2
exit 1
