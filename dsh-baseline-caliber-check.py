#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-baseline-caliber-check.py — 冻结基线必须与**同口径**复算一致(T205 的判据)

由来(2026-09-12 11:1x, cl-265 caliberBias): 判读器把基线与干预两臂的推进速率作比, 而两者的
**时代覆盖**不同 —— 22:0x 那次冻结用窗口全长 24h 作分母, 而该窗口里只有 4.6h 落在时代内 ⇒
基线被低估 5.2 倍 ⇒ ratio 放大 ⇒ **偏向判 causal**。口径已在判读器里改为"该臂自己的时代覆盖小时数",
并按同口径重新冻结了基线。

但**冻结文件本身是可以被写错的**(它就是一张数字表, 没有任何东西核它): 谁再按旧口径冻结一次,
判读器照用不误, 偏差原样回来。故本判据把"基线数字必须与同口径复算一致"变成可执行检查:
  · 复算 = 在 [windowStart, windowEnd) 内、且 ts >= eraSince 的 pool-change 条数 ÷ 时代覆盖小时数;
  · 与文件里的 perHour 逐项比(容差 max(0.05, 5%));
  · 某臂零覆盖 ⇒ 文件里不得写 0.0, 必须是 null/缺省(0 会被读成"测过且为零")。

退出码: 0 = 一致; 1 = 不一致(基线不可信 ⇒ 判读结论不可信); 3 = 读不到文件/账本。
用法: dsh-baseline-caliber-check.py [--baseline P] [--log P] [--json]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
DEFAULT_BASELINE = os.path.join(D, 'wake-intervention-baseline.json')
DEFAULT_LOG = os.path.join(D, 'incubation-log.jsonl')


def ms_of(v):
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            dt = datetime.datetime.fromisoformat(v.replace('Z', '+00:00'))
        except Exception:  # noqa: BLE001
            return None
        return dt.timestamp() * 1000.0 if dt.tzinfo else None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--baseline', default=DEFAULT_BASELINE)
    ap.add_argument('--log', default=DEFAULT_LOG)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    try:
        b = json.load(open(args.baseline, encoding='utf8'))
    except Exception as exc:  # noqa: BLE001
        print('[baseline-caliber] 读不到基线文件: %s' % exc, file=sys.stderr)
        return 3
    lo, hi = ms_of(b.get('windowStart')), ms_of(b.get('windowEnd'))
    era = ms_of(b.get('eraSince'))
    if lo is None or hi is None or hi <= lo:
        print('[baseline-caliber] 基线窗口不可解析(windowStart/windowEnd 须为带时区的 ISO)', file=sys.stderr)
        return 3
    cov_h = (hi - max(lo, era if era is not None else lo)) / 3600000.0
    if cov_h <= 0:
        print('[baseline-caliber] 该窗口完全没有时代内的覆盖 ⇒ 基线不可用(不能拿它当比较基准)', file=sys.stderr)
        return 1
    try:
        rows = [json.loads(l) for l in open(args.log, encoding='utf8') if l.strip()]
    except Exception as exc:  # noqa: BLE001
        print('[baseline-caliber] 读不到账本: %s' % exc, file=sys.stderr)
        return 3
    rows = [r for r in rows if r.get('evidence') == 'pool-change']
    rows = [r for r in rows if lo <= (ms_of(r.get('ts')) or -1) < hi]
    if era is not None:
        rows = [r for r in rows if (ms_of(r.get('ts')) or -1) >= era]
    bad, out = [], {}
    for gid, rec in (b.get('rates') or {}).items():
        n = sum(1 for r in rows if str(r.get('goalId')) == gid)
        want = n / cov_h
        got = rec.get('perHour') if isinstance(rec, dict) else None
        out[gid] = {'advances': n, 'coverageHours': round(cov_h, 2), 'expectedPerHour': round(want, 4), 'recorded': got}
        if got is None:
            bad.append('%s: 覆盖 %.2fh 却记成 null/缺省(有覆盖就必须给数)' % (gid, cov_h))
            continue
        if abs(float(got) - want) > max(0.05, 0.05 * want):
            bad.append('%s: 记 %s 而同口径复算是 %.4f(覆盖 %.2fh, %d 条) ⇒ 分母口径又变了?'
                       % (gid, got, want, cov_h, n))
    if args.json:
        print(json.dumps({'coverageHours': round(cov_h, 2), 'goals': out, 'bad': bad}, ensure_ascii=False))
    if bad:
        print('红: ' + '; '.join(bad), file=sys.stderr)
        return 1
    print('[baseline-caliber] %d 臂与同口径复算一致(时代覆盖 %.2fh)' % (len(out), cov_h))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
