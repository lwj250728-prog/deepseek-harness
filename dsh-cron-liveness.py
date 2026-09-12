#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-cron-liveness.py — 排程机制的**活性**核查: 每条 cron 是否真的产出了痕迹(cl-290 的直接后果)

由来(2026-09-12 19:0x 实证): `dsh-cog-tests.sh` 的可执行位被自己的编辑工具抹掉后, **cron 的套件静默死了 1.5 小时**
—— 日志里只有一行 `Permission denied`, 裁决行缺失; 是我"对照权威日志发现 18:17 没有裁决行"才抓到的。
⇒ "机制在仓库里 + 台账在册 + 套件绿"**都不等于它在跑**。故本工具做一件很笨但必要的事:
把 crontab 每条命令的**见证产物**(日志文件 / 账本行 / 输出文件)找出来, 与其排程周期比**新鲜度**;
见证缺失或过期的条目**逐条列出**, 而不是笼统说"排程正常"。

用法: dsh-cron-liveness.py [--json] [--grace 2.0]
退出码: 0 = 全部新鲜(或已如实标注无见证); 1 = 有过期/缺失的见证(需人看); 3 = 读不到 crontab。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

COG = os.path.expanduser('~/.dsh/cognitive-pipeline')
# 每条排程命令的见证: 日志重定向路径, 或(无重定向时)由命令名推出的常见日志
LOG_RE = re.compile(r'>>?\s*(\S+)')


def schedule_minutes(spec: str):
    """把 5 段 cron 表达式折算成'最大间隔(分钟)'的粗略估计, 用于新鲜度判定。"""
    m, h = spec.split()[0], spec.split()[1]
    if m.startswith('*/'):
        return int(m[2:])
    if ',' in m:
        parts = sorted(int(x) for x in m.split(','))
        gaps = [b - a for a, b in zip(parts, parts[1:])] + [60 - parts[-1] + parts[0]]
        return min(gaps) * (1 if h == '*' else 1)
    if m.isdigit() and h.startswith('*/'):
        return int(h[2:]) * 60
    return 24 * 60


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--grace', type=float, default=2.0, help='允许的超期倍数(默认 2 倍间隔)')
    args = ap.parse_args()
    try:
        cron = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=30).stdout
    except Exception as exc:  # noqa: BLE001
        print('[cron-liveness] 读不到 crontab: %s' % exc, file=sys.stderr)
        return 3
    now = time.time()
    rows = []
    for line in cron.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        spec, cmd = ' '.join(parts[:5]), parts[5]
        every = schedule_minutes(spec)
        m = LOG_RE.search(cmd)
        witness, age_min, verdict = None, None, 'no-witness'
        if m:
            witness = os.path.expanduser(m.group(1))
            if os.path.exists(witness):
                age_min = (now - os.path.getmtime(witness)) / 60.0
                verdict = 'fresh' if age_min <= every * args.grace else 'stale'
            else:
                verdict = 'missing'
        rows.append({'schedule': spec, 'everyMinutes': every, 'cmd': cmd[:90],
                     'witness': witness, 'ageMinutes': None if age_min is None else round(age_min, 1),
                     'verdict': verdict})
    stale = [r for r in rows if r['verdict'] in ('stale', 'missing')]
    if args.json:
        print(json.dumps({'entries': len(rows), 'problems': stale}, ensure_ascii=False))
    else:
        print('排程条目 %d, 过期/缺见证 %d:' % (len(rows), len(stale)))
        for r in stale:
            print('  ⚠ %-14s 每 %4d 分钟 | %s | 见证: %s (%.1f 分钟前)'
                  % (r['schedule'], r['everyMinutes'], r['cmd'][:46], r['witness'], r['ageMinutes'] or -1))
        fresh = sum(1 for r in rows if r['verdict'] == 'fresh')
        nw = sum(1 for r in rows if r['verdict'] == 'no-witness')
        print('  新鲜 %d / 无重定向(不可判) %d' % (fresh, nw))
    return 1 if stale else 0


if __name__ == '__main__':
    sys.exit(main())
