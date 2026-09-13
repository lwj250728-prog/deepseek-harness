#!/usr/bin/env bash
# dsh-guard-t256-probe.sh — T256「就绪读数新字段」开火探针(**双臂**)
# 三个变异体(各对应一条断言的方向):
#   A resolved 不按关心的包过滤 ⇒ 越界(202 个插件全塞进去, 行膨胀)
#   B repo 用另一套口径(把 live 也算可交付) ⇒ 与 deploy-lag 判定不一致(决策会错)
#   C 上游不可用时编造部分字段(而不是 null) ⇒ "没测到"被当成"测到 0"
set -uo pipefail
NAME="就绪读数的新字段必须同口径且不越界: repo 与 deploy-lag 逐项一致 + resolved 只含关心的包且 mtime 属实"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-readiness.py"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T256 干净臂: 未变异时判绿(应然)" >&2; exit 0
  fi
  echo "干净臂: 未变异时就判红" >&2; exit 3
fi
BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
restore() { cp -p "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT
survived=""
for M in A B C; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("            if not any(target.endswith('/' + v) for v in (data.get('vendors') or [])):\n                continue",
           "            pass  # MUTANT A: 不按关心的包过滤")],
    "B": [("                'deliverableOnRestart': sorted(p for p, v in verdicts if v == 'carrier-stale'),",
           "                'deliverableOnRestart': sorted(p for p, v in verdicts if v in ('carrier-stale', 'live')),  # MUTANT B: 另一套口径")],
    # C 的靶子必须是**初始赋值**(上游不可用时 run_json 返回 None ⇒ 不进 except ⇒ 改 except 是惰性的, 这一版探针就这么空转过一次)
    "C": [("    repo = None\n    try:\n        rc2, payload, _ = run_json(",
           "    repo = {'scanned': 0, 'deliverableOnRestart': [], 'needsBuildFirst': []}  # MUTANT C: 上游不可用时编造部分字段\n    try:\n        rc2, payload, _ = run_json(")],
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
echo "[guard-fire] FIRED T256: resolved 越界 / repo 两套口径 / 编造部分字段 都被判据抓住" >&2
exit 1
