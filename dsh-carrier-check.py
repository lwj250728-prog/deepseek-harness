#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""载体与活体源核对(tp-094 / T114)。

起点是一个真实的漏检: 09-10 17:48 的三问帧 Q1 只核了 PID 与模型名(状态证据), 没读
心跳账本与供应商目录(活体源), 于是 17:47:55 首次上报的 `model-unavailable` 在 1 分钟
之内的核对里被漏掉 —— cl-014 伪饱足的当场复现, 也是 exp_254"状态证据会随合法变化误报,
判据须用效果证据"的应验。PID 不变 ≠ 载体健康: 模型被下架时 PID 照样是那个 PID。

本脚本把"环境核对"从看名字改成读活体源三件:
  · 进程: PID / 启动时间 / 存活时长
  · 心跳: quiet-driver-heartbeat.jsonl 里最近 3 条 model-* 记录(效果证据)
  · 目录: model-catalog.json 的 verdict / catalog / 在用项与 profile 默认是否在册

降级判据(任一成立即降级, 退出码 2, 并打印"不得声称环境无变化"):
  · 最新 model-* 心跳为 model-unavailable
  · catalog verdict 含 missing(在用项或默认项不在册)
退出码: 0 = 活体源正常; 2 = 降级; 1 = 读不到活体源(缺证据本身也是失败, 不出数)。

用法: dsh-carrier-check.py [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
HEARTBEAT = os.path.join(DIR, 'quiet-driver-heartbeat.jsonl')
CATALOG = os.path.join(DIR, 'model-catalog.json')


def read_jsonl_tail(path: str, limit: int) -> list[dict]:
    rows: list[dict] = []
    with open(path, encoding='utf8') as handle:
        for line in handle:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    return rows[-limit:]


def process_facts() -> dict:
    facts: dict = {'pid': os.getpid()}
    try:
        out = subprocess.run(['pgrep', '-f', 'bin.js web'], capture_output=True, text=True, timeout=20)
        pids = [p for p in out.stdout.split() if p.strip()]
        facts['servicePids'] = pids
        if pids:
            stat = subprocess.run(['ps', '-o', 'lstart=', '-p', pids[0]], capture_output=True,
                                  text=True, timeout=20).stdout.strip()
            facts['serviceStartedAt'] = stat
            et = subprocess.run(['ps', '-o', 'etimes=', '-p', pids[0]], capture_output=True,
                                text=True, timeout=20).stdout.strip()
            facts['serviceUptimeSec'] = int(et) if et.isdigit() else None
    except Exception as exc:                                  # pragma: no cover
        facts['serviceError'] = str(exc)[:120]
    return facts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    if not os.path.exists(HEARTBEAT):
        print('缺活体源: 心跳账本不存在(%s) —— 无证据不得判"环境无变化"' % HEARTBEAT, file=sys.stderr)
        return 1
    if not os.path.exists(CATALOG):
        print('缺活体源: 供应商目录快照不存在(%s)' % CATALOG, file=sys.stderr)
        return 1

    beats = read_jsonl_tail(HEARTBEAT, 400)
    model_beats = [b for b in beats if str(b.get('reason', '')).startswith('model-')]
    last_model = model_beats[-1] if model_beats else None
    catalog = json.load(open(CATALOG, encoding='utf8'))
    verdict = str(catalog.get('verdict') or '')

    degraded: list[str] = []
    if last_model and last_model.get('reason') == 'model-unavailable':
        degraded.append('最新 model-* 心跳为 model-unavailable(%s, %s)'
                        % (last_model.get('model'), last_model.get('source')))
    if 'missing' in verdict:
        degraded.append('目录判定 verdict=%s(在用 %s / profile 默认 %s)'
                        % (verdict, catalog.get('modelInUse'), catalog.get('profileDefault')))
    if not model_beats:
        degraded.append('心跳账本内无任何 model-* 记录(活体源从未体检)')

    payload = {
        'process': process_facts(),
        'lastModelBeats': [
            {'ts': b.get('ts'), 'reason': b.get('reason'), 'model': b.get('model'), 'source': b.get('source')}
            for b in model_beats[-3:]
        ],
        'catalog': {'verdict': verdict, 'catalog': catalog.get('catalog'),
                    'modelInUse': catalog.get('modelInUse'),
                    'profileDefault': catalog.get('profileDefault'),
                    'checkedAtLocal': catalog.get('checkedAtLocal')},
        'degraded': degraded,
        'verdict': 'degraded' if degraded else 'ok',
        'note': ('PID 不变不代表载体健康: 模型被下架时 PID 照样不变。'
                 '环境核对必须读活体源(心跳/目录), 只看名字属状态证据(cl-014 伪饱足)。'),
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        proc = payload['process']
        print('进程: PID %s 启动 %s 存活 %ss'
              % (','.join(proc.get('servicePids') or []) or proc.get('pid'),
                 proc.get('serviceStartedAt'), proc.get('serviceUptimeSec')))
        print('最近 model-* 心跳: %s'
              % ' | '.join('%s %s' % (b['reason'], (b['model'] or '')[:28]) for b in payload['lastModelBeats']))
        print('目录: %s | catalog=%s | 在用=%s | 默认=%s'
              % (verdict, catalog.get('catalog'), catalog.get('modelInUse'), catalog.get('profileDefault')))
        if degraded:
            print('判定: 降级 —— 不得声称环境无变化')
            for item in degraded:
                print('  · %s' % item)
        else:
            print('判定: 活体源正常')
    return 2 if degraded else 0


if __name__ == '__main__':
    raise SystemExit(main())
