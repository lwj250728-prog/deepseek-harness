#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-audit-coverage-check.py — 审计字段必须落在**审计 payload 的顶层**(T212 的判据, cl-278 实测所得)

为什么需要这个工具(而不是一句 `"retrievalIds" in src[start:start+1400]`):
  2026-09-12 我给 cognitive-inject 的 5 处审计点补 `retrievedIds`, 结果**两次**把 `...retrievalIds`
  插进了 `candidateScores: cooled.map(hit => ({...}))` 这种**嵌套对象**里 —— 而我的自查是"在附近 1400 字符内
  能否搜到该字符串", 于是**误判为已接**; tsc 也不报错(嵌套对象多一个字段类型合法); 产物 grep 同样命中。
  真正抓住它的是**活着的行为检查**(重启后 15:22 那条 path='raw' 的行没有字段)。
  ⇒ 判据必须"看层级", 不能"看附近": 本工具用括号配对取出 audit({...}) 的**顶层**片段, 只在那里找字段。

用法: dsh-audit-coverage-check.py [--src P] [--field retrievedIds] [--json]
退出码: 0 = 每个审计点的顶层都带该字段; 1 = 有审计点缺(或只出现在嵌套里); 3 = 读不到源码。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_SRC = os.environ.get('DSH_INJECT_SRC') or os.path.expanduser('~/dsh-fork/packages/context/cognitive-inject/src/index.ts')


def top_level_text(src: str, start: int) -> str:
    """从 `audit({` 的 `{` 之后开始, 按括号配对取出该调用的**顶层**字符(跳过嵌套)。"""
    i = src.find('{', start)
    if i < 0:
        return ''
    depth = 0
    out = []
    while i < len(src):
        ch = src[i]
        if ch in '{[(':
            depth += 1
            if depth == 1:
                i += 1
                continue
        elif ch in '}])':
            depth -= 1
            if depth == 0:
                break
        if depth == 1:
            out.append(ch)
        i += 1
    return ''.join(out)


# retrieve() 之前就返回的审计点: 该回合根本没有候选, 无处可记(retrievalIds 不在作用域内)。
# 只豁免**显式列名且 payload 是光秃秃的 stage** 的那一处 —— 将来它若带上别的字段, 就仍会被检查。
EXEMPT_STAGES = {"skipped-reflective-frame": "在 retrieve() 之前返回(该回合无候选)"}


def offenders(src: str, field: str):
    bad = []
    pos = 0
    while True:
        pos = src.find('audit({', pos)
        if pos < 0:
            break
        head = src[pos:pos + 80]
        top = top_level_text(src, pos)
        trivial = top.strip().rstrip(',').strip()
        exempt = next((k for k in EXEMPT_STAGES if ("stage: '" + k + "'") in head), None)
        if exempt and trivial.startswith("stage:"):
            pos += 1
            continue
        if ('...' + field) not in top:
            bad.append(head.split('\n')[0][:70])
        pos += 1
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--field', default='retrievalIds')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    try:
        src = open(args.src, encoding='utf8').read()
    except Exception as exc:  # noqa: BLE001
        print('[audit-coverage] 读不到源码: %s' % exc, file=sys.stderr)
        return 3
    total = src.count('audit({')
    if total == 0:
        print('[audit-coverage] 源码里没有任何 audit({ 调用 —— 判据前提不成立', file=sys.stderr)
        return 3
    bad = offenders(src, args.field)
    if args.json:
        print(json.dumps({'sites': total, 'missing': bad}, ensure_ascii=False))
    if bad:
        print('红: 这些审计点的**顶层**没有 ...%s(注意: 插进嵌套对象里不算接上, 类型检查与产物 grep 都抓不到): %s'
              % (args.field, bad), file=sys.stderr)
        return 1
    print('[audit-coverage] %d 个审计点的顶层都带 ...%s' % (total, args.field))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
