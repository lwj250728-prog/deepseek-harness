#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-mutation-lock.py — 按**文件**(不是按机制)互斥的变异锁(cl-322)。

为什么必须按文件: 2026-09-13 夜里实测 —— arms 检查持着**共享**变异锁跑 T231 的探针, 而 T231 的判据体
(`dsh-degeneracy-check.py`)**也**要拿那把锁 ⇒ 退化成"等锁超时 ⇒ exit 3" ⇒ T231 干净臂红 ⇒ T222 判红。
根因不是"谁忘了解锁", 而是**锁的粒度选错了**: 两个机制明明改的是**不同文件**(arms 的 T231 探针改
`dsh-degeneracy-check.py`; 退化检查改 `dsh-stage-summary.py`/`dsh-probe-binding.py`/...), 却被一把全局锁串起来。
按文件上锁后, 只有**真的改同一个文件**时才互斥 —— 那才是应该互斥的全部情形。

用法:
  dsh-mutation-lock.py --files A.py B.py -- <命令...>     # 先锁 A/B, 再执行命令(退出码原样透传)
  dsh-mutation-lock.py --probe /path/probe.sh -- <命令...> # 从探针脚本解析它改哪些文件(仓库内已存在的绝对路径)
  dsh-mutation-lock.py --show                             # 打印它会用到的锁目录与已有锁
  退出码: 命令自身的退出码; 3 = 取锁失败(超时/异常), **不等于命令失败**。

约定: 多文件按**排序后**逐个获取(避免两个进程互相持有对方需要的锁而死锁); 等锁默认 180s(SIGALRM 超时 ⇒ exit 3)。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys

TAG = '[mutation-lock]'
COG = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
LOCKDIR = os.path.join(COG, '.mutation-locks')
# 探针脚本里**已存在**的绝对路径 = 它可能改的目标(与 dsh-probe-binding.py 同一套解析: 它错不了就一起错)
PATHISH = re.compile(r'["\']((?:/|\$HOME/)[^"\'`\n]*?)["\']')


def probe_targets(probe: str) -> list:
    try:
        text = open(probe, encoding='utf8').read()
    except Exception:
        return []
    out = []
    for raw in PATHISH.findall(text):
        p = raw.replace('$HOME', os.path.expanduser('~'))
        if not p.startswith('/') or not os.path.exists(p):
            continue
        if p.endswith(('.py', '.sh', '.ts', '.mts')) and p not in out and p != probe:
            out.append(p)
    return out


def lock_path(path: str) -> str:
    return os.path.join(LOCKDIR, hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:16] + '.lock')


def acquire(paths: list, timeout: float):
    """按排序逐个取 EX 锁; 返回已开句柄列表(进程退出自动释放)。"""
    import fcntl
    os.makedirs(LOCKDIR, exist_ok=True)

    def _on_alarm(_s, _f):
        raise TimeoutError('等锁超时')

    signal.signal(signal.SIGALRM, _on_alarm)
    handles = []
    try:
        for p in sorted(set(paths)):
            fh = open(lock_path(p), 'w')
            signal.alarm(int(timeout))
            try:
                fcntl.flock(fh, fcntl.LOCK_EX)
            finally:
                signal.alarm(0)
            fh.write(json.dumps({'path': os.path.abspath(p), 'pid': os.getpid()}) + '\n')
            fh.flush()
            handles.append(fh)
    except (TimeoutError, OSError) as exc:
        print('%s 取锁失败(%s) ⇒ 不做任何变异/执行(exit 3, 不等于命令失败)' % (TAG, exc), file=sys.stderr)
        return None
    return handles


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='*', default=[])
    ap.add_argument('--probe', default=None)
    ap.add_argument('--timeout', type=float, default=180.0)
    ap.add_argument('--show', action='store_true')
    # `--shell <整串>`: 用 `bash -lc` 执行**一个** argv —— 修复实测到的回归(2026-09-14 00:1x):
    # 早先的 REMAINDER 形态要求调用方把命令当 argv 传, 但 arms 检查是把**包装后的整串**交给 `bash -lc` 的,
    # 于是 `cd X && rm -rf ... && ...` 里的 `&&` 被外层 shell 吃掉, 包装器只拿到 `... -- cd /home/...` 这段前缀,
    # 而 `cd` 是内建、在子进程里不存在 ⇒ 返回 3 ⇒ T118 被误报成 mutant-mismatch(3/3)。⇒ 必须由包装器自己解释整串。
    ap.add_argument('--shell', default=None)
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    args = ap.parse_args()

    if args.show:
        print('锁目录: %s' % LOCKDIR)
        if os.path.isdir(LOCKDIR):
            for n in sorted(os.listdir(LOCKDIR)):
                print('  %s' % n)
        return 0

    targets = list(args.files or [])
    if args.probe:
        found = probe_targets(args.probe)
        if not found:
            print('%s 从探针解析不出任何目标文件: %s ⇒ 退化为"不锁"(风险高于拦住, 只在探针不写源码时正确)'
                  % (TAG, args.probe), file=sys.stderr)
        targets += found
    targets = [t for t in targets if t and os.path.exists(t)]
    if targets:
        handles = acquire(targets, args.timeout)
        if handles is None:
            return 3
        print('%s 已按文件加锁 %d 个: %s' % (TAG, len(targets), ', '.join(os.path.basename(t) for t in targets)),
              file=sys.stderr)

    if args.shell is not None:
        try:
            return subprocess.run(['bash', '-lc', args.shell]).returncode
        except Exception as exc:
            print('%s --shell 执行失败: %s' % (TAG, exc), file=sys.stderr)
            return 3
    cmd = [c for c in args.cmd if c != '--']
    if not cmd:
        return 0
    try:
        return subprocess.run(cmd).returncode
    except FileNotFoundError as exc:
        print('%s 命令不存在: %s' % (TAG, exc), file=sys.stderr)
        return 3


if __name__ == '__main__':
    sys.exit(main())
