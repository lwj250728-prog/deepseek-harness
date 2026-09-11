#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-causality.py — "唤醒与推进之间有没有可测因果"的更强检验(孵化目标 nextAction ②)。

背景: 反向判据已给出"42% 的池推进**没有**对应唤醒"⇒ 提醒不是推进的必要条件。但"不必要"还没回答
**"有没有用"**: 可能唤醒提高了推进速率(是催化), 也可能完全无关(是噪声)。本工具做的是速率对照:

    把观测窗口切成等长时段(默认 60 分钟), 每个时段按"该目标在此段内有没有行动帧"分为
    **有唤醒段** / **无唤醒段**, 比较两组的**推进速率(次/小时)**; 用二项检验给出 p 值。

判读(预登记, 先写死):
  · 速率比 >=1.5 且 p < 0.05            ⇒ `catalyst`  唤醒可测地提高推进速率
  · 速率比 <=0.67 且 p < 0.05           ⇒ `anti`      有唤醒的时段推进更慢(警告: 可能是"推进后无需再唤醒"的倒因为果)
  · 其余(含 p >= 0.05)                  ⇒ `no-signal` 在本样本上测不出速率差异
  · 有唤醒段或长度 < 5 段               ⇒ `insufficient` 对照太窄, 不下结论(不假装有结论)

已知混淆(必须随结论一起报): ①行动帧本身由**定时脉冲**产生, 若脉冲恰好也只在与推进相关的时段出现, 因果方向不可分;
②"无唤醒段"常常是**停顿期**(我被别的事占住), 那本身就会压低推进 —— 故本工具同时报**目标自身被唤醒的密度**与窗口长度。

用法: dsh-wake-causality.py [--goal ID] [--bin-min 60] [--hours 72] [--json]
退出码: 0 正常; 1 样本不足(不当通过); 2 读不到账本。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import math
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
FRAMES = os.path.join(D, 'quiet-driver-frames.jsonl')
INCUBATION = os.path.join(D, 'incubation-log.jsonl')
OUT = os.path.join(D, 'wake-causality.jsonl')


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


def binom_p(k: int, n: int, p: float) -> float:
    """双侧二项检验(正态近似, 样本小时只用于档位判断, 不作为精细 p 值)。"""
    if n == 0:
        return 1.0
    sd = math.sqrt(n * p * (1 - p)) or 1e-9
    z = abs(k - n * p) / sd
    return 2 * (1 - 0.5 * (1 + math.erf(z / math.sqrt(2))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--goal', default=None, help='只算该目标(默认全库可测目标)')
    ap.add_argument('--bin-min', type=float, default=60.0)
    ap.add_argument('--hours', type=float, default=72.0)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    frames = [r for r in load(FRAMES) if r.get('kind') == 'action-frame']
    changes = [r for r in load(INCUBATION) if r.get('evidence') == 'pool-change']
    if not frames or not changes:
        print('读不到账本(帧 %d / 池变更 %d)' % (len(frames), len(changes)), file=sys.stderr)
        return 2
    now_ms = datetime.datetime.now().timestamp() * 1000
    cut = now_ms - args.hours * 3600 * 1000
    if args.goal:
        frames = [f for f in frames if str(f.get('goalId')) == args.goal]
        changes = [c for c in changes if str(c.get('goalId')) == args.goal]
    frames = [f for f in frames if (ms_of(f.get('ts')) or 0) >= cut]
    changes = [c for c in changes if (ms_of(c.get('ts')) or 0) >= cut]
    bin_ms = args.bin_min * 60 * 1000

    # 以"最后一个事件"为右端, 往前切等长时段(不含未来空段)
    last = max([ms_of(f.get('ts')) or 0 for f in frames] + [ms_of(c.get('ts')) or 0 for c in changes])
    start = max(cut, last - bin_ms * int((last - cut) // bin_ms))
    bins: dict[int, dict] = {}
    idx = 0
    t = last
    while t - bin_ms >= start:
        bins[idx] = {'wakes': 0, 'advances': 0}
        idx += 1
        t -= bin_ms
    def bidx(ts: float) -> int | None:
        if ts < start or ts > last:
            return None
        return int((last - ts) // bin_ms)
    for f in frames:
        i = bidx(ms_of(f.get('ts')) or 0)
        if i is not None and i in bins:
            bins[i]['wakes'] += 1
    for c in changes:
        i = bidx(ms_of(c.get('ts')) or 0)
        if i is not None and i in bins:
            bins[i]['advances'] += 1

    woken = [b for b in bins.values() if b['wakes'] > 0]
    idle = [b for b in bins.values() if b['wakes'] == 0]
    h = args.bin_min / 60.0
    exp_w, exp_i = len(woken) * h, len(idle) * h
    adv_w = sum(b['advances'] for b in woken)
    adv_i = sum(b['advances'] for b in idle)
    rate_w = adv_w / exp_w if exp_w else None
    rate_i = adv_i / exp_i if exp_i else None
    ratio = (rate_w / rate_i) if (rate_w and rate_i) else None
    p = binom_p(adv_w, adv_w + adv_i, exp_w / (exp_w + exp_i)) if (exp_w + exp_i) else 1.0
    if len(woken) < 5 or len(idle) < 5:
        verdict, reason = 'insufficient', '有唤醒段 %d / 无唤醒段 %d —— 对照太窄(各需 >=5 段), 不下结论' % (len(woken), len(idle))
    elif p >= 0.05:
        verdict, reason = 'no-signal', '两种时段推进速率无可测差异(p=%.3f)' % p
    elif ratio and ratio >= 1.5:
        verdict, reason = 'catalyst', '有唤醒时段推进更快(×%.2f, p=%.3f)' % (ratio, p)
    elif ratio and ratio <= 0.67:
        verdict, reason = 'anti', '有唤醒时段推进反而更慢(×%.2f, p=%.3f) —— 警惕倒因为果(推进后无须再唤醒)' % (ratio, p)
    else:
        verdict, reason = 'no-signal', '速率比 ×%.2f 未过阈值且 p=%.3f' % (ratio or 0, p)

    payload = {
        'ts': datetime.datetime.now().astimezone().isoformat(), 'goal': args.goal or 'ALL',
        'binMin': args.bin_min, 'hours': args.hours, 'bins': len(bins),
        'wokenBins': len(woken), 'idleBins': len(idle),
        'wokenHours': round(exp_w, 2), 'idleHours': round(exp_i, 2),
        'advancesInWoken': adv_w, 'advancesInIdle': adv_i,
        'rateWoken': round(rate_w, 4) if rate_w is not None else None,
        'rateIdle': round(rate_i, 4) if rate_i is not None else None,
        'rateRatio': round(ratio, 3) if ratio else None, 'p': round(p, 4),
        'verdict': verdict, 'reason': reason,
        'confounds': ['行动帧由定时脉冲产生 ⇒ 因果方向可能与脉冲共线',
                      '无唤醒段往往是停顿期(我被别的事占住), 本身压低推进',
                      '池变更只含插件/写入方记录的行, 早期推进可能无记录(下限)'],
    }
    with open(OUT, 'a', encoding='utf8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('目标=%s | 时段 %d×%g分钟 | 有唤醒段 %d(推进 %d)/无唤醒段 %d(推进 %d)'
          % (payload['goal'], len(bins), args.bin_min, len(woken), adv_w, len(idle), adv_i))
    print('推进速率: 有唤醒 %.3f 次/h vs 无唤醒 %.3f 次/h | 比 %s | p=%.3f'
          % (rate_w or 0, rate_i or 0, payload['rateRatio'], p))
    print('判读: %s —— %s' % (verdict, reason))
    return 0


if __name__ == '__main__':
    sys.exit(main())
