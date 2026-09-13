#!/usr/bin/env bash
# dsh-guard-t250-probe.sh — T250「产物层端到端」的开火探针(**双臂**)
# 变异体作用在**产物副本**上(绝不改真 lib):
#   A 把链检索调用抹掉(retrieveChain → null)      ⇒ 链不被服务 ⇒ 校验器必红
#   B 注入记录丢掉 chainId                          ⇒ 结算侧折不到链 ⇒ 校验器必红
# 干净臂(DSH_PROBE_CLEAN=1): 真产物 ⇒ 6/6 全通。
set -uo pipefail
NAME="构建产物层端到端: 链能被找到+被注入+引用折回链账本"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
ART="$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T250 干净臂: 真产物判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 真产物就判红 —— 判据无区分力或产物坏了" >&2
  exit 3
fi

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
survived=""
for M in A B; do
  MUT="$TMPD/mutant-$M.js"
  python3 - "$ART" "$MUT" "$M" <<'MK' || exit 3
import sys
src, dst, which = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf8").read()
REPL = {
    "A": [("resolved.chain.enabled ? retrieveChain(ctx.cognitivePipeline, situation, agent.session.id, resolved.chain) : null",
           "null /* MUTANT A: 链检索被抹掉 */")],
    "B": [("chainHit === null ? {} : { chainId: chainHit.chainId }",
           "/* MUTANT B: 注入记录不再带 chainId */")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "产物结构变了, 探针自身失效(%s): %r" % (which, old[:40])
    s = s.replace(old, new)
open(dst, "w", encoding="utf8").write(s)
assert "MUTANT" in open(dst, encoding="utf8").read(), "变异没落盘"
MK
  DSH_VERIFY_INJECT_ARTIFACT="$MUT" python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
done
if [ -n "$survived" ]; then echo "变异体$survived 存活 ⇒ 产物层校验对这些缺陷无区分力" >&2; exit 4; fi
echo "[guard-fire] FIRED T250: 产物里抹掉链检索 / 丢 chainId 都被产物层校验抓住" >&2
exit 1
