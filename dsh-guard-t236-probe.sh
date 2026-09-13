#!/usr/bin/env bash
# dsh-guard-t236-probe.sh — T236「介入层不许误读」的开火探针(**双臂**)
# 变异臂: 让闸门的 in_flight() **恒假**(`if not os.path.exists(lp): return False` → `if True: return False`)
#   ⇒ 持锁时不再报「在飞的变异」⇒ T236 的①必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T236 必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="介入层不许误读: 持锁⇒在飞不算泄漏 + 锁被持⇒带外码 7 且裁 infra + 见证锁有界"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-mutant-gate.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T236 干净臂: 未变异时判绿(应然)" >&2
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
old = """    lp = os.path.join(locks_dir, hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:16] + '.lock')
    if not os.path.exists(lp):
        return False"""
new = """    lp = os.path.join(locks_dir, hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:16] + '.lock')
    if True:  # MUTANT: 在飞识别恒假
        return False"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 在飞识别恒假" in open(p, encoding="utf8").read(), "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "在飞识别恒假后判据仍判绿 —— 持锁时的泄漏误报不会被抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T236: 在飞识别恒假(持锁被读成泄漏)被判据抓住" >&2
exit 1
