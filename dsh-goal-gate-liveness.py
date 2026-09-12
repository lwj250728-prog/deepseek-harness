#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-goal-gate-liveness.py — 目标池**不得全体无界挂门**(cl-266 的正面判据 / cl-250 同族)

背景(2026-09-12 09:4x): 三个 active 目标全部挂上条件门 ⇒ 驱动侧选目标返回 []，系统进入"完全正常的
静默"(cl-266 实测)。当时其中一道门(refine 样本门)的样本**只能由被它挡住的那些回合产出** ⇒ 门在静默期
自我饿死。cl-266 原提议的代理判据是"该门的输入产物过去 24h 有写入"——**本判据的取证把它证伪了**:
那道门的输入 predictions.jsonl 每回合都在写(本次取证时 09:32 刚写过 1 条)，而它的决定性计数器
(A1·真提升 已结算)自 **09-09 18:45 起 63 小时未动**(全史 6 条里另 4 条从未结算)。代理判据会把一道
饿死的门判成活的 ⇒ 代理不等于判据。

故本脚本不给"输入文件活着"这种代理，而是给每条 active 目标一个**可判定**的结论:
  · 无 waitChecker                                  ⇒ drivable        (ok)
  · 门当场 exit 0                                   ⇒ drivable        (ok)
  · 声明了 waitCheckerDeadline 且**行为上被消费**     ⇒ self-satisfying (ok)
  · 其余(含"声明了时限但门不消费它")                 ⇒ unbounded
判据: active 目标里**至少一条** ok —— 否则系统可能永久静默(exit 1)。

"行为上被消费"是**证伪口径**，不是文本口径(2026-09-12 09:2x 的教训: 结构断言抓不住"接线在、语义错"):
  把命令行里那串时限**替换成一个过去的时刻**重跑一次 —— 真消费 `--deadline` 的门必须由此放行(exit 0);
  `/bin/false --deadline <D>` 这种"逐字包含却不当回事"的装饰性时限会仍然非零 ⇒ 判 unbounded。

退出码: 0 = 合规(或没有可判的 active 目标); 1 = 全体无界 ⇒ 静默死锁风险; 3 = 读不到池。
用法: dsh-goal-gate-liveness.py [--pool P] [--timeout S] [--json] [--quiet]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

DEFAULT_POOL = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')
OK = ('drivable', 'self-satisfying')


def parse_iso(v):
    try:
        dt = datetime.datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    except Exception:  # noqa: BLE001
        return None
    if dt.tzinfo is None:          # 裸本地时间在回溯读数里有歧义 ⇒ 不认
        return None
    return dt


def classify(g: dict, timeout: float, now: datetime.datetime):
    """→ (verdict, 说明)"""
    cmd = str(g.get('waitChecker') or '').strip()
    if not cmd:
        return 'drivable', '无门'
    try:
        rc = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout).returncode
    except Exception as exc:  # noqa: BLE001
        return 'unbounded', '门跑不动(%s) ⇒ 无法证明能自行解冻' % type(exc).__name__
    if rc == 0:
        return 'drivable', '门当场满足'
    if rc not in (0, 1):
        return 'unbounded', '门返回故障码 %d(约定只允许 0/1)' % rc
    declared = str(g.get('waitCheckerDeadline') or '').strip()
    if not declared:
        return 'unbounded', '未声明时限 ⇒ 无界(只能靠外部事件解冻)'
    if parse_iso(declared) is None:
        return 'unbounded', '声明的时限不可解析(须为带时区的 ISO): %r' % declared
    if declared not in cmd:
        return 'unbounded', '声明了时限但门命令行里没有它 ⇒ 声明是装饰'
    past = (now - datetime.timedelta(hours=1)).isoformat()
    try:
        rc2 = subprocess.run(cmd.replace(declared, past), shell=True,
                             capture_output=True, timeout=timeout).returncode
    except Exception as exc:  # noqa: BLE001
        return 'unbounded', '时限消费性的反证跑不动(%s)' % type(exc).__name__
    if rc2 != 0:
        return 'unbounded', '时限逐字在命令行里却**不被消费**(把时限换成过去仍 exit %d)' % rc2
    return 'self-satisfying', '时限被消费(换成过去即放行) ⇒ 到 %s 自行解冻' % declared


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', default=DEFAULT_POOL)
    ap.add_argument('--timeout', type=float, default=300.0)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.pool):
        print('[gate-liveness] 读不到目标池: %s' % args.pool, file=sys.stderr)
        return 3
    latest: dict = {}
    for line in open(args.pool, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if r.get('id'):
                latest[str(r['id'])] = r          # last-wins
    active = [r for r in latest.values() if str(r.get('status')) == 'active']
    if not active:
        print('[gate-liveness] 池内没有 active 目标 ⇒ 无静默死锁可言, 不判')
        return 0

    now = datetime.datetime.now().astimezone()
    out = []
    for g in active:
        verdict, why = classify(g, args.timeout, now)
        out.append({'id': g.get('id'), 'verdict': verdict, 'why': why,
                    'deadline': g.get('waitCheckerDeadline')})
    alive = [o for o in out if o['verdict'] in OK]
    if args.json:
        print(json.dumps({'active': len(out), 'alive': len(alive), 'goals': out}, ensure_ascii=False))
    elif not args.quiet:
        for o in out:
            print('  %-32s %-15s %s' % (o['id'], o['verdict'], o['why']))
        print('[gate-liveness] active %d 条, 可自行解冻 %d 条' % (len(out), len(alive)))
    if not alive:
        print('红: %d 条 active 目标**全部**是无界门 ⇒ 系统可能永久静默(没有任何一条能靠时间解冻); '
              '明细: %s' % (len(out), '; '.join('%s(%s)' % (o['id'], o['why']) for o in out)), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
