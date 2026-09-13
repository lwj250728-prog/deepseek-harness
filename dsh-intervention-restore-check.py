#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-intervention-restore-check.py — 干预窗口的**恢复腿**必须真的跑过(cl-265 的事故判据)

由来(2026-09-13 11:0x, **实测事故**): 09-12 08:00 我把 goal-experience-library 的唤醒关掉做干预实验,
计划 24 小时后恢复; 恢复靠 `systemd-run --user --on-active` 排的**瞬态定时器**。当天夜里 dsh 因会话过大
OOM 崩溃, 用户管理器里的瞬态定时器一并消失 ⇒ **恢复腿从未触发**, 而池子里留着
`triggerThresholds={kernel:1.01,focus:1.01}` + `waitChecker=/bin/false` —— 一个 active 目标被静默停摆
**27 小时**, 期间没有任何判据、任何日志说它不对(我甚至在崩溃前用 `--write --show` 写恢复, 而那张组合
当时是静默空操作, 见 T185)。

三条教训都做成了判据:
  ① 窗口结束后池子不得仍留**干预特征**(本脚本的主判据: 拿 disable 行自己记下的 thresholdsAfter/
     waitCheckerAfter 当指纹, 而不是硬编码 1.01 —— 硬编码会让判据在下次改参数时静默失效);
  ② 每条已结束的 disable 必须有对应的 `restore` 事件行(否则"恢复"只发生在我的记忆里);
  ③ 判据本身不依赖瞬态定时器: 它由 cron 每小时跑(持久), 恢复腿若再被吃掉, 最多 1 小时内转红。

用法: dsh-intervention-restore-check.py [--grace-min 30] [--json]
退出码: 0 = 无缺口; 2 = 有缺口(窗口已结束而池子仍是干预态 / 缺 restore 记录); 3 = 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))


def dir_path() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load_jsonl(path: str):
    if not os.path.exists(path):
        return None
    out = []
    with open(path, encoding='utf8') as fh:
        for line in fh:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    return out


def parse_ts(value):
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(value)[:26])
    except Exception:
        return None
    return dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt.astimezone(TZ)


def same(a, b) -> bool:
    return json.dumps(a, ensure_ascii=False, sort_keys=True) == json.dumps(b, ensure_ascii=False, sort_keys=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--grace-min', type=float, default=30.0)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    d = dir_path()
    recs = load_jsonl(os.path.join(d, 'wake-interventions.jsonl'))
    pool = load_jsonl(os.path.join(d, 'dormant-goals.jsonl'))
    if recs is None or pool is None:
        print('读数失败: 缺 wake-interventions.jsonl 或 dormant-goals.jsonl(判据前提不成立) 于 %s' % d,
              file=sys.stderr)
        return 3
    current = {}
    for row in pool:
        gid = row.get('id') or row.get('goalId')
        if gid:
            current[gid] = row                      # last-wins

    now = datetime.datetime.now(TZ)
    problems, checked = [], []
    for rec in recs:
        if rec.get('event') != 'disable':
            continue
        goal = rec.get('goal') or rec.get('goalId')
        start = parse_ts(rec.get('ts'))
        hours = rec.get('plannedHours')
        if goal is None or start is None or not isinstance(hours, (int, float)):
            problems.append('disable 记录不完整(缺 goal/ts/plannedHours)⇒ 恢复腿无法判定: %s'
                            % json.dumps(rec, ensure_ascii=False)[:120])
            continue
        end = start + datetime.timedelta(hours=float(hours))
        if now <= end + datetime.timedelta(minutes=args.grace_min):
            continue                                 # 窗口尚在(或刚结束, 留宽限)
        overdue_h = (now - end).total_seconds() / 3600.0
        restores = [r for r in recs if r.get('event') == 'restore' and (r.get('goal') or r.get('goalId')) == goal
                    and (parse_ts(r.get('ts')) or start) > start]
        row = current.get(goal)
        sig_th, sig_wait = rec.get('thresholdsAfter'), rec.get('waitCheckerAfter')
        still_off = False
        if row is None:
            problems.append('%s 的 disable 已结束 %.1fh, 但池子里找不到该目标(无法确认恢复)' % (goal, overdue_h))
        else:
            if isinstance(sig_th, dict) and same(row.get('triggerThresholds'), sig_th):
                still_off = True
            if isinstance(sig_wait, str) and str(row.get('waitChecker') or '') == sig_wait:
                still_off = True
            if still_off:
                problems.append('%s 的干预窗口已结束 %.1fh, 池子**仍是干预态**(阈值 %s / waitChecker %s)'
                                ' ⇒ 恢复腿没跑; 该目标在此期间被静默停摆'
                                % (goal, overdue_h, json.dumps(row.get('triggerThresholds'), ensure_ascii=False),
                                   row.get('waitChecker')))
            elif not restores:
                problems.append('%s 的窗口已结束 %.1fh, 池子看起来已恢复, 但**没有 restore 事件行**(恢复无据可依)'
                                % (goal, overdue_h))
        checked.append({'goal': goal, 'windowEnd': end.isoformat(), 'overdueHours': round(overdue_h, 2),
                        'hasRestoreRecord': bool(restores), 'poolStillIntervened': still_off,
                        'restoreTs': str(restores[-1].get('ts'))[:19] if restores else None})
    payload = {'checkedAt': now.isoformat(), 'closedWindows': len(checked), 'problems': problems, 'windows': checked}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        # 首行带时刻: cron 见证的**新鲜度**必须能从日志本身判读(否则 dsh-cron-liveness 只能说"文件存在")
        print('%s 已结束的干预窗口 %d 个 | 缺口 %d' % (now.isoformat()[:19], len(checked), len(problems)))
        for w in checked:
            print('  · %s 窗口结束 %s(超期 %.1fh) restore记录=%s 池仍干预态=%s'
                  % (w['goal'], w['windowEnd'][:16], w['overdueHours'], w['hasRestoreRecord'], w['poolStillIntervened']))
        for p in problems:
            print('  ✗ %s' % p)
    return 2 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
