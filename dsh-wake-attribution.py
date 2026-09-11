#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-attribution.py — "唤醒是否真的驱动了行动"的常驻读数(cl-251)。

问题: 三率(触发/采纳/推进)回答的是"唤醒之后池/产物有没有变", 但**没有回答"是不是这次唤醒让它变的"**。
一个目标可以每次被唤醒后都因为**别的原因**发生变化(我在做别的事时顺手改了它的 nextAction), 于是三率
看起来很好而提醒本身其实没用。本工具算的是更窄、更难自欺的一条:

    被唤醒(行动帧驱动该目标) ⇒ **同会话、同一回合窗口内、该目标从这一条 nextAction 前进到另一条** 的比率

归因判据(严格): 取 `quiet-driver-frames.jsonl` 的 action-frame(带 goalId/nextAction/session/ts),
在 `incubation-log.jsonl` 里找同 goalId、同 sessionId、ts 落在 (frame.ts, frame.ts+窗口] 的 pool-change,
并要求它的 `before` 与 frame 的 `nextAction` **前缀一致** —— 即"被驱动的那一步确实被推进了"。只按时间
相邻而不核对内容, 就会把"恰好同回合发生的别的改动"算成唤醒的功劳(那正是自欺的形态)。

输出: 逐目标 唤醒数/被推进数/比率; 并标出**噪声候选**(唤醒 ≥3 次且 0 次推进)。噪声候选的处置不是继续
解释, 而是降相似度权重/调阈值/改写 focus。

用法: dsh-wake-attribution.py [--window-min 60] [--json] [--no-record]
退出码: 0 正常; 3 读不到账本。
记录: 每次运行追加一行到 `wake-attribution.jsonl`(常驻读数)。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
FRAMES = os.path.join(DIR, 'quiet-driver-frames.jsonl')
INCUBATION = os.path.join(DIR, 'incubation-log.jsonl')
TRIGGERS = os.path.join(DIR, 'goal-trigger-log.jsonl')
RECORD = os.path.join(DIR, 'wake-attribution.jsonl')
PREFIX = 60          # nextAction 前缀比较长度(足够区分不同步骤, 又不怕尾部改写)
# 噪声候选的判据: 行动帧够多但严格归因率很低。此前写成"严格归因恰好为 0" —— 太二值: 1/15(6.7%) 与 0/15
# 会被当成两回事, 而它们都说明"这批提醒基本没带来推进"。阈值写进记录, 便于日后复核与调整。
NOISE_MIN_FRAMES = 5
NOISE_MAX_RATE = 0.20



# 由**别的机制拥有 nextAction** 的目标: 它们的 nextAction 会被那个机制直接改写, 于是"帧驱动的那一步被推进"
# 这条严格判据对它们**结构性地**失败(实测: goal-adoption-rate 宽松 88.2% 却严格 0% —— 它几乎每次都变,
# 但从不是帧驱动的那一步, 因为闸门在达标时会自己武装 nextAction)。这不是"提醒没用", 而是**这支尺子量不了它**:
# 故单列, 并从"可严格测量"的总率里剔除, 免得用一个错口径去调权重。
GOVERNED_ELSEWHERE = {
    'goal-adoption-rate': 'dsh-adoption-gate-arm.py 达标时自动武装 nextAction(闸门拥有该字段)',
}

def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def load(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    rows = []
    for line in open(path, encoding='utf8'):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def ms_of(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
        except Exception:
            try:
                return float(value)
            except Exception:
                return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--window-min', type=float, default=180.0,
                    help='唤醒后多久内的推进算这次唤醒的功劳(默认 180: 60 分钟会把 p90≈45/最大≈60 的真实归因截断)')
    ap.add_argument('--pre-tolerance-min', type=float, default=30.0,
                    help='容许推进发生在帧时间戳**之前**多少分钟(默认 30): 行动帧的 ts 是**回合结束**才写的, '
                         '它引发的那次池变更可能早于它 —— 实测 20:02 那对(change 20:02:46.4 / frame 20:02:47)'
                         '就因"必须晚于帧时间戳"这一假设被漏掉; 内容匹配(before 前缀)仍要求逐字一致, 不会误认')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-record', action='store_true')
    args = ap.parse_args()
    try:
        frames = [r for r in load(FRAMES) if r.get('kind') == 'action-frame']
        changes = [r for r in load(INCUBATION) if r.get('evidence') == 'pool-change']
        triggers = load(TRIGGERS)
    except FileNotFoundError as exc:
        print('读不到账本: %s' % exc, file=sys.stderr)
        return 3

    window_ms = args.window_min * 60 * 1000
    tol_ms = args.pre_tolerance_min * 60 * 1000
    pool_status = {}
    try:
        pool_path = os.path.join(DIR, 'dormant-goals.jsonl')
        if os.path.exists(pool_path):
            for line in open(pool_path, encoding='utf8'):
                if line.strip():
                    row = json.loads(line)
                    pool_status[str(row.get('id'))] = row.get('status')      # last-wins
    except Exception:
        pool_status = {}

    per: dict[str, dict] = collections.defaultdict(lambda: {
        'frames': 0, 'attributed': 0, 'loose': 0, 'delays': [], 'unattributedFrames': [],
        'wakes': 0, 'skippedWaiting': 0})
    for wake in triggers:
        gid = str(wake.get('goalId') or '?')
        per[gid]['wakes'] += 1
        if wake.get('skipped'):
            per[gid]['skippedWaiting'] += 1

    for frame in frames:
        gid = str(frame.get('goalId') or '?')
        session = str(frame.get('session') or '')
        ts = ms_of(frame.get('ts'))
        driven = str(frame.get('nextAction') or '')[:PREFIX]
        slot = per[gid]
        slot['frames'] += 1
        hit = None
        loose_hit = None
        if ts is not None and driven:
            for change in changes:
                if str(change.get('goalId')) != gid:
                    continue
                if session and str(change.get('sessionId') or '') != session:
                    continue
                cts = ms_of(change.get('ts'))
                # 帧 ts = 回合结束时写入; 它引发的池变更可能略早于它 ⇒ 允许前向容差(内容仍须逐字匹配)
                if cts is None or not (ts - tol_ms <= cts <= ts + window_ms):
                    continue
                if loose_hit is None or cts < ms_of(loose_hit.get('ts')):
                    loose_hit = change
                if str(change.get('before') or '')[:PREFIX] == driven:
                    hit = change
                    break
        if loose_hit is not None:
            slot['loose'] += 1
            slot['delays'].append(round((ms_of(loose_hit.get('ts')) - ts) / 60000, 1))
        if hit is not None:
            slot['attributed'] += 1
        else:
            slot['unattributedFrames'].append({'ts': frame.get('ts'), 'driven': driven})

    rows = []
    for gid, slot in sorted(per.items()):
        f = slot['frames']
        rate = (slot['attributed'] / f) if f else None
        rows.append({
            'goalId': gid, 'wakes': slot['wakes'], 'skippedWaiting': slot['skippedWaiting'],
            'frames': f, 'attributed': slot['attributed'],
            'attributionRate': round(rate, 3) if rate is not None else None,
            'loose': slot['loose'],
            'looseRate': round(slot['loose'] / f, 3) if f else None,
            'looseDelayMin': min(slot['delays']) if slot['delays'] else None,
            'looseDelayMax': max(slot['delays']) if slot['delays'] else None,
            'status': pool_status.get(gid),
            # 只有"现在仍可被驱动"(active)的目标才谈噪声候选; paused/dormant 的历史帧只作信息展示
            'noiseCandidate': bool(f >= NOISE_MIN_FRAMES and rate is not None and rate < NOISE_MAX_RATE
                                   and pool_status.get(gid) == 'active'),
            'unattributedSample': [u['driven'][:40] for u in slot['unattributedFrames'][-2:]],
        })
    for r in rows:
        r['governedElsewhere'] = r['goalId'] in GOVERNED_ELSEWHERE
        r['governedReason'] = GOVERNED_ELSEWHERE.get(r['goalId'])
    measurable = [r for r in rows if r['frames'] > 0 and not r['governedElsewhere']]
    m_frames = sum(r['frames'] for r in measurable)
    m_attr = sum(r['attributed'] for r in measurable)
    driven_rows = [r for r in rows if r['frames'] > 0]
    total_frames = sum(r['frames'] for r in driven_rows)
    total_attr = sum(r['attributed'] for r in driven_rows)
    total_loose = sum(r['loose'] for r in driven_rows)
    payload = {
        'ts': now_iso(), 'origin': os.environ.get('DSH_RUN_ORIGIN') or 'manual',
        'windowMin': args.window_min, 'preToleranceMin': args.pre_tolerance_min,
        'noiseRule': 'frames>=%d 且 严格归因率<%d%% 且 目标当前 active' % (NOISE_MIN_FRAMES, int(NOISE_MAX_RATE * 100)),
        'frames': total_frames, 'attributed': total_attr,
        'attributionRate': round(total_attr / total_frames, 3) if total_frames else None,
        'looseRate': round(total_loose / total_frames, 3) if total_frames else None,
        'noiseCandidates': [r['goalId'] for r in measurable if r['noiseCandidate']],
        'measurableFrames': m_frames,
        'measurableAttributionRate': round(m_attr / m_frames, 3) if m_frames else None,
        'governedElsewhere': {gid: reason for gid, reason in GOVERNED_ELSEWHERE.items() if gid in per},
        'perGoal': rows,
    }
    if not args.no_record:
        with open(RECORD, 'a', encoding='utf8') as f:
            f.write(json.dumps(payload, ensure_ascii=False) + '\n')
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('唤醒→推进归因(窗口 %.0f 分钟): 行动帧 %d | **严格(该步被推进)** %d = %.1f%% | 宽松(窗口内该目标有推进) %d = %.1f%%'
              % (args.window_min, total_frames, total_attr, 100 * (payload['attributionRate'] or 0),
                 total_loose, 100 * (payload['looseRate'] or 0)))
        print('口径说明: 严格=被驱动的那一步确实被推进(核 `before` 前缀); 宽松=窗口内该目标有任何推进(不核对内容)。'
              '两者差距大时, 先怀疑口径(窗口长度/池重复行时代/nextAction 由别的机制改写)再谈"提醒没用"')
        print('可严格测量口径(剔除 nextAction 由别的机制拥有的目标): %d 条行动帧 ⇒ **%.1f%%**'
              % (m_frames, 100 * (payload['measurableAttributionRate'] or 0)))
        print('噪声判据: %s' % payload['noiseRule'])
        print('%-32s %6s %8s %9s %8s %8s' % ('目标', '唤醒', '行动帧', '被推进', '严格率', '宽松率'))
        for r in driven_rows:
            print('%-32s %6d %8d %9d %8s %8s%s' % (r['goalId'], r['wakes'], r['frames'], r['attributed'],
                  ('%.1f%%' % (100 * r['attributionRate'])) if r['attributionRate'] is not None else '-',
                  ('%.1f%%' % (100 * r['looseRate'])) if r['looseRate'] is not None else '-',
                  '  ← 噪声候选' if r['noiseCandidate'] else ('  ← 由别的机制拥有(量不了)' if r['governedElsewhere'] else '')))
        if payload['noiseCandidates']:
            print('噪声候选(%s): %s —— 处置: 先逐条排除替代解释(是不是在合法等待/nextAction 由别的机制拥有), '
                  '再考虑降相似度权重/调阈值/改写 focus, 而不是继续解释'
                  % (payload['noiseRule'], ', '.join(payload['noiseCandidates'])))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
