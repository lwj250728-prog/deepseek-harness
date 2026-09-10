#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""账本状态单一入口(tp-117 / cl-187): **默认去重**, 消除"随手按行数"的口径错。

起因(2026-09-11 03:1x): 我随手核对言行账本时报"未关单 137", 而按 last-wins 去重后是 **58** ——
套件里早已为这个坑建了守卫(T33/last-wins 断言), 但**我自己的快速核对没有走那套判据**。
结论: 把纪律变成**工具默认值**——凡"看一眼账本", 只用一个入口, 且它内部强制去重。

用法: dsh-ledger-status.py [--json]
退出码: 0。
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
TERMINAL = {'done', 'retired', 'closed'}


def dedup(path: str, key: str = 'id') -> dict:
    """追加式账本读取的**唯一正确方式**: 同 key 多行时后者覆盖前者(cl-041)。"""
    out: dict = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding='utf8'):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if isinstance(rec.get(key), str):
            out[rec[key]] = rec            # last-wins
    return out


def main() -> int:
    args = sys.argv[1:]
    claims = dedup(os.path.join(D, 'claims-ledger.jsonl'))
    tests = dedup(os.path.join(D, 'test-pending.jsonl'))
    open_claims = {k: v for k, v in claims.items() if v.get('status') not in TERMINAL}
    payload = {
        'claims': {'lines': sum(1 for l in open(os.path.join(D, 'claims-ledger.jsonl'), encoding='utf8') if l.strip()),
                   'unique': len(claims),
                   'byStatus': dict(Counter(v.get('status') for v in claims.values())),
                   'openCount': len(open_claims), 'openIds': sorted(open_claims)[:10]},
        'tests': {'unique': len(tests),
                  'byStatus': dict(Counter(v.get('status') for v in tests.values()))},
        'note': '本工具默认 last-wins 去重; 任何"按行数"的账本计数都是错的(cl-041/cl-187)',
    }
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        c = payload['claims']
        print('言行账本: %d 行 / 唯一 %d / **未关单 %d**' % (c['lines'], c['unique'], c['openCount']))
        print('  状态分布:', c['byStatus'])
        print('测试账本: 唯一 %d | 状态分布: %s' % (payload['tests']['unique'], payload['tests']['byStatus']))
        print('  注: 按行数统计未关单会得到 %d(错), 已强制去重' % c['lines'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
