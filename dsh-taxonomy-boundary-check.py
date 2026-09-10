#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""整合层边界复算(tp-112 / cl-169): 小簇结构性不可自修复 —— 按 7 天节奏复算, 达标即提示重试。

决策记录(2026-09-10 23:5x, 行动帧 nextAction 的 A/B 取舍): **选 B(维持现状 + 已知边界)**, 不选 A
(按簇规模缩放验证要求)。理由: 局部路径的验证样本量 = max(1, floor(n × 0.2)); 对 3 条成员的簇,
那是**1 条**验证样本 —— 用 1 条样本"接受"一次重建, 是把噪声当证据(正是今天反复修的"指标测在
错误的总体上"); 宁可明确边界, 也不制造假严谨。

本脚本把边界变成可复算的事实:
  · 每次运行统计任务经验的簇规模, 并把 `n >= LOCAL_READY_N(15)` 的簇标为"局部路径应已可用";
  · 一旦出现这样的簇, 就写一条 claim 条目(cl-taxonomy-ready-*)提示**必须重试 local 重建**;
  · 记录落 taxonomy-boundary.jsonl(每次一行), 供 7 天节奏复核。
用法: dsh-taxonomy-boundary-check.py [--json]
退出码: 0 = 无达标簇; 2 = 出现 n>=15 的簇(该重试 local 重建了)。
"""
from __future__ import annotations

import collections
import datetime
import json
import os
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
LOG = os.path.join(DIR, 'taxonomy-boundary.jsonl')
LEDGER = os.path.join(DIR, 'claims-ledger.jsonl')
TZ = datetime.timezone(datetime.timedelta(hours=8))
LOCAL_READY_N = 15          # validationSize = max(1, floor(n*0.2)) >= 3  ⇔  n >= 15
VALIDATION_RATIO = 0.2
MIN_VALIDATION = 3


def cluster_sizes() -> dict:
    path = os.path.join(DIR, 'experiences.jsonl')
    sizes: collections.Counter = collections.Counter()
    if os.path.exists(path):
        for line in open(path, encoding='utf8'):
            if not line.strip():
                continue
            rec = json.loads(line)
            cid = rec.get('clusterId')
            sizes[str(cid) if cid is not None else 'unclustered'] += 1
    return dict(sizes)


def main() -> int:
    args = sys.argv[1:]
    sizes = cluster_sizes()
    big = {k: v for k, v in sizes.items() if v >= LOCAL_READY_N and k != 'unclustered'}
    # 修正(cl-169): "存在 n>=15 的簇" **不等于** "局部路径可用" —— 局部重建作用于**最差簇**,
    # 若最差簇自身很小(实测 3/9 条), 该路径仍被结构性暂缓。故判据不看"有没有大簇",
    # 而看"**有没有按期真的重试过**": 超过 STALE_DAYS 未在 taxonomy-rebuild.jsonl 留下 local 尝试 => 提示。
    STALE_DAYS = 7
    attempts = []
    rp = os.path.join(DIR, 'taxonomy-rebuild.jsonl')
    if os.path.exists(rp):
        for line in open(rp, encoding='utf8'):
            if not line.strip():
                continue
            rec_ = json.loads(line)
            if rec_.get('scope') == 'local' and rec_.get('ts'):
                attempts.append(rec_['ts'])
    last_local = max(attempts) if attempts else None
    age_days = None
    if last_local:
        age_days = (datetime.datetime.now(TZ) - datetime.datetime.fromisoformat(last_local)).total_seconds() / 86400.0
    overdue = last_local is None or (age_days is not None and age_days > STALE_DAYS)
    ready = {'overdue': True, 'lastLocalAttempt': last_local, 'ageDays': round(age_days, 1) if age_days else None} if overdue else {}
    rec = {
        'ts': datetime.datetime.now(TZ).isoformat(),
        'origin': os.environ.get('DSH_RUN_ORIGIN', 'manual'),
        'clusterSizes': sizes,
        'localReadyThreshold': LOCAL_READY_N,
        'bigClusters': big,
        'retryStatus': ready,
        'validationMath': 'validationSize = max(1, floor(n × %s)) >= %d ⇔ n >= %d'
                          % (VALIDATION_RATIO, MIN_VALIDATION, LOCAL_READY_N),
        'verdict': 'local-retry-overdue' if ready else 'local-retry-on-schedule',
    }
    with open(LOG, 'a', encoding='utf8') as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    if ready:
        rows = [json.loads(l) for l in open(LEDGER, encoding='utf8') if l.strip()] if os.path.exists(LEDGER) else []
        cid = 'cl-taxonomy-ready-' + datetime.datetime.now(TZ).strftime('%Y%m%d')
        if not any(r.get('id') == cid for r in rows):
            rows.append({
                'id': cid, 'status': 'open', 'ts': rec['ts'],
                'claim': ('局部重建已超过 %d 天未重试(上次: %s) —— 必须重试 rebuild_taxonomy(local) 并把结果'
                          '写入 taxonomy-rebuild.jsonl(簇规模: %s)') % (STALE_DAYS, ready.get('lastLocalAttempt'), sizes),
                'source': 'dsh-taxonomy-boundary-check.py(cron)',
                'reviewBy': (datetime.datetime.now(TZ) + datetime.timedelta(days=2)).strftime('%Y-%m-%d'),
                'disposition': '达标即重试一次 local 重建; 若仍 deferred/拒绝, 记录为"该路径在现数据下仍不可用"并隔 7 天再算',
            })
            with open(LEDGER, 'w', encoding='utf8') as fh:
                fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
            print('已写入提示条目 %s' % cid)
    if '--json' in args:
        print(json.dumps(rec, ensure_ascii=False))
    else:
        print('簇规模: %s | 大簇(>=%d): %s | 重试状态: %s => %s'
              % (sizes, LOCAL_READY_N, big or '无', ready or '按期', rec['verdict']))
    return 2 if ready else 0


if __name__ == '__main__':
    raise SystemExit(main())
