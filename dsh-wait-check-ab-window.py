#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-ab-window.py — 条件型等待: A/B 后窗回合数是否够判(cl-215 的第二个样本)。

用法(池内挂成 waitChecker): dsh-wait-check-ab-window.py [--change utility-fusion] [--min-turns 40]

为什么需要: 目标池里"等样本攒够再复读"这类 nextAction, 若没有条件型等待, 行动帧每 20 分钟就会把
同一步再催一次 —— 而样本只能靠时间攒(实测注入 3.15 次/h ⇒ 每 2h 约 +6 回合)。cl-215 建的机制是:
等待型目标带 `waitChecker`(一条命令), 唤醒侧在标 `skipped:waiting` 前跑一次; **exit 0 = 条件已满足
⇒ 不跳过(该干了)**, 非 0 = 还没满足 ⇒ 标 skipped(不打扰)。

口径: **不自己重算**回合数 —— 直接调用 `dsh-adoption-stats.py`(与 `dsh-ab-compare.py` 同一个口径),
免得出现"同一指标两套口径"(那正是 ab-compare 文档里记着的亏)。切换点从 `dsh-ab-compare.py` 的
`CHANGES` 窗口规格读(单一事实来源)。

退出码: 0 条件满足(该复读); 1 条件未满足(继续等待); 3 测不出来(不得当成满足)。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys

REPO = os.path.expanduser('~/dsh-fork')
ADOPTION = os.path.join(REPO, 'dsh-adoption-stats.py')
AB = os.path.join(REPO, 'dsh-ab-compare.py')


def load_change(name: str) -> dict:
    """从 ab-compare 的窗口规格读该变更(单一事实来源; 该模块 main 有 __main__ 守卫, 可安全导入)。"""
    spec = importlib.util.spec_from_file_location('dsh_ab_compare', AB)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    changes = getattr(mod, 'CHANGES', {})
    if name not in changes:
        raise SystemExit('未知变更 %r(可选: %s)' % (name, ', '.join(sorted(changes))))
    return changes[name]


def window_turns(split_iso: str) -> int:
    out = subprocess.run([sys.executable, ADOPTION, '--since', split_iso, '--json'],
                         capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        raise RuntimeError('口径脚本失败: %s' % (out.stderr or out.stdout)[:160])
    data = json.loads(out.stdout)
    turns = data.get('turnsWithInjection')
    if not isinstance(turns, int):
        raise RuntimeError('口径脚本未给出 turnsWithInjection: %s' % str(data)[:160])
    return turns


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--change', default='utility-fusion')
    ap.add_argument('--min-turns', type=int, default=40)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    change = load_change(args.change)
    try:
        turns = window_turns(change['splitAt'])
    except Exception as exc:                       # 测不出来必须非 0(不得当成满足)
        print('[wait-check] 无法测量: %s' % exc, file=sys.stderr)
        return 3
    met = turns >= args.min_turns
    if not args.quiet:
        print('[wait-check] %s 后窗回合 %d/%d ⇒ %s'
              % (args.change, turns, args.min_turns, '条件已满足(该复读并裁决)' if met else '条件未满足(继续等待, 不打扰)'))
    return 0 if met else 1


if __name__ == '__main__':
    raise SystemExit(main())
