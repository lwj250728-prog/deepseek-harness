#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-assert-runner.py — 把套件里的**某条断言**单独取出来跑(cl-272 债务偿还的工具)

为什么需要: 补"开火命令"时最忌讳把判据**再写一遍**(那就是同一指标两套口径 —— 我已经栽过)。
更稳的做法是让探针喂一份**缺陷件**给**同一条断言**(靠 T196/T199/T200 里新加的 DSH_* 注入点),
看它是否真的转红。本工具负责"取出来跑"这一步。

取法(可靠的原因): T118 强制新增断言 body 里**不得有裸单引号** ⇒ 断言一律长这样:
    t "名字" python3 -c '
    <body 若干行>
    '
于是 body = 两个单引号行之间的内容, 不需要解析 bash。

用法: dsh-assert-runner.py --name "<断言名>" [--suite P] [--list]
退出码: 0 = 该断言通过; 1 = 该断言转红(转红时它的 stderr 已透传); 3 = 取不到断言(名字错/不是 python3 -c 型)
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

DEFAULT_SUITE = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')


def extract(name: str, suite: str):
    lines = open(suite, encoding="utf8").read().split("\n")
    head = 't "%s" python3 -c \'' % name
    for i, l in enumerate(lines):
        if l.strip() == head.strip():
            body = []
            for j in range(i + 1, len(lines)):
                if lines[j].strip() == "'":
                    return "\n".join(body)
                body.append(lines[j])
            return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--name')
    ap.add_argument('--suite', default=DEFAULT_SUITE)
    ap.add_argument('--list', action='store_true')
    args = ap.parse_args()
    if args.list:
        for l in open(args.suite, encoding="utf8"):
            s = l.strip()
            if s.startswith('t "') and 'python3 -c' in s:
                print(s.split('"')[1])
        return 0
    if not args.name:
        print('需要 --name(或用 --list 看可选名字)', file=sys.stderr)
        return 3
    body = extract(args.name, args.suite)
    if body is None:
        print('取不到断言 %r(名字不对, 或它不是 python3 -c 型)' % args.name, file=sys.stderr)
        return 3
    r = subprocess.run([sys.executable, "-c", body], capture_output=True, text=True,
                       timeout=1200, env=dict(os.environ))
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    return 0 if r.returncode == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
