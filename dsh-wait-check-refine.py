#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-refine.py — 条件型等待: 精排收益 A/B 的两组样本是否够判。

用途(挂成目标池 waitChecker): `dsh-wait-check-refine.py [--min-n 5]`
判据: `dsh-refine-eval.py` 报的 "A1·真提升(changed)" 与 "B·未开火(审计后)" 两组**各自**的已结算样本数
都 ≥ min-n ⇒ exit 0(该裁决是否接 LLM 重排); 否则 exit 1(继续等待, 唤醒侧标 skipped)。
测不出/输出格式变了 ⇒ exit 3(**不得**当成满足)。

设计取舍: 本脚本**不重算**分组, 而是跑 `dsh-refine-eval.py` 并解析它的输出 —— 那 5 条门槛与分组规则只
存在于一处(同一指标两套口径是明确踩过的亏)。输出一旦解析不了就 fail-closed 报 3, 而不是静默放行。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

REPO = os.path.expanduser('~/dsh-fork')
TOOL = os.path.join(REPO, 'dsh-refine-eval.py')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-n', type=int, default=5)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    out = subprocess.run([sys.executable, TOOL], capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        print('[wait-check-refine] 度量器失败: %s' % (out.stderr or out.stdout)[-160:], file=sys.stderr)
        return 3
    text = out.stdout
    counts = {}
    # 真实输出形如: "A1·真提升(changed): 已结算 2 条, 平均误差 0.417, 中位 ..."
    # 门槛按**已结算**样本(与工具自己的"真提升与未开火各需 5 条"同口径)
    for label, pat in (('A1', r'A1·真提升\(changed\):\s*已结算\s*(\d+)\s*条'),
                       ('B', r'B·未开火\(审计后\):\s*已结算\s*(\d+)\s*条')):
        m = re.search(pat, text)
        if m is None:
            print('[wait-check-refine] 输出里找不到 %s 组(格式可能变了) ⇒ 不得当成满足' % label, file=sys.stderr)
            return 3
        counts[label] = int(m.group(1))
    met = counts['A1'] >= args.min_n and counts['B'] >= args.min_n
    if not args.quiet:
        print('[wait-check-refine] A1·真提升 %d/%d, B·未开火 %d/%d ⇒ %s'
              % (counts['A1'], args.min_n, counts['B'], args.min_n,
                 '样本已足(该裁决是否接 LLM 重排)' if met else '样本不足(继续等待, 不打扰)'))
    return 0 if met else 1


if __name__ == '__main__':
    raise SystemExit(main())
