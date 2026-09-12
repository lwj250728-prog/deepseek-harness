#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-intervention-expectation-check.py — 实际读数 vs **预演写下的预期**的自动比对(cl-285/cl-286 的收口)

为什么需要: 干预窗口结束后的三个时刻(恢复 08:00 / 判读 08:05 / 恢复腿复核 08:35)全是**无人值守**的, 而判读器
会给出多个分支(causal / no-effect / no-headroom-controls / causal-thin-baseline / insufficient-* / contaminated)。
没有预先写死的"预期分支", 事后**任何**分支都能被解释成"符合预期" —— 那就不是预注册而是事后叙事。
预演工具(dsh-intervention-preflight.py)会算出预期; 本工具在窗口结束后把它与实际读数**逐字段比对**,
不一致就明说要先查口径, 而不是让人直接采信结论。

期望来源(机器可读, 写在言行账本里): 某条 cl-* 的 `expectedVerdict` / `expectedReversal` / `expectedAt` 字段。
用法: dsh-intervention-expectation-check.py [--claim cl-265] [--target goal-experience-library] [--json] [--write]
退出码: 0 = 一致(或判读尚未产出, 如实报告不判); 1 = **不一致**(先查口径); 3 = 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

COG = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
LEDGER = os.path.join(COG, 'claims-ledger.jsonl')
READOUT = os.path.join(COG, 'wake-intervention-readout.jsonl')


def load_last(path: str, key: str):
    latest = {}
    try:
        for line in open(path, encoding='utf8'):
            if line.strip():
                r = json.loads(line)
                if r.get(key):
                    latest[str(r[key])] = r
    except FileNotFoundError:
        return {}
    return latest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--claim', default='cl-265')
    ap.add_argument('--target', default='goal-experience-library')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--write', action='store_true', help='把比对结果作为字段写回该 cl-* 行(经 dsh-ledger-append.py)')
    args = ap.parse_args()

    claims = load_last(LEDGER, 'id')
    if not os.path.exists(LEDGER):
        print('[expect] 读不到言行账本: %s' % LEDGER, file=sys.stderr)
        return 3
    claim = claims.get(args.claim) or {}
    exp_verdict = str(claim.get('expectedVerdict') or '').strip()
    exp_reversal = str(claim.get('expectedReversal') or '').strip()
    if not exp_verdict:
        print('[expect] %s 里没有机器可读的 expectedVerdict ⇒ 无法比对(先跑 dsh-intervention-preflight.py 并把它写进账本)'
              % args.claim, file=sys.stderr)
        return 3
    rows = [json.loads(l) for l in open(READOUT, encoding='utf8') if l.strip()] if os.path.exists(READOUT) else []
    # **必须取本窗口的判读行**: 只取"最新一行"会把更早一次试验/手工跑的读数当成本次结果
    # (本工具第一次跑就踩到: 实际读到 insufficient-baseline-zero, 而那是更早一行的读数) ⇒ 用窗口起点过滤。
    win_start = str(claim.get('expectedWindowStart') or '').strip()
    if not win_start:
        dis = [r for r in load_last(os.path.join(COG, 'wake-interventions.jsonl'), 'ts').values()
               if r.get('goal') == args.target and r.get('event') == 'disable']
        dis = sorted(dis, key=lambda r: str(r.get('ts') or ''))
        win_start = str(dis[-1].get('ts') or '')[:16] if dis else ''
    # 窗口**结束时刻**: 判读行必须在窗口结束**之后**产出才作数 —— 因为窗口没结束时跑出来的行是试探读数。
    # 实测(2026-09-12 18:2x): 真账本里已有两条 startIso=2026-09-12T08:00 的行(07:37/07:38 的窗口前试探),
    # 它们与真正的窗口读数**共用一个窗口键** ⇒ 只按 startIso 过滤会把试探读数当成结果(本工具第二次踩到)。
    win_end = ''
    res = [r for r in load_last(os.path.join(COG, 'wake-interventions.jsonl'), 'ts').values()
           if r.get('goal') == args.target and r.get('event') == 'restore']
    if res:
        win_end = str(sorted(res, key=lambda r: str(r.get('ts') or ''))[-1].get('ts') or '')[:16]
    else:
        d = [r for r in load_last(os.path.join(COG, 'wake-interventions.jsonl'), 'ts').values()
             if r.get('goal') == args.target and r.get('event') == 'disable']
        if d:
            _d = sorted(d, key=lambda r: str(r.get('ts') or ''))[-1]
            try:
                import datetime as _dt
                _end = _dt.datetime.fromisoformat(str(_d['ts'])) + _dt.timedelta(hours=float(_d.get('plannedHours') or 24))
                win_end = _end.strftime('%Y-%m-%dT%H:%M')
            except Exception:  # noqa: BLE001
                win_end = ''

    def in_window(r):
        if win_start and str(r.get('startIso') or '')[:16] != win_start:
            return False
        if win_end and str(r.get('ts') or '')[:16] < win_end:
            return False
        return True
    mains = [r for r in rows if r.get('target') == args.target and r.get('event') != 'reversal' and in_window(r)]
    revs = [r for r in rows if r.get('target') == args.target and r.get('event') == 'reversal' and in_window(r)]
    if not mains:
        print('[expect] **本窗口**(起点 %s, 结束 %s)之后的判读行还没产出 ⇒ 不判(预期分支=%s; '
              '窗口结束前跑出来的行属试探读数, 不作数)' % (win_start or '未知', win_end or '未知', exp_verdict))
        return 0
    actual = str(mains[-1].get('verdict') or '')
    actual_rev = str(revs[-1].get('verdict') or '(尚无)') if revs else '(尚无)'
    same = actual == exp_verdict
    rev_ok = (not exp_reversal) or (actual_rev == exp_reversal)
    payload = {'claim': args.claim, 'expected': {'verdict': exp_verdict, 'reversal': exp_reversal},
               'actual': {'verdict': actual, 'reversal': actual_rev},
               'match': same and rev_ok,
               'readoutTs': str(mains[-1].get('ts'))[:19]}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('预期 %s / 实际 %s ⇒ %s' % (exp_verdict, actual, '一致' if same else '**不一致**'))
        print('恢复腿: 预期 %s / 实际 %s ⇒ %s' % (exp_reversal or '(未预登记)', actual_rev,
                                                  '一致' if rev_ok else '**不一致**'))
        if not (same and rev_ok):
            print('  提示: 不一致时**先查口径**(窗口边界/时代覆盖/对照臂是否有池写入), 再决定是否采信实际读数; '
                  '不要把\"分支不同\"直接当成\"结论不同\"。')
    if args.write:
        tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-ledger-append.py')
        import subprocess
        cmd = [sys.executable, tool, args.claim,
               '--set', 'expectationCheck=%s' % json.dumps(payload, ensure_ascii=False)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        print('  写回: ' + (r.stdout or r.stderr).strip()[:160])
    return 0 if (same and rev_ok) else 1


if __name__ == '__main__':
    sys.exit(main())
