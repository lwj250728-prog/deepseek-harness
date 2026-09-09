#!/usr/bin/env python3
"""dsh-incubation-stats.py — 目标孵化三指标统计（触发 / 采纳 / 推进）

背景（2026-09-09 行动帧）：孵化机制的验收靠三率防空转，但此前只有"触发"和"采纳"两个计数，
"推进"全靠人工核对。本脚本把它自动化：

  触发 = dormant-goals.jsonl 的 triggerCount（哨兵命中次数）
  采纳 = adoptedCount + incubation-log.jsonl（采纳时刻，插件落盘）
  推进 = 采纳时刻之后 24h 内，goal-watch 的 changeCount 是否增加（结构性证据：
         目标的 nextAction/notes 真的变了，而不是"回复里提到了关键词"）

用法: python3 dsh-incubation-stats.py [--json]
产物: ~/.dsh/cognitive-pipeline/incubation-stats.md（供世界模型引用）
      每次运行顺带把 (ts, goalId, changeCount) 追加进 goal-watch-history.jsonl
"""
import json, os, sys, datetime

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)


def load_lines(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return []
    out = []
    for line in open(p, encoding='utf8'):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def load_json(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding='utf8'))
    except json.JSONDecodeError:
        return {}


goals = load_lines('dormant-goals.jsonl')
adoptions = load_lines('incubation-log.jsonl')
watch = load_json('goal-watch.json')
history = load_lines('goal-watch-history.jsonl')

# 追加本次快照（推进率判据需要变更历史）
snapshot = []
for gid, w in watch.items():
    snapshot.append({
        'ts': NOW.isoformat(),
        'goalId': gid,
        'changeCount': w.get('changeCount', 0),
        'lastChanged': w.get('lastChanged'),
    })
if snapshot:
    with open(os.path.join(D, 'goal-watch-history.jsonl'), 'a', encoding='utf8') as f:
        for s in snapshot:
            f.write(json.dumps(s, ensure_ascii=False) + '\n')


def parse(ts):
    if not ts:
        return None
    try:
        return datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None


def advanced(goal_id, adopted_at):
    """采纳后 24h 内 changeCount 是否增加（用变更历史 + 当前 lastChanged 判）。"""
    w = watch.get(goal_id)
    if w is None:
        return None  # 无监视记录 → 无法判定
    last = parse(w.get('lastChanged'))
    if last is not None and last > adopted_at:
        return (last - adopted_at).total_seconds() <= 24 * 3600
    # 回看历史快照
    for h in history:
        if h.get('goalId') != goal_id:
            continue
        hts = parse(h.get('ts'))
        if hts is None or hts <= adopted_at:
            continue
        if hts - adopted_at <= datetime.timedelta(hours=24):
            return True
    return False


rows = []
for g in goals:
    gid = g.get('id')
    triggers = g.get('triggerCount') or 0
    adoptions_of = [a for a in adoptions if a.get('goalId') == gid]
    adopted = len(adoptions_of) if adoptions_of else (g.get('adoptedCount') or 0)
    verdicts = []
    for a in adoptions_of:
        at = parse(a.get('ts'))
        if at is None:
            continue
        verdicts.append(advanced(gid, at))
    advanced_n = sum(1 for v in verdicts if v is True)
    pending = sum(1 for v in verdicts if v is None) + (0 if verdicts else max(0, adopted - len(verdicts)))
    rows.append({
        'goalId': gid,
        'triggers': triggers,
        'adopted': adopted,
        'advanced': advanced_n,
        'pending': pending,
        'adopt_rate': round(adopted / triggers * 100, 1) if triggers else 0.0,
        'advance_rate': round(advanced_n / adopted * 100, 1) if adopted else 0.0,
    })

if '--json' in sys.argv:
    print(json.dumps(rows, ensure_ascii=False, indent=1))
else:
    lines = [
        '# 目标孵化三指标（触发 / 采纳 / 推进）',
        '',
        f'生成时间：{NOW.strftime("%Y-%m-%d %H:%M")}',
        '',
        '| 目标 | 触发 | 采纳 | 采纳率 | 推进 | 推进率 | 待观察 |',
        '|---|---|---|---|---|---|---|',
    ]
    for r in rows:
        lines.append('| %s | %d | %d | %.1f%% | %d | %.1f%% | %d |' % (
            r['goalId'], r['triggers'], r['adopted'], r['adopt_rate'],
            r['advanced'], r['advance_rate'], r['pending']))
    lines += [
        '',
        '判据说明：',
        '- 触发 = 哨兵 pre-step 命中（dormant-goals.jsonl.triggerCount）',
        '- 采纳 = 回合文本命中配置关键词，采纳时刻记于 incubation-log.jsonl',
        '- 推进 = 采纳后 24h 内 goal-watch.changeCount 增加（结构性证据，非文本关键词）',
        '- 待观察 = 采纳未满 24h 或缺少监视记录',
    ]
    text = '\n'.join(lines) + '\n'
    open(os.path.join(D, 'incubation-stats.md'), 'w', encoding='utf8').write(text)
    print(text)
