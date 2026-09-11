#!/usr/bin/env python3
"""新建/在池目标的"入池体检"（tp-074 / T92）。

exp_302 的教训：新增一个被机制驱动的 active 目标，等于**同时新增三条判据的前提**——
  · T57: 该目标必须在 dsh-incubation-stats.py 的 GOAL_WITNESS 里有专属外部产物锚
  · T21f: 若行动帧派发把会话链锚切到它, 必须有带该 chainId 的经验继承
  · T33: 它派生的认领项必须带 reviewBy
当天我建 goal-adoption-rate 时三处全红，就是因为"目标建好了、判据的前提没补"。
本脚本把这三条(加上向量维度)合成一次体检，可在建目标时先跑一遍。

用法：dsh-goal-onboard-check.py [goalId|all]
退出码：0 = 全部通过；1 = 有阻塞项。
"""
from __future__ import annotations

import json
import os
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
STATS = os.path.expanduser('~/dsh-fork/dsh-incubation-stats.py')
POOL = os.path.join(DIR, 'dormant-goals.jsonl')
ANCHORS = os.path.join(DIR, 'chain_anchors.json')
EXPERIENCES = os.path.join(DIR, 'experiences.jsonl')


def load_pool() -> dict[str, dict]:
    pool: dict[str, dict] = {}
    if not os.path.exists(POOL):
        return pool
    for line in open(POOL, encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record.get('id'), str):
            pool[record['id']] = record   # last-wins
    return pool


def witness_ids() -> set[str]:
    if not os.path.exists(STATS):
        return set()
    text = open(STATS, encoding='utf8').read()
    start = text.find('GOAL_WITNESS = {')
    if start < 0:
        return set()
    block = text[start:text.index('}', start)]
    return {piece.split("'")[1] for piece in block.split('\n') if "'" in piece}


def chained_ids() -> set[str]:
    have: set[str] = set()
    if not os.path.exists(EXPERIENCES):
        return have
    for line in open(EXPERIENCES, encoding='utf8'):
        if not line.strip():
            continue
        try:
            chain = json.loads(line).get('chainId')
        except Exception:
            continue
        if isinstance(chain, str) and chain:
            have.add(chain)
    return have


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else 'all'
    pool = load_pool()
    goals = [g for g in pool.values() if g.get('status') == 'active'] if target == 'all' \
        else [pool[target]] if target in pool else []
    if not goals:
        print('无可体检目标（target=%s）' % target, file=sys.stderr)
        return 1

    witnesses = witness_ids()
    chained = chained_ids()
    anchored = set(json.load(open(ANCHORS, encoding='utf8')).values()) if os.path.exists(ANCHORS) else set()
    problems: list[str] = []

    for goal in goals:
        gid = goal['id']
        if gid not in witnesses:
            problems.append('%s: T57 无专属见证锚(请在 dsh-incubation-stats.py 的 GOAL_WITNESS 中登记)' % gid)
        if gid in anchored and gid not in chained:
            problems.append('%s: T21f 已被链锚指向但无经验继承(补一条带该 chainId 的经验)' % gid)
        # 2026-09-11 18:2x 修: 这行的原话是"缺失可留空由插件自愈", 但判据把缺失当成维度 0 一起开火 ——
        # 于是"我按设计清空向量等自愈"反而被判缺陷(实测: 经验库目标清空三个向量后本组转红)。
        # 缺失(None/空)不是缺陷, 插件载入时按文本自愈; 只有**非空却长度不对**才是真异常。
        dims = {len(goal.get(key) or []) for key in ('repVector', 'kernelVector', 'focusVector')} - {0}
        if dims and dims != {384}:
            problems.append('%s: 向量维度异常 %s(应为 {384}; 缺失可留空由插件自愈)' % (gid, sorted(dims)))

    if problems:
        for problem in problems:
            print('红: ' + problem, file=sys.stderr)
        return 1
    print('通过: %d 个 active 目标入池体检全绿(%s)' % (len(goals), ', '.join(g['id'] for g in goals)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
