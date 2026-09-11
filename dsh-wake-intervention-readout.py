#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-intervention-readout.py — 唤醒干预实验的判读器(cl-265)。

背景: 观测分不开因果(唤醒与推进共线于活动期), 故做了干预: 把目标 goal-experience-library 的
triggerThresholds 抬到 1.01(不再被唤醒)24 小时, 次日自动恢复。本工具按**事先预登记**的判据机械判读,
免得 24 小时后我又临时定口径(那正是今天反复踩的"事后解释"坑)。

预登记判据(cl-265):
  指标 = 该目标的**推进次数/小时**(池变更行 evidence=pool-change, 时代起点取 attribution-era.json)
  基线 = 干预窗口**之前等长**的窗口; 对照 = 同期未被干预的 active 目标(各自算自己的前后比)
  · 目标速率比 <= 0.5 且 目标的降幅大于**所有**对照目标的降幅 ⇒ `causal`(唤醒确实是推进的因, 恢复阈值)
  · 目标速率比 > 0.5, 或降幅不超过对照 ⇒ `no-effect`(提醒对该目标无独立贡献 ⇒ 按噪声处置: 改写 focus/降权重)
  · 干预窗口内该目标**仍被唤醒过**(triggerCount 增长) ⇒ `contaminated`(开关没真关上, 结论作废)

用法: dsh-wake-intervention-readout.py [--target ID] [--start ISO] [--end ISO] [--json]
退出码: 0 正常; 1 参数/前置不足(窗口未结束等); 2 读不到账本。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
LOG = os.path.join(D, 'incubation-log.jsonl')
POOL = os.path.join(D, 'dormant-goals.jsonl')
ERA = os.path.join(D, 'attribution-era.json')
OUT = os.path.join(D, 'wake-intervention-readout.jsonl')
TERMINAL = {'done', 'retired', 'closed'}


def ms_of(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000
        except Exception:
            try:
                return float(v)
            except Exception:
                return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='goal-experience-library')
    ap.add_argument('--start', default=None, help='干预窗口开始(ISO); 缺省=wake-interventions.jsonl 里最后一次 disable')
    ap.add_argument('--end', default=None, help='干预窗口结束(ISO); 缺省=该次 disable 之后最近一次 restore, 或现在')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    recs = []
    iv = os.path.join(D, 'wake-interventions.jsonl')
    if os.path.exists(iv):
        for line in open(iv, encoding='utf8'):
            if line.strip():
                recs.append(json.loads(line))
    start_ms = ms_of(args.start) if args.start else None
    if start_ms is None:
        dis = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'disable']
        if not dis:
            print('没有 disable 记录且未给 --start ⇒ 无法判读', file=sys.stderr)
            return 1
        start_ms = ms_of(dis[-1].get('ts'))
    end_ms = ms_of(args.end) if args.end else None
    if end_ms is None:
        res = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'restore'
               and (ms_of(r.get('ts')) or 0) > (start_ms or 0)]
        end_ms = ms_of(res[-1].get('ts')) if res else datetime.datetime.now().timestamp() * 1000
    if end_ms <= start_ms:
        print('窗口不合法(end <= start)', file=sys.stderr)
        return 1
    span = end_ms - start_ms
    base_start, base_end = start_ms - span, start_ms

    era_since = None
    try:
        era_since = (json.load(open(ERA, encoding='utf8')) or {}).get('since')
    except Exception:
        era_since = None
    era_ms = ms_of(era_since) if era_since else None

    pool = {}
    for line in open(POOL, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if r.get('id'):
                pool[str(r['id'])] = r
    try:
        changes = [json.loads(l) for l in open(LOG, encoding='utf8') if l.strip()]
    except Exception as exc:  # noqa: BLE001
        print('读不到账本: %s' % exc, file=sys.stderr)
        return 2
    changes = [c for c in changes if c.get('evidence') == 'pool-change']
    if era_ms is not None:
        changes = [c for c in changes if (ms_of(c.get('ts')) or 0) >= era_ms]

    def rate(goal: str, lo: float, hi: float) -> float:
        n = sum(1 for c in changes if str(c.get('goalId')) == goal and lo <= (ms_of(c.get('ts')) or 0) < hi)
        return n / (span / 3600000.0)

    hours = span / 3600000.0
    t_rate_i, t_rate_b = rate(args.target, start_ms, end_ms), rate(args.target, base_start, base_end)
    ratio = (t_rate_i / t_rate_b) if t_rate_b > 0 else (0.0 if t_rate_i == 0 else float('inf'))
    controls = {}
    for gid, row in pool.items():
        if gid == args.target or row.get('status') in TERMINAL or row.get('status') != 'active':
            continue
        b, i = rate(gid, base_start, base_end), rate(gid, start_ms, end_ms)
        controls[gid] = {'baseline': round(b, 3), 'intervention': round(i, 3),
                         'ratio': (round(i / b, 3) if b > 0 else None)}
    ctrl_ratios = [c['ratio'] for c in controls.values() if c['ratio'] is not None]
    target_row = pool.get(args.target) or {}
    # 污染检查: 干预窗口内该目标是否仍被唤醒(triggerCount 只能查现值, 故同时看触发日志的时间戳)
    contaminated = False
    trig = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'disable']
    live_after = target_row.get('lastTriggerAt')
    lm = ms_of(live_after)
    if lm is not None and start_ms <= lm < end_ms:
        contaminated = True
    # 2026-09-12 06:1x 补: 关闭必须**两侧同时**生效 —— 抬 triggerThresholds 只停哨兵提醒, 行动帧由
    # quiet-driver 按 status/waitChecker 选(实测查证), 故窗口内若仍出现该目标的行动帧 ⇒ 开关没关全, 结论作废。
    frames_in_window = 0
    try:
        for line in open(os.path.join(D, 'quiet-driver-frames.jsonl'), encoding='utf8'):
            if not line.strip():
                continue
            f = json.loads(line)
            if f.get('kind') != 'action-frame' or str(f.get('goalId')) != args.target:
                continue
            fm = ms_of(f.get('ts'))
            if fm is not None and start_ms <= fm < end_ms:
                frames_in_window += 1
    except Exception:
        frames_in_window = -1
    if frames_in_window > 0:
        contaminated = True

    dropped_more_than_controls = all((ratio is not None and ratio <= r) for r in ctrl_ratios) if ctrl_ratios else True
    if contaminated:
        verdict, reason = 'contaminated', ('干预窗口内该目标仍被唤醒过(lastTriggerAt=%s / 窗口内行动帧 %d 条) '
                                           '⇒ 开关没真关上, 结论作废' % (live_after, frames_in_window))
    elif ratio is not None and ratio <= 0.5 and dropped_more_than_controls:
        verdict, reason = 'causal', ('目标推进速率 %.3f→%.3f 次/h(比 %.2f, 降幅大于所有对照 %s) ⇒ 唤醒是推进的因'
                                     % (t_rate_b, t_rate_i, ratio, ctrl_ratios))
    else:
        verdict, reason = 'no-effect', ('目标推进速率 %.3f→%.3f 次/h(比 %s) 未达 >=50%% 降幅或未超过对照 %s '
                                        '⇒ 提醒对该目标无独立贡献' % (t_rate_b, t_rate_i, ratio, ctrl_ratios))
    payload = {'ts': datetime.datetime.now().astimezone().isoformat(), 'target': args.target,
               'startIso': datetime.datetime.fromtimestamp(start_ms / 1000).astimezone().isoformat(),
               'endIso': datetime.datetime.fromtimestamp(end_ms / 1000).astimezone().isoformat(),
               'hours': round(hours, 2), 'eraSince': era_since,
               'targetBaselineRate': round(t_rate_b, 3), 'targetInterventionRate': round(t_rate_i, 3),
               'targetRatio': ratio if ratio is None else (round(ratio, 3) if ratio != float('inf') else 'inf'),
               'framesInWindow': frames_in_window,
               'controls': controls, 'verdict': verdict, 'reason': reason}
    with open(OUT, 'a', encoding='utf8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('干预判读 %s | 窗口 %s → %s(%.1fh, 时代起点 %s)'
          % (args.target, payload['startIso'][11:16], payload['endIso'][11:16], hours, era_since))
    print('  目标推进速率: 基线 %.3f → 干预 %.3f 次/h(比 %s)' % (t_rate_b, t_rate_i, payload['targetRatio']))
    print('  对照: %s' % json.dumps(controls, ensure_ascii=False))
    print('判读: %s —— %s' % (verdict, reason))
    return 0


if __name__ == '__main__':
    sys.exit(main())
