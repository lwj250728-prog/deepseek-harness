#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-sweep.py — 门限裁决的条件门(cl-263)。

为什么需要它: "等新上限时代攒到 >=10 个埋点回合再裁决"是**样本型等待**, 而行动帧只认条件不认样本
⇒ 门没挂上时驱动侧每轮都把它当"该干了"重复催办(与 cl-126/cl-215/cl-265 同型; 本步已被提醒多次)。

条件(exit 0 = 该跑裁决): 用**规范调用**(时代起点取 scan-era 声明)跑一次扫描, 其判读**能出真裁决**
(widen-gate / tradeoff-ceiling / no-headroom)。任何 insufficient-*(样本不足/顶满上限/未声明时代) ⇒ exit 1。
失败(脚本跑不动/解析不了) ⇒ exit 1(fail-closed: 绝不冒充"满足")。

用法: dsh-wait-check-sweep.py [--min-rounds N](默认取工具内的门槛, 即 >=10)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-threshold-sweep.py')
REAL = ('widen-gate', 'tradeoff-ceiling', 'no-headroom')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-rounds', type=int, default=10)
    args = ap.parse_args()
    try:
        r = subprocess.run(['python3', TOOL, '--json'], capture_output=True, text=True, timeout=600)
        payload = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as exc:  # noqa: BLE001
        print('[wait-check-sweep] 扫描跑不动或解析不了(%s) ⇒ fail-closed 视为未满足' % exc, file=sys.stderr)
        return 1
    verdict = payload.get('verdict')
    rounds = payload.get('roundsWithBelowGate')
    capped = (payload.get('subGateDiagnostics') or {}).get('cappedRounds')
    if verdict in REAL:
        print('[wait-check-sweep] 条件已满足: 可出真裁决(%s), 埋点回合 %s, 顶满 %s' % (verdict, rounds, capped))
        return 0
    if rounds is not None and rounds < args.min_rounds:
        print('[wait-check-sweep] 继续等待: 埋点回合 %d/%d(顶满 %s) ⇒ %s'
              % (rounds, args.min_rounds, capped, verdict))
        return 1
    print('[wait-check-sweep] 继续等待: %s(%s)' % (verdict, str(payload.get('reason'))[:90]))
    return 1


if __name__ == '__main__':
    sys.exit(main())
