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
DEFAULT_SPLIT = '2026-09-10T14:07:00+08:00'   # topK 1 -> 3 的重启时刻


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
    payload = {
        'verdict': verdict,
        'novelty': novelty_stats(split_ms),
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
        keys = ('decisions', 'injections', 'injectedCountDistribution', 'distinctExperiences',
                'candidatesMedian', 'vetoJudgedTotal', 'vetoSilentTotal', 'injectedCharsMean')
        print('  %-28s %-22s %-22s' % ('指标', '加宽前', '加宽后'))
        for key in keys:
            print('  %-28s %-22s %-22s' % (key, payload['before'].get(key), payload['after'].get(key)))
        print('  %-28s %-22s %-22s' % ('-- 新鲜度 --', '', ''))
        for key in ('n', 'priorInjectionsMedian', 'priorInjectionsMean', 'neverInjectedShare'):
            print('  %-28s %-22s %-22s'
                  % (key, payload['novelty']['before'].get(key), payload['novelty']['after'].get(key)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
