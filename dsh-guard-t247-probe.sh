#!/usr/bin/env bash
# dsh-guard-t247-probe.sh — T247「目标树编码端」的开火探针(**双臂**)
# 变异臂: 把 service.remember 里的 parentNodeId 落盘抹掉 ⇒ 委派回执进不了 store ⇒ 子链挂不上父链, T247 必红。
#   (复现 cl-347 的原病: 字段类型与持久化都在, 但**没有任何入口把它写进去**。)
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T247 必绿。
set -uo pipefail
NAME="目标树: 委派回执经工具写入后真的长出子链(编码端)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T247 干净臂: 未变异时判绿(应然)" >&2
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
old = "      ...input.parentNodeId === undefined ? {} : { parentNodeId: input.parentNodeId },"
assert s.count(old) == 1, "结构变了, 探针自身失效"
new = "      // MUTANT: 委派回执不再落盘(编码端入口被抹掉, 树长不出来)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 委派回执不再落盘" in open(p, encoding="utf8").read(), "变异没落盘"
MK
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
cp -p "$BAK" "$SRC"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
if [ "$rc" -eq 0 ]; then echo "抹掉回执落盘后判据仍判绿 —— 编码端有没有入口没人管" >&2; exit 4; fi
if [ "$rc" -eq 3 ]; then echo "变异臂拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
echo "[guard-fire] FIRED T247: 委派回执不落盘(树边无入口)被判据抓住" >&2
exit 1
