#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-intervention.py — 目标唤醒的**开关干预**工具(cl-264 的干预实验)。

为什么需要它: 观测层面已经用尽 —— "有唤醒的时段推进更快"(×2.49/×13.4)在**同样活跃时段对照**下不成立
(目标层 30/60 分钟粒度 p≈0.10 ⇒ no-signal; 全库层"活跃但无唤醒"的段数为 0 ⇒ 对照不适用),
因为唤醒与推进**共线于活动期**, 观测分不开因果。唯一能分开的办法是**干预**: 关掉某目标的唤醒, 看推进是否随之下降。

设计原则(全部为了让实验可在无人记得的情况下正确结束):
  ① **开关=池字段**: 用 `triggerThresholds`(kernel/focus) 抬到 1.01 = 任何相似度都命不中 ⇒ 该目标不再被唤醒。
     不新增代码路径、不改驱动, 只改一个已有字段的值。
  ② **原值必须落盘**: 每次 disable 都把原 `triggerThresholds` 与触发计数写进 `wake-interventions.jsonl`,
     使 restore 有据可依(回滚不靠记忆, 也不靠 git)。
  ③ **本工具只改这一个字段**: 其余字段由现有唯一写入方 `dsh-goal-pool-write.py` 追加行(last-wins), 保持写入口收口。

用法:
  dsh-wake-intervention.py disable <goalId> --hours 24 --reason "..."   # 关闭唤醒并登记
  dsh-wake-intervention.py restore <goalId> [--reason "..."]            # 按登记的原值恢复
  dsh-wake-intervention.py status [<goalId>]
退出码: 0 正常; 2 参数/状态问题(如 restore 无原始值可依); 3 池不可读。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
POOL = os.path.join(D, 'dormant-goals.jsonl')
RECORD = os.path.join(D, 'wake-interventions.jsonl')
WRITER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-goal-pool-write.py')
OFF_THRESHOLDS = {'kernel': 1.01, 'focus': 1.01}   # 相似度上界为 1 ⇒ 1.01 永不命中


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def current(goal_id: str) -> dict:
    row = None
    for line in open(POOL, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if str(r.get('id')) == goal_id:
                row = r                                   # last-wins
    if row is None:
        raise LookupError('池里没有该目标: ' + goal_id)
    return row


def records() -> list[dict]:
    if not os.path.exists(RECORD):
        return []
    out = []
    for line in open(RECORD, encoding='utf8'):
        if line.strip():
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def apply(goal_id: str, thresholds: dict, reason: str) -> int:
    """通过唯一写入方改 triggerThresholds(保持写入口收口)。"""
    r = subprocess.run(['python3', WRITER, goal_id, '--pool', POOL,
                        '--set', 'triggerThresholds=' + json.dumps(thresholds, ensure_ascii=False),
                        '--reason', reason, '--write'],
                       capture_output=True, text=True, timeout=300)
    print((r.stdout or '') + (r.stderr or ''), end='')
    return r.returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('disable')
    d.add_argument('goal')
    d.add_argument('--hours', type=float, default=24.0)
    d.add_argument('--reason', default='')
    s = sub.add_parser('restore')
    s.add_argument('goal')
    s.add_argument('--reason', default='干预窗口结束, 回滚到原阈值')
    st = sub.add_parser('status')
    st.add_argument('goal', nargs='?')
    args = ap.parse_args()

    if args.cmd == 'status':
        for rec in records():
            if rec.get('event') in ('disable', 'restore') and (args.goal is None or rec.get('goal') == args.goal):
                print('%s %-8s %s -> %s | 原因: %s' % (str(rec.get('ts'))[:19], rec.get('event'),
                                                       rec.get('goal'), json.dumps(rec.get('thresholdsAfter'), ensure_ascii=False),
                                                       str(rec.get('reason'))[:60]))
        if not records():
            print('（无干预记录）')
        return 0

    try:
        row = current(args.goal)
    except LookupError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    orig = row.get('triggerThresholds')
    if args.cmd == 'disable':
        if orig == OFF_THRESHOLDS:
            print('已经是关闭状态(阈值 %s), 幂等返回' % json.dumps(orig, ensure_ascii=False))
            return 0
        rc = apply(args.goal, OFF_THRESHOLDS, args.reason or '关闭唤醒做干预实验')
        if rc == 0:
            with open(RECORD, 'a', encoding='utf8') as f:
                f.write(json.dumps({'ts': now_iso(), 'event': 'disable', 'goal': args.goal,
                                    'thresholdsBefore': orig, 'thresholdsAfter': OFF_THRESHOLDS,
                                    'triggerCountBefore': row.get('triggerCount'),
                                    'plannedHours': args.hours, 'reason': args.reason}, ensure_ascii=False) + '\n')
            print('[干预] %s 唤醒已关闭(阈值 %s), 计划 %g 小时后恢复' % (args.goal, json.dumps(OFF_THRESHOLDS), args.hours))
        return rc
    # restore
    prior = [r for r in records() if r.get('goal') == args.goal and r.get('event') == 'disable']
    if not prior:
        print('restore 无原始阈值可依(没有 disable 记录)⇒ 拒绝猜测', file=sys.stderr)
        return 2
    back = prior[-1].get('thresholdsBefore')
    if not isinstance(back, dict) or not back:
        print('disable 记录里没有原阈值 ⇒ 拒绝猜测', file=sys.stderr)
        return 2
    rc = apply(args.goal, back, args.reason)
    if rc == 0:
        with open(RECORD, 'a', encoding='utf8') as f:
            f.write(json.dumps({'ts': now_iso(), 'event': 'restore', 'goal': args.goal,
                                'thresholdsAfter': back, 'restoredFrom': prior[-1].get('ts'),
                                'reason': args.reason}, ensure_ascii=False) + '\n')
        print('[干预] %s 唤醒已恢复(阈值 %s)' % (args.goal, json.dumps(back, ensure_ascii=False)))
    return rc


if __name__ == '__main__':
    sys.exit(main())
