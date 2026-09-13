#!/usr/bin/env bash
# dsh-guard-t248-probe.sh — T248「经验链进入注入」的开火探针(**双臂**)
# 两个变异体必须各自让判据转红:
#   A 链检索被关掉(chain.enabled -> false)  ⇒ 链永远不被服务 ⇒ 服务类用例红
#   B 注入记录不带 chainId                   ⇒ 结算侧折不到链 ⇒ hitCount/citedCount 恒 0(回到原病)
#   C 忽略会话级条数上限(链是大块头)          ⇒ 同一会话把多条链都塞进上下文 ⇒ 预算被吃
#   D 关掉语义键(查询向量传 null)             ⇒ 换个说法问同一件事又找不到了
#   E 忽略语义空间门槛(置 0)                  ⇒ 语义门槛失效, 不相关的链也会被服务
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
for M in A B C D E; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("      ? await retrieveChain(ctx.cognitivePipeline, situation, agent.session.id, resolved.chain, queryEmbedding)",
           "      ? null  /* MUTANT A: 链检索被关掉 */")],
    "B": [("      ...chainHit === null ? {} : { chainId: chainHit.chainId },",
           "      /* MUTANT B: 注入记录不再带 chainId */")],
    "C": [("  if (served.size >= config.maxPerSession) return null",
           "  if (false) return null  /* MUTANT C: 忽略会话级条数上限 */")],
    "D": [("      ? await retrieveChain(ctx.cognitivePipeline, situation, agent.session.id, resolved.chain, queryEmbedding)",
           "      ? await retrieveChain(ctx.cognitivePipeline, situation, agent.session.id, resolved.chain, null)  /* MUTANT D: 关掉语义键 */")],
    "E": [("    const semanticFloor = config.minSimilarity + config.semanticMargin",
           "    const semanticFloor = 0  /* MUTANT E: 忽略语义空间门槛 */")],
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
echo "[guard-fire] FIRED T248: 关链检索 / 丢 chainId / 忽略会话上限 / 关语义键 / 忽略语义门槛 都被判据抓住" >&2
exit 1
