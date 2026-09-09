#!/usr/bin/env bash
# dsh-freeze-wiki.sh — 冻结"知识层"快照(cl-086 换模清单第 2 项: 换模前须冻结 wiki)。
#
# 为什么: 经验库(chains/taxonomy/jumps/weights)是跨模型对照的唯一基准。模型切换或到期时,
# 若没有带时间戳的快照, 事后无法回答"换模前这套知识长什么样、换模后漂了多少"。
# 保留最近 10 份, 超出按时间裁剪。
set -uo pipefail
D="$HOME/.dsh/cognitive-pipeline"
SNAP_ROOT="$D/snapshots"
STAMP="$(date +%Y%m%d-%H%M)"
SNAP="$SNAP_ROOT/$STAMP"
mkdir -p "$SNAP"
frozen=0
for f in chains.json taxonomy.json trigger_jumps.json channel_weights.json acceptance.json solidified_strategies.json loops.json; do
  if [ -f "$D/$f" ]; then cp "$D/$f" "$SNAP/"; frozen=$((frozen+1)); fi
done
# 记一份元信息: 冻结时的模型(便于跨模型对照)
python3 - "$SNAP/meta.json" <<'PY'
import json, os, sys, datetime, subprocess
out = sys.argv[1]
model = None
hb = os.path.expanduser('~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl')
if os.path.exists(hb):
    for line in reversed(open(hb, encoding='utf8').read().splitlines()):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get('model'):
            model = r['model']; break
json.dump({'ts': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
           'model': model}, open(out, 'w', encoding='utf8'), ensure_ascii=False)
PY
# 裁剪: 只留最近 10 份
ls -1dt "$SNAP_ROOT"/*/ 2>/dev/null | tail -n +11 | while read -r old; do rm -rf "$old"; done
echo "[freeze-wiki] 冻结 $frozen 个文件 → $SNAP"
