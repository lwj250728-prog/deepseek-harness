#!/usr/bin/env bash
# dsh-guard-t233-probe.sh — T233「池压实与写者互斥」的开火探针(**双臂**)
# 变异臂: 让**写者不持锁**(`_lock = _pool_guard(...)` → `_lock = None`) ⇒ 写者不再等锁 ⇒ T233 判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T233 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="池压实与写者必须互斥: 写者等锁 + 压实成功 + 两者都不丢"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-goal-pool-write.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T233 干净臂: 未变异时判绿(应然)" >&2
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
old = "    _lock = _pool_guard(args.pool) if args.write else None"
new = "    _lock = None  # MUTANT: 写者不持锁(互斥失效)"
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 写者不持锁" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "写者不持锁后判据仍判绿 —— 并发窗口不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T233: 写者不持锁(互斥失效)被判据抓住" >&2
exit 1
