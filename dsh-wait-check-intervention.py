#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-intervention.py — 干预实验的条件门(cl-265)。

为什么需要它: "到点判读干预"这一步的时点在 24 小时之后, 而**行动帧只认条件不认日历** —— 门没挂上时,
驱动侧每轮都会把它当成"该干了"重复催办(实测: 本步已被提醒 2 次, 与 cl-126/cl-215 同型)。
按 cl-250 的纪律, 条件型等待必须在**驱动侧**也生效: 挂一个 waitChecker, 满足才放行。

条件(exit 0 = 该复读判读):
  ①干预窗口已经开始(存在 disable 记录且其 ts 已过); **且**
  ②窗口已经结束(存在 restore 记录, 或 disable 的 plannedHours 已过); **且**
  ③判读器已经产出该目标在**该窗口**内的判读行(不是旧窗口的残留)。

否则 exit 1(继续等待, 不打扰)并打印为什么。测不出来(fail-closed)⇒ exit 1, 绝不冒充"满足"。
用法: dsh-wait-check-intervention.py [--target ID] [--min-hours N]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
IV = os.path.join(D, 'wake-interventions.jsonl')
READOUT = os.path.join(D, 'wake-intervention-readout.jsonl')


def ms_of(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000
        except Exception:
            return None
    return None


def load(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding='utf8'):
        if line.strip():
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='goal-experience-library')
    ap.add_argument('--min-hours', type=float, default=0.0,
                    help='窗口至少要走完这么多小时才放行(默认 0 = 只看恢复记录/计划时长)')
    args = ap.parse_args()

    recs = load(IV)
    # 2026-09-13 12:5x(行动帧执行时抓出): 本门**不认识预登记的窗口** —— 我 12:34 用 plan-disable 把窗口改期到
    # 09-14 03:12, 而门只看"最后一条 disable", 于是它盯着**上一轮已经判读并处置完的窗口**报"条件已满足"
    # ⇒ 驱动侧会为一步明天才可执行的工作反复催办(与 cl-126/cl-215 同型), 且对**尚未开启**的新窗口毫无感知。
    # 补两条: ①有未取消、未到点的 plan-disable ⇒ 继续等待(报出 dueAt); ②最新窗口**已处置过**(判读账本里有
    # 该窗口的裁决行) ⇒ 也继续等待(没有可读的东西了, 别再催)。
    dis = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'disable']
    plans = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'plan-disable']
    cancelled = {str(r.get('planKey')) for r in recs if r.get('event') == 'plan-cancel'}
    pending = [r for r in plans if str(r.get('ts')) not in cancelled]
    now_ms = datetime.datetime.now().timestamp() * 1000
    if pending:
        last_plan = max(pending, key=lambda r: str(r.get('ts')))
        due = ms_of(last_plan.get('dueAt'))
        if due is not None and now_ms < due:
            print('[wait-check-intervention] 预登记窗口**尚未开启**(plan-disable dueAt=%s, 还剩 %.1f 小时) '
                  '⇒ 继续等待, 不打扰' % (str(last_plan.get('dueAt'))[:19], (due - now_ms) / 3600000.0))
            return 1
        after = [r for r in dis if (ms_of(r.get('ts')) or 0) > (ms_of(last_plan.get('ts')) or 0)]
        if not after:
            print('[wait-check-intervention] 预登记窗口已到点但**没有开窗记录**(开窗腿失败或尚未跑) ⇒ 继续等待; '
                  '查腿账本 wake-intervention-legs.jsonl 的 plan-disable 行')
            return 1
    if not dis:
        print('[wait-check-intervention] 尚未开始: 没有 disable 记录 ⇒ 继续等待(不打扰)')
        return 1
    d = dis[-1]
    start = ms_of(d.get('ts'))
    if start is None:
        print('[wait-check-intervention] disable 记录没有可解析的时间戳 ⇒ fail-closed 视为未满足')
        return 1
    now = datetime.datetime.now().timestamp() * 1000
    if now < start:
        print('[wait-check-intervention] 窗口未到(计划 %s 开始) ⇒ 继续等待' % str(d.get('ts'))[:19])
        return 1
    planned_end = start + float(d.get('plannedHours') or 24) * 3600 * 1000
    res = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'restore' and (ms_of(r.get('ts')) or 0) > start]
    ended = bool(res) or now >= planned_end
    if not ended:
        left = (planned_end - now) / 3600000.0
        print('[wait-check-intervention] 窗口进行中(还剩 %.1f 小时) ⇒ 继续等待, 不打扰' % left)
        return 1
    if args.min_hours > 0 and (now - start) / 3600000.0 < args.min_hours:
        print('[wait-check-intervention] 窗口只走了 %.1f 小时(< %.1f) ⇒ 继续等待'
              % ((now - start) / 3600000.0, args.min_hours))
        return 1
    # 判读行必须是**本窗口**的(用 startIso 判定, 免得旧窗口的残留被当成新结果)
    start_iso = datetime.datetime.fromtimestamp(start / 1000).astimezone().isoformat()
    rows = [r for r in load(READOUT) if r.get('target') == args.target]
    fresh = [r for r in rows if str(r.get('startIso', ''))[:16] == start_iso[:16]]
    if not fresh:
        print('[wait-check-intervention] 窗口已结束但**本窗口**的判读行还没出(判读器应于结束 +5 分钟跑) ⇒ 继续等待')
        return 1
    adj = load(os.path.join(D, 'wake-intervention-adjudication.jsonl'))
    key = str(d.get('ts'))[:19]
    if any(key in str(r.get('windowId') or '') for r in adj):
        print('[wait-check-intervention] 本窗口**已判读并处置**(判读账本已有该窗口的裁决行, 见 wake-intervention-adjudication.jsonl) '
              '⇒ 无可读之物, 继续等待/不打扰')
        return 1
    print('[wait-check-intervention] 条件已满足: 本窗口判读已产出(verdict=%s)且**尚未处置**' % fresh[-1].get('verdict'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
