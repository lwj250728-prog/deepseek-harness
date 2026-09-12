#!/usr/bin/env bash
# dsh-guard-t206-probe.sh — T206「一次性会话的注入立刻结算」的开火探针
# 语义: 把 service.ts **变异**成旧行为(去掉一次性会话规则 ⇒ 旁路会话的注入又只能等 24h TTL),
#       再让 T206 的判据去审它 —— 必须判红。
#   exit 1 = FIRED(判据能抓住旧行为)
#   exit 4 = 漂移(变异版仍判绿 ⇒ 守卫是死的)
#   exit 3 = 探针自身失效(源码结构与假设不符)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
marker = "if (stale.createdAt > cutoff && !(oneShotSession(String(stale.sessionId)) && stale.createdAt <= oneShotCutoff)) continue"
assert src.count(marker) == 1, "找不到一次性会话判断(结构变了, 探针自身失效)"
mut = src.replace(marker, "if (stale.createdAt > cutoff) continue   // 变异: 旧行为(等 24h TTL)")
open(os.path.join(T, "mutant-service.ts"), "w", encoding="utf8").write(mut)
MK
if DSH_SVC_SRC="$TMP/mutant-service.ts" python3 -c '
import os, re
src = open(os.environ["DSH_SVC_SRC"], encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js"), encoding="utf8").read()
blk = re.search(r"for \(const stale of this\.store\.injectionsSnapshot\(\)\) \{(.*?)\n    \}", src, re.S)
assert blk, "找不到 stale 结算循环"
body = blk.group(1)
assert "stale.sessionId === sessionId" in body, "当前会话的跳过判断消失了"
assert "oneShotSession" in body, "stale 分支没有消费一次性会话规则(仍在等 24h TTL)"
assert body.index("stale.sessionId === sessionId") < body.index("createdAt > cutoff"), "顺序不对"
assert "quiet-frame-" in lib, "产物里没有规则"
' 2>/dev/null; then
  echo "变异成旧行为(去掉一次性会话规则)却判绿了 —— 重启打断的注入又会滞留 24h" >&2
  exit 4
fi
echo "[guard-fire] FIRED T206: 去掉一次性会话规则后 T206 判红" >&2
exit 1
