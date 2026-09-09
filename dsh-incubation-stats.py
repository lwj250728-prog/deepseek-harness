#!/usr/bin/env python3
"""dsh-incubation-stats.py — 目标孵化三指标统计（触发 / 采纳 / 推进）

背景（2026-09-09 行动帧）：孵化机制的验收靠三率防空转，但此前只有"触发"和"采纳"两个计数，
"推进"全靠人工核对。本脚本把它自动化：

  触发 = dormant-goals.jsonl 的 triggerCount（哨兵命中次数）
  采纳 = adoptedCount + incubation-log.jsonl（采纳时刻，插件落盘）
  推进 = 采纳后 24h 内**该目标专属**外部产物锚增长（cl-069 全局锚 → cl-077 专属见证）
  不可判定 = 基线之前的存量采纳（adoptedCount 已计数但 incubation-log 无时间戳，
             无法计算 24h 窗口）——单列出来，不混进推进率分母（cl-078）

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
    # cl-077: 目标专属见证。全局锚(gitCommits/suitePasses)只回答"机器在动吗",
    # 不能回答"这个目标推进了吗"——于是给每个目标配它自己的外部产物。
    def git_count(paths):
        try:
            return int(subprocess.run(['git', '-C', os.path.expanduser('~/dsh-fork'), 'rev-list', '--count', 'HEAD', '--'] + paths,
                                      capture_output=True, text=True, timeout=30).stdout.strip() or 0)
        except Exception:
            return 0

    suite_assertions = 0
    suite = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
    if os.path.exists(suite):
        suite_assertions = len(re.findall(r'^t "', open(suite, encoding='utf8').read(), flags=re.M))

    audited = 0
    pred = os.path.join(D, 'predictions.jsonl')
    if os.path.exists(pred):
        for line in open(pred, encoding='utf8'):
            if line.strip() and '"originalTopExpId"' in line:
                audited += 1

    return {
        'draftsChars': drafts,           # 小说专属
        'gitCommits': commits,           # 全局背景
        'suitePasses': passes,           # 全局背景
        'suiteAssertions': suite_assertions,                 # 检索/数字生命共享(机制产出)
        'retrievalCommits': git_count(['packages/cognition/cognitive-pipeline']),   # 检索专属
        'incubationCommits': git_count(['packages/context/dormant-goal', 'packages/context/quiet-driver']),  # 数字生命专属
        'auditedPredictions': audited,   # 检索专属(精排 A/B 样本)
    }


anchors = external_anchors()
anchor_history = load_lines('external-anchors.jsonl')
with open(os.path.join(D, 'external-anchors.jsonl'), 'a', encoding='utf8') as f:
    f.write(json.dumps({'ts': NOW.isoformat(), **anchors}, ensure_ascii=False) + '\n')

goals = load_lines('dormant-goals.jsonl')
adoptions = load_lines('incubation-log.jsonl')
# cl-078: 存量采纳基线——基线建立前 adoptedCount 已计数但没有 incubation-log 时间戳的采纳,
# 无法判定其 24h 窗口, 因此明确标为不可判定, 而不是默默从分母里消失或永久挂"待观察"。
baseline = load_json('incubation-baseline.json')
baseline_goals = baseline.get('goals', {}) if isinstance(baseline, dict) else {}
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


# cl-077: 每个目标的专属见证。判据必须与它要回答的问题同域——全局锚只作背景。
GOAL_WITNESS = {
    'goal-novel-60w': ('draftsChars',),
    'goal-retrieval-optimization': ('retrievalCommits', 'auditedPredictions', 'suiteAssertions'),
    'goal-digital-life-incubation': ('incubationCommits', 'suiteAssertions'),
}
GLOBAL_WITNESS = ('draftsChars', 'gitCommits', 'suitePasses')


def _grew(fields, adopted_at):
    def value_at(field):
        before = None
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is not None and hts <= adopted_at and h.get(field) is not None:
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
            if h.get(field) is not None:
                best = max(best, h.get(field, 0))
        best = max(best, anchors.get(field, 0) if field in anchors else best)
        return before, best
    for field in fields:
        before, after = value_at(field)
        if after > before:
            return True
    return False


def advanced(goal_id, adopted_at):
    """该目标**专属**见证是否增长(cl-077)。"""
    return _grew(GOAL_WITNESS.get(goal_id, GLOBAL_WITNESS), adopted_at)


def advanced_global(adopted_at):
    """旧的全局锚判据(仅作对照, 不作结论)。"""
    return _grew(GLOBAL_WITNESS, adopted_at)


def _legacy_advanced(goal_id, adopted_at):
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
    verdicts_global = []
    for a in adoptions_of:
        at = parse(a.get('ts'))
        if at is None:
            continue
        verdicts.append(advanced(gid, at))
        verdicts_global.append(advanced_global(at))
    advanced_n = sum(1 for v in verdicts if v is True)
    advanced_global_n = sum(1 for v in verdicts_global if v is True)
    pending = sum(1 for v in verdicts if v is None) + (0 if verdicts else max(0, adopted - len(verdicts)))
    # adopted 已经是"有据采纳"(带 incubation-log 时间戳); 计数器与它的差额=存量不可判定项。
    # 分母=有据采纳, 不可判定项既不进分子也不进分母(它连时间都没有, 谈不上窗口)。
    adopted_counter = g.get('adoptedCount') or 0
    undecidable = int((baseline_goals.get(gid) or {}).get('undecidableAdoptions', 0))
    if undecidable == 0:
        undecidable = max(0, adopted_counter - adopted)
    rows.append({
        'goalId': gid,
        'triggers': triggers,
        'adopted': adopted,
        'adopted_counter': adopted_counter,
        'undecidable': undecidable,
        'advanced': advanced_n,
        'advanced_global': advanced_global_n,
        'witness': list(GOAL_WITNESS.get(gid, GLOBAL_WITNESS)),
        'pending': pending,
        'adopt_rate': round(adopted / triggers * 100, 1) if triggers else 0.0,
        'advance_rate': round(advanced_n / adopted * 100, 1) if adopted else None,
        'advance_rate_global': round(advanced_global_n / adopted * 100, 1) if adopted else None,
    })

if '--json' in sys.argv:
    print(json.dumps(rows, ensure_ascii=False, indent=1))
else:
    lines = [
        '# 目标孵化三指标（触发 / 采纳 / 推进）',
        '',
        f'生成时间：{NOW.strftime("%Y-%m-%d %H:%M")}',
        '',
        '| 目标 | 触发 | 采纳 | 采纳率 | 不可判定 | 推进(专属) | 推进率(专属) | 推进率(全局锚对照) | 专属见证 |',
        '|---|---|---|---|---|---|---|---|---|',
    ]
    for r in rows:
        rate = '—' if r['advance_rate'] is None else '%.1f%%' % r['advance_rate']
        rate_g = '—' if r['advance_rate_global'] is None else '%.1f%%' % r['advance_rate_global']
        lines.append('| %s | %d | %d | %.1f%% | %d | %d | %s | %s | %s |' % (
            r['goalId'], r['triggers'], r['adopted'], r['adopt_rate'],
            r['undecidable'], r['advanced'], rate, rate_g, '+'.join(r['witness'])))
    lines += [
        '',
        '判据说明：',
        '- 触发 = 哨兵 pre-step 命中（dormant-goals.jsonl.triggerCount）',
        '- 采纳 = 结构性证据：回合内目标 nextAction/notes 真的变了（incubation-log.jsonl 记 evidence=pool-change；关键词仅在池不可读时兜底）',
        '- 推进(专属) = 采纳后 24h 内**该目标专属**外部产物锚增长（cl-077）：小说→draftsChars；'
        '检索→retrievalCommits/auditedPredictions/suiteAssertions；数字生命→incubationCommits/suiteAssertions',
        '- 推进率(全局锚对照) = 旧判据（draftsChars/gitCommits/suitePasses）——只回答"机器在动吗"，保留作对照，不作结论',
        '- 待观察 = 采纳未满 24h 或缺少监视记录',
        '- 不可判定 = 计数器 adoptedCount 与有据采纳的差额：基线前的存量采纳无时间戳，24h 窗口无从计算；单列，既不进分子也不进分母（incubation-baseline.json 固定该差额）',
    ]
    text = '\n'.join(lines) + '\n'
    open(os.path.join(D, 'incubation-stats.md'), 'w', encoding='utf8').write(text)
    print(text)
