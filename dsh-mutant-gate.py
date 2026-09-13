#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-mutant-gate.py — 变异体泄漏闸门(cl-316, 2026-09-13 立)。

风险(cl-316 实证): 我的两套验证机制(14 条双臂探针 + T231 的 `dsh-degeneracy-check.py`)**都会临时改写受版本控制的源码**,
把 `MUTANT` 标记写进目标文件, 靠 finally 复原。而:
  · 仓库里**没有**任何"不得提交变异体"的闸门(`grep MUTANT` 在钩子/部署脚本里零命中);
  · 另一会话握着 604 个删除, 随时可能 `git add -A && commit`;
  ⇒ 一次变异窗口撞上提交, 变异体就会被当代码提交并部署, **而产物看上去完全正常**(这正是今天反复出现的"静默"家族)。

本闸门: 已跟踪文件里含 `MUTANT` 标记的, 必须落在**登记过的合法容器**里(探针脚本 = 变异的**定义**; 见证脚本 = 它自带
MUTANT_OLD/NEW 常量), 否则判泄漏。合法容器写在 `mutant-gate-allow.json`(可增, 每条要写理由), **不是硬编码** ——
所以"清单被消费"本身是可观测的: 清单若空/读不到, 10 条探针脚本会当场被报成泄漏(而不是静默放过)。

用法:
  dsh-mutant-gate.py --check            # 扫工作区已跟踪文件
  dsh-mutant-gate.py --check --staged   # 只扫**暂存**内容(给提交前用)
  exit 0 = 无泄漏 / 1 = 有泄漏 / 3 = 前提不成立(非 git 仓库 / 清单读不到)
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys

TAG = '[mutant-gate]'
MARK = 'MUTANT'
REPO = os.path.expanduser('~/dsh-fork')
# 自带说明: 判定阈值不硬编码, 但清单文件缺失时**不得静默放行** ⇒ 见 check() 的 exit 3。
DEFAULT_ALLOW = os.path.expanduser('~/.dsh/cognitive-pipeline/mutant-gate-allow.json')


def git(*args, repo=REPO) -> tuple[int, str]:
    try:
        r = subprocess.run(['git', '-C', repo] + list(args), capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout
    except Exception as exc:
        return 1, str(exc)


def load_allow(path: str):
    try:
        with open(path, encoding='utf8') as fh:
            d = json.load(fh)
    except Exception:
        return None
    return [str(x.get('glob')) for x in (d.get('containers') or []) if x.get('glob')]


def allowed(path: str, globs: list) -> str | None:
    base = os.path.basename(path)
    for g in globs:
        if fnmatch.fnmatch(base, g) or fnmatch.fnmatch(path, g):
            return g
    return None


def is_binary(data: bytes) -> bool:
    return b'\0' in data[:4096]


def scan(repo: str, globs: list, staged: bool) -> tuple[list, int]:
    if staged:
        rc, out = git('diff', '--cached', '--name-only', '-z', repo=repo)
        names = [n for n in out.split('\0') if n]
        reader = lambda p: subprocess.run(['git', '-C', repo, 'show', ':' + p],
                                          capture_output=True, timeout=120).stdout  # noqa: E731
    else:
        rc, out = git('ls-files', '-z', repo=repo)
        names = [n for n in out.split('\0') if n]
        reader = lambda p: open(os.path.join(repo, p), 'rb').read()  # noqa: E731
    leaks, scanned = [], 0
    for p in names:
        try:
            data = reader(p)
        except Exception:
            continue
        if is_binary(data):
            continue
        scanned += 1
        if MARK in data.decode('utf8', 'ignore'):
            container = allowed(p, globs)
            if container is None:
                leaks.append({'file': p, 'why': '含 %s 标记但不在合法容器清单里 ⇒ 疑似变异体泄漏' % MARK})
    return leaks, scanned


def check(args) -> int:
    rc, _ = git('rev-parse', '--git-dir', repo=args.repo)
    if rc != 0:
        print('%s 不是 git 仓库: %s ⇒ 前提不成立' % (TAG, args.repo), file=sys.stderr)
        return 3
    allow_path = args.allow or DEFAULT_ALLOW
    globs = load_allow(allow_path)
    if globs is None:
        print('%s 读不到合法容器清单: %s ⇒ 前提不成立(不得静默放行)' % (TAG, allow_path), file=sys.stderr)
        return 3
    leaks, scanned = scan(args.repo, globs, args.staged)
    if leaks:
        for x in leaks:
            print('%s **泄漏** %s: %s' % (TAG, x['file'], x['why']), file=sys.stderr)
    print('%s 扫了 %d 个%s文件, 合法容器 %d 条(pattern), 泄漏 %d 条%s'
          % (TAG, scanned, '暂存' if args.staged else '已跟踪', len(globs), len(leaks),
             '' if leaks else ' ⇒ 干净'), file=sys.stderr)
    if args.json:
        print(json.dumps({'scanned': scanned, 'containers': len(globs), 'leaks': leaks}, ensure_ascii=False))
    return 1 if leaks else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--staged', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--allow', default=None)
    ap.add_argument('--repo', default=REPO)
    args = ap.parse_args()
    if not args.check:
        ap.error('需要 --check')
    return check(args)


if __name__ == '__main__':
    sys.exit(main())
