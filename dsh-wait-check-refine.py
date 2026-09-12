#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-refine.py — 条件型等待: 精排收益 A/B 的两组样本是否够判。

用途(挂成目标池 waitChecker): `dsh-wait-check-refine.py [--min-n 5] [--deadline ISO]`
判据: `dsh-refine-eval.py` 报的 "A1·真提升(changed)" 与 "B·未开火(审计后)" 两组**各自**的已结算样本数
都 ≥ min-n ⇒ exit 0(该裁决是否接 LLM 重排); 否则 exit 1(继续等待, 唤醒侧标 skipped)。
测不出/输出格式变了 ⇒ exit 3(**不得**当成满足)。

--deadline(2026-09-12 09:4x 增; cl-266/cl-250 同族): **门本身不许无界**。
  背景: 本门的样本只随"有回合在跑"而增长, 而回合又可能被这道门挡掉 ⇒ 纯样本门在静默期会**自我饿死**。
  实测(2026-09-12 09:4x): A1·真提升**全史只有 6 条**(已结算 2), 门槛要 5 ⇒ 门能不能满足, 取决于
  "我记不记得回来看", 而不是取决于机制 —— 这正是 cl-250"门必须有可满足性"与 cl-266"至少一道门要能自满足"
  要拦的形态。
  故允许声明一个**时限**: 到点后即使样本不足也放行, 但必须**显式标注"证据不足"** —— 放行 ≠ 样本已足,
  调用方据此只能结案"证据不足, 不下接/不接的结论", 不得读成"A/B 已对照完"。

**fail-closed 优先于时限**: 度量器失败(exit 3)或时限字符串解析不了(exit 3), **任何情况下都不放行** ——
时限放行的只是"测得出但样本不够", 不是"测不出来"。否则"时限"会变成绕过 fail-closed 的后门。

设计取舍: 本脚本**不重算**分组, 而是跑 `dsh-refine-eval.py` 并解析它的输出 —— 那 5 条门槛与分组规则只
存在于一处(同一指标两套口径是明确踩过的亏)。输出一旦解析不了就 fail-closed 报 3, 而不是静默放行。
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import subprocess
import sys

REPO = os.path.expanduser('~/dsh-fork')
# 工具路径可注入(仅供测试: 用它喂一份坏输出, 验证"解析不了 ⇒ exit 3 不放行")
TOOL = os.environ.get('DSH_REFINE_EVAL') or os.path.join(REPO, 'dsh-refine-eval.py')


def parse_deadline(text: str):
    """ISO 时限 → 毫秒。解析不了返回 (None, 原因)。"""
    try:
        dt = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
    except Exception as exc:  # noqa: BLE001
        return None, '不是 ISO 时间(%s)' % exc
    if dt.tzinfo is None:
        return None, '缺时区偏移(裸本地时间在跨时区/回溯读数里是有歧义的)'
    return dt.timestamp() * 1000.0, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-n', type=int, default=5)
    ap.add_argument('--deadline', default=None, help='ISO 时限(必须带时区): 到点后即使样本不足也放行并标注证据不足')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    # 时限**先**解析(便宜且确定): 写错了当场 fail-closed, 不与"度量器恰好也失败"混成同一种错。
    dl_ms, dl_err = None, None
    if args.deadline:
        dl_ms, dl_err = parse_deadline(args.deadline)
        if dl_ms is None:
            print('[wait-check-refine] 时限无法解析: %s ⇒ fail-closed 不放行' % dl_err, file=sys.stderr)
            return 3

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
    now_ms = datetime.datetime.now().timestamp() * 1000.0
    if met:
        reason = 'samples'
    elif dl_ms is not None and now_ms >= dl_ms:
        reason = 'deadline'
    else:
        reason = None

    if not args.quiet:
        verdict = {'samples': '样本已足(该裁决是否接 LLM 重排)',
                   'deadline': '时限已到但样本仍不足',
                   None: '样本不足(继续等待, 不打扰)'}[reason]
        print('[wait-check-refine] A1·真提升 %d/%d, B·未开火 %d/%d ⇒ %s'
              % (counts['A1'], args.min_n, counts['B'], args.min_n, verdict))
    if reason == 'deadline':
        # 放行 ≠ 样本已足: 这一行是给**下游调用方**看的判据, 不是给人看的注脚
        print('[wait-check-refine] ⏰ 时限 %s 已到而样本仍不足 ⇒ 按证据不足放行: '
              '据此只能结案「证据不足, 不下接/不接 LLM 重排的结论」' % args.deadline)
    if reason is not None:
        print('[wait-check-refine] 放行理由=%s' % reason)
        return 0
    if dl_ms is not None:
        print('[wait-check-refine] 时限还剩 %.1f 小时(%s)' % ((dl_ms - now_ms) / 3600000.0, args.deadline))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
