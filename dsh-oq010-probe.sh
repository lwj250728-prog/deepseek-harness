#!/usr/bin/env bash
# dsh-oq010-probe.sh — oq-010 数据探测(执行门: 数据变化才解锁解读, 不靠主观记得)
# 2026-09-08 00:2x 建立。数据中心次日更新制: 数据入中心后由本脚本检测变化。
# 探测逻辑: 跑 --detail → 三态:
#   detail-error  → 页异常(非数据未入)
#   detail-关键词 → 与上次 data-ready 指纹比较, 变化才解锁(防重复解锁轰炸)
#   其他          → 真未入(静默)
# 2026-09-08 09:1x 修复(行动帧重复推送实证): v2 工具每次都能读到数据,
#   原逻辑"能读到=数据入中心"导致每次 cron 都重复解锁+重复写 data-ready(08:49/09:07 两次)。
#   改为指纹去重: 数据无变化则只记"无变化", 不重复解锁。
set -uo pipefail
DIR=/home/ubuntu/.dsh/cognitive-pipeline
OUT=$(cd /home/ubuntu/.dsh/novel-tools && timeout 60 python3 read_platform_signal.py --detail 2>&1)

if echo "$OUT" | grep -q "detail-error"; then
  echo "[oq010] $(date '+%F %T') ⚠ 数据中心页异常(404/不可达)——非'数据未入': $(echo "$OUT" | grep detail-error | head -1 | cut -c1-80)" >> "$DIR/oq010-probe.log"
elif echo "$OUT" | grep -qE "detail-(阅读|完读|追读|收藏|评论|新增)" && ! echo "$OUT" | grep -q "不可达"; then
  # 数据可读 → 与上次指纹比较(去重: 只在新数据时解锁)
  FINGER=$(echo "$OUT" | grep -oE "total=[0-9]+|search=[0-9]+|近[0-9]+天序列: \[[^]]*\]" | md5sum | cut -d' ' -f1)
  LAST=$(cat "$DIR/.oq010-fingerprint" 2>/dev/null || echo "none")
  if [ "$FINGER" = "$LAST" ]; then
    echo "[oq010] $(date '+%F %T') 数据无变化(指纹相同), 不重复解锁" >> "$DIR/oq010-probe.log"
  else
    echo "$OUT" > "$DIR/oq010-data-ready.json"
    echo "$FINGER" > "$DIR/.oq010-fingerprint"
    echo "[oq010] $(date '+%F %T') 数据变化, 已解锁待解读" >> "$DIR/oq010-probe.log"
    # 解锁目标 nextAction(去"待"前缀 → 行动帧可推)
    python3 - << 'PYEOF'
import json, os, datetime
p = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')
rows = []
changed = False
for line in open(p, encoding='utf8'):
    d = json.loads(line)
    if d.get('id') == 'goal-digital-life-incubation':
        d['nextAction'] = ('执行 oq-010 解读: 读 oq010-data-ready.json(数据中心新数据), '
                           '按 world-model 读者层基线解读, 结论回写 world-model')
        d['notes'] = (d.get('notes') or []) + [f"2026-09-08 {datetime.datetime.now().strftime('%H:%M')}: oq-010 数据变化(probe 检测指纹变化), nextAction 解锁"]
        changed = True
    rows.append(d)
if changed:
    with open(p, 'w', encoding='utf8') as f:
        for d in rows:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    print('[oq010] nextAction 已解锁(数据变化)')
PYEOF
  fi
else
  echo "[oq010] $(date '+%F %T') 数据未入中心(基础状态: 粉丝$(echo "$OUT" | grep -oP '(?<="粉丝": )[0-9]+' || echo '?')), 继续探测" >> "$DIR/oq010-probe.log"
fi
