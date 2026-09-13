#!/usr/bin/env bash
# dsh-guard-t248-probe.sh — T248「经验链进入注入」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红:
#   A 链检索被关掉(chain.enabled -> false)  ⇒ 链永远不被服务 ⇒ 服务类用例红
#   B 注入记录不带 chainId                   ⇒ 结算侧折不到链 ⇒ hitCount/citedCount 恒 0(回到原病)
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T248 必绿。
set -uo pipefail
NAME="经验链进入注入: 能被找到 + 被渲染 + 引用回填到链账本"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T248 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
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
    "A": [("      ? retrieveChain(ctx.cognitivePipeline, situation, agent.session.id, resolved.chain)",
           "      ? null  /* MUTANT A: 链检索被关掉 */")],
    "B": [("      ...chainHit === null ? {} : { chainId: chainHit.chainId },",
           "      /* MUTANT B: 注入记录不再带 chainId */")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s): %r" % (which, old[:50])
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read(), "变异没落盘"
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
done

if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 判据对这些缺陷无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T248: 链检索关掉 / 注入记录丢 chainId 都被判据抓住" >&2
exit 1
