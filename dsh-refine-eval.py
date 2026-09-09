#!/usr/bin/env python3
"""精排收益评估（cl-071 的下游判据 / cl-068 的度量器）。

背景：cl-071 把精排结果落盘（retrievalNote / promotedExpId / originalTopExpId），
目的只有一个——让"精排到底有没有用"变成可统计的问题，而不是"我觉得更准"。

本脚本读 predictions.jsonl，按"是否发生精排提升"分组，比较两组的预测误差：
  A 组 = promotedExpId 非空（精排把某个候选提到首位）
  B 组 = retrievalNote 为空（精排门控未开火，走的是融合 top-1）
只统计已结算（actualOutcome 非空且 predictionError 非空）的预测。

注意：这是**观测对比**，不是随机对照——A 组本来就是低置信/平坦 top 的查询，
先天更难。所以判据不是"A 组误差更低"，而是：
  · A 组误差显著高于 B 组 → 精排没有救回难查询（门控开火但无效）
  · A 组误差接近或低于 B 组 → 精排把难查询拉回到平均线附近（有效）
样本 n<5 时只打印计数，不给结论（防小样本过度解读）。
"""
import json, os, statistics, sys

P = os.path.expanduser('~/.dsh/cognitive-pipeline/predictions.jsonl')
MIN_N = 5


def load():
    rows = []
    with open(P, encoding='utf8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def resolved(r):
    return r.get('actualOutcome') is not None and isinstance(r.get('predictionError'), (int, float))


def is_autonomous(r):
    """cl-062 起, 自主回合会自动创建预测(问"本轮是否产出落盘产物")——那是另一个问题,
    混进精排 A/B 会把两种误差语义平均成一个数(tp-052 实测 A 均值 0.400→0.408)。"""
    return str(r.get('situation', '')).startswith('自主回合')


def main():
    rows = load()
    auto = [r for r in rows if is_autonomous(r)]
    rows = [r for r in rows if not is_autonomous(r)]
    audited = [r for r in rows if 'originalTopExpId' in r]
    promoted = [r for r in audited if r.get('promotedExpId')]
    # cl-093: B 组定义修正——此前"无 note 且无 originalTopExpId"只命中**审计字段上线前**的
    # 历史行(129 条), 与"门控未开火"不是一回事; 现在要求带审计键且未提升。
    legacy = [r for r in rows if 'originalTopExpId' not in r]
    no_refine = [r for r in rows
                 if r.get('retrievalNote') is None and r.get('promotedExpId') is None and 'originalTopExpId' in r]

    noop = [r for r in promoted if r.get('promotedExpId') == r.get('originalTopExpId')]
    changed = [r for r in promoted if r.get('promotedExpId') != r.get('originalTopExpId')]
    print(f'检索类预测 {len(rows)}（已排除自主回合预测 {len(auto)}）；带审计键 {len(audited)}；'
          f'精排提升 {len(promoted)}（真提升 {len(changed)} / 身份提升 noop {len(noop)}）')
    print(f'门控未开火(带审计键) {len(no_refine)} ｜ 审计前历史行(无法判门控) {len(legacy)}')
    if auto:
        settled_auto = [r for r in auto if resolved(r)]
        if settled_auto:
            errs_auto = [r['predictionError'] for r in settled_auto]
            print(f'自主回合预测(另一问题, 单列): {len(auto)} 条, 已结算 {len(settled_auto)} 条, '
                  f'平均误差 {statistics.mean(errs_auto):.3f}')

    # cl-087: A 组必须再拆——"真提升"(换人)与"身份提升"(noop, bestExpId==原首位)误差语义不同,
    # 混在一起会把"精排只是确认了原顺序"算成精排的收益/损失。
    groups = {
        'A1·真提升(changed)': [r for r in changed if resolved(r)],
        'A2·身份提升(noop)': [r for r in noop if resolved(r)],
        'B·未开火(审计后)': [r for r in no_refine if resolved(r)],
        'L·审计前历史行': [r for r in legacy if resolved(r)],
    }
    for name, g in groups.items():
        if not g:
            print(f'{name}: 已结算 0 条')
            continue
        errs = [r['predictionError'] for r in g]
        print(f'{name}: 已结算 {len(g)} 条, 平均误差 {statistics.mean(errs):.3f}, '
              f'中位 {statistics.median(errs):.3f}, 最大 {max(errs):.3f}')

    # cl-089: 链级诊断——精排是"链内重排"还是"跨链改道"? 跨链且误差变差=误路由。
    exp_chain = {}
    for r in load():
        pass
    try:
        exps = [json.loads(l) for l in open(os.path.expanduser('~/.dsh/cognitive-pipeline/experiences.jsonl'), encoding='utf8') if l.strip()]
        for e in exps:
            exp_chain[e.get('expId')] = e.get('chainId')
    except Exception:
        exps = []
    buckets = {'noop': [], 'intra-chain': [], 'cross-chain': [], 'unknown': []}
    for r in promoted:
        a, b = r.get('originalTopExpId'), r.get('promotedExpId')
        if a == b:
            buckets['noop'].append(r); continue
        ca, cb = exp_chain.get(a), exp_chain.get(b)
        if ca is None or cb is None:
            buckets['unknown'].append(r)
        elif ca == cb:
            buckets['intra-chain'].append(r)
        else:
            buckets['cross-chain'].append(r)
    print('\n链级诊断（精排把谁换成了谁）：')
    for name, g in buckets.items():
        if not g:
            print(f'  {name:<12} 0 条')
            continue
        errs = [r['predictionError'] for r in g if resolved(r)]
        stat = f'平均误差 {statistics.mean(errs):.3f}' if errs else '无已结算样本'
        print(f'  {name:<12} {len(g)} 条（已结算 {len(errs)}）  {stat}')

    if len(groups['A1·真提升(changed)']) < MIN_N or len(groups['B·未开火']) < MIN_N:
        print(f'\n样本不足（真提升与未开火各需 {MIN_N} 条）——只报计数，不给结论。')
        return 0

    a = statistics.mean(r['predictionError'] for r in groups['A1·真提升(changed)'])
    b = statistics.mean(r['predictionError'] for r in groups['B·未开火'])
    print(f'\nA {a:.3f} vs B {b:.3f} → 差 {a - b:+.3f}')
    if a > b + 0.10:
        print('判读：精排开火了但没救回难查询（A 明显更差）——门控或候选窗口需重标定。')
    elif a <= b + 0.10:
        print('判读：精排把低置信查询拉回平均线附近——保留；继续积累样本看趋势。')

    # 逐条明细：谁被提到首位、原首位是谁
    print('\n明细（最近 10 条提升）：')
    for r in promoted[-10:]:
        err = r.get('predictionError')
        tag = 'noop' if r.get('promotedExpId') == r.get('originalTopExpId') else 'changed'
        print(f"  {r['predictionId']}  {r.get('originalTopExpId')} → {r.get('promotedExpId')}"
              f"  [{tag}]  误差={'-' if err is None else format(err, '.3f')}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
