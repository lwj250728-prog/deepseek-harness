#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守卫必须能开火: must-fire 覆盖登记与核验(tp-103 / T119)。

来由(本会话实证三次): 判据被自己的测试数据或自身形式满足, 于是"守卫看着活着其实从不开火":
  · 腐烂检测用裸子串搜索套件, 被用例自己写进套件文本的 "T999" 满足;
  · 合成用例写死的取值字面量进了套件文本, 覆盖率检查"找到"它;
  · 断言 body 跑在 bash 单引号里, body 内单引号把引号提前闭合, 源码被吞掉引号后**仍能求值**,
    写出的源码缺引号 => 扫不到 => 全绿。
三次都只被"正向路径必须开火"那一条断言抓住。故把纪律机械化: **每条新守卫必须登记它的开火路径**,
且登记的路径要么是套件里真实存在的断言, 要么是一条命令 —— 该命令现在就要**真的开火**
(非零退出), 否则登记不算数。

范围纪律: 只对**新守卫**(T112 起)强制, 历史 101 个断言组写入 baseline 不追溯
(用文本启发式量过: 108 组里仅 22 组像是有 must-fire 形态, 但启发式本身粗糙, 不适合当判据总体)。

用法: dsh-guard-fire-check.py [--json] [--init-baseline]
退出码: 0 正常; 2 有未登记的新守卫或登记的开火路径已失效。
"""
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
SUITE = os.environ.get('DSH_SUITE') or os.path.join(REPO, 'dsh-cog-tests.sh')
REGISTRY = os.path.join(DIR, 'guard-fire.json')
LOG = os.path.join(DIR, 'guard-fire.log')
TZ = datetime.timezone(datetime.timedelta(hours=8))


def groups_in_suite() -> dict[str, str]:
    text = open(SUITE, encoding='utf8').read()
    blocks = re.split(r'\n(?=# ── T\d)', text)
    out: dict[str, str] = {}
    for block in blocks:
        match = re.search(r'\[T(\d{2,3})\]', block)
        if match:
            out['T' + match.group(1)] = block
    return out


def main() -> int:
    args = sys.argv[1:]
    if not os.path.exists(REGISTRY):
        print('缺登记簿: %s' % REGISTRY, file=sys.stderr)
        return 1
    reg = json.load(open(REGISTRY, encoding='utf8'))
    groups = groups_in_suite()
    baseline = set(reg.get('baselineGroups') or [])
    declared = {e['guard']: e for e in (reg.get('guards') or []) if e.get('guard')}

    if '--init-baseline' in args:
        scope = {g for g in groups if int(g[1:]) < 112}
        reg['baselineGroups'] = sorted(scope)
        reg['baselineAt'] = datetime.datetime.now(TZ).isoformat()
        json.dump(reg, open(REGISTRY, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
        print('基线已写入: %d 个历史断言组(不追溯)' % len(scope))
        return 0

    problems: list[str] = []
    # ① 新守卫(>=T112)必须登记
    for gid in sorted(groups):
        if int(gid[1:]) < 112 or gid in baseline:
            continue
        if gid not in declared:
            problems.append('%s 是新守卫但未登记开火路径' % gid)
    # ② 登记的开火路径必须真实存在
    for gid, entry in declared.items():
        if gid not in groups:
            problems.append('%s 登记的守卫在套件里已不存在(腐烂)' % gid)
            continue
        fires = entry.get('mustFire') or []
        if not fires:
            problems.append('%s 未声明任何开火路径' % gid)
        for fire in fires:
            name = fire.get('assertion')
            if name and ('t "%s"' % name) not in groups[gid]:
                problems.append('%s 声明的开火断言不在该组内: %s' % (gid, name))
    # ③ 声明的开火命令必须现在就能开火(非零退出) —— 这才是"守卫活着"的直接证据
    fired: list[str] = []
    for gid, entry in declared.items():
        for fire in entry.get('mustFire') or []:
            cmd = fire.get('command')
            if not cmd:
                continue
            run = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True, timeout=600)
            if run.returncode == 0:
                problems.append('%s 的开火命令没有开火(退出码 0): %s' % (gid, cmd[:80]))
            else:
                fired.append('%s(退出码 %d)' % (gid, run.returncode))

    payload = {'scannedAt': datetime.datetime.now(TZ).isoformat(),
               'groups': len(groups), 'baselineGroups': len(baseline),
               'declared': len(declared), 'problems': problems,
               'liveFired': fired,
               'note': '新守卫(>=T112)必须登记开火路径; 声明的命令必须现在就能开火'}
    with open(LOG, 'a', encoding='utf8') as fh:
        fh.write('%s 组%d 登记%d 实开火%d 问题%d\n'
                 % (payload['scannedAt'][:16], len(groups), len(declared), len(fired), len(problems)))
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('断言组 %d | 基线 %d | 已登记守卫 %d | 现场开火 %d | 问题 %d'
              % (len(groups), len(baseline), len(declared), len(fired), len(problems)))
        for item in problems:
            print('  · %s' % item)
        for item in fired:
            print('  开火: %s' % item)
    return 2 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
