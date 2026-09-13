#!/usr/bin/env bash
# dsh-guard-t255-probe.sh — T255「就绪读数留痕」开火探针(**双臂**)
# 三个变异体必须各自让判据转红:
#   A 无视 DRY            ⇒ 判据自检会污染读数历史
#   B 覆盖而非追加        ⇒ 并发跑套件互相吃掉历史(只剩 1 行)
#   C 附属写入失败改成抛出 ⇒ **主判定被带走**(本会话实测过的崩溃形态: rc=1 且无任何输出)
set -uo pipefail
NAME="链就绪读数必须落成可判读的滚动数据: DRY 不写 + 追加不覆盖 + 有上限 + 附属写入失败不许带走主判定"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-chain-readiness.py"
if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T255 干净臂: 未变异时判绿(应然)" >&2; exit 0
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
    "A": [("    if args.record and os.environ.get('DSH_CHAIN_READINESS_DRY') != '1':",
           "    if args.record:  # MUTANT A: 无视 DRY")],
    "B": [("        with open(path, 'a', encoding='utf8') as fh:",
           "        with open(path, 'w', encoding='utf8') as fh:  # MUTANT B: 覆盖而非追加")],
    "C": [("        print('[ready] 读数落盘失败(不影响本次判定): %s' % exc, file=sys.stderr)\n        return None",
           "        print('[ready] 读数落盘失败(不影响本次判定): %s' % exc, file=sys.stderr)\n        raise  # MUTANT C: 附属失败改抛出")],
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
echo "[guard-fire] FIRED T255: 无视 DRY / 覆盖历史 / 附属失败抛出 都被判据抓住" >&2
exit 1
