#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-attribution.py — 条件型等待: 归因读数的新样本是否够复测。

用途(挂成目标池 waitChecker): `dsh-wait-check-attribution.py [--min-new-frames 5]`
判据: 自**上一次归因读数**(wake-attribution.jsonl 末条记录的 frames 计数)以来新写入的行动帧数 ≥ min ⇒
exit 0(该复测); 否则 exit 1(继续等待, 唤醒侧标 skipped:waiting)。

为什么需要: "等 5~10 条新帧再复测"这类 nextAction 若没有条件门, 行动帧会每 20 分钟把同一步再催一次,
而样本只能靠时间攒(实测活跃时段约 1~2 条/小时)。读不出来 ⇒ exit 3(**不得**当成满足)。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-new-frames', type=int, default=5)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    frames_path = os.path.join(D, 'quiet-driver-frames.jsonl')
    readings_path = os.path.join(D, 'wake-attribution.jsonl')
    try:
        current = sum(1 for line in open(frames_path, encoding='utf8')
                      if line.strip() and json.loads(line).get('kind') == 'action-frame')
        readings = [json.loads(l) for l in open(readings_path, encoding='utf8') if l.strip()]
    except Exception as exc:
        print('[wait-check-attribution] 读不到账本: %s' % exc, file=sys.stderr)
        return 3
    if not readings:
        print('[wait-check-attribution] 尚无归因读数 ⇒ 不得当成满足', file=sys.stderr)
        return 3
    last = readings[-1]
    if 'frames' not in last:
        print('[wait-check-attribution] 末条读数没有 frames 计数(格式变了?) ⇒ 不得当成满足', file=sys.stderr)
        return 3
    new = current - int(last['frames'])
    met = new >= args.min_new_frames
    if not args.quiet:
        print('[wait-check-attribution] 自上次读数(%s)新增行动帧 %d/%d ⇒ %s'
              % (str(last.get('ts'))[:19], new, args.min_new_frames,
                 '样本已足(该复测归因读数)' if met else '样本不足(继续等待, 不打扰)'))
    return 0 if met else 1


if __name__ == '__main__':
    raise SystemExit(main())
