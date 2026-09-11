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

# 条件型等待(cl-252, 2026-09-12): "低归因"有两种完全不同的成因 —— ①提醒没用(噪声) ②目标**合法地被
# 自己的条件门挡着**, 期间根本不会产生新的行动帧。原来的噪声判据只看帧数与归因率, 于是把②读成①:
# 实测 goal-experience-library 是当时**唯一**的噪声候选(15 帧/1 归因/6.7%), 而它的 waitChecker
# (`dsh-wait-check-ab-window.py --min-turns 40`)未满足 ⇒ 驱动侧按 cl-250 把它排除 ⇒ 样本门靠等待永远
# 攒不到。若照噪声处置(降相似度权重/改写 focus), 就是**用错误读数拆掉一个正在按纪律等待的目标**。
# 故: 逐目标跑它自己的 waitChecker, **与驱动侧同一语义**(exit 0 = 条件已满足 ⇒ 该干; 非 0/超时/测不出
# = 未满足 ⇒ 不该干), 未满足者标 heldByCondition 并从噪声候选里剔除。
WAIT_CHECK_TIMEOUT = 25.0

# 时代限定(2026-09-12 03:0x, cl-261): 归因率是"这次唤醒有没有推动下一步"的度量, 而下一步是会被**反复重写**的。
# 用一个目标的**全部历史帧**判它今天是不是噪声, 会把三件事混在一起: ①旧 nextAction 时代的步法(实测
# goal-experience-library 的 16 帧里有 8 帧是"③a 检查: 可执行, 每次唤醒跑一次, 同读数不重复劳动"这类**幂等复读步**
# —— 复读步天然产生不了池变更, 于是被判成"没推动") ②被条件门冻结的时段(门开着时驱动侧不产生帧, 率被冻住)
# ③当前接线。故: 噪声裁决只看最近 NOISE_WINDOW_HOURS 内的帧; 窗口内不足 NOISE_MIN_FRAMES 帧就**不判**
# (报 stale-window), 而不是拿旧账判今天。
NOISE_WINDOW_HOURS = 72.0



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


def wait_condition_met(cmd: str) -> bool | None:
    """跑目标的 waitChecker —— 与 quiet-driver 的 waitConditionMet 同一语义。

    exit 0 = 条件已满足(该驱动); 非 0 / 超时 / 命令为空 = 未满足(不该驱动)。
    返回 None 表示"该目标没挂条件门"(而不是"条件未满足"), 两者在读数里必须分得开:
    前者不参与 held 判定, 后者是 held 的**唯一**依据。
    """
    import subprocess
    c = (cmd or '').strip()
    if not c:
        return None
    try:
        r = subprocess.run(c, shell=True, capture_output=True, timeout=WAIT_CHECK_TIMEOUT)
        return r.returncode == 0
    except Exception:
        return False   # fail-closed: 测不出就不当条件已满足(与驱动侧一致)


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
    ap.add_argument('--since', default=None,
                    help='只统计该时刻之后写入的行动帧(ISO 或 epoch ms)。全时读数会把"条件门装好之前"与之后混在一起 '
                         '—— 复测某目标是否变好时, 必须限定时代, 否则结论由旧账决定')
    ap.add_argument('--noise-window-hours', type=float, default=NOISE_WINDOW_HOURS,
                    help='噪声裁决只看最近这么多小时内的行动帧(默认 72): 全部历史帧会把旧 nextAction 时代的'
                         '步法与门控冻结时段混进今天的裁决(cl-261)')
    ap.add_argument('--reverse', action='store_true',
                    help='同时算**反向判据**: 有多少次池推进**没有**对应的行动帧(即没被唤醒也被推进了)')
    args = ap.parse_args()
    try:
        frames = [r for r in load(FRAMES) if r.get('kind') == 'action-frame']
        if args.since:
            cut = ms_of(args.since) or 0.0
            frames = [r for r in frames if (ms_of(r.get('ts')) or 0) > cut]
        changes = [r for r in load(INCUBATION) if r.get('evidence') == 'pool-change']
        triggers = load(TRIGGERS)
    except FileNotFoundError as exc:
        print('读不到账本: %s' % exc, file=sys.stderr)
        return 3

    window_ms = args.window_min * 60 * 1000
    tol_ms = args.pre_tolerance_min * 60 * 1000
    pool_status = {}
    pool_wait = {}
    try:
        pool_path = os.path.join(DIR, 'dormant-goals.jsonl')
        if os.path.exists(pool_path):
            for line in open(pool_path, encoding='utf8'):
                if line.strip():
                    row = json.loads(line)
                    pool_status[str(row.get('id'))] = row.get('status')      # last-wins
                    pool_wait[str(row.get('id'))] = row.get('waitChecker')
    except Exception:
        pool_status = {}

    per: dict[str, dict] = collections.defaultdict(lambda: {
        'frames': 0, 'attributed': 0, 'loose': 0, 'delays': [], 'unattributedFrames': [],
        'wakes': 0, 'skippedWaiting': 0, 'framesRecent': 0, 'attributedRecent': 0})
    now_ms = datetime.datetime.now().timestamp() * 1000
    window_cut_ms = now_ms - args.noise_window_hours * 3600 * 1000
    for wake in triggers:
        gid = str(wake.get('goalId') or '?')
        per[gid]['wakes'] += 1
        if wake.get('skipped'):
            per[gid]['skippedWaiting'] += 1

    for frame in frames:
        gid = str(frame.get('goalId') or '?')
        session = str(frame.get('session') or '')
        f_ts = ms_of(frame.get('ts')) or 0.0
        recent = f_ts >= window_cut_ms
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
        if recent:
            slot['framesRecent'] += 1
        if hit is not None:
            slot['attributed'] += 1
            if recent:
                slot['attributedRecent'] += 1
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
            'framesRecent': slot['framesRecent'],
            'attributionRateRecent': (round(slot['attributedRecent'] / slot['framesRecent'], 3)
                                      if slot['framesRecent'] else None),
            # cl-261: 裁决**只看窗口内的帧**; 窗口内帧数不够就"不判"(stale-window), 不拿旧账判今天。
            'noiseCandidate': bool(slot['framesRecent'] >= NOISE_MIN_FRAMES
                                   and slot['framesRecent'] > 0
                                   and (slot['attributedRecent'] / slot['framesRecent']) < NOISE_MAX_RATE
                                   and pool_status.get(gid) == 'active'),
            'waitChecker': (pool_wait.get(gid) or '').strip() or None,
            # 条件门未满足 ⇒ 期间不会新增行动帧 ⇒ "低归因"在这里不构成噪声证据(cl-252)
            'heldByCondition': False,
            'unattributedSample': [u['driven'][:40] for u in slot['unattributedFrames'][-2:]],
        })
    for r in rows:
        r['governedElsewhere'] = r['goalId'] in GOVERNED_ELSEWHERE
        r['governedReason'] = GOVERNED_ELSEWHERE.get(r['goalId'])
        # 只对"可能被判噪声"或"仍 active 且有帧"的目标真跑条件门: 其它目标(无帧/paused)没有判定价值,
        # 而 waitChecker 是外部命令 —— 不该为了好看对全池都执行一遍。
        if pool_status.get(r['goalId']) == 'active' and r['frames'] > 0:
            met = wait_condition_met(str(pool_wait.get(r['goalId']) or ''))
            r['waitConditionMet'] = met
            if met is False:
                r['heldByCondition'] = True
                r['noiseCandidate'] = False
        else:
            r['waitConditionMet'] = None
        # 自证: 被条件门挡住的目标必须能被指认出来, 否则剔除动作会变成静默的
        if r['heldByCondition']:
            r['noiseCandidateBasis'] = 'held-by-condition'
        elif r['noiseCandidate']:
            r['noiseCandidateBasis'] = 'rate'
        elif (r['frames'] >= NOISE_MIN_FRAMES and r['framesRecent'] < NOISE_MIN_FRAMES
              and pool_status.get(r['goalId']) == 'active'):
            r['noiseCandidateBasis'] = 'stale-window'   # 历史帧够多但都在窗口外 ⇒ 不判, 而不是判噪声
        else:
            r['noiseCandidateBasis'] = 'not-candidate'
    measurable = [r for r in rows if r['frames'] > 0 and not r['governedElsewhere']]
    m_frames = sum(r['frames'] for r in measurable)
    m_attr = sum(r['attributed'] for r in measurable)
    driven_rows = [r for r in rows if r['frames'] > 0]
    total_frames = sum(r['frames'] for r in driven_rows)
    total_attr = sum(r['attributed'] for r in driven_rows)
    total_loose = sum(r['loose'] for r in driven_rows)
    reverse = None
    if args.reverse:
        # 反向判据(帧要求的下一个可证伪点): 池推进**不是**由"关于该目标的唤醒"带来的比例。
        # 若这个比例很高, 说明提醒不是推进的生产者 —— 那么"唤醒→推进"的因果链需要重估, 而不是继续
        # 用正向归因率给自己打分。判据: 一条 pool-change 若在 (ts - 窗口, ts + 前向容差) 内找不到
        # 同一目标、同一会话、且 before 与之匹配的行动帧 ⇒ 记为"未被唤醒也被推进"。
        unown = []
        for change in changes:
            gid = str(change.get('goalId'))
            session = str(change.get('sessionId') or '')
            cts = ms_of(change.get('ts'))
            before = str(change.get('before') or '')[:PREFIX]
            if cts is None:
                continue
            owned = False
            for frame in frames:
                if str(frame.get('goalId')) != gid:
                    continue
                if session and str(frame.get('session') or '') != session:
                    continue
                fts = ms_of(frame.get('ts'))
                if fts is None:
                    continue
                if cts - tol_ms <= fts <= cts + window_ms and str(frame.get('nextAction') or '')[:PREFIX] == before:
                    owned = True
                    break
            if not owned:
                unown.append({'goalId': gid, 'ts': str(change.get('ts'))[:19], 'before': before[:40]})
        reverse = {'changes': len(changes), 'withoutWake': len(unown),
                   'withoutWakeRate': round(len(unown) / len(changes), 3) if changes else None,
                   'sample': unown[-3:]}
    payload = {
        'ts': now_iso(), 'origin': os.environ.get('DSH_RUN_ORIGIN') or 'manual',
        'since': args.since,
        'windowMin': args.window_min, 'preToleranceMin': args.pre_tolerance_min,
        'noiseRule': ('最近 %gh 内 frames>=%d 且 严格归因率<%d%% 且 目标当前 active 且 **其 waitChecker 未拦着**'
                      % (args.noise_window_hours, NOISE_MIN_FRAMES, int(NOISE_MAX_RATE * 100))),
        'noiseWindowHours': args.noise_window_hours,
        'heldByCondition': [r['goalId'] for r in rows if r.get('heldByCondition')],
        'frames': total_frames, 'attributed': total_attr,
        'attributionRate': round(total_attr / total_frames, 3) if total_frames else None,
        'looseRate': round(total_loose / total_frames, 3) if total_frames else None,
        'noiseCandidates': [r['goalId'] for r in measurable if r['noiseCandidate']],
        'measurableFrames': m_frames,
        'measurableAttributionRate': round(m_attr / m_frames, 3) if m_frames else None,
        'governedElsewhere': {gid: reason for gid, reason in GOVERNED_ELSEWHERE.items() if gid in per},
        'perGoal': rows,
        'reverse': reverse,
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
        if payload.get('heldByCondition'):
            print('被自身条件门挡住(不计入噪声, 期间不会新增行动帧): %s' % ', '.join(payload['heldByCondition']))
        print('%-32s %6s %8s %9s %8s %8s' % ('目标', '唤醒', '行动帧', '被推进', '严格率', '宽松率'))
        for r in driven_rows:
            print('%-32s %6d %8d %9d %8s %8s%s' % (r['goalId'], r['wakes'], r['frames'], r['attributed'],
                  ('%.1f%%' % (100 * r['attributionRate'])) if r['attributionRate'] is not None else '-',
                  ('%.1f%%' % (100 * r['looseRate'])) if r['looseRate'] is not None else '-',
                  ('  ← 噪声候选' if r['noiseCandidate'] else
                   ('  ← 历史帧够多但窗口内不足(不判)' if r.get('noiseCandidateBasis') == 'stale-window' else
                    ('  ← 被自身条件门挡着(不计噪声)' if r.get('heldByCondition') else
                     ('  ← 由别的机制拥有(量不了)' if r['governedElsewhere'] else ''))))))
        if reverse is not None:
            print('反向判据: 池推进 %d 次, 其中 **%d 次没有对应的唤醒**(%.1f%%) —— 未被唤醒也被推进 ⇒ 提醒不是推进的必要条件'
                  % (reverse['changes'], reverse['withoutWake'], 100 * (reverse['withoutWakeRate'] or 0)))
            for x in reverse['sample']:
                print('    %s %s | %s' % (x['ts'], x['goalId'], x['before']))
        if payload['noiseCandidates']:
            print('噪声候选(%s): %s —— 处置: 先逐条排除替代解释(是不是在合法等待/nextAction 由别的机制拥有), '
                  '再考虑降相似度权重/调阈值/改写 focus, 而不是继续解释'
                  % (payload['noiseRule'], ', '.join(payload['noiseCandidates'])))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
