#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机制台账: 防"修复广度不完整"(tp-104 / T120)。

本轮实证: 我给"排程痕迹必须可辨来源"加了 origin 标记, 但只改了 5 个新机制里的 3 个 ——
漏掉的恰是后果最重的两个(闸门 ARMED 会改写目标 nextAction; 观察快照是判据的唯一入口)。
同一天里"修复只覆盖碰到的那几处"已出现多次(消费方判据没跟上、快照被子窗口覆盖、日志未与套件分离)。
故把**广度本身**做成判据: 凡 crontab 里被调用的 dsh 脚本, 都必须在机制台账里登记,
且台账声明的性质(脚本存在 / 带 origin 标记 / 排程条目带 DSH_RUN_ORIGIN=cron / 记录文件存在)必须成立。

用法: dsh-mechanism-inventory-check.py [--json] [--init-baseline]
退出码: 0 正常; 1 缺台账; 2 有缺口。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
INVENTORY = os.path.join(DIR, 'mechanism-inventory.json')


def crontab_scripts() -> dict[str, str]:
    out = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=30).stdout
    found: dict[str, str] = {}
    for line in out.splitlines():
        if line.strip().startswith('#') or not line.strip():
            continue
        for match in re.finditer(r'(/home/\S+/dsh-[\w.-]+\.(?:py|sh))', line):
            found[match.group(1)] = line
    return found


def main() -> int:
    args = sys.argv[1:]
    if not os.path.exists(INVENTORY):
        print('缺机制台账: %s' % INVENTORY, file=sys.stderr)
        return 1
    inv = json.load(open(INVENTORY, encoding='utf8'))
    entries = {e['script']: e for e in (inv.get('mechanisms') or []) if e.get('script')}
    exempt = {e['script'] for e in (inv.get('exemptions') or []) if isinstance(e, dict) and e.get('script')}
    exempt |= {str(x) for x in (inv.get('exemptions') or []) if isinstance(x, str)}
    baseline = {str(x) for x in (inv.get('baselineUnregistered') or [])}
    cron = crontab_scripts()
    problems: list[str] = []

    # ① 广度: 排程调用的每个 dsh 脚本都必须在台账里(否则"新增机制忘了登记"就是这么漏的)
    for script, line in sorted(cron.items()):
        if script in exempt:
            continue
        if script not in entries and os.path.basename(script) not in baseline:
            problems.append('排程调用的脚本未登记台账: %s' % os.path.basename(script))
    # ② 台账声明的性质必须成立
    for script, entry in sorted(entries.items()):
        if not os.path.exists(script):
            problems.append('%s 台账在册但脚本不存在(腐烂)' % os.path.basename(script))
            continue
        text = open(script, encoding='utf8').read()
        if entry.get('originTagged') and 'DSH_RUN_ORIGIN' not in text:
            problems.append('%s 声明带 origin 标记但源码里没有' % os.path.basename(script))
        if entry.get('cron'):
            line = cron.get(script)
            if line is None:
                problems.append('%s 台账称有排程但 crontab 里找不到' % os.path.basename(script))
            elif 'DSH_RUN_ORIGIN=cron' not in line:
                problems.append('%s 的排程条目没带 DSH_RUN_ORIGIN=cron' % os.path.basename(script))
        for path in entry.get('records') or []:
            if not os.path.exists(path):
                problems.append('%s 声明的记录文件不存在: %s' % (os.path.basename(script), path))

    payload = {'cronScripts': len(cron), 'inventory': len(entries), 'exempt': len(exempt),
               'problems': problems,
               'note': '广度判据: 排程调用的 dsh 脚本必须在台账在册; 台账声明的性质须逐条成立'}
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('排程脚本 %d | 台账 %d | 豁免 %d | 缺口 %d'
              % (len(cron), len(entries), len(exempt), len(problems)))
        for item in problems:
            print('  · %s' % item)
    return 2 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
