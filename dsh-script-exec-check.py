#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-script-exec-check.py — 被套件**按路径直接调用**的脚本必须存在且可执行(cl-376 / tp-214 / T258)

为什么需要(tp-214 的实证): `dsh-edit-check.sh` 权限被写成 **600** 之后, 套件里
  · 第 1490 行 `test -x` 判红 —— 恰好那一个文件有判据;
  · 第 1499 行**直接执行**它, 报的是 `bash: line 1: …: No such file or directory` —— **误导性错误**(看起来像文件不存在)。
仓库里还有几十个脚本被套件按路径直接调用, 但**只有那一个**有执行位判据 ⇒ 其余靠运气。

判据(静态 + 行为, 都不依赖"恰好有人测过"):
  ① **静态**: 扫描套件里**按路径直接调用**的脚本(两种形态: `test -x '<path>'` 与 `bash -c "… '<path>' …"` 里作为命令首词),
     逐个要求 `X_OK`; 违规即指名并 exit 1。
  ② 用 `python3 <path>` / `bash <path>` 调用的脚本**不要求**可执行位(语言解释器显式调用), 避免误报。
  ③ 注入点: DSH_EXECCHECK_SUITE=<套件路径> / DSH_EXECCHECK_REPO=<仓库根> ⇒ 判据与探针可用合成世界驱动。
退出码: 0 = 全部可执行; 1 = 有违规(指名); 3 = 环境不成立(套件读不到)。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# `test -x '<path>'`  或  `bash -c "… '<path>' …"` 里的路径(用单/双引号包裹, 含 $HOME)
PATTERNS = [
    re.compile(r"test\s+-x\s+['\"]?([^'\"\s]+)['\"]?"),
    # `bash -c "…"` 与 `bash -c '…'`: **分开匹配外层引号**, 否则内层单引号会把匹配截断
    # (第一版就漏了 `bash -c "'$T/x.sh'"` 这种形态, 合成世界里一个目标都没解析出来 —— 自我空过)
    re.compile(r'bash\s+-c\s+"([^"]*)"'),
    re.compile(r"bash\s+-c\s+'([^']*)'"),
]


def expand(path: str, repo: str) -> str:
    return path.replace("$HOME", os.path.expanduser("~")).replace("${HOME}", os.path.expanduser("~"))


def bare_invocations(suite_text: str, repo: str) -> set[str]:
    """从套件里挑出"按路径直接调用"的脚本(不是 python3/bash 显式解释的那种)。"""
    out: set[str] = set()
    for line in suite_text.splitlines():
        # ① test -x '<path>'
        for m in PATTERNS[0].finditer(line):
            p = expand(m.group(1), repo)
            if p.endswith(('.sh', '.py')) and not p.startswith('-'):
                out.add(p)
        # ② bash -c "<脚本> ..." : 取内层字符串的首个 token 作为命令
        for m in list(PATTERNS[1].finditer(line)) + list(PATTERNS[2].finditer(line)):
            inner = m.group(1).strip()
            first = inner.split()[0] if inner.split() else ''
            p = expand(first.strip("'\"") if first else '', repo)
            if p.endswith(('.sh', '.py')) and not p.startswith('-'):
                out.add(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--suite', default=os.environ.get('DSH_EXECCHECK_SUITE')
                    or os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh'))
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if not os.path.exists(args.suite):
        print('[exec-check] 读不到套件: %s ⇒ 环境不成立' % args.suite, file=sys.stderr)
        return 3
    text = open(args.suite, encoding='utf8', errors='replace').read()
    repo = os.environ.get('DSH_EXECCHECK_REPO') or os.path.dirname(os.path.abspath(args.suite))
    targets = sorted(bare_invocations(text, repo))
    missing, not_exec = [], []
    for p in targets:
        if not os.path.exists(p):
            missing.append(p)
        elif not os.access(p, os.X_OK):
            not_exec.append('%s (权限 %o)' % (p, os.stat(p).st_mode & 0o777))
    problems = missing + not_exec
    if args.json:
        import json
        print(json.dumps({'suite': args.suite, 'targets': len(targets), 'missing': missing,
                          'notExecutable': not_exec}, ensure_ascii=False))
    else:
        print('[exec-check] 套件里按路径直接调用的脚本 %d 个' % len(targets))
        for p in targets:
            mode = os.stat(p).st_mode & 0o777 if os.path.exists(p) else None
            print('   %s %s%s' % ('✓' if os.access(p, os.X_OK) else '✗', os.path.basename(p),
                                  '' if mode is None else ' (权限 %o)' % mode))
    if problems:
        print('[exec-check] **违规 %d 个**(被直接调用却不存在/不可执行): %s' % (len(problems), problems[:6]), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
