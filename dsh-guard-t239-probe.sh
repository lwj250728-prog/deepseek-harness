#!/usr/bin/env bash
# dsh-guard-t239-probe.sh — T239「零可跑 spec 判定口径」的开火探针(**双臂**)
# 变异臂: 让 T237 的包内扫描**退回只看 tests/**(`os.walk(os.path.join(ROOT, p))` → 加 "tests" 子目录)
#   ⇒ tests/ 之外放 spec 的合成包会被当成"零可跑 spec" ⇒ T239 判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T239 必须判绿。
set -uo pipefail
NAME="零可跑 spec 的判定必须按包内任意位置: tests/ 外的 spec 也算 + 债清单逐条可解释"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-cog-tests.sh"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T239 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
trap 'cp -p "$BAK" "$SRC"; rm -f "$BAK"' EXIT
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = "    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, p)):"
new = "    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, p, \"tests\")):  # MUTANT: 退回只看 tests/"
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 退回只看 tests/" in open(p, encoding="utf8").read(), "变异没落盘"
MK
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then
  echo "退回只看 tests/ 后判据仍判绿 —— tests/ 外的 spec 会被误记为债" >&2
  exit 4
fi
if [ "$rc" -eq 3 ]; then
  echo "变异臂拿到 exit 3(取不到断言) ⇒ 这是**探针自身失效**, 不是开火(实测踩过: 判据没进套件时被当成 FIRED)" >&2
  exit 3
fi
cp -p "$BAK" "$SRC"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败(套件哈希不符)" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
echo "[guard-fire] FIRED T239: 退回只看 tests/(tests/ 外的 spec 被误记为债)被判据抓住" >&2
exit 1
