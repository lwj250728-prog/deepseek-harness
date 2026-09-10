#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采纳观察快照(tp-093 / T113 的数据侧): 每次观察把主判据的数字落一行, 供趋势判读。

为什么需要: nextAction 是"观察型 24h"——判据要有 n>=100 才判, 意味着同一个数字要看很多次。
没有追加式快照, 每次都是"当前值 vs 我记忆里的值"(cl-116 的老毛病: 拿记忆当基线)。这里把
每次观察的 (时间, 窗口, 注入, 采纳, 文本率, lift, 不同经验数, 样本是否够) 写死, 判读时看趋势。

用法: dsh-adoption-observe.py            # 追加一行快照
数据源: ab-compare.json(唯一 A/B 生产者) —— 不在这里重算, 只转录。
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.path.expanduser('~/dsh-fork')
AB = os.path.join(DIR, 'ab-compare.json')
OUT = os.path.join(DIR, 'adoption-observations.jsonl')
TZ = datetime.timezone(datetime.timedelta(hours=8))



def _mem_available_mb() -> int:
    """宿主可用内存(MB)。观测工具不得与被观测的服务抢内存到把服务打死(cl-155 OOM 事故)。"""
    try:
        with open(os.environ.get('DSH_MEMINFO_PATH', '/proc/meminfo'), encoding='utf8') as fh:
            for line in fh:
                if line.startswith('MemAvailable'):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return 10 ** 6

def main() -> int:
    # 先让唯一生产者刷新一次, 保证转录的数字来自刚跑过的对照而不是过期快照。
    run = subprocess.run([sys.executable, os.path.join(REPO, 'dsh-ab-compare.py'), '--quiet'],
                         capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        print('A/B 生产者失败: %s' % (run.stderr or '')[:300], file=sys.stderr)
        return 1
    payload = json.load(open(AB, encoding='utf8'))
    adoption = payload.get('adoption') or {}
    segs = adoption.get('segments') or {}
    before, union = segs.get('before'), adoption.get('afterUnion')
    if not before or not union:
        print('缺前后窗数据, 拒绝写快照', file=sys.stderr)
        return 1
    verdict = payload.get('adoptionVerdict') or {}
    if _mem_available_mb() < 400:
        print('内存不足(<400MB): 拒绝运行以免触发 OOM', file=sys.stderr)
        return 3
    record = {
        'ts': datetime.datetime.now(TZ).isoformat(),
        'splitAt': payload.get('splitAt'),
        'beforeWindow': {'hours': before.get('hours'), 'injected': before.get('injected'),
                         'citedLedger': before.get('citedLedger'), 'rateLedger': before.get('rateLedger'),
                         'injectionsPerHour': before.get('injectionsPerHour'),
                         'citedPerHour': before.get('citedPerHour'),
                         'turnsWithInjection': before.get('turnsWithInjection'),
                         'textRate': before.get('textRate'), 'lift': before.get('lift')},
        'afterWindow': {'hours': union.get('hours'), 'injected': union.get('injected'),
                        'citedLedger': union.get('citedLedger'), 'rateLedgerMixedLens': union.get('rateLedgerMixedLens'),
                        'turnsWithInjection': union.get('turnsWithInjection'), 'textRate': union.get('textRate'),
                        'lift': union.get('lift')},
        'funnel': {'distinctExperiences': payload.get('after', {}).get('distinctExperiences'),
                   'distinctExperiencesBefore': payload.get('before', {}).get('distinctExperiences'),
                   'injectedCharsMean': payload.get('after', {}).get('injectedCharsMean'),
                   'injectedCountDistribution': payload.get('after', {}).get('injectedCountDistribution')},
        'verdict': {'enoughSample': verdict.get('enoughSample'), 'direction': verdict.get('direction'),
                    'rollbackIf': verdict.get('rollbackIf'), 'abVerdict': payload.get('verdict')},
        'confounders': [c.get('kind') for c in (payload.get('confounders') or [])],
        'source': 'transcribed from ab-compare.json (single A/B producer)',
        'origin': os.environ.get('DSH_RUN_ORIGIN', 'manual'),
    }
    with open(OUT, 'a', encoding='utf8') as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + '\n')
    print('已追加观察快照: 前窗 注入%s/采纳%s 文本率%s lift%s | 后窗 注入%s/采纳%s 文本率%s 回合%s'
          % (before.get('injected'), before.get('citedLedger'), before.get('textRate'), before.get('lift'),
             union.get('injected'), union.get('citedLedger'), union.get('textRate'),
             union.get('turnsWithInjection')))
    print('判据: 样本%s | 方向 %s | 回滚条件 %s'
          % ('足' if verdict.get('enoughSample') else '不足', verdict.get('direction'), verdict.get('rollbackIf')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
