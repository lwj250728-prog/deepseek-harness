#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-intervention-legs.py — 干预实验的腿由**持久 tick** 驱动(cl-265 事故的机制修法)。

由来(2026-09-13 实测事故): 09-12 08:00 的唤醒干预实验把恢复腿挂在 `systemd-run --user --on-active`
排的**瞬态定时器**上。当天夜里 dsh 因会话过大 OOM 崩溃 ⇒ 瞬态单元一并消失 ⇒ **恢复腿从未触发**,
池子里留着 `triggerThresholds=1.01` + `waitChecker=/bin/false`, 一个 active 目标被静默停摆 **27 小时**。
判据(dsh-intervention-restore-check.py)能在 1 小时内报出"池子仍是干预态", 但它**只报警不执行**;
腿的**排程**本身仍然只活在我的记忆里 —— 这正是本条要修的东西。

修法:**排程落进账本 + 由 cron 每 5 分钟 tick 一次**(cron 是持久的, 崩溃不会把它带走), 每条腿:
  · `restore`(窗口到点)      → dsh-wake-intervention.py restore <goal>  (原值取自 disable 行, 不靠记忆)
  · `readout`(恢复后 +5min)  → dsh-wake-intervention-readout.py          (判读行)
  · `reversal`(恢复后 +30min) → dsh-wake-intervention-readout.py --reversal-eval (恢复腿复核)
  · `expect`(恢复后 +35min)  → dsh-intervention-expectation-check.py --write (预登记期望比对)
幂等: 每条腿按 (窗口, 腿名) 在 `wake-intervention-legs.jsonl` 里记一次成功; 失败则**下一 tick 重试**
(持久化的意义就在于重试), 并把"超期未完成"打成 PROBLEM 行 —— 腿再也不能静默消失。

用法: dsh-intervention-legs.py [--dry-run] [--overdue-alert-min 120] [--json]
退出码: 0 = 本轮无失败; 2 = 有腿执行失败或超期未完成(下一 tick 会重试); 3 = 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
REPO = os.path.dirname(os.path.abspath(__file__))
LEG_DELAYS_MIN = {'readout': 5, 'reversal': 30, 'expect': 35}


def d() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load_jsonl(path: str):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding='utf8') as fh:
        for line in fh:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def iso(ts: str):
    try:
        v = datetime.datetime.fromisoformat(str(ts))
        return v if v.tzinfo else v.replace(tzinfo=TZ)
    except Exception:
        return None


def plans(recs):
    """预登记的**开窗**(2026-09-13 12:3x 补): 干预实验的两端都该由持久 tick 驱动 —— 此前只有恢复腿在
    runner 里, 而"开窗"仍靠我手敲一条 disable 命令(那一刻我若没敲/敲错, 整个实验就不存在或时间戳不对)。
    故新增 plan-disable 事件(含 dueAt/hours/reversalExpectation), 由 tick 到点执行 disable。

    → [{key, goal, dueAt, hours, expectation, done}]
    """
    out = []
    done = {(str(r.get('goal')), str(r.get('reason'))[:40]) for r in recs if r.get('event') == 'disable'}
    # plan-cancel(2026-09-13 13:0x 补): 预登记的窗口若因**与另一个实验重叠**而要改期, 必须有正式的取消事件 ——
    # 否则旧 plan 到点照样开窗(账本是追加式的, 直接"改一行"改不掉已经写下的计划)。这是"计划也必须可撤销"。
    cancelled = {str(r.get('planKey')) for r in recs if r.get('event') == 'plan-cancel'}
    for r in recs:
        if r.get('event') != 'plan-disable' or str(r.get('ts')) in cancelled:
            continue
        due = iso(r.get('dueAt'))
        goal = r.get('goal') or r.get('goalId')
        if due is None or not goal:
            continue
        out.append({'key': str(r.get('ts')), 'goal': goal, 'dueAt': due,
                    'hours': float(r.get('hours') or 24.0),
                    'expectation': str(r.get('reversalExpectation') or ''),
                    'reason': str(r.get('reason') or ''),
                    'done': any(g == goal and '预登记窗口开启' in rs for g, rs in done)})
    return out


def windows(recs):
    """→ [{key, goal, disableAt, dueAt, restoreAt}]；key = disable 行的 ts(窗口唯一标识)。"""
    out = []
    for r in recs:
        if r.get('event') != 'disable':
            continue
        goal = r.get('goal') or r.get('goalId')
        at = iso(r.get('ts'))
        if not goal or at is None:
            continue
        hours = float(r.get('plannedHours') or 24.0)
        restore = None
        for r2 in recs:
            if r2.get('event') == 'restore' and (r2.get('goal') or r2.get('goalId')) == goal:
                t2 = iso(r2.get('ts'))
                if t2 and t2 > at and (restore is None or t2 < restore):
                    restore = t2
        out.append({'key': str(r.get('ts')), 'goal': goal, 'disableAt': at,
                    'dueAt': at + datetime.timedelta(hours=hours), 'restoreAt': restore})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--overdue-alert-min', type=float, default=120.0)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    recs = load_jsonl(os.path.join(d(), 'wake-interventions.jsonl'))
    if not recs:
        print('[legs] 无干预记录 ⇒ 无腿可驱动(不是失败)')
        return 0
    ledger_path = os.path.join(d(), 'wake-intervention-legs.jsonl')
    done = {(str(r.get('window')), str(r.get('leg')))
            for r in load_jsonl(ledger_path) if r.get('exit') == 0}
    now = datetime.datetime.now(TZ)
    failures, overdue, ran = [], [], []

    # 预登记的开窗腿: 到点即执行 disable(带预登记里的期望), 之后按正常窗口走恢复/判读/复核
    for pl in plans(recs):
        if pl['done'] or now < pl['dueAt']:
            continue
        cmd = [sys.executable, os.path.join(REPO, 'dsh-wake-intervention.py'), 'disable', pl['goal'],
               '--hours', str(pl['hours']), '--reason', '预登记窗口开启(cron tick, dsh-intervention-legs.py)',
               '--reversal-expectation', pl['expectation']]
        late_min = (now - pl['dueAt']).total_seconds() / 60.0
        if args.dry_run:
            print('[dry-run] 到期腿 %s/plan-disable(已超期 %.1f 分钟): %s' % (pl['goal'], late_min, ' '.join(cmd[1:4])))
            continue
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            rc, tail = r.returncode, ((r.stdout or r.stderr).strip().splitlines() or [''])[-1][:160]
        except subprocess.TimeoutExpired:
            rc, tail = 124, '超时'
        row = {'ts': now.isoformat(), 'window': pl['key'], 'goal': pl['goal'], 'leg': 'plan-disable',
               'due': pl['dueAt'].isoformat(), 'lateMin': round(late_min, 1), 'exit': rc,
               'scheduler': 'cron-tick', 'origin': os.environ.get('DSH_RUN_ORIGIN', 'manual'),
               'cmd': ' '.join(cmd[1:]), 'tail': tail}
        with open(ledger_path, 'a', encoding='utf8') as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
        ran.append(row)
        if rc != 0:
            failures.append('%s/plan-disable exit=%d %s' % (pl['goal'], rc, tail))

    for w in windows(recs):
        legs = []
        if w['restoreAt'] is None:
            legs.append(('restore', w['dueAt'],
                         [sys.executable, os.path.join(REPO, 'dsh-wake-intervention.py'), 'restore', w['goal'],
                          '--reason', 'cron tick(dsh-intervention-legs.py): 窗口到点自动恢复, 原值取自 disable 行']))
        else:
            for leg, delay in LEG_DELAYS_MIN.items():
                cmd = ([sys.executable, os.path.join(REPO, 'dsh-wake-intervention-readout.py')]
                       + (['--reversal-eval'] if leg == 'reversal' else [])
                       + (['--write'] if leg == 'expect' else []))
                if leg == 'expect':
                    cmd = [sys.executable, os.path.join(REPO, 'dsh-intervention-expectation-check.py'), '--write']
                legs.append((leg, w['restoreAt'] + datetime.timedelta(minutes=delay), cmd))
        for leg, due, cmd in legs:
            if (w['key'], leg) in done:
                continue
            if now < due:
                continue
            late_min = (now - due).total_seconds() / 60.0
            if args.dry_run:
                print('[dry-run] 到期腿 %s/%s(已超期 %.1f 分钟): %s' % (w['goal'], leg, late_min, ' '.join(cmd[1:3])))
                continue
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
                rc = r.returncode
                tail = (r.stdout or r.stderr).strip().splitlines()[-1][:160] if (r.stdout or r.stderr).strip() else ''
            except subprocess.TimeoutExpired:
                rc, tail = 124, '超时(>900s)'
            row = {'ts': now.isoformat(), 'window': w['key'], 'goal': w['goal'], 'leg': leg,
                   'due': due.isoformat(), 'lateMin': round(late_min, 1), 'exit': rc,
                   'scheduler': 'cron-tick', 'origin': os.environ.get('DSH_RUN_ORIGIN', 'manual'),
                   'cmd': ' '.join(cmd[1:]), 'tail': tail}
            with open(ledger_path, 'a', encoding='utf8') as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + '\n')
            ran.append(row)
            if rc != 0:
                failures.append('%s/%s exit=%d %s' % (w['goal'], leg, rc, tail))
            if late_min > args.overdue_alert_min and rc != 0:
                overdue.append('%s/%s 超期 %.1f 分钟仍未完成' % (w['goal'], leg, late_min))

    origin = os.environ.get('DSH_RUN_ORIGIN', 'manual')
    print('[legs] origin=%s 窗口 %d 本轮执行 %d 失败 %d 超期未完成 %d'
          % (origin, len(windows(recs)), len(ran), len(failures), len(overdue)))
    for f in failures:
        print('[legs] 失败: %s' % f)
    for o in overdue:
        print('[legs] PROBLEM: %s' % o)
    if args.json:
        print(json.dumps({'windows': len(windows(recs)), 'ran': ran, 'failures': failures,
                          'overdue': overdue}, ensure_ascii=False))
    return 2 if (failures or overdue) else 0


if __name__ == '__main__':
    raise SystemExit(main())
