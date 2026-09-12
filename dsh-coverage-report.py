#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-coverage-report.py — 注入覆盖率的**A 臂基线/复查**读数(experiment-diversity-bonus-20260912.md 的测量器)

它回答四个数(cl-284 的预登记判据 1~3 全靠这四个数):
  ① 覆盖率 = 时代内被注入过的**任务层**条目数 / 任务层库规模;
  ② 线上引用率(口径必须 `citation-era`, 且**分层报告** —— cl-289: 41% 的帧层同质低分会把合并均值拖低三分之一);
  ③ 上下文成本 = 每回合注入字符数均值 + 每回合注入条目数(护栏: 不得靠"多塞"提高覆盖率);
  ④ 排名分布 = "从未注入"的任务层条目在检索列表里的排名中位/前 10 占比(判断约束是轮换深度还是相似度差距)。

用法: dsh-coverage-report.py [--since ISO] [--json]
退出码: 0 正常; 3 读不到账本。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import statistics
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load(name, key):
    out = {}
    path = os.path.join(D, name)
    if not os.path.exists(path):
        return out
    for line in open(path, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if r.get(key):
                out[str(r[key])] = r
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default=None)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    since = args.since
    if not since:
        try:
            since = json.load(open(os.path.join(D, 'citation-era.json'), encoding='utf8'))['since']
        except Exception:  # noqa: BLE001
            print('[coverage] 缺 citation-era.json 且未给 --since ⇒ 拒绝出数(跨时代平均会把信号不存在读成没用)', file=sys.stderr)
            return 3
    era_ms = datetime.datetime.fromisoformat(since.replace('Z', '+00:00')).timestamp() * 1000

    task = load('experiences.jsonl', 'expId')
    frames = load('experiences-frames.jsonl', 'expId')
    inj = load('injections.jsonl', 'injectionId')
    era = [r for r in inj.values() if (r.get('createdAt') or 0) >= era_ms]
    if not task or not era:
        print('[coverage] 缺数据(任务层 %d / 时代内注入 %d) ⇒ 拒绝出数' % (len(task), len(era)), file=sys.stderr)
        return 3

    injected, cited_by_layer = set(), {'task': [0, 0], 'frame': [0, 0]}
    for r in era:
        for e in (r.get('expIds') or []):
            injected.add(e)
        layer = 'frame' if e_in_frames(e, frames) else 'task'
        if r.get('cited') is not None:
            cited_by_layer[layer][1] += 1
            if r.get('cited') is True:
                cited_by_layer[layer][0] += 1
    cov_num = len({e for e in injected if e in task})
    coverage = cov_num / len(task)

    audit = load('retrieval-audit.jsonl', 't')
    ranks = []
    for a in audit.values():
        ids = a.get('retrievedIds')
        if not isinstance(ids, list) or (a.get('t') or 0) < era_ms:
            continue
        ranked = {e: i + 1 for i, e in enumerate(ids)}
        never = [e for e in task if e not in injected]
        ranks += [ranked[e] for e in never if e in ranked]
    chars = [a.get('textChars') for a in audit.values()
             if isinstance(a.get('textChars'), (int, float)) and (a.get('t') or 0) >= era_ms]
    counts = [len(r.get('expIds') or []) for r in era]

    payload = {
        'eraSince': since, 'libraryTask': len(task), 'libraryFrames': len(frames),
        'injectedDistinctTask': cov_num, 'coverageTask': round(coverage, 4),
        'citationRateTask': (round(cited_by_layer['task'][0] / cited_by_layer['task'][1], 4)
                             if cited_by_layer['task'][1] else None),
        'citationRateFrame': (round(cited_by_layer['frame'][0] / cited_by_layer['frame'][1], 4)
                              if cited_by_layer['frame'][1] else None),
        'citationSettledTask': cited_by_layer['task'][1], 'citationSettledFrame': cited_by_layer['frame'][1],
        'meanTextChars': round(statistics.mean(chars), 1) if chars else None,
        'meanExpIdsPerInjection': round(statistics.mean(counts), 3) if counts else None,
        'neverInjectedRankMedian': statistics.median(ranks) if ranks else None,
        'neverInjectedTop10Share': (round(sum(1 for r in ranks if r <= 10) / len(ranks), 4) if ranks else None),
        'neverInjectedObservations': len(ranks),
        'layerSplitNote': '引用率与库统计均**分层报告**(cl-289); 覆盖率只按任务层算',
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('时代 since=%s' % since)
        print('  覆盖率(任务层): %d/%d = %.1f%%' % (cov_num, len(task), 100 * coverage))
        print('  引用率: 任务层 %s(n=%d) | 帧层 %s(n=%d)   ← 分层, 不合并不取均值'
              % (payload['citationRateTask'], payload['citationSettledTask'],
                 payload['citationRateFrame'], payload['citationSettledFrame']))
        print('  成本: 每回合注入字符 %s | 每回合注入条目 %s' % (payload['meanTextChars'], payload['meanExpIdsPerInjection']))
        print('  排名(从未注入者): 中位 %s, 前 10 占比 %s, 观测 %d'
              % (payload['neverInjectedRankMedian'], payload['neverInjectedTop10Share'], payload['neverInjectedObservations']))
    return 0


def e_in_frames(e, frames):
    return e in frames


if __name__ == '__main__':
    sys.exit(main())
