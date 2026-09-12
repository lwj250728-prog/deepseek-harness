#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-intervention-reversal-lint.py — 干预实验的**恢复腿必须预登记**(T203 的判据)

由来(2026-09-12 10:2x): cl-265 的干预窗口跑到一半, 我才用三问帧实测发现"恢复腿不是回到静默" ——
目标当前的门 `dsh-wait-check-sweep.py` 已经 exit 0(可出真裁决), 所以 08:00 一恢复该目标立刻重新可
驱动。这条判据如果等窗口结束之后再解释, 那就不是预登记而是**事后叙事**; 与 `threshold-prereg.json`
(门限裁决的预登记)是同一条纪律。

判据(只审**未恢复**的窗口 —— 历史窗口缺登记是既成事实, 不追认):
  · 每条 open 窗口必须在**窗口结束之前**存在一条恢复腿预期(disable 行里的 reversalExpectation,
    或该目标后续任一行的 reversalExpectation —— 即 `preregister` 补登记);
  · 预期的时间戳必须 **< 窗口结束时刻**(disable.ts + plannedHours); 晚于它 ⇒ 事后叙事 ⇒ 红。

退出码: 0 = 合规(或没有 open 窗口); 1 = 红(缺预登记/预登记晚于窗口结束); 3 = 读不到账本。
用法: dsh-intervention-reversal-lint.py [--record P] [--quiet] [--json]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
DEFAULT_RECORD = os.path.join(D, 'wake-interventions.jsonl')


def ms_of(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            dt = datetime.datetime.fromisoformat(v.replace('Z', '+00:00'))
        except Exception:  # noqa: BLE001
            return None
        if dt.tzinfo is None:
            return None
        return dt.timestamp() * 1000.0
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--record', default=DEFAULT_RECORD)
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if not os.path.exists(args.record):
        print('[reversal-lint] 读不到干预账本: %s' % args.record, file=sys.stderr)
        return 3
    recs = []
    for line in open(args.record, encoding='utf8'):
        if line.strip():
            try:
                recs.append(json.loads(line))
            except Exception:  # noqa: BLE001
                continue

    goals = []
    for r in recs:
        g = str(r.get('goal') or '')
        if g and g not in goals:
            goals.append(g)
    out, bad = [], []
    for g in goals:
        rs = [r for r in recs if str(r.get('goal')) == g]
        dis = [r for r in rs if r.get('event') == 'disable']
        if not dis:
            continue
        last_dis = dis[-1]
        d_ms = ms_of(last_dis.get('ts'))
        if d_ms is None:
            bad.append('%s: disable 记录时间戳不可解析 ⇒ 无法判定窗口边界' % g)
            continue
        after = [r for r in rs if (ms_of(r.get('ts')) or 0) > d_ms and r.get('event') == 'restore']
        if after:
            continue                                  # 窗口已恢复 ⇒ 不审(不追认历史)
        end_ms = d_ms + float(last_dis.get('plannedHours') or 24.0) * 3600 * 1000.0
        cand = [r for r in rs if str(r.get('reversalExpectation') or '').strip()]
        item = {'goal': g, 'windowEnd': datetime.datetime.fromtimestamp(end_ms / 1000).astimezone().isoformat()}
        if not cand:
            bad.append('%s: 未恢复的窗口缺恢复腿预登记(reversalExpectation) —— 事后再解释就不是预登记' % g)
            out.append(dict(item, verdict='missing'))
            continue
        last = cand[-1]
        e_ms = ms_of(last.get('ts'))
        item['expectationTs'] = str(last.get('ts'))[:19]
        item['expectation'] = str(last.get('reversalExpectation'))[:120]
        if e_ms is None:
            bad.append('%s: 恢复腿预期的时间戳不可解析' % g)
            out.append(dict(item, verdict='bad-ts'))
        elif e_ms >= end_ms:
            bad.append('%s: 恢复腿预期登记于 %s, **晚于窗口结束**(%s) ⇒ 事后叙事'
                       % (g, str(last.get('ts'))[:19], item['windowEnd'][:19]))
            out.append(dict(item, verdict='post-hoc'))
        else:
            out.append(dict(item, verdict='ok'))

    if args.json:
        print(json.dumps({'windows': out, 'bad': bad}, ensure_ascii=False))
    elif not args.quiet:
        for o in out:
            print('  %-32s %-10s 窗口结束=%s 预期登记=%s' % (o['goal'], o['verdict'],
                                                             o.get('windowEnd', '?')[:16], o.get('expectationTs', '-')))
        print('[reversal-lint] 未恢复窗口 %d 个, 合规 %d 个' % (len(out), sum(1 for o in out if o['verdict'] == 'ok')))
    if bad:
        print('红: ' + '; '.join(bad), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
