#!/usr/bin/env bash
# dsh-guard-t240-probe.sh — T240「构建新鲜度判据的内容优先」的开火探针(**双臂**)
# 变异臂: 把 T159 退回**只看 mtime**(`if gap > 1 and content_changed(src):` → `if gap > 1:`) ⇒
#   T240 造的"仅 mtime 变新、内容与 HEAD 一致"现场会被 T159 误判成落后 ⇒ T240 必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T240 必须判绿。
set -uo pipefail
NAME="仅 mtime 变新但内容与 HEAD 一致时不得判 src 落后(内容优先)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-cog-tests.sh"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T240 干净臂: 未变异时判绿(应然)" >&2
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
old = "    if gap > 1 and content_changed(src):   # 1s 容忍文件系统粒度"
new = "    if gap > 1:   # MUTANT: 退回只看 mtime(丢掉内容优先)"
assert s.count(old) == 1, "结构变了(锚点不在): 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 退回只看 mtime" in open(p, encoding="utf8").read(), "变异没落盘"
MK
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ]; then
  echo "退回只看 mtime 后判据仍判绿 —— mtime 假红不会被抓" >&2
  exit 4
fi
if [ "$rc" -eq 3 ]; then
  echo "变异臂拿到 exit 3(取不到断言/前提不成立) ⇒ 探针自身失效, 不算开火" >&2
  exit 3
fi
cp -p "$BAK" "$SRC"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败(套件哈希不符)" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
echo "[guard-fire] FIRED T240: 退回只看 mtime(mtime 假红)被判据抓住" >&2
exit 1
