#!/usr/bin/env python3
"""A/B 对照（tp-088 / T104）：加宽前后同一批指标，机械对比。

今天的教训(cl-116)：我用"记忆里的数字"当基线，把 cl-100 修复前的坏账本读数当成了
现状，据此立了一个错的闸门。所以任何 A/B 都必须在**改变发生的那一刻**把基线写死，
之后每次都从同一个脚本出两栏对比——不允许再"凭印象比较"。

数据源：retrieval-audit.jsonl（含 rawHits/candidates/vetoJudged/expIds/injectedChars）
分组：以 --split（默认取 profile 里 topK 的当前值对应的切换时刻，见 ab-baselines.json）
输出：ab-compare.json + 控制台两栏

用法：dsh-ab-compare.py [--split ISO] [--quiet]
退出码：0 = 出数；1 = 缺数据或基线。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
AUDIT = os.path.join(DIR, 'retrieval-audit.jsonl')
OUT = os.path.join(DIR, 'ab-compare.json')
BASELINES = os.path.join(DIR, 'ab-baselines.json')
CONFOUNDERS = os.path.join(DIR, 'ab-confounders.jsonl')
DEFAULT_SPLIT = '2026-09-10T14:07:00+08:00'   # topK 1 -> 3 的重启时刻
REPO = os.path.expanduser('~/dsh-fork')
# 结算口径变更时刻: cl-128 改用未截断文本(outcomeFull)后, cited 口径与之前不可直接比。
# 它落在"加宽后"窗口内 => 后窗本身混合两套口径, 必须在对照里显式切出来, 否则低估后窗。
SETTLEMENT_FIX_COMMIT = '8ed52e7'
ADOPTION_SCRIPT = os.path.join(REPO, 'dsh-adoption-stats.py')


def commit_epoch(rev: str) -> int | None:
    import subprocess
    try:
        out = subprocess.run(['git', '-C', REPO, 'show', '-s', '--format=%at', rev],
                             capture_output=True, text=True, timeout=30)
        return int(out.stdout.strip()) * 1000 if out.stdout.strip() else None
    except Exception:
        return None


def _iso_ms(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return int(datetime.datetime.fromisoformat(iso).timestamp() * 1000)
    except Exception:
        return None


def lens_change() -> tuple[int | None, str | None]:
    """引用口径生效时刻: 从混杂因素账本取 kind=settlement-fix 的 ts。

    提交时刻≠生效时刻(提交 04:57 / 部署 15:50), 所以这条边界必须来自账本记录的事实时间。

    返回 (毫秒, 账本原始字符串)。字符串**逐字转抄**而不是用 fromtimestamp 再生成:
    重新生成会丢掉时区偏移(+08:00 => 裸本地时间), 于是"同一瞬间、两种表示",
    任何跨文件比较都会失配 —— 而这正是本轮 T113 抓到的第一次红。
    """
    if not os.path.exists(CONFOUNDERS):
        return None, None
    for line in open(CONFOUNDERS, encoding='utf8'):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get('kind') == 'settlement-fix':
            ms = _iso_ms(row.get('ts'))
            if ms:
                return ms, row.get('ts')
    return None, None


def adoption_window(since_iso: str, until_iso: str | None) -> dict | None:
    """把采纳率交给唯一生产者(dsh-adoption-stats.py), 本脚本只负责切窗口。

    不在这里重算采纳率: 今天(09-09)已经吃过一次"同一指标两套口径"的亏——手算一套、
    脚本一套、水位不同, 结论就随口径漂移。此处只做 shell 转发与窗口编排。
    """
    import subprocess
    cmd = [sys.executable, ADOPTION_SCRIPT, '--since', since_iso, '--json']
    if until_iso:
        cmd += ['--until', until_iso]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            return {'error': (out.stderr or '').strip()[:200]}
        return json.loads(out.stdout)
    except Exception as exc:                                  # pragma: no cover
        return {'error': str(exc)[:200]}


def adoption_comparison(split_ms: int, until_fix_ms: int | None, until_fix_iso: str | None = None) -> dict:
    """加宽前 / 加宽后(旧口径段) / 加宽后(新口径段) 三段采纳对照 + 归一化。

    口径变更时刻取自混杂因素账本(kind=settlement-fix), 不取 commit author time:
    09-10 实测踩过——把 cl-100 的干净窗口水位(04:57 提交时刻)当成了 cl-128 的口径
    变更时刻(15:50 部署), 于是"后窗"被切成 [14:07, 04:57) 空集, 整张表错位。
    提交时刻 ≠ 口径生效时刻; 有账本就用账本(cl-130 的同族教训)。
    """
    clean = commit_epoch(SETTLEMENT_FIX_COMMIT)
    if clean is None:
        return {'error': '缺水位: 无法确定结算修复时刻, 拒绝出采纳对照'}
    # 干净窗口起点直接由提交时刻推导(水位是常量), 不读 adoption-stats.json 快照——
    # 快照会被子窗口运行改写, 拿它当水位等于把水位交给"最后一次谁跑过脚本"。
    clean_start_ms = clean + 2 * 60 * 1000
    clean_start = datetime.datetime.fromtimestamp(clean_start_ms / 1000).isoformat()
    split_iso = datetime.datetime.fromtimestamp(split_ms / 1000).isoformat()
    segments = {
        'before': adoption_window(clean_start, split_iso),
        'afterOldLens': adoption_window(split_iso, until_fix_ms and
                                        datetime.datetime.fromtimestamp(until_fix_ms / 1000).isoformat()),
        'afterNewLens': (adoption_window(datetime.datetime.fromtimestamp(until_fix_ms / 1000).isoformat(), None)
                         if until_fix_ms else None),
    }

    def rate(seg: dict | None, path: str):
        cur = seg
        for key in path.split('.'):
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        return cur

    # 绝对条数必须配合窗口时长看: 前窗 9 小时 51 注入, 后窗 3 小时 20 注入,
    # 直接比"绝对条数"会把时段长度当成效能(cl-134)。
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    spans = {'before': (split_ms - _iso_ms(clean_start)), 'afterOldLens': None, 'afterNewLens': None}
    if until_fix_ms:
        spans['afterOldLens'] = until_fix_ms - split_ms
        spans['afterNewLens'] = max(0, now_ms - until_fix_ms)
    rows = {}
    for name, seg in segments.items():
        if seg is None:
            continue
        hours = (spans.get(name) or 0) / 3600000.0
        injected = rate(seg, 'total.injected')
        rows[name] = {
            'windowStart': seg.get('windowStart'), 'windowEnd': seg.get('windowEnd'),
            'hours': round(hours, 2),
            'injected': injected,
            'citedLedger': rate(seg, 'total.cited'),
            'rateLedger': rate(seg, 'total.rate'),
            'injectionsPerHour': round(injected / hours, 1) if hours and injected else None,
            'citedPerHour': (round((rate(seg, 'total.cited') or 0) / hours, 2) if hours else None),
            'turnsWithInjection': seg.get('turnsWithInjection'),
            'textRate': seg.get('textMentionAdoptionRate'),
            'backgroundRate': seg.get('backgroundRate'),
            'lift': seg.get('lift'),
        }
    # 后窗合体(账本口径跨了变更点 => 比例不可直接相加, 只给绝对条数与回合级文本率)
    after_union = None
    if rows.get('afterOldLens') and rows.get('afterNewLens'):
        import math
        a, b = rows['afterOldLens'], rows['afterNewLens']
        inj = (a['injected'] or 0) + (b['injected'] or 0)
        cited = (a['citedLedger'] or 0) + (b['citedLedger'] or 0)
        turns = (a['turnsWithInjection'] or 0) + (b['turnsWithInjection'] or 0)
        union_background = round(((a['backgroundRate'] or 0) * (a['turnsWithInjection'] or 0)
                                  + (b['backgroundRate'] or 0) * (b['turnsWithInjection'] or 0)) / turns, 4) \
            if turns else None
        union_text = round(((a['textRate'] or 0) * (a['turnsWithInjection'] or 0)
                            + (b['textRate'] or 0) * (b['turnsWithInjection'] or 0)) / turns, 4) if turns else None
        after_union = {
            'hours': round(a['hours'] + b['hours'], 2), 'injected': inj, 'citedLedger': cited,
            'rateLedgerMixedLens': round(cited / inj, 4) if inj else None,
            'lensWarning': '跨结算口径变更点, 比例仅供看量级, 判定须分段看',
            'turnsWithInjection': turns,
            'textRate': union_text,
            'backgroundRate': union_background,
            'lift': (round(union_text / union_background, 3)
                     if union_text is not None and union_background else None),
        }
    return {'segments': rows, 'afterUnion': after_union,
            'settlementLensChangedAt': until_fix_iso or (
                datetime.datetime.fromtimestamp(until_fix_ms / 1000).isoformat() if until_fix_ms else None),
            'settlementLensSource': 'ab-confounders.jsonl kind=settlement-fix 的 ts(事实时间)',
            'cleanWindowStart': clean_start,
            'note': ('绝对采纳条数须归一化(条/小时)后再比: 前窗 9h/后窗 3h, 直接比条数等于比时段长度; '
                     'lift 与文本口径以"回合"为单位, 是主判据的方向指示。'
                     '分段理由: cited(账本口径)跨 15:50 结算口径变更不可直接比, 故后窗切两段; '
                     '文本口径独立读会话文本、不受结算口径影响, 其合体值可直接与前窗比。')}


def load_rows() -> list[dict]:
    rows = []
    for line in open(AUDIT, encoding='utf8'):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def summarize(rows: list[dict]) -> dict:
    injected = [r for r in rows if r.get('stage') == 'injected' and r.get('expIds')]
    counts = collections.Counter(len(r['expIds']) for r in injected)
    distinct = {e for r in injected for e in r['expIds']}
    chars = [r['injectedChars'] for r in injected if isinstance(r.get('injectedChars'), int)]
    judged = [r['vetoJudged'] for r in injected if isinstance(r.get('vetoJudged'), int)]
    silent = [r['vetoSilent'] for r in injected if isinstance(r.get('vetoSilent'), int)]
    cands = [r['candidates'] for r in rows if isinstance(r.get('candidates'), int)]
    return {
        'decisions': len(rows),
        'injections': len(injected),
        'injectedPerDecision': round(len(injected) / len(rows), 3) if rows else None,
        'injectedCountDistribution': {str(k): v for k, v in sorted(counts.items())},
        'distinctExperiences': len(distinct),
        'candidatesMedian': sorted(cands)[len(cands) // 2] if cands else None,
        'vetoJudgedTotal': sum(judged) if judged else None,
        'vetoSilentTotal': sum(silent) if silent else None,
        'injectedCharsMean': round(sum(chars) / len(chars)) if chars else None,
        'injectedCharsTotal': sum(chars) if chars else None,
    }


def confounders_in_window(before_start_ms: int) -> list[dict]:
    """窗口内的环境变更(混杂因素): 供应商改名/结算口径变化/受控重启等。

    cl-130 的教训: A/B 两侧可能被"模型其实换了""口径改了"这类**与实验变量无关**的变化
    污染。把这类变更记成账本并在对照里自动列出——不允许之后再凭记忆补注。
    """
    if not os.path.exists(CONFOUNDERS):
        return []
    items = []
    for line in open(CONFOUNDERS, encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        try:
            stamp = int(datetime.datetime.fromisoformat(record['ts']).timestamp() * 1000)
        except Exception:
            continue
        # 区间型混杂(如"供应商改名发生在 09:00~15:18 之间"): 只要窗口与之有交集就算命中,
        # 否则一个边界模糊的变更会因为时间戳恰好落在窗口外而被静默漏掉(cl-130 的形态)。
        until_ms = None
        if record.get('until'):
            try:
                until_ms = int(datetime.datetime.fromisoformat(record['until']).timestamp() * 1000)
            except Exception:
                until_ms = None
        if (until_ms is None and stamp >= before_start_ms) or (until_ms is not None and until_ms >= before_start_ms):
            items.append({**record, 'tsMs': stamp})
    return sorted(items, key=lambda r: r['tsMs'])


def novelty_stats(split_ms: int) -> dict:
    """注入新鲜度: 每个 expId 在被注入时刻"此前已被注入过几次"。

    cl-120+cl-121 的设计目标是"让模型看到更新鲜的经验"; 采纳率(最终指标)样本还小,
    而这个中间变量可以立刻量出来——它才是加宽/轮换是否起作用的直接证据。
    """
    injections = {}
    for line in open(os.path.join(DIR, 'injections.jsonl'), encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record.get('injectionId'), str):
            injections[record['injectionId']] = record
    main = 'session-63251d85-ef77-4299-939d-9a6fe9b5bec6'
    ordered = sorted((r for r in injections.values() if str(r.get('sessionId')) == main),
                     key=lambda r: r.get('createdAt') or 0)
    seen: dict[str, int] = {}
    before, after = [], []
    for record in ordered:
        bucket = after if (record.get('createdAt') or 0) >= split_ms else before
        for exp_id in record.get('expIds') or []:
            bucket.append(seen.get(exp_id, 0))
            seen[exp_id] = seen.get(exp_id, 0) + 1

    def summarize(values: list[int]) -> dict:
        if not values:
            return {'n': 0}
        ordered_values = sorted(values)
        return {
            'n': len(values),
            'priorInjectionsMedian': ordered_values[len(ordered_values) // 2],
            'priorInjectionsMean': round(sum(values) / len(values), 1),
            'neverInjectedShare': round(sum(1 for v in values if v == 0) / len(values), 3),
        }
    return {'before': summarize(before), 'after': summarize(after)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', default=None)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    split_iso = args.split
    if split_iso is None and os.path.exists(BASELINES):
        try:
            split_iso = json.load(open(BASELINES, encoding='utf8')).get('splitAt')
        except Exception:
            split_iso = None
    split_iso = split_iso or DEFAULT_SPLIT
    split_ms = int(datetime.datetime.fromisoformat(split_iso).timestamp() * 1000)

    rows = load_rows()
    before = [r for r in rows if (r.get('t') or 0) < split_ms]
    after = [r for r in rows if (r.get('t') or 0) >= split_ms]
    if not rows:
        print('缺 retrieval-audit.jsonl 记录: 无法对照', file=sys.stderr)
        return 1

    # 样本充分性: 今天三次误判(n=1 / 3-of-3 / post-cover 计数)都源于"拿小样本当结论"。
    # 对照结果必须自带这一判读, 否则 4 条样本的两栏表会被当成结论。
    MIN_SAMPLE = 10
    before_sum, after_sum = summarize(before), summarize(after)
    verdict = ('insufficient-sample'
               if before_sum['decisions'] < MIN_SAMPLE or after_sum['decisions'] < MIN_SAMPLE
               else 'comparable')
    all_times = [r.get('t') or 0 for r in rows if r.get('t')]
    confounds = confounders_in_window(min(all_times) if all_times else 0)
    # cl-134: 主判据(不同经验数 + 采纳率不降 + 绝对采纳数不降)此前在对照里缺席——
    # 漏斗指标全在, 采纳侧却要人肉另跑脚本, 于是"判读"看着像有依据其实缺一半。
    # 口径变更时刻来自混杂因素账本(事实时间), 不是 commit author time —— 提交≠生效。
    lens_ms, lens_iso = lens_change()
    adoption = adoption_comparison(split_ms, lens_ms, lens_iso)
    # 判据字段必须落在 payload 里(写文件之前), 不能只在打印分支里算:
    # --quiet 消费者(观察快照脚本)拿到的会是 null —— "判据只长在显示路径上"是今天的同族病。
    adoption_verdict = None
    if isinstance(adoption, dict) and adoption.get('segments'):
        _segs = adoption['segments']
        _b, _union = _segs.get('before'), adoption.get('afterUnion') or {}
        _turns = _union.get('turnsWithInjection') or 0
        _enough = _turns >= 40
        _direction = None
        if _b and _union.get('textRate') is not None and _b.get('textRate') is not None:
            _direction = ('adverse' if _union['textRate'] < _b['textRate'] / 2
                          else 'not-adverse' if _union['textRate'] >= _b['textRate'] else 'mixed')
        adoption_verdict = {
            'enoughSample': _enough,
            'sampleNote': '后窗有注入回合 %s(阈值 40 才允许下方向性结论)' % _turns,
            'direction': _direction,
            'rollbackIf': '后窗回合文本率 < 前窗一半 且 后窗有注入回合>=40 => topK 回滚到 1',
            'judgeLiftAt': 'lift 需 n>=100(目标池判据), 当前仅作方向指示',
        }
    payload = {
        'verdict': verdict,
        'confounders': confounds,
        'confoundNote': ('窗口内存在与实验变量无关的环境变更, 结论须带此保留'
                         if confounds else '窗口内无已登记的混杂因素'),
        'novelty': novelty_stats(split_ms),
        'adoption': adoption,
        'adoptionVerdict': adoption_verdict,
        'minSample': MIN_SAMPLE,
        'splitAt': split_iso,
        'splitReason': 'topK 1 -> 3 (cl-120 主杠杆)',
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'before': before_sum,
        'after': after_sum,
    }
    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    if not args.quiet:
        print('切换点 %s (%s) | 判读: %s' % (split_iso, payload['splitReason'], payload['verdict']))
        if confounds:
            print('混杂因素 %d 条(窗口内):' % len(confounds))
            for item in confounds:
                print('  [%s] %s — %s' % (item['ts'][:16], item['kind'], item['note'][:60]))
        keys = ('decisions', 'injections', 'injectedCountDistribution', 'distinctExperiences',
                'candidatesMedian', 'vetoJudgedTotal', 'vetoSilentTotal', 'injectedCharsMean')
        print('  %-28s %-22s %-22s' % ('指标', '加宽前', '加宽后'))
        for key in keys:
            print('  %-28s %-22s %-22s' % (key, payload['before'].get(key), payload['after'].get(key)))
        print('  %-28s %-22s %-22s' % ('-- 新鲜度 --', '', ''))
        for key in ('n', 'priorInjectionsMedian', 'priorInjectionsMean', 'neverInjectedShare'):
            print('  %-28s %-22s %-22s'
                  % (key, payload['novelty']['before'].get(key), payload['novelty']['after'].get(key)))
        # ── 采纳侧(主判据的一半, cl-134 前一直缺席) ──
        if isinstance(adoption, dict) and 'segments' in adoption:
            segs = adoption['segments']
            print('  %-28s %-22s %-22s' % ('-- 采纳(主判据) --', '加宽前', '加宽后'))
            order = [k for k in ('before', 'afterOldLens', 'afterNewLens') if k in segs]
            for key, label in (('windowStart', '窗口起点'), ('hours', '窗口时长(h)'), ('injected', '注入条数'),
                               ('injectionsPerHour', '注入/小时'), ('citedLedger', '采纳条数(账本)'),
                               ('citedPerHour', '采纳/小时'), ('rateLedger', '采纳率(账本口径)'),
                               ('turnsWithInjection', '有注入的回合'), ('textRate', '文本口径回合率'),
                               ('backgroundRate', '背景率(提到未注入项)'), ('lift', 'lift(文本 vs 背景)')):
                values = [str(segs[k].get(key)) for k in order]
                if len(values) == 2:
                    print('  %-28s %-22s %-22s' % (key, values[0], values[1]))
                else:
                    print('  %-28s %s' % (key, ' | '.join(values)))
            if adoption.get('afterUnion'):
                u = adoption['afterUnion']
                print('  后窗合体: 注入 %s / 采纳 %s 条 / 回合文本率 %s (%s h)'
                      % (u['injected'], u['citedLedger'], u['textRate'], u['hours']))
            print('  注: %s' % adoption['note'])
            # 判据从 payload 读(与落盘同源), 打印分支不再自算。
            av = payload.get('adoptionVerdict') or {}
            print('  判读: 样本%s(%s); 方向=%s; 回滚条件: %s'
                  % ('已足' if av.get('enoughSample') else '不足', av.get('sampleNote'),
                     av.get('direction'), av.get('rollbackIf')))
        elif isinstance(adoption, dict) and adoption.get('error'):
            print('  采纳对照不可用: %s' % adoption['error'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
