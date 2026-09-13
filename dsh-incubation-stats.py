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

    audit_path = os.path.join(D, 'retrieval-audit.jsonl')
    audit_lines = sum(1 for l in open(audit_path, encoding='utf8') if l.strip()) if os.path.exists(audit_path) else 0

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
        # cl-164 口径修正: 数字生命的"推进"必须量**它自己的产物**, 不能量 suiteAssertions ——
        # 那是元层量, 我今天写 15 组守卫就等于让这个目标"推进"了 15 次(推进率恒 100%, 指标失效)。
        'digitalLifeArtifacts': digital_life_artifacts(),   # 数字生命专属文档字节数(身份/世界模型/孵化笔记)
        'digitalLifeChainMembers': digital_life_chain_members(),  # 带该目标链锚的经验条数(链在长吗)
        'libraryCommits': git_count(['packages/cognition/cognitive-pipeline', 'packages/context/cognitive-inject']),
        'libraryAudits': (len(open(os.path.join(D, 'library-health.jsonl'), encoding='utf8').readlines())
                          if os.path.exists(os.path.join(D, 'library-health.jsonl')) else 0),
        'metaCommits': git_count_meta(),                    # 元层(守卫/判据)提交 —— 单列, 不计入任何目标
        'auditedPredictions': audited,   # 检索专属(精排 A/B 样本)
        # goal-adoption-rate 专属: 注入策略代码的提交数 + 四级漏斗审计条数
        # (审计条数是该目标第 1 步的直接产物, 也是"采纳率可被度量"的载体)
        'injectionCommits': git_count(['packages/context/cognitive-inject']),
        'adoptionAudits': audit_lines,
    }


def digital_life_artifacts() -> int:
    """数字生命专属产物的体量(字节): 身份叙事/世界模型/孵化笔记等文档。

    这些是"生命本体"的可见产物 —— 与"测试套件长了多少"无关(cl-164)。
    """
    import glob
    total = 0
    # 只算**人工撰写的**本体文档; 排除生成物(incubation-stats.md 每次跑都被重写,
    # 若把它算进产物, 锚会因'我自己跑了一次统计'而增长 —— 自我灌水的第二形态, 实测踩到)。
    for pattern in ('north-star*', 'world-model*', 'identity*', 'framework-improvement*'):
        for path in glob.glob(os.path.join(D, pattern)):
            try:
                total += os.path.getsize(path)
            except Exception:
                pass
    return total


def digital_life_chain_members() -> int:
    """带 goal-digital-life-incubation 链锚的任务经验条数(链是否在生长)。"""
    count = 0
    path = os.path.join(D, 'experiences.jsonl')
    if os.path.exists(path):
        for line in open(path, encoding='utf8'):
            if line.strip() and 'goal-digital-life-incubation' in line:
                count += 1
    return count


def git_count_meta() -> int:
    """元层提交数(守卫/判据/口径类) —— 单列展示, 明确不计入任何目标的推进。"""
    import subprocess
    keys = ('guard', 'T1', 'test', 'catalog', 'sentinel', 'provenance', 'inventory',
            'enum', 'taxonomy', 'audit', 'carrier', 'memory', 'incubation-stats')
    try:
        out = subprocess.run(['git', '-C', REPO, 'log', '--since=24 hours ago', '--pretty=%s'],
                             capture_output=True, text=True, timeout=60).stdout.splitlines()
    except Exception:
        return 0
    return sum(1 for subject in out if any(k in subject for k in keys))


anchors = external_anchors()
anchor_history = load_lines('external-anchors.jsonl')
with open(os.path.join(D, 'external-anchors.jsonl'), 'a', encoding='utf8') as f:
    f.write(json.dumps({'ts': NOW.isoformat(), **anchors}, ensure_ascii=False) + '\n')

# cl-241: 池是只追加 + last-wins 的账本 ⇒ 必须先按 id 收敛到末行。实测不收敛的后果: 经验库目标
# 在池里有两行, 本报表就把它列成两行(同一目标被算两次), 任何对池的聚合都会偏高。
_pool_rows = load_lines('dormant-goals.jsonl')
_goals_by_id: dict = {}
for _row in _pool_rows:
    _goals_by_id[_row.get('id')] = _row
goals = list(_goals_by_id.values())
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
# cl-164: 专属见证里**不得**再出现 suiteAssertions —— 见 GOAL_WITNESS 上方的注释与 T127。
GOAL_WITNESS = {
    'goal-novel-60w': ('draftsChars',),
    'goal-retrieval-optimization': ('retrievalCommits', 'auditedPredictions'),
    'goal-digital-life-incubation': ('incubationCommits', 'digitalLifeArtifacts', 'digitalLifeChainMembers'),
    # 采用率优化: 注入策略提交 + 四级漏斗审计条数(可度量化本身就是产物)
    'goal-adoption-rate': ('injectionCommits', 'adoptionAudits'),
    # 经验库目标(cl-179): 专属见证 = 双库代码提交 + 库健康审计产物行数
    'goal-experience-library': ('libraryCommits', 'libraryAudits'),
}
GLOBAL_WITNESS = ('draftsChars', 'gitCommits', 'suitePasses')


_witness_undecidable = {'n': 0}


def _grew(fields, adopted_at):
    def value_at(field):
        before = None
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is not None and hts <= adopted_at and h.get(field) is not None:
                before = h.get(field, 0)
        if before is None:
            # cl-164: 新增锚在旧快照里不存在时, 原来记 before=0 ⇒ 每次历史采纳都显示'从 0 涨到现在'
            # ⇒ 又一片 100%。没有历史记录的字段不可比较, 返回 None 让上层计入不可判定。
            return None, None
        best = before
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is None or hts <= adopted_at:
                continue
            if hts - adopted_at > datetime.timedelta(hours=24):
                continue
            if h.get(field) is not None:
                best = max(best, h.get(field, 0))
        # cl-164 修第二处口径缺陷: 原写法把**当前值**无条件折进历史比较, 于是任何 N 天前的采纳,
        # 只要该锚此后涨过一次就判'推进' —— 推进率结构性恒 100%(实测 14/14)。当前值只在
        # '采纳后 24h 窗口仍开着'时参与比较。
        if adopted_at + datetime.timedelta(hours=24) >= datetime.datetime.now(adopted_at.tzinfo):
            best = max(best, anchors.get(field, 0) if field in anchors else best)
        return before, best
    pairs = [value_at(field) for field in fields]
    usable = [(b, a) for b, a in pairs if b is not None and a is not None]
    if not usable:
        _witness_undecidable['n'] += 1
        return False
    if any(a > b for b, a in usable):
        return True
    # cl-242(2026-09-11 19:4x 实测): 窗口**还没走完**且暂未增长时, 原来直接返回 False ⇒ 刚发生的采纳被
    # 记成"0% 推进"。这是旧的"结构性恒 100%"的**镜像假阴性**: 同样是拿没走完的窗口当结论。判据应按
    # 自己的文档("待观察 = 采纳未满 24h 或缺少监视记录")返回 None, 由上层计入待观察、不进分母。
    if adopted_at + datetime.timedelta(hours=24) > datetime.datetime.now(adopted_at.tzinfo):
        return None
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
            # cl-164: 新增锚在旧快照里不存在时, 原来记 before=0 ⇒ 每次历史采纳都显示'从 0 涨到现在'
            # ⇒ 又一片 100%。没有历史记录的字段不可比较, 返回 None 让上层计入不可判定。
            return None, None
        best = before
        for h in anchor_history:
            hts = parse(h.get('ts'))
            if hts is None or hts <= adopted_at:
                continue
            if hts - adopted_at > datetime.timedelta(hours=24):
                continue
            best = max(best, h.get(field, 0))
        # 当前值也算一次观测(脚本刚写下的快照就在 anchor_history 里)
        # cl-164 修第二处口径缺陷: 原写法把**当前值**无条件折进历史比较, 于是任何 N 天前的采纳,
        # 只要该锚此后涨过一次就判'推进' —— 推进率结构性恒 100%(实测 14/14)。当前值只在
        # '采纳后 24h 窗口仍开着'时参与比较。
        if adopted_at + datetime.timedelta(hours=24) >= datetime.datetime.now(adopted_at.tzinfo):
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
        # 分母只算**已裁决**的采纳(排除待观察 pending 与不可判定 undecidable) —— 拿没走完的窗口当分母
        # 正是 cl-242 的成因。全部待观察时给 None(不假装 0%)。
        'advance_rate': round(advanced_n / (adopted - pending - undecidable) * 100, 1)
                        if (adopted - pending - undecidable) > 0 else None,
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
        '检索→retrievalCommits/auditedPredictions/suiteAssertions；数字生命→incubationCommits/suiteAssertions；'
        '采纳率→injectionCommits/adoptionAudits/suiteAssertions',
        '- 推进率(全局锚对照) = 旧判据（draftsChars/gitCommits/suitePasses）——只回答"机器在动吗"，保留作对照，不作结论',
        '- 待观察 = 采纳未满 24h 或缺少监视记录',
        '- **见证不可判定** = 采纳发生但该目标的专属锚在历史快照里没有记录, 无法比较(不得记 0): %d 次' % _witness_undecidable['n'],
        '- 不可判定 = 计数器 adoptedCount 与有据采纳的差额：基线前的存量采纳无时间戳，24h 窗口无从计算；单列，既不进分子也不进分母（incubation-baseline.json 固定该差额）',
    ]
    # cl-251: 三率回答"唤醒之后有没有变", 归因率回答"是不是这次唤醒让它变的"
    _wake_attr = None
    try:
        _wa_path = os.path.join(D, 'wake-attribution.jsonl')
        if os.path.exists(_wa_path):
            _lines = [l for l in open(_wa_path, encoding='utf8') if l.strip()]
            if _lines:
                _wake_attr = json.loads(_lines[-1])
    except Exception:
        _wake_attr = None

    # cl-251: 唤醒→推进归因并列展示(读最近一条 wake-attribution.jsonl)
    if _wake_attr:
        lines += ['',
                  '**唤醒→推进归因(cl-251)**: 严格(被驱动的那一步确实被推进) **%s%%** / 宽松(窗口内该目标有推进) %s%% '
                  '—— 窗口 %.0f 分钟, 行动帧 %s 条, 噪声候选: %s'
                  % (round(100 * (_wake_attr.get('attributionRate') or 0), 1),
                     round(100 * (_wake_attr.get('looseRate') or 0), 1),
                     _wake_attr.get('windowMin') or 0, _wake_attr.get('frames'),
                     '、'.join(_wake_attr.get('noiseCandidates') or []) or '无'),
                  '- 口径: 严格=核对被驱动的那一步(`before` 前缀一致); 宽松=窗口内该目标有任何推进。'
                  '两者差距大时先怀疑口径(窗口长度/池重复行时代/nextAction 由别的机制改写), 再谈"提醒没用"']
        _rev = _wake_attr.get('reverse') or {}
        if _rev:
            lines += ['**反向判据(提醒是否必要)**: 池推进 %s 次中 **%s 次没有对应的唤醒**(%s%%) —— '
                      '这部分推进**未被唤醒也在发生** ⇒ 唤醒是推进的**贡献者而非必要条件**; '
                      '读三率时不得把它当成"唤醒驱动了推进"的证据。'
                      % (_rev.get('changes'), _rev.get('withoutWake'),
                         round(100 * (_rev.get('withoutWakeRate') or 0), 1))]
    # 2026-09-13 11:1x(行动帧 goal-digital-life-incubation 第⑤步): 干预判读结论必须**常驻且抹不掉** ——
    # 本文件是整份重写的, 手写段落下次生成就没了(本脚本末尾 open('w') 覆盖全文)。故结论落
    # wake-intervention-adjudication.jsonl(追加式), 由本脚本渲染成常驻段: 持久性由数据保证, 不靠"别删"。
    _adj = []
    try:
        _adj_path = os.path.join(D, 'wake-intervention-adjudication.jsonl')
        if os.path.exists(_adj_path):
            _adj = [json.loads(l) for l in open(_adj_path, encoding='utf8') if l.strip()]
    except Exception:
        _adj = []
    if _adj:
        _a = _adj[-1]
        _w = _a.get('windowLeg') or {}
        _r = _a.get('reversalLeg') or {}
        lines += ['',
                  '**干预判读·常驻**(源: wake-intervention-adjudication.jsonl, 判读于 %s | 目标 %s)'
                  % (str(_a.get('ts') or '')[:16], _a.get('goal') or '?'),
                  '- 窗口 %s' % (_a.get('windowId') or '?'),
                  '- **干预腿结论 %s**: %s' % (_w.get('conclusion') or '?', _w.get('reading') or ''),
                  '- %s' % (_w.get('whyNotNoEffect') or ''),
                  '- **恢复腿结论 %s**(预登记期望=%s / 当时记录=%s): %s'
                  % (_r.get('conclusion') or '?', _r.get('expectedVerdict') or '?',
                     _r.get('recordedVerdict') or '?', _r.get('whyVoid') or ''),
                  '- 根因: %s' % (_a.get('rootCause') or ''),
                  '- 持久化修法: %s' % (_a.get('durableFix') or ''),
                  '- 下一步: %s' % (_a.get('nextAction') or '')]
    text = '\n'.join(lines) + '\n'
    # 原子写(2026-09-13 11:1x): 这份文件是世界模型引用的一手读数, 原来 open('w') 先截断再写 ——
    # 生成中途失败会把它清空。改成 temp+fsync+os.replace, 与其它产物同一纪律。
    _out = os.path.join(D, 'incubation-stats.md')
    with open(_out + '.tmp', 'w', encoding='utf8') as _fh:
        _fh.write(text)
        _fh.flush()
        os.fsync(_fh.fileno())
    os.replace(_out + '.tmp', _out)
    print(text)
