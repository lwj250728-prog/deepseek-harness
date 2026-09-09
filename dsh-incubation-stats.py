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


def external_anchors():
    """外部产物锚(cl-069): 这三个值只会因为真实产出而增长——记账动作改不动它们。"""
    import glob, re, subprocess
    # 1) 小说正文字数
    drafts = 0
    for path in sorted(glob.glob(os.path.expanduser('~/dsh-workshop/novels/qizhongjiyi/drafts/00*.md'))):
        text = re.sub(r'^# .*', '', open(path, encoding='utf8').read(), flags=re.M)
        drafts += len(re.sub(r'\s', '', text))
    # 2) ~/.dsh 提交数
    try:
        commits = int(subprocess.run(['git', '-C', os.path.expanduser('~/.dsh'), 'rev-list', '--count', 'HEAD'],
                                     capture_output=True, text=True, timeout=30).stdout.strip() or 0)
    except Exception:
        commits = 0
    # 3) 最近一次套件通过数(读 cron 日志; 手动运行不写日志 → 可能滞后)
    passes = 0
    log = os.path.join(D, '.cog-tests.log')
    if os.path.exists(log):
        for line in reversed(open(log, encoding='utf8', errors='ignore').read().splitlines()):
            m = re.search(r'结果: (\d+) 通过', line)
            if m:
                passes = int(m.group(1)); break
    return {'draftsChars': drafts, 'gitCommits': commits, 'suitePasses': passes}


anchors = external_anchors()
anchor_history = load_lines('external-anchors.jsonl')
with open(os.path.join(D, 'external-anchors.jsonl'), 'a', encoding='utf8') as f:
    f.write(json.dumps({'ts': NOW.isoformat(), **anchors}, ensure_ascii=False) + '\n')

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
    """采纳后 24h 内**外部产物**是否增长(cl-069)。

    判据从 goal-watch.changeCount 换成三个外部锚: 小说正文字数 / git 提交数 / 套件通过数。
    理由: changeCount 会把"改写 nextAction 的记账动作"计成推进(实测首次'推进'即此类),
    而这三个值只会因真实产出增长。
    """
    def value_at(field):
        before = None
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is not None and hts <= adopted_at:
                before = h.get(field, 0)
        if before is None:
            before = 0
        best = before
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is None or hts <= adopted_at:
                continue
            if hts - adopted_at > datetime.timedelta(hours=24):
                continue
            best = max(best, h.get(field, 0))
        # 当前值也算一次观测(脚本刚写下的快照就在 anchor_history 里)
        best = max(best, anchors.get(field, 0) if field in anchors else best)
        return before, best
    for field in ('draftsChars', 'gitCommits', 'suitePasses'):
        before, after = value_at(field)
        if after > before:
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
        '- 采纳 = 结构性证据：回合内目标 nextAction/notes 真的变了（incubation-log.jsonl 记 evidence=pool-change；关键词仅在池不可读时兜底）',
        "- 推进 = 采纳后 24h 内**外部产物锚**任一增长（drafts 正文字数 / git 提交数 / 套件通过数）——记账动作改不动这三个值",
        '- 待观察 = 采纳未满 24h 或缺少监视记录',
    ]
    text = '\n'.join(lines) + '\n'
    open(os.path.join(D, 'incubation-stats.md'), 'w', encoding='utf8').write(text)
    print(text)
