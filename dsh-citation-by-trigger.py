#!/usr/bin/env python3
"""dsh-citation-by-trigger.py — 按触发源拆引用率，找"死掉的注入通道"。

背景：注入环的整体引用率只有 ~4%（验收线 25%），但"整体低"不能指导改动——
必须知道是哪一类触发在制造无用的注入。本脚本按 triggerSource 分类统计引用率，
并对"已结算 ≥50 条且引用率 0%"的类打死亡标记（这类通道要么触发器错，要么内容无关）。

用法: python3 dsh-citation-by-trigger.py
"""
import datetime, json, os, sys
from collections import defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
MIN_SETTLED = 50


def load_era(d: str):
    """返回 (since_ms, since_iso)。读不到/解析不了直接抛 —— 调用方 fail-closed。

    cl-274: 引用率的**采集方式**在 09-10 05:28 前后变了(注入块里加了引用契约,
    commit 8e5b7dc)。09-04~09-09 的 0%~5% 测的是"我有没有自发写 ID", 不是
    "经验有没有用"; 混在一起算平均会把"信号不存在"读成"通道死亡"。
    """
    p = os.path.join(d, 'citation-era.json')
    since = str(json.load(open(p, encoding='utf8')).get('since') or '')
    if not since:
        raise ValueError('citation-era.json 缺 since')
    ms = int(datetime.datetime.fromisoformat(since).timestamp() * 1000)
    return ms, since


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
    d = os.environ.get('DSH_COG_DIR') or D
    try:
        era_ms, era_since = load_era(d)
    except Exception as exc:
        print('缺时代: 读不到/解析不了 citation-era.json(%s) ⇒ 拒绝出数(跨时代平均会把'
              '"信号不存在"读成"经验没用")' % exc, file=sys.stderr)
        return 1
    path = os.path.join(d, 'injections.jsonl')
    all_rows = [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]
    rows = [r for r in all_rows if (r.get('createdAt') or 0) >= era_ms]
    pre_era = len(all_rows) - len(rows)
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
    print(f'注入 {len(rows)} 条｜已结算 {total_settled}｜总引用率 {total_cited / max(total_settled, 1) * 100:.1f}%'
          f'｜时代 since={era_since}(跨时代剔除 {pre_era} 条: 那段时间 cited 不可观测, 分子分母都不计)')
    if total_settled < MIN_SETTLED:
        print(f'  证据不足: 时代内已结算仅 {total_settled} 条(< {MIN_SETTLED}) ⇒ 死亡通道判定与引用率均不可读, 先攒数据。')
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
    # cl-100: 按日看引用率——整体低可能是"某天起崩塌", 而不是一直如此。
    import datetime, collections
    byday = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        if r.get('cited') is None:
            continue
        d = datetime.datetime.fromtimestamp((r.get('createdAt') or 0) / 1000).strftime('%m-%d')
        byday[d][1] += 1
        if r.get('cited'):
            byday[d][0] += 1
    print('\n按日引用率:')
    for d in sorted(byday):
        c, s = byday[d]
        print(f'  {d}  已结算 {s:>4} | 被引用 {c:>3} | {c / s * 100:>5.1f}%')

    if dead:
        print(f'\n判读: {", ".join(dead)} 通道引用率为 0 —— 需查触发器是否过宽或内容是否无关, 不建议继续加量。')
    else:
        print('\n判读: 无死亡通道。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
