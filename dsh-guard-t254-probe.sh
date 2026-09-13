#!/usr/bin/env bash
# dsh-guard-t254-probe.sh — T254「语义标定脚本的判据」开火探针(**双臂**)
# 变异体(都对应"声明在、行为不在"的一类):
#   A 缺 key 不再 fail-closed(exit 3 → 0) ⇒ 会静默产出假结论
#   B 留一法不排除自身            ⇒ 真身链恒 1.0, 精度被虚高
set -uo pipefail
NAME="语义标定脚本: 缺 key 必须 fail-closed + 留一法排除自身 + 分组按成员 + 可复算"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-key-semantic-audit.mjs"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T254 干净臂: 未变异时判绿(应然)" >&2; exit 0
  fi
  echo "干净臂: 未变异时就判红" >&2; exit 3
fi
BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
restore() { cp -p "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT
survived=""
for M in A B; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("    console.error('[semantic-audit] 拿不到 SILICONFLOW_API_KEY ⇒ 环境不成立(不静默退回词面, 那会让结论失真)')\n    process.exit(3)",
           "    process.exit(0)  /* MUTANT A: 不再 fail-closed */")],
    "B": [("      if (other.expId === m.expId) continue\n      const v = vec(String(other.sar?.situation ?? ''))",
           "      const v = vec(String(other.sar?.situation ?? ''))  /* MUTANT B: 不排除自身 */")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s)" % which
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read()
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效" >&2; exit 3; fi
done
if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 判据无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T254: 取消 fail-closed / 留一法含自身 都被判据抓住" >&2
exit 1
