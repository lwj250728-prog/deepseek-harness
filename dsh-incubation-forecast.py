#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-incubation-forecast.py — 把孵化机制从"能自证"推进到"能预测"(预登记 + 记分)。

问题: 三率(触发/采纳/推进)是**事后**统计 —— 它们能说明"过去没空转", 但任何机制都可以用事后指标把自己
讲圆。真正能把它与自欺区分开的是**先写预测、后核命中**: 预测必须带区间与评估规则, 且在观察窗结束前
不可改。本工具做两件事:

  --register  按当前计数为每个目标预登记一条预测: 接下来 K 次唤醒里
              ① 采纳次数区间(二项, Wilson 95%)
              ② 推进次数区间(用"已裁决采纳"的历史推进率; 无已裁决样本则不给推进预测, 只记"不可预测")
              同时写下**评估规则**(累计触发达到 basis+K 时结算; 实际落在区间内 = 命中)与**截止时间**。
  --score     把已到结算点的预测逐条结算(命中/未命中/样本未到), 并给出累计命中率。

口径纪律: 预测的**基准**(basisTriggers/basisAdoptions)与**实际**都读同一份 `goal-trigger-log.jsonl`
(唤醒侧写的事实行); 推进率沿用 `dsh-incubation-stats.py` 的判据(专属见证 + 只算已裁决), 不另起一套。

用法: dsh-incubation-forecast.py --register [--horizon 10] [--json]
      dsh-incubation-forecast.py --score [--json]
退出码: 0 正常; 3 读不到事实账本。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import math
import os
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
TRIGGERS = os.path.join(DIR, 'goal-trigger-log.jsonl')
PREDICTIONS = os.path.join(DIR, 'incubation-predictions.jsonl')


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def load_trigger_rows() -> list[dict]:
    if not os.path.exists(TRIGGERS):
        raise FileNotFoundError(TRIGGERS)
    rows = []
    for line in open(TRIGGERS, encoding='utf8'):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """二项比例的 Wilson 区间(小样本也稳)。n=0 时给 [0,1](不可知)。"""
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))



def beta_binomial_interval(k: int, n: int, horizon: int, level: float = 0.95) -> tuple[int, int]:
    """未来 horizon 次唤醒里成功次数的预测区间(beta-二项, Jeffreys 先验 Beta(k+0.5, n-k+0.5))。

    为什么不用"二项比例区间 × horizon": 那样得到的区间宽到几乎必然命中(实测 10 次唤醒给出 [0,8]),
    预测就失去了可证伪性 —— 那正是本机制要防的自我确认。beta-二项是标准做法: 先验+似然的后验预测分布,
    取 level 分位点。n=0 时退化为均匀先验, 区间会很宽(诚实地表示"什么都不知道")。
    """
    alpha = k + 0.5
    beta = n - k + 0.5
    if horizon <= 0:
        return (0, 0)

    def log_beta(a: float, b: float) -> float:
        return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)

    log_den = log_beta(alpha, beta)
    weights = []
    for x in range(horizon + 1):
        log_p = (math.lgamma(horizon + 1) - math.lgamma(x + 1) - math.lgamma(horizon - x + 1)
                 + log_beta(x + alpha, horizon - x + beta) - log_den)
        weights.append(math.exp(log_p))
    total = sum(weights)
    tail = (1 - level) / 2
    lo = hi = 0
    acc = 0.0
    for x, w in enumerate(weights):
        acc += w / total
        if acc >= tail:
            lo = x
            break
    acc = 0.0
    for x in range(horizon, -1, -1):
        acc += weights[x] / total
        if acc >= tail:
            hi = x
            break
    return (lo, max(lo, hi))


def funnel(rows: list[dict]) -> dict[str, dict]:
    """逐目标漏斗: 唤醒数 / 采纳数 / 采纳率区间(直接来自事实行, 不含任何推断)。"""
    per: dict[str, dict] = {}
    for row in rows:
        gid = str(row.get('goalId') or '?')
        slot = per.setdefault(gid, {'triggers': 0, 'adoptions': 0, 'skippedWaiting': 0})
        slot['triggers'] += 1
        if row.get('adopted') is True:
            slot['adoptions'] += 1
        if row.get('skipped'):
            slot['skippedWaiting'] += 1
    for gid, slot in per.items():
        lo, hi = wilson(slot['adoptions'], slot['triggers'])
        slot['adoptRate'] = round(slot['adoptions'] / slot['triggers'], 4) if slot['triggers'] else None
        slot['adoptRateCI'] = [round(lo, 4), round(hi, 4)]
    return per


def advance_rates() -> dict[str, dict]:
    """沿用 dsh-incubation-stats.py 的判据(专属见证 + 只算已裁决), 不另起口径。"""
    import subprocess
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-incubation-stats.py'), '--json'],
                         capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        return {}
    try:
        return {row['goalId']: row for row in json.loads(out.stdout)}
    except Exception:
        return {}


def register(horizon: int) -> dict:
    rows = load_trigger_rows()
    per = funnel(rows)
    adv = advance_rates()
    registered = []
    for gid, slot in sorted(per.items()):
        n, k = slot['triggers'], slot['adoptions']
        lo, hi = slot['adoptRateCI']
        # 采纳次数区间: beta-二项预测区间(见函数注释: 用二项比例区间×horizon 会宽到不可证伪)
        adopt_lo, adopt_hi = beta_binomial_interval(k, n, horizon)
        adopt_point = round(slot['adoptRate'] * horizon, 2) if slot['adoptRate'] is not None else None
        a = adv.get(gid) or {}
        decided = (a.get('adopted') or 0) - (a.get('pending') or 0) - (a.get('undecidable') or 0)
        if decided > 0 and a.get('advance_rate') is not None:
            p_adv = a['advance_rate'] / 100.0
            adv_lo, adv_hi = beta_binomial_interval(int(a.get('advanced') or 0), decided, horizon)
            advance_interval = [adv_lo, adv_hi]
            advance_point = round(p_adv * horizon, 2)
            advance_note = '推进区间按已裁决采纳的推进率 %s%% (decided=%d)' % (a.get('advance_rate'), decided)
        else:
            advance_interval = None
            advance_point = None
            advance_note = '无已裁决采纳样本 ⇒ 不预测推进(不编区间)'
        registered.append({
            'goalId': gid,
            'basisTriggers': n,
            'basisAdoptions': k,
            'horizonWakes': horizon,
            'adoptInterval': [adopt_lo, adopt_hi],
            'adoptPoint': adopt_point,
            'advanceInterval': advance_interval,
            'advancePoint': advance_point,
            'method': 'beta-binomial(Jeffreys) 95% 预测区间; 命中=实际落在区间内, tightHit=|实际-点估计|<=1',
            'rule': ('累计唤醒数达到 %d 时结算: 该窗口内实际采纳数落在 adoptInterval 内 = 命中; '
                     'advanceInterval 非空时同样判命中, 为空则该维度不判' % (n + horizon)),
            'deadline': (datetime.datetime.now().astimezone() + datetime.timedelta(days=3)).isoformat(),
            'note': advance_note,
        })
    record = {'ts': now_iso(), 'kind': 'register', 'version': 2,
              'origin': os.environ.get('DSH_RUN_ORIGIN') or 'manual',
              'horizonWakes': horizon, 'predictions': registered}
    with open(PREDICTIONS, 'a', encoding='utf8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
    return record


def score() -> dict:
    if not os.path.exists(PREDICTIONS):
        return {'scored': [], 'hitRate': None, 'note': '尚无预登记'}
    rows = load_trigger_rows()
    per = funnel(rows)
    live: dict[str, dict] = {}
    results = []
    # last-wins: 同一 (goalId, 基准唤醒数) 可能有多次预登记(如口径收紧后的重登记), 只认最后一次
    latest: dict[tuple, dict] = {}
    for line in open(PREDICTIONS, encoding='utf8'):
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get('kind') != 'register':
            continue
        for pred in rec.get('predictions') or []:
            latest[(pred['goalId'], pred['basisTriggers'])] = (rec, pred)
    for rec, pred in latest.values():
        if True:
            gid = pred['goalId']
            basis, target = pred['basisTriggers'], pred['basisTriggers'] + pred['horizonWakes']
            cur = per.get(gid, {}).get('triggers', 0)
            if cur < target:
                live[gid] = {'goalId': gid, 'remaining': target - cur, 'target': target,
                             'adoptInterval': pred['adoptInterval']}
                continue
            # 结算: 该窗口内的实际采纳 = 当前采纳 − 基准采纳
            actual_adopt = per.get(gid, {}).get('adoptions', 0) - pred['basisAdoptions']
            lo, hi = pred['adoptInterval']
            point = pred.get('adoptPoint')
            hit = lo <= actual_adopt <= hi
            tight = point is not None and abs(actual_adopt - point) <= 1
            results.append({'goalId': gid, 'registeredAt': rec['ts'][:19], 'target': target,
                            'actualAdoptions': actual_adopt, 'interval': [lo, hi], 'point': point,
                            'hit': hit, 'tightHit': tight,
                            'advanceInterval': pred.get('advanceInterval')})
    hits = [r for r in results if r['hit']]
    tights = [r for r in results if r.get('tightHit')]
    payload = {'ts': now_iso(), 'scored': results, 'live': live,
               'hitRate': round(len(hits) / len(results), 3) if results else None,
               'tightHitRate': round(len(tights) / len(results), 3) if results else None,
               'note': ('尚无已结算预测(全部仍在窗口内)' if not results else
                        '命中 %d/%d' % (len(hits), len(results)))}
    with open(PREDICTIONS, 'a', encoding='utf8') as f:
        f.write(json.dumps({'kind': 'score', **payload}, ensure_ascii=False) + '\n')
    return payload


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--register', action='store_true')
    ap.add_argument('--score', action='store_true')
    ap.add_argument('--horizon', type=int, default=10, help='预测未来多少次唤醒(默认 10)')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if args.register == args.score:
        print('用法: --register 或 --score(二选一)', file=sys.stderr)
        return 2
    try:
        if args.register:
            rec = register(args.horizon)
            if args.json:
                print(json.dumps(rec, ensure_ascii=False))
            else:
                print('已预登记 %d 个目标的预测(未来 %d 次唤醒):' % (len(rec['predictions']), args.horizon))
                for p in rec['predictions']:
                    print('  %-32s 基准 %d 唤醒/%d 采纳 ⇒ 采纳区间 %s%s | %s'
                          % (p['goalId'], p['basisTriggers'], p['basisAdoptions'], p['adoptInterval'],
                             (' 推进区间 %s' % p['advanceInterval']) if p['advanceInterval'] else ' 推进: 不预测',
                             p['note']))
        else:
            payload = score()
            if args.json:
                print(json.dumps(payload, ensure_ascii=False))
            else:
                print('已结算 %d 条 | 区间命中率 %s | 点估计命中率(误差<=1) %s | 仍需等待 %d 个目标'
                      % (len(payload['scored']), payload['hitRate'], payload['tightHitRate'],
                         len(payload.get('live') or {})))
                for r in payload['scored']:
                    print('  %-32s 区间 %s 点 %s 实际 %s ⇒ %s%s' % (r['goalId'], r['interval'], r.get('point'),
                            r['actualAdoptions'], '命中' if r['hit'] else '未命中',
                            ' (点估计误差<=1)' if r.get('tightHit') else ''))
                for gid, l in (payload.get('live') or {}).items():
                    print('  %-32s 还差 %d 次唤醒结算' % (gid, l['remaining']))
    except FileNotFoundError as exc:
        print('读不到事实账本: %s' % exc, file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
