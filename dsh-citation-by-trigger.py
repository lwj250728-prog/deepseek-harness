#!/usr/bin/env python3
"""dsh-citation-by-trigger.py — 按触发源拆引用率，找"死掉的注入通道"。

背景：注入环的整体引用率只有 ~4%（验收线 25%），但"整体低"不能指导改动——
必须知道是哪一类触发在制造无用的注入。本脚本按 triggerSource 分类统计引用率，
并对"已结算 ≥50 条且引用率 0%"的类打死亡标记（这类通道要么触发器错，要么内容无关）。

用法: python3 dsh-citation-by-trigger.py
"""
import json, os, sys
from collections import defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
MIN_SETTLED = 50


def cls(ts: str) -> str:
    ts = ts or ''
    if ts.startswith('jump:'):
        return 'jump'
    if ts.startswith('derived:'):
        return 'derived'
    if ts.startswith('static:'):
        return 'static'
    return 'other'


def main() -> int:
    path = os.path.join(D, 'injections.jsonl')
    rows = [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]
    agg = defaultdict(lambda: [0, 0])
    for r in rows:
        if r.get('cited') is None:
            continue
        c = cls(r.get('triggerSource'))
        agg[c][1] += 1
        if r.get('cited'):
            agg[c][0] += 1
    total_cited = sum(v[0] for v in agg.values())
    total_settled = sum(v[1] for v in agg.values())
    print(f'注入 {len(rows)} 条｜已结算 {total_settled}｜总引用率 {total_cited / max(total_settled, 1) * 100:.1f}%')
    dead = []
    for k, (cited, settled) in sorted(agg.items()):
        rate = cited / max(settled, 1) * 100
        flag = ''
        if settled >= MIN_SETTLED and cited == 0:
            flag = '  ← 死亡通道(≥%d 条已结算且 0 引用)' % MIN_SETTLED
            dead.append(k)
        print(f'  {k:<8} 已结算 {settled:>4} | 被引用 {cited:>3} | 引用率 {rate:>5.1f}%{flag}')
    # 触发词粒度
    with_jump = [r for r in rows if r.get('cited') is not None and (r.get('jumpWords') or [])]
    without = [r for r in rows if r.get('cited') is not None and not (r.get('jumpWords') or [])]
    def rate(g):
        return sum(1 for r in g if r.get('cited')) / max(len(g), 1) * 100
    print(f'  带 jumpWords: {len(with_jump)} 条, 引用率 {rate(with_jump):.1f}%'
          f'｜不带: {len(without)} 条, 引用率 {rate(without):.1f}%')
    if dead:
        print(f'\n判读: {", ".join(dead)} 通道引用率为 0 —— 需查触发器是否过宽或内容是否无关, 不建议继续加量。')
    else:
        print('\n判读: 无死亡通道。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
