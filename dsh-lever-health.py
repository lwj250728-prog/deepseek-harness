#!/usr/bin/env python3
"""注入侧杠杆的健康度（tp-085 / T100；cl-119 的"不留从不生效的机制"）。

今天三个调度杠杆接连被同一个根因卡住或自证惰性：
  · cl-116 回合类型闸门 —— 立项依据来自坏账本(cl-100 修复前), 已默认关闭
  · cl-118/119 经验退避   —— 挡下唯一候选=通道静默, 保活必然放行 => 100% 开火 = 惰性
  · cl-121 新颖性轮换     —— 曾据 n=1 判"结构性受阻", 后被 rotated=True 推翻
每次都是事后查数才发现。本脚本把"杠杆是否真的在起作用"变成常规指标，并对
"已判定惰性"的杠杆打显式标记——**不允许一个从不生效的机制静默留在链路上**。

判据(窗口内)：
  · backoff:  保活开火数 / 有候选被退避挡下的决策数 >= 0.8 且样本 >= 5 => inert
  · rotation: 决策数 >= 5 且 rotated 从未为真 => inert
  · gate:     配置关闭 => disabled(不算 inert, 但要显式)

用法：dsh-lever-health.py [--hours 24] [--quiet]
退出码：0 = 已出数；1 = 审计缺失。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
AUDIT = os.path.join(DIR, 'retrieval-audit.jsonl')
OUT = os.path.join(DIR, 'lever-health.json')
INERT_THRESHOLD = 0.8
MIN_SAMPLE = 5


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--hours', type=float, default=24.0)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    if not os.path.exists(AUDIT):
        print('缺 retrieval-audit.jsonl: 无法判定杠杆健康度', file=sys.stderr)
        return 1
    cutoff = (time.time() - args.hours * 3600) * 1000
    rows = []
    for line in open(AUDIT, encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if (record.get('t') or 0) > cutoff:
            rows.append(record)

    decisions = len(rows)
    blocked = [r for r in rows if (r.get('backoffDropped') or 0) > 0]
    admitted = [r for r in blocked if r.get('backoffAdmitted') is not None]
    rotated = [r for r in rows if r.get('rotated') is True]
    injected = [r for r in rows if r.get('stage') == 'injected']
    distinct = {e for r in injected for e in (r.get('expIds') or [])}

    keepalive_rate = (len(admitted) / len(blocked)) if blocked else None
    backoff_inert = (keepalive_rate is not None and keepalive_rate >= INERT_THRESHOLD
                     and len(blocked) >= MIN_SAMPLE)
    rotation_inert = decisions >= MIN_SAMPLE and len(rotated) == 0

    payload = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'generatedAtLocal': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'windowHours': args.hours,
        'decisions': decisions,
        'injected': len(injected),
        'distinctExperiencesInjected': len(distinct),
        'levers': {
            'backoff': {
                'blockedDecisions': len(blocked),
                'keepaliveAdmitted': len(admitted),
                'keepaliveRate': None if keepalive_rate is None else round(keepalive_rate, 3),
                'inert': backoff_inert,
                'note': '保活开火率 >=80% 即判定退避惰性(挡下即放行, 等于没削体积)',
            },
            'rotation': {
                'fired': len(rotated),
                'inert': rotation_inert,
                'note': '决策 >=5 却从未轮换 => 惰性(候选供给不足或机制失效)',
            },
            'turnGate': {
                'enabled': False,
                'note': '默认关闭(cl-116: 立项依据来自 cl-100 修复前的坏账本); 重新启用需干净样本',
            },
        },
        'inertLevers': [name for name, info in {
            'backoff': backoff_inert, 'rotation': rotation_inert,
        }.items() if info],
    }
    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    if not args.quiet:
        print('窗口 %.0fh: 决策 %d, 注入 %d, 不同经验 %d'
              % (args.hours, decisions, len(injected), len(distinct)))
        print('  backoff  挡下 %d 次, 保活放行 %d 次 (%s) => %s'
              % (len(blocked), len(admitted),
                 'n/a' if keepalive_rate is None else '%.0f%%' % (keepalive_rate * 100),
                 '惰性' if backoff_inert else '正常/样本不足'))
        print('  rotation 开火 %d 次 => %s' % (len(rotated), '惰性' if rotation_inert else '正常/样本不足'))
        if payload['inertLevers']:
            print('  惰性杠杆(必须显式处置): %s' % payload['inertLevers'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
