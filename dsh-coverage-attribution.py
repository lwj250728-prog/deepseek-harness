#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-coverage-attribution.py — 库覆盖率的**四类归因**(cl-278 的前置 ① 落地后重测)。

背景(cl-278): 时代内库里大半经验从未被注入, 但当时**归因不了** —— 审计每回合只落 preTop(≤5)+belowGate,
而 rawHits 中位 276 ⇒ 每回合可见候选 ~5 条、约 97% 的原始命中在账本里不可见, 于是"未被检索到"与
"排在第 6 名之外"分不开。前置 ①(审计记**完整检索 id 列表** `retrievedIds`, 已在 09-12 部署)现已满足,
本脚本用这份完整列表把"未注入"批次拆成因, 并回答 cl-296 那个假设(falsification 预登记):
**"不截断查询元素池"是不是库覆盖率的头号杠杆?**

口径(先写死, 防事后解释):
  · 时代: `coverage-era.json`(缺文件即 exit 3, 不猜); 可用边界 = max(era.since, 带 retrievedIds 的最早行 t);
  · `retrievedIds` = **过阈**(similarity ≥ minSimilarity)候选, **按 rankKey 降序**(= 实际注入排序) ⇒ 其下标即排名;
  · `belowGate` = 阈下候选(现记录全部, 上限 500); `injections.jsonl.expIds` = 真注入过的 id;
  · 库 = experiences.jsonl(任务层); 窗口 = [可用边界, 最后一条带 retrievedIds 的行]。

四类(互斥, 按优先级从上到下; "太新"单列为机会不足标记, 不占类):
  ① 排名出局      : 过阈检索到, 但最好排名 > topK(注入窗口装不下)
  ② 窗口内被吸收  : 过阈且最好排名 ≤ topK, 却没有任何注入行(被轮换/冷却/否决吸收)
  ③ 门限挡下      : 从未过阈, 但出现在 belowGate(minSimilarity=0.4 挡下的)
  ④ 检索未取到    : 两份列表都没有它
  · 时代前注入过的从归因批次里排除(它们不是"从没被用", 而是"时代之前被用过")。

**为什么第④类还要再分**: 候选列表 = `experiencesSnapshot() - isTaskRestatement - isSelfFrameExperience` ⇒
**注入前过滤器**先把两类条目剔掉再打分, 于是"不在候选里"有两种完全不同的含义: ①被设计排除(不是缺陷);
②检索真没取到(cl-278 原本**无法证明**的那一类)。故第④类按**同一判据的镜像**(逐字对齐 task-restatement.ts:26
与 self-frame.ts 的规则; 只照抄规则, 不改生产行为)再分两小类, 条数分开报。

用法: python3 dsh-coverage-attribution.py [--json]
退出码: 0 出数; 3 缺前置(时代文件/审计行不足)。
"""
from __future__ import annotations

import json
import os
import re
import statistics
import sys
from collections import Counter

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
MIN_TURNS = 10
NEW_ITEM_MS = 24 * 3600 * 1000
# 镜像 packages/cognition/cognitive-pipeline/src/task-restatement.ts(逐字同规则)
_TASK_TRACE = re.compile(r'调用|pwsh|Start-Process|Stop-Process|glob|grep|read|write|edit|explore|consolidate|remember', re.I)
_TASK_INSTR = re.compile(r'任务|需要|请完成|请执行|要求')
_TASK_DELEG = re.compile(r'子代理执行|启动子代理|执行.{0,8}任务|按该|按照该|根据任务')
# 镜像 self-frame.ts 的 situation 前缀判据
_SELF_FRAME_PREFIX = ('自主回合', '检索路由歧义', '三问帧旁路评估', '自主回合(无用户在场)')


def is_task_restatement(e: dict) -> bool:
    sar = e.get('sar') or {}
    action, situation = str(sar.get('action') or ''), str(sar.get('situation') or '')
    if _TASK_TRACE.search(action):
        return False
    return bool(_TASK_INSTR.search(situation) and _TASK_DELEG.search(action))


def is_self_frame(e: dict) -> bool:
    sar = e.get('sar') or {}
    action, situation = str(sar.get('action') or ''), str(sar.get('situation') or '')
    if str(e.get('kind') or '') == 'frame':
        return True
    if action.startswith('quiet-driver 旁路三问帧'):
        return True
    return any(situation.startswith(p) for p in _SELF_FRAME_PREFIX)


def excluded_before_scoring(e: dict) -> str:
    """→ '任务复述' / '自帧' / ''(未被排除)。"""
    if is_task_restatement(e):
        return '任务复述'
    if is_self_frame(e):
        return '自帧'
    return ''


def load(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p, encoding='utf8') if l.strip()]


def era_since_ms():
    p = os.path.join(D, 'coverage-era.json')
    if not os.path.exists(p):
        print('[coverage] 缺时代文件: %s(采集方式变了就必须声明, 否则跨时代混算)' % p, file=sys.stderr)
        return None
    try:
        since = json.load(open(p, encoding='utf8')).get('since') or ''
        import datetime
        return int(datetime.datetime.fromisoformat(since).timestamp() * 1000)
    except Exception as exc:
        print('[coverage] 时代文件读不了/解析不了: %s' % exc, file=sys.stderr)
        return None


def live_topk():
    """活配置里的 topK / minSimilarity(cl-278: 引用的必须是**在跑的那个值**)。"""
    topk, minsim, src = None, None, ''
    for cand in ('~/.dsh/profiles/web/cordis.patch.yml',):
        p = os.path.expanduser(cand)
        if not os.path.exists(p):
            continue
        src = p
        for line in open(p, encoding='utf8'):
            s = line.strip()
            if s.startswith('topK:'):
                try:
                    topk = int(s.split(':', 1)[1].strip())
                except Exception:
                    pass
            if s.startswith('minSimilarity:'):
                try:
                    minsim = float(s.split(':', 1)[1].strip())
                except Exception:
                    pass
    return topk, minsim, src


def idf_shape(lib, batch_rank_cut, injected_win, excluded_ids):
    """**生产里"陈旧"的真实形态**(2026-09-13 13:5x, cl-053 nextAction ① 的兑现)。

    计划的问法是"从查询池较旧的那部分重建陈旧元素的 IDF 分布" —— 但**生产里没有查询池**:
    cognitive-inject 的 BM25 查询是**当轮**的 `queryText`(情境文本), 没有任何跨轮元素累积
    (grep elementPool/accumulate 无命中; trigger_jumps.json 是**学到的触发词↔跳词词典**, 不是池)。
    ⇒ 旧 §3b 的"淘汰/衰减"在**当前实现下没有作用面**。

    我们真实存在的"陈旧"是**库侧长尾**: 很早入库、却从未被注入过的条目。它到底更像哪一类?
      · 若它们的元素 IDF 分布 ≈ 旧构造(中位 1.39) ⇒ 内容是**常见词**那一类(和别的条目长得一样);
      · 若 ≈ 最坏构造(4.91) ⇒ 是**罕见/独特**内容, 却被排序饿着 ⇒ 提权有依据。
    本函数给两类条目(窗口内注入过 / 排名出局的长尾)算**条目内元素 IDF 的中位与最大**, 让这个判断有数。
    """
    import math, re
    from collections import Counter
    def elems(t):
        out = []
        for m in re.finditer(r'[\u4e00-\u9fff]+|[a-zA-Z0-9_]+', t):
            seg = m.group(0)
            if re.match(r'[a-zA-Z0-9_]', seg):
                out.append(seg.lower())
            else:
                out.extend(seg)
        return out
    def full(r):
        s = r.get('sar') or {}
        return f"{s.get('situation','')} {s.get('action','')} {s.get('outcome','')}"
    docs = {e['expId']: elems(full(e)) for e in lib if e.get('expId')}
    N = len(docs) or 1
    df = Counter()
    for d in docs.values():
        for w in set(d):
            df[w] += 1
    def idf(w):
        return math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
    def shape(ids):
        med, mx = [], []
        for i in ids:
            d = docs.get(i) or []
            if not d:
                continue
            vals = [idf(w) for w in set(d)]
            med.append(statistics.median(vals))
            mx.append(max(vals))
        if not med:
            return None
        return {'n': len(med), 'medianIdf': round(statistics.median(med), 2),
                'maxIdfP50': round(statistics.median(mx), 2),
                'maxIdfP90': round(sorted(mx)[int(0.9 * (len(mx) - 1))], 2)}
    return {'injectedInWindow': shape(injected_win),
            'rankCutLongTail': shape(batch_rank_cut),
            'reference': {'cl053LegacySampledElements': 1.39, 'adversarialIdfTop400': 4.91},
            'caliber': '条目内**元素**的 IDF(单字/英文词, 与 dsh-admission-scan 同一套切词); 库 %d 条' % len(docs)}


def main() -> int:
    era = era_since_ms()
    if era is None:
        return 3
    audits = load('retrieval-audit.jsonl')
    tagged = [r for r in audits if r.get('retrievedIds') is not None]
    if len(tagged) < MIN_TURNS:
        print('[coverage] 带 retrievedIds 的审计行只有 %d 条(<%d) ⇒ 样本不足, 不出数' % (len(tagged), MIN_TURNS),
              file=sys.stderr)
        return 3
    tagged.sort(key=lambda r: r.get('t') or 0)
    w0 = max(era, int(tagged[0]['t']))
    w1 = int(tagged[-1]['t'])
    topk, minsim, cfg = live_topk()
    lib = load('experiences.jsonl')
    inj = load('injections.jsonl')

    # 过阈检索: expId → 最好排名(0-based) 与 被检索到的回合数
    best_rank: dict[str, int] = {}
    turns_seen: dict[str, int] = {}
    for r in tagged:
        if (r.get('t') or 0) < w0:
            continue
        for idx, eid in enumerate(r['retrievedIds']):
            if eid not in best_rank or idx < best_rank[eid]:
                best_rank[eid] = idx
            turns_seen[eid] = turns_seen.get(eid, 0) + 1
    # 阈下: 出现在 belowGate 但从未过阈
    below: set[str] = set()
    for r in tagged:
        if (r.get('t') or 0) < w0:
            continue
        for hit in (r.get('belowGate') or []):
            eid = hit.get('expId')
            if eid and eid not in best_rank:
                below.add(eid)
    # 注入: 窗口内 / 时代前
    injected_win, injected_pre = set(), set()
    for row in inj:
        t = row.get('createdAt') or 0
        for eid in (row.get('expIds') or []):
            if t >= w0:
                injected_win.add(eid)
            else:
                injected_pre.add(eid)

    import datetime
    tz = datetime.timezone(datetime.timedelta(hours=8))
    fmt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, tz).strftime('%m-%d %H:%M')
    print('库 %d 条(任务层) | topK=%s minSimilarity=%s(活配置 %s)' % (len(lib), topk, minsim, cfg))
    print('时代 since=%s | 可用窗口 %s → %s | 带 retrievedIds 的回合 %d'
          % (fmt(era), fmt(w0), fmt(w1), sum(1 for r in tagged if (r.get('t') or 0) >= w0)))

    batch, pre_used, win_used = [], [], []
    for e in lib:
        eid = e.get('expId')
        if not eid:
            continue
        if eid in injected_win:
            win_used.append(eid)
        elif eid in injected_pre:
            pre_used.append(eid)
        else:
            batch.append(e)
    b_rank, b_absorb, b_gate, b_miss, b_new, b_excl = [], [], [], [], [], []
    for e in batch:
        eid = e['expId']
        created = e.get('timestamp') or 0
        too_new = created and (w1 - created) < NEW_ITEM_MS
        if eid in best_rank:
            if topk is not None and best_rank[eid] > topk:
                b_rank.append(eid)
            else:
                b_absorb.append(eid)
        elif eid in below:
            (b_new if too_new else b_gate).append(eid)
        else:
            why = excluded_before_scoring(e)
            if why:
                b_excl.append((eid, why))
            else:
                (b_new if too_new else b_miss).append(eid)
    n = len(batch)
    share = lambda xs: ('%5.1f%%' % (100 * len(xs) / n)) if n else '  n/a'
    print('\n归因批次 = 窗口内未注入 %d 条(另: 时代前注入过 %d 条已排除, 窗口内注入过 %d 条)' % (n, len(pre_used), len(win_used)))
    print('  ① 排名出局(过阈但最好排名 > topK=%s)   %3d 条 %s' % (topk, len(b_rank), share(b_rank)))
    print('  ② 窗口内被吸收(排名 ≤ topK 却未注入)   %3d 条 %s' % (len(b_absorb), share(b_absorb)))
    print('  ③ 门限挡下(只在 belowGate 里)          %3d 条 %s' % (len(b_gate), share(b_gate)))
    print('  ④ 不在任何候选列表里                   %3d 条 %s' % (len(b_miss) + len(b_excl), share(b_miss + b_excl)))
    print('     ④a 被注入前过滤器排除(设计如此)     %3d 条 %s  %s'
          % (len(b_excl), share(b_excl), dict((w, sum(1 for _, x in b_excl if x == w)) for _, w in b_excl) or ''))
    print('     ④b **检索真没取到**(cl-278 原本不可证) %3d 条 %s' % (len(b_miss), share(b_miss)))
    print('  ※ 太新(加入 <24h, 机会不足, 不归类)    %3d 条(其中 门限挡下 %d / 未取到 %d)'
          % (len(b_new), len([x for x in b_new if x in below]), len([x for x in b_new if x not in below])))
    if b_rank:
        rk = sorted(best_rank[e] for e in b_rank)
        print('  排名出局者的最好排名: 中位 %d, p90 %d, 最小 %d (topK=%s)' % (
            statistics.median(rk), rk[int(0.9 * (len(rk) - 1))], rk[0], topk))
    reachable = len(win_used) + len([e for e in batch if e['expId'] in best_rank])
    print('\n离线指标对: 检索可及率(进过过阈候选) %.1f%% (%d/%d) | 窗口内注入覆盖率 %.1f%% (%d/%d)'
          % (100 * reachable / max(len(lib), 1), reachable, len(lib),
             100 * len(win_used) / max(len(lib), 1), len(win_used), len(lib)))
    # ── 判读(cl-296 的证伪信号写在这里) ──
    pool_trunc = 0   # 查询元素池在**生产**里不截断(hot-engine.lexicalScore 遍历 new Set(elements(queryText)));
                     # 故"元素池截断丢失"这一类在当前实现下**恒为 0**, 见下面的 判读 行。
    print('\n判读: 查询元素池在生产里**不截断**(hot-engine.lexicalScore 遍历 new Set(elements(queryText)), 无 cap)')
    print('      ⇒ "不截断查询池"这条杠杆对覆盖率**恒无作用面**(cl-296 的证伪信号成立: 覆盖率问题不在准入/元素池侧)。')
    dominant = max((('排名出局', len(b_rank)), ('窗口内被吸收', len(b_absorb)),
                    ('门限挡下', len(b_gate)), ('检索真没取到', len(b_miss)),
                    ('被过滤器排除', len(b_excl))), key=lambda kv: kv[1]) if n else ('n/a', 0)
    print('      最大类 = %s(%d/%d) ⇒ 下一步该动的是 %s' % (
        dominant[0], dominant[1], n,
        {'排名出局': '注入窗口/topK(而非检索或准入)', '窗口内被吸收': '选择与抑制(轮换/冷却/否决)',
         '门限挡下': 'minSimilarity 门限', '检索真没取到': '检索侧(表征/查询覆盖)',
         '被过滤器排除': '无需动 —— 该类是设计排除(任务复述/自帧), 不是缺陷'}.get(dominant[0], 'n/a')))
    if len(b_miss) == 0:
        print('      **cl-278 的核心问句已可答**: 把"被设计排除"的剔除后, "检索真没取到" = 0 ⇒ 覆盖率损失**全部**发生在'
              '选择侧(注入窗口/门限/抑制), 不是检索侧没取到。')
    else:
        print('      cl-278 的核心问句: "检索真没取到" %d 条(%s) —— 低于可按条排查的量级前不单独立项。'
              % (len(b_miss), share(b_miss).strip()))
    # 2026-09-13 12:3x(cl-278 nextAction ③): 把「被注入前过滤器排除」与「检索真没取到」做成**常驻计数**。
    # 动机: 这两个数此前只在我手算时出现(9 条), 没有落账 ⇒ 下一帧很容易把"没被注入"重新读成"检索失败"(已经发生过一次)。
    # 落账口径: 每次运行追加一行(含 era 边界与窗口), 供阶段总结与后续帧直接引用, 不必重跑。
    _row = {'ts': datetime.datetime.now(tz).isoformat(), 'era': fmt(era), 'usableSince': fmt(w0),
            'windowEnd': fmt(w1), 'turns': sum(1 for r in tagged if (r.get('t') or 0) >= w0),
            'library': len(lib), 'injectedInWindow': len(win_used), 'injectedPreEra': len(pre_used),
            'batch': n, 'rankCut': len(b_rank), 'absorbed': len(b_absorb),
            'belowGateOnly': len(b_gate), 'excludedByFilter': dict(Counter(w for _, w in b_excl)),
            'notRetrieved': len(b_miss), 'reachableRate': round(reachable / max(len(lib), 1), 4)}
    lp = os.path.join(D, 'coverage-attribution.jsonl')
    if '--dry-run' not in sys.argv:
        with open(lp, 'a', encoding='utf8') as fh:
            fh.write(json.dumps(_row, ensure_ascii=False) + '\n')
        print('\n已落常驻计数: %s(excludedByFilter=%s, notRetrieved=%d)'
              % (lp, _row['excludedByFilter'], _row['notRetrieved']))
    else:
        print('\n(--dry-run: 未落常驻计数; 本行内容 %s)' % json.dumps(_row, ensure_ascii=False))
    # 生产里"陈旧"的真实形态(cl-053 nextAction ①): 长尾 vs 已注入的 IDF 分布对照
    try:
        shape = idf_shape(lib, [e['expId'] for e in batch if e['expId'] in set(b_rank)], set(win_used),
                          {eid for eid, _ in b_excl})
        print('\n=== 长尾 vs 已注入: 元素 IDF 分布(cl-053 ① 的兑现) ===')
        for k in ('injectedInWindow', 'rankCutLongTail'):
            v = shape.get(k)
            if v:
                print('  %-18s n=%-4d 条目内元素 IDF 中位 %.2f | 条目最大 IDF 中位 %.2f / p90 %.2f'
                      % (k, v['n'], v['medianIdf'], v['maxIdfP50'], v['maxIdfP90']))
        it, lt = shape.get('injectedInWindow'), shape.get('rankCutLongTail')
        if it and lt:
            d = lt['medianIdf'] - it['medianIdf']
            print('  判读: 长尾 − 已注入 的中位 IDF 差 %+.2f ⇒ %s' % (
                d, '长尾**更独特**(罕见元素更多) ⇒ 提权有依据' if d > 0.5 else
                   ('长尾更"普通"(常见词更多) ⇒ 提权多半只会换来冗余' if d < -0.5 else
                    '两类**几乎没有区别** ⇒ 长尾不是"独特内容被饿着", 而是排序/窗口问题(与 cl-278 同向)')))
            print('  参照: 旧构造抽到的元素中位 IDF 1.39(常见词) / 最坏构造(IDF 前400) 4.91')
    except Exception as exc:  # noqa: BLE001
        print('  (IDF 形态测量失败: %s)' % exc)
    if '--json' in sys.argv:
        print(json.dumps({'library': len(lib), 'window': [w0, w1], 'topK': topk, 'minSimilarity': minsim,
                          'injectedInWindow': len(win_used), 'injectedPreEra': len(pre_used),
                          'batch': n, 'rankCut': len(b_rank), 'absorbed': len(b_absorb),
                          'belowGate': len(b_gate), 'notRetrieved': len(b_miss), 'excludedByFilter': len(b_excl), 'tooNew': len(b_new),
                          'elementPoolTruncationLoss': pool_trunc,
                          'reachableRate': reachable / max(len(lib), 1),
                          'injectionCoverage': len(win_used) / max(len(lib), 1),
                          'dominant': dominant[0]}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
