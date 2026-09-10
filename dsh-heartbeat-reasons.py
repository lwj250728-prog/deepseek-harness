#!/usr/bin/env python3
"""心跳理由集合的同步检查（cl-117 / T94 附属）。

quiet-driver 每 tick 落一条心跳，reason 取值必须与代码里的 beat() 调用点保持同步。
加了新心跳理由却忘登记，断言会在"重启后 20 分钟"才开火（T59 的 guard），于是能藏
好几个小时——本次实测：model-* 系列从 09:40 就在写，直到 11:20 guard 过期才暴露。

本脚本双向检查：
  · 账本里出现了代码未声明的 reason → 红（未知理由）
  · 代码声明了但从未出现的 reason → 只报不红（可见的空过）

用法：dsh-heartbeat-reasons.py
退出码：0 = 全在已知集合内；1 = 出现未知理由。
"""
from __future__ import annotations

import json
import os
import re
import sys

HB = os.path.expanduser('~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl')
SRC = os.path.expanduser('~/dsh-fork/packages/context/quiet-driver/src/index.ts')
# 与代码 beat() 调用点同步的显式白名单；新增理由时必须登记（否则本检查会红）。
KNOWN = {
    'tick', 'silent-skip', 'agent-not-live', 'agent-resumed', 'agent-resume-failed',
    'busy', 'user-active', 'model-unavailable', 'model-ok', 'model-check-unknown',
    'dispatch-unconsumed', 'dispatch-suspended',
}


def main() -> int:
    if not os.path.exists(HB):
        print('心跳文件缺失', file=sys.stderr)
        return 1
    rows = [json.loads(line) for line in open(HB, encoding='utf8') if line.strip()]
    seen = {row.get('reason') for row in rows}
    unknown = sorted(reason for reason in seen if reason not in KNOWN)
    declared: set[str] = set()
    if os.path.exists(SRC):
        code = open(SRC, encoding='utf8').read()
        declared = set(re.findall(r"beat\('([a-z-]+)'", code))
    print('心跳理由: 白名单 %d, 账本出现 %d, 代码声明 %d'
          % (len(KNOWN), len(seen), len(declared)))
    print('  代码声明但从未出现: %s' % sorted(declared - seen))
    print('  白名单有但代码没有: %s' % sorted(KNOWN - declared - seen))
    if unknown:
        print('红: 未知心跳理由(未登记): %s' % unknown, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
