#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""客户端"取数 effect 自取消"形状闸(cl-221 / cl-222)。

起因: 用户报"目标轨迹 ui 没有内容"。宿主 RPC 200/17834B、清单已注册、产物含全部代码 ——
状态证据全绿, 面板却是空的。真实浏览器(CDP)实测才看清: 点击后确实发出 1 个 POST, 随即被
**自己**取消(ERR_ABORTED/canceled), 12s 后仍停在"…"。根因是一个被复制了三份的形状:

    useEffect(() => {
      if (guard) return            # guard 里读的是"这次请求自己会改的量"
      const controller = new AbortController()
      void refresh(controller.signal)
      return () => { controller.abort() }
    }, [status, refresh])          # ← 依赖里放着 status / asked / refresh

refresh(注入面)的第一步是 actions.begin(), 它把 status 翻成 loading ⇒ 依赖变化 ⇒ React 跑上一轮
effect 的 cleanup ⇒ abort 掉刚发出的请求; 而 abort 又被注入面的 `if (signal.aborted) return`
静默吞掉 ⇒ 永久 loading、永久空面板。`asked` 版本更隐蔽: effect 自己 setAsked(true) 就等于自己
改依赖。三个实例: ui-goal-tree(GoalTree)、ui-cognition(LifeStrip / LearningArea)。

判据: 凡 effect 里建 AbortController 并发起取数, 其依赖数组不得含
  ① status/loading/error  —— 取数第一步就会改它;
  ② 本 effect 内自己 set 的 state(如 asked)  —— 自己改自己的依赖;
  ③ refresh  —— 注入面在真实注册里会被重建, 且它自带 begin()。
修法: 把会自变的量放进 ref(取数 effect 只依赖"用户动作"那一维, 或干脆空依赖 + ref 守卫)。

用法: dsh-client-effect-shape-check.py [--json] [--repo PATH]
退出码: 0 无违例; 2 有违例(逐条打印 file:line 与原因)。
"""
from __future__ import annotations

import glob
import json
import os
import re
import sys

REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
# 取数第一步会改的状态量: 依赖它们 = 依赖"这次请求自己将要写的东西"
SELF_MUTATED = ('status', 'loading', 'error', 'asked')
EFFECT = re.compile(r'useEffect\(\(\) => \{(.*?)\n  \}, \[([^\]]*)\]\)', re.S)


def scan(repo: str) -> list[dict]:
    problems: list[dict] = []
    pattern = os.path.join(repo, 'packages/client/*/src/client/**/*.tsx')
    for path in sorted(glob.glob(pattern, recursive=True)):
        src = open(path, encoding='utf8').read()
        rel = path.split('packages/')[-1]
        for match in EFFECT.finditer(src):
            body, raw_deps = match.group(1), match.group(2)
            if 'abort()' not in body:
                continue
            deps = [d.strip() for d in raw_deps.split(',') if d.strip()]
            line = src[:match.start()].count('\n') + 1
            for dep in deps:
                reason = None
                if dep in SELF_MUTATED:
                    reason = f'依赖 {dep} —— 取数第一步(begin)就会改它, effect 会 abort 掉自己刚发的请求'
                elif dep == 'refresh' and 'refresh(' in body:
                    reason = '依赖 refresh 且自己发起取数 —— 注入面会重建且自带 begin()'
                elif re.search(r'set%s\(' % (dep[0].upper() + dep[1:]), body):
                    reason = f'依赖本 effect 自写的 state {dep} —— 等于自己触发自己的 cleanup'
                if reason is not None:
                    problems.append({'file': rel, 'line': line, 'dep': dep, 'reason': reason})
    return problems


def main() -> int:
    args = sys.argv[1:]
    repo = REPO
    if '--repo' in args:
        repo = args[args.index('--repo') + 1]
    problems = scan(repo)
    if '--json' in args:
        print(json.dumps({'repo': repo, 'problems': problems, 'count': len(problems)}, ensure_ascii=False))
    else:
        print('客户端取数 effect 形状闸: %d 处违例' % len(problems))
        for p in problems:
            print('  · %s:%d %s' % (p['file'], p['line'], p['reason']))
    return 2 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
