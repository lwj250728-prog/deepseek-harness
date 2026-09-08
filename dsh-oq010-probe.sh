#!/usr/bin/env bash
# dsh-oq010-probe.sh — oq-010 数据探测(执行门: 数据入中心即读数, 不靠主观记得)
# 2026-09-08 00:2x 建立。数据中心次日更新制: 09-07数据约09-08上午入中心。
# 探测逻辑: 跑 --detail, 若输出含细粒度关键词(阅读/完读/收藏)则数据已入→触发完整解读;
#          否则静默退出(下次cron再探)。
set -uo pipefail
OUT=$(cd /home/ubuntu/.dsh/novel-tools && timeout 90 python3 read_platform_signal.py --detail 2>&1)
# 修正(2026-09-08 00:2x 审视发现): 排除"数据中心不可达"的detail失败提示——那是错误非数据就绪。
# 只认真实的细粒度数据标签(detail-阅读 等), 不含裸"detail"或"不可达"。
# 多入口探测: 若 --detail 无数据(数据中心未更新), 试作者页小说数据区(book_list等可能含阅读数据)
# tp-011 修复(2026-09-08 08:2x): 分三态——detail-error(页异常, 非数据未入) / detail-关键词(数据入) / 其他(真未入)
if echo "$OUT" | grep -q "detail-error"; then
  echo "[oq010] $(date '+%F %T') ⚠ 数据中心页异常(404/不可达)——非'数据未入', 需人工定位真实URL: $(echo "$OUT" | grep detail-error | head -1 | cut -c1-80)" >> /home/ubuntu/.dsh/cognitive-pipeline/oq010-probe.log
elif echo "$OUT" | grep -qE "detail-(阅读|完读|追读|收藏|评论|新增)" && ! echo "$OUT" | grep -q "不可达"; then
  # 数据已入中心 → 记录+标记待解读
  echo "$OUT" > /home/ubuntu/.dsh/cognitive-pipeline/oq010-data-ready.json
  echo "[oq010] $(date '+%F %T') 数据已入中心, 待完整解读" >> /home/ubuntu/.dsh/cognitive-pipeline/oq010-probe.log
  # 触发 quiet-driver 感知: 更新目标 nextAction 去掉"待"前缀(否则行动帧 WAITING_PREFIX 会跳过,
  # 数据入了也没人解读——2026-09-08 07:5x 接线审计发现的链路缺口)。
  # 改后: 目标变 actionable → 下个行动帧 tick 会把"解读 oq-010 数据"推给主会话执行。
  echo "ready" > /home/ubuntu/.dsh/cognitive-pipeline/.oq010-trigger  # 双保险: 标记文件仍在(供人工/帧检查)
  python3 - << 'PYEOF'
import json, os, datetime
p = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')
rows = []
changed = False
for line in open(p, encoding='utf8'):
    d = json.loads(line)
    if d.get('id') == 'goal-digital-life-incubation':
        d['nextAction'] = ('执行 oq-010 解读: 读 oq010-data-ready.json(刚入中心的09-07细粒度数据), '
                           '按 world-model 读者层基线(前5章定生死/8-15万字给量/完读率20%+追更40%)解读, '
                           '结论回写 world-model + 决定 ch13-21 发布节奏')
        d['notes'] = (d.get('notes') or []) + [f"2026-09-08 {datetime.datetime.now().strftime('%H:%M')}: oq-010 数据已入中心(probe 检测), nextAction 解锁为可执行"]
        changed = True
    rows.append(d)
if changed:
    with open(p, 'w', encoding='utf8') as f:
        for d in rows:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    print('[oq010] goal nextAction 已解锁(待事件→执行解读)')
PYEOF
else
  echo "[oq010] $(date '+%F %T') 数据未入中心(基础状态: 粉丝$(echo "$OUT" | grep -oP '(?<="粉丝": )[0-9]+' || echo '?')), 继续探测" >> /home/ubuntu/.dsh/cognitive-pipeline/oq010-probe.log
fi
