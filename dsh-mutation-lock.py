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
# **带外失败码**(2026-09-14 00:3x): 介入层自己的失败绝不能冒充被包装物的裁决 —— 申报码实测只有 1(43 条)/2(2 条),
# 故取 7 作"包装器基础设施失败"(原用 3, 与探针自身"自身失效"的 3 撞车, 会被记成 probe 漂移)。
OOB_EXIT = 7
OOB_MARK = 'MUTATION_LOCK_FAILED'
# **测量租约**(2026-09-14 00:5x 立): 连续三轮 arms 测量都被我自己的并行实验毒到(T231 clean=3 / T232 mutant=3),
# 因为"测量"与"临时变异"共用同一批文件。租约文件由测量方刷新(带 pid+ts), 变异方发现**新鲜的租约且自己不是测量方**
# (DSH_MEASUREMENT 未置位) 就拒绝 —— 免得我拿被污染的测量当证据。
LEASE_TTL = 300.0


def lease_path() -> str:
    """惰性求值: COG 在本文件里定义在下面那几行, 早绑定会 NameError(第一次实现就这样炸了)。"""
    return os.path.join(COG, '.measurement.lease')


def measurement_in_flight() -> bool:
    try:
        d = json.load(open(lease_path(), encoding='utf8'))
        pid = int(d.get('pid') or 0)
        age = __import__('time').time() - float(d.get('ts') or 0)
        if age > LEASE_TTL:
            return False
        os.kill(pid, 0)               # 进程还在?
        return True
    except Exception:
        return False
COG = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
# 锁目录必须与闸门(dsh-mutant-gate.py)用**同一个注入点**: 闸门早就认 DSH_MUTATION_LOCKS, 而本包装器原来只认 COG
# ⇒ 两条路径指向不同目录时, 「在飞」与「持锁」互相看不见(2026-09-14 01:2x 实测: 包装器在真实目录加锁, 而对照实验
# 在临时目录持锁 ⇒ 包装器照常拿到锁, 带外通道测不出来)。
LOCKDIR = os.environ.get('DSH_MUTATION_LOCKS') or os.path.join(COG, '.mutation-locks')
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
        print('%s 取锁失败(%s) ⇒ 不做任何变异/执行(带外退出码 %d, 不等于命令失败也不要当成探针漂移)'
              % (TAG, exc, OOB_EXIT), file=sys.stderr)
        return None
    return handles


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', nargs='*', default=[])
    ap.add_argument('--probe', default=None)
    ap.add_argument('--timeout', type=float,
                    default=float(os.environ.get('DSH_MUTATION_LOCK_WAIT') or 180.0))
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

    if measurement_in_flight() and not os.environ.get('DSH_MEASUREMENT'):
        print('%s 有测量在进行中(租约 %s) ⇒ 拒绝临时变异(带外码 %d): 免得污染正在采集的证据'
              % (TAG, lease_path(), OOB_EXIT), file=sys.stderr)
        print(OOB_MARK, file=sys.stderr)
        return OOB_EXIT
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
            print(OOB_MARK, file=sys.stderr)
            return OOB_EXIT
        print('%s 已按文件加锁 %d 个: %s' % (TAG, len(targets), ', '.join(os.path.basename(t) for t in targets)),
              file=sys.stderr)

    if args.shell is not None:
        try:
            return subprocess.run(['bash', '-lc', args.shell]).returncode
        except Exception as exc:
            print('%s --shell 执行失败: %s' % (TAG, exc), file=sys.stderr)
            return OOB_EXIT
    cmd = [c for c in args.cmd if c != '--']
    if not cmd:
        return 0
    try:
        return subprocess.run(cmd).returncode
    except FileNotFoundError as exc:
        print('%s 命令不存在: %s' % (TAG, exc), file=sys.stderr)
        return OOB_EXIT


if __name__ == '__main__':
    sys.exit(main())
