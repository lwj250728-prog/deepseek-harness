#!/usr/bin/env bash
# dsh-guard-t216-probe.sh — T216「账本压缩必须保持 last-wins 不变」的开火探针
# 语义: 把压缩工具变异成**保留每个 id 的第一行而不是最后一行**(即压缩后 last-wins 视图会变),
#       判据必须抓到它。工具自身有一道"last-wins 校验不过就拒绝写入"的闸 ⇒ 变异版应当以 exit 2 拒绝。
#   exit 1 = FIRED(判据/闸门抓住了) / exit 4 = 漂移(变异版仍被判绿) / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-claims-ledger-compact.py"), encoding="utf8").read()
marker = "        superseded = ident and latest_index.get(ident) != i"
assert src.count(marker) == 1, "找不到 superseded 判定(结构变了, 探针自身失效)"
mut = src.replace(marker, "        superseded = ident and latest_index.get(ident) == i   # 变异: 保留第一行")
open(os.path.join(T, "mutant-compact.py"), "w", encoding="utf8").write(mut)
# 合成账本: id A 三行(最后一行是当前), id B 一行
rows = [{"id": "cl-a", "ts": "2026-09-01T10:00:00+08:00", "status": "open", "claim": "旧1", "reviewBy": "2026-09-20"},
        {"id": "cl-a", "ts": "2026-09-02T10:00:00+08:00", "status": "open", "claim": "旧2", "reviewBy": "2026-09-20"},
        {"id": "cl-a", "ts": "2026-09-03T10:00:00+08:00", "status": "open", "claim": "当前", "reviewBy": "2026-09-20"},
        {"id": "cl-b", "ts": "2026-09-01T11:00:00+08:00", "status": "open", "claim": "B", "reviewBy": "2026-09-20"}]
import json
with open(os.path.join(T, "ledger.jsonl"), "w", encoding="utf8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
MK
if DSH_COMPACT_TOOL="$TMP/mutant-compact.py" DSH_COMPACT_LEDGER="$TMP/ledger.jsonl" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "账本压缩必须保持 last-wins 视图不变(否则拒写)" >/dev/null 2>&1; then
  echo "变异版(保留第一行)仍被判绿 —— 压缩会悄悄改读数" >&2
  exit 4
fi
echo "[guard-fire] FIRED T216: 压缩变异版被判据/闸门抓住" >&2
exit 1
