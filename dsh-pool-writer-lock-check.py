#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-pool-writer-lock-check.py — 池的**写入面**清点: 凡以写模式打开目标池的脚本, 必须持同一把锁(cl-321)。

由来(实测 2026-09-13 23:1x): tp-197 的互斥修法只覆盖了"我改过的那两个"写者, 而强匹配(写模式 open 指向池)
实测池有 **3 个**写者 —— 第三个 `dsh-fix-adoption-count.py` 是全量重写('w')且**一个守卫都没有**,
文档字符串还自称"读-改-写之间不留窗口"(又一个"声明未被消费")。互斥的覆盖面必须**按写入面清点**, 不能按印象假定。

本检查两条:
  ① **静态**: 扫 `dsh-*` 脚本, 找出所有"写模式 open 指向池路径"的文件; 同一文件里必须出现 `<pool>.lock` 的持锁证据,
     否则判红(新的写者漏锁会被当场抓到, 而不是等我下次想起来清点);
  ② **行为**: 对登记了安全读模式的写者, 持锁期间跑它一次 ⇒ 必须**等锁**(耗时超过阈值); 不等锁 ⇒ 判红
     (静态发现"提到了锁"不等于真的持锁 —— 这正是今天反复出现的"声明 vs 行为"之分)。

用法:
  dsh-pool-writer-lock-check.py --check [--json] [--skip-behaviour]
  exit 0 = 全绿 / 1 = 有红 / 3 = 前提不成立(找不到池/无写者)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

TAG = '[pool-writers]'
REPO = os.path.expanduser('~/dsh-fork')
POOL = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')
LOCK_HINT = '.lock'

# 行为验证登记: 只有"有安全只读模式"的写者才能被这样测(否则会改真实池)。它们是**声明**, 每条写理由。
BEHAVIOUR = [
    {'script': 'dsh-fix-adoption-count.py', 'safe_args': ['--dry-run'],
     'why': '支持 --dry-run(只读重算), 持锁期间必须等; 不需要写真实池'},
]

OPEN_RE = re.compile(r'open\(\s*([^)]*?)\s*\)', re.S)


def python_writers(repo: str = REPO) -> list:
    """返回 [(脚本, 证据行)]: 以写模式 open 池路径的脚本。"""
    out = []
    for name in sorted(os.listdir(repo)):
        if not name.endswith('.py') or not name.startswith('dsh-'):
            continue
        path = os.path.join(repo, name)
        try:
            src = open(path, encoding='utf8').read()
        except Exception:
            continue
        if 'dormant-goals' not in src:
            continue
        for m in OPEN_RE.finditer(src):
            args = m.group(1)
            if not re.search(r'["\'](a|w|a\+|w\+)["\']', args):
                continue
            if not re.search(r'pool|POOL', args):
                continue
            line = src[:m.start()].count('\n') + 1
            out.append({'script': name, 'line': line, 'call': ' '.join(args.split())[:70]})
    return out


def lock_mode(path: str) -> str:
    """返回该文件请求的锁模式: ex / shared / none(或 flock-但模式不明)。

    **互斥必须是 LOCK_EX**: 只"提到 flock"不算 —— `LOCK_SH` 允许两个写者同时进入, 那时静态绿而互斥早已失效。
    (这正是 tp-202 的退化解 A: 把 LOCK_EX 改成 LOCK_SH。)
    """
    try:
        src = open(path, encoding='utf8').read()
    except Exception:
        return 'none'
    if 'flock' not in src:
        return 'none'
    if 'LOCK_EX' in src:
        return 'ex'
    if 'LOCK_SH' in src:
        return 'shared'
    return 'flock-unknown'


def behaviour(entry: dict, pool: str = POOL, repo: str = REPO,
              lock_hold: float = 3.0, threshold: float = 1.5) -> dict:
    """持有 `<pool>.lock` 期间跑该脚本的安全模式 ⇒ 必须等锁。"""
    path = os.path.join(repo, entry['script'])
    holder = subprocess.Popen([sys.executable, '-c',
                               'import fcntl,time,sys\n'
                               'fh=open(sys.argv[1],"w")\n'
                               'fcntl.flock(fh,fcntl.LOCK_EX)\n'
                               'time.sleep(float(sys.argv[2]))\n', POOL + '.lock', str(lock_hold)])
    time.sleep(0.5)
    t0 = time.time()
    r = subprocess.run([sys.executable, path] + entry['safe_args'], capture_output=True, text=True, timeout=300)
    waited = time.time() - t0
    holder.wait(timeout=60)
    return {'script': entry['script'], 'waited': round(waited, 2), 'rc': r.returncode,
            'waited_enough': waited >= threshold, 'tail': (r.stdout or r.stderr).strip().splitlines()[-1][:100]
            if (r.stdout or r.stderr).strip() else ''}


def check(args) -> int:
    pool = args.pool or POOL
    repo = args.repo or REPO
    if not os.path.exists(pool):
        print('%s 找不到目标池: %s ⇒ 前提不成立' % (TAG, pool), file=sys.stderr)
        return 3
    writers = python_writers(repo)
    if not writers:
        print('%s 一个写者都没扫到 ⇒ 前提不成立(扫法坏了?)' % TAG, file=sys.stderr)
        return 3
    reds, ok = [], []
    seen = set()
    for w in writers:
        key = w['script']
        if key in seen:
            continue
        seen.add(key)
        mode = lock_mode(os.path.join(repo, key))
        good = mode == 'ex'
        (ok if good else reds).append({
            'script': key, 'line': w['line'], 'call': w['call'], 'mode': mode,
            'why': None if good else (
                '以写模式打开池, 但没有持**独占**锁(模式=%s) ⇒ 互斥不成立(只提到 flock 不算)' % mode)})
    results = []
    if not args.skip_behaviour:
        for entry in BEHAVIOUR:
            if entry['script'] not in seen:
                reds.append({'script': entry['script'], 'why': '行为登记指向的脚本已不是写者(登记腐烂)'})
                continue
            try:
                res = behaviour(entry, pool=pool, repo=repo)
            except Exception as exc:
                reds.append({'script': entry['script'], 'why': '行为验证跑不起来: %s' % exc})
                continue
            results.append(res)
            if not res['waited_enough']:
                reds.append({'script': entry['script'],
                             'why': '持锁期间只用了 %.2fs ⇒ 它**没有等锁**(静态提到锁 != 真持锁)' % res['waited']})
    for w in ok:
        print('%s ✓ %s(第 %d 行) 持锁' % (TAG, w['script'], w['line']), file=sys.stderr)
    for r in results:
        print('%s %s 行为: 等锁 %.2fs(rc=%s) %s' % (TAG, r['script'], r['waited'], r['rc'], r['tail']),
              file=sys.stderr)
    for r in reds:
        print('%s **判红** %s: %s' % (TAG, r['script'], r['why']), file=sys.stderr)
    print('%s 池写者 %d 个: 持锁 %d / 判红 %d' % (TAG, len(seen), len(ok), len(reds)), file=sys.stderr)
    if args.json:
        print(json.dumps({'writers': sorted(seen), 'locked': [w['script'] for w in ok],
                          'behaviour': results, 'red': reds}, ensure_ascii=False))
    return 1 if reds else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--skip-behaviour', dest='skip_behaviour', action='store_true')
    ap.add_argument('--pool', default=None)
    ap.add_argument('--repo', default=None)
    args = ap.parse_args()
    if not args.check:
        ap.error('需要 --check')
    return check(args)


if __name__ == '__main__':
    sys.exit(main())
