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


def main():
    rows = load()
    audited = [r for r in rows if 'originalTopExpId' in r]
    promoted = [r for r in audited if r.get('promotedExpId')]
    no_refine = [r for r in rows if r.get('retrievalNote') is None and r.get('originalTopExpId') is None]

    print(f'预测总数 {len(rows)}；带审计键 {len(audited)}；其中精排提升 {len(promoted)}')
    print(f'精排门控未开火 {len(no_refine)}')

    groups = {
        'A·精排提升': [r for r in promoted if resolved(r)],
        'B·未开火': [r for r in no_refine if resolved(r)],
    }
    for name, g in groups.items():
        if not g:
            print(f'{name}: 已结算 0 条')
            continue
        errs = [r['predictionError'] for r in g]
        print(f'{name}: 已结算 {len(g)} 条, 平均误差 {statistics.mean(errs):.3f}, '
              f'中位 {statistics.median(errs):.3f}, 最大 {max(errs):.3f}')

    if len(groups['A·精排提升']) < MIN_N or len(groups['B·未开火']) < MIN_N:
        print(f'\n样本不足（门槛各 {MIN_N} 条）——只报计数，不给结论。')
        return 0

    a = statistics.mean(r['predictionError'] for r in groups['A·精排提升'])
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
        print(f"  {r['predictionId']}  {r.get('originalTopExpId')} → {r.get('promotedExpId')}"
              f"  误差={'-' if err is None else format(err, '.3f')}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
