#!/usr/bin/env bash
# dsh-guard-t212-probe.sh — T212「审计字段必须在 payload 顶层」的开火探针
# 语义: 把路径变异成**真实发生过的缺陷形态** —— `...retrievalIds` 被插进嵌套对象
#   (`candidateScores: cooled.map(hit => ({ ..., ...retrievalIds }))`)里, 而不是 audit payload 的顶层。
#   这种形态: tsc 不报错(嵌套对象多字段合法)、产物 grep 也命中 —— 只有"看层级"的判据能抓。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
i = src.find("audit({ stage: 'injected', path: 'raw'")
assert i > 0, "找不到 path='raw' 审计点(结构变了)"
j = src.find("})\n", i)
seg = src[i:j]
top = " triggerSource: verdict.triggerSource, ...retrievalIds,"
assert seg.count(top) == 1, "顶层字段不在预期位置(结构变了)"
seg2 = seg.replace(top, " triggerSource: verdict.triggerSource,")
nested = "candidateScores: cooled.map(hit => ({ expId: hit.expId, similarity: hit.similarity })),"
assert seg2.count(nested) == 1
seg2 = seg2.replace(nested, "candidateScores: cooled.map(hit => ({ expId: hit.expId, similarity: hit.similarity, ...retrievalIds })),")
open(os.path.join(T, "mutant.ts"), "w", encoding="utf8").write(src[:i] + seg2 + src[j:])
MK
if DSH_INJECT_SRC="$TMP/mutant.ts" python3 /home/ubuntu/dsh-fork/dsh-audit-coverage-check.py >/dev/null 2>&1; then
  echo "把字段插进嵌套对象的源码被判绿 —— '改过了≠生效了'又混过去了" >&2
  exit 4
fi
echo "[guard-fire] FIRED T212: 字段插在嵌套里(顶层没有)被看层级的判据判红" >&2
exit 1
