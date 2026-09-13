#!/usr/bin/env bash
# dsh-guard-t238-probe.sh — T238「变异复原必须保持元数据」的开火探针(**双臂**)
# 变异臂: 让介入层**不还 mtime**(把 `_restore_meta()` 的调用点短路) ⇒ 探针跑完 mtime 被推新 ⇒ T238 必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T238 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="变异复原必须保持元数据: 跑探针前后 sha256 复原一致且 mtime_ns 不变"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-mutation-lock.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T238 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
trap 'cp -p "$BAK" "$SRC"; rm -f "$BAK"' EXIT
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = """            rc = subprocess.run(['bash', '-lc', args.shell]).returncode
            _restore_meta()"""
new = """            rc = subprocess.run(['bash', '-lc', args.shell]).returncode
            # MUTANT: 不还 mtime(介入层不再保管元数据)"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 不还 mtime" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "介入层不还 mtime 后判据仍判绿 —— 元数据污染不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T238: 介入层不还 mtime(复原推新时间戳)被判据抓住" >&2
exit 1
