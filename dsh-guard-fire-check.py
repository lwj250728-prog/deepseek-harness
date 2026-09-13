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


def _log_path(default: str) -> str:
    """归属分离(cl-146): 同上, cron 与套件痕迹分开。"""
    if '--log' in sys.argv:
        idx = sys.argv.index('--log')
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return default
TZ = datetime.timezone(datetime.timedelta(hours=8))


def _suite_log_path() -> str:
    """套件自己的裁决日志(cl-146 归属分离: cron 与手工各写各的)。"""
    if '--suite-log' in sys.argv:
        idx = sys.argv.index('--suite-log')
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return os.path.join(DIR, '.cog-tests.log')


def suite_verdicts(log_path: str, max_age_h: float = 8.0):
    """最近一轮套件的逐条裁决 → ({断言名: '✓'|'✗'}, 说明); 块太旧/读不到 ⇒ (None, 原因)。

    为什么用套件自己的日志当"干净臂": 断言的真值只在套件上下文里成立 —— 实测 T139 的断言要求套件导出的
    DSH_COG_RUN_PID, 单独另起进程跑 body 必然红(第一版就是这么误报的)。日志是同一个上下文的一手裁决。
    块陈旧超过 max_age_h ⇒ 判"无法判定"而不是判绿(fail-closed, 不许拿陈旧的 ✓ 当现在的证据)。
    """
    if not os.path.exists(log_path):
        return None, '套件裁决日志不存在(%s)' % log_path
    try:
        lines = open(log_path, encoding='utf8', errors='replace').read().split('\n')
    except Exception as exc:
        return None, '套件裁决日志读不了(%s)' % exc
    marks = [i for i, l in enumerate(lines) if '累计裁决' in l]
    if not marks:
        return None, '日志里没有裁决行'
    tail = lines[marks[-1]]
    stamp = re.search(r'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', tail)
    if stamp:
        when = datetime.datetime.strptime(stamp.group(1), '%Y-%m-%d %H:%M:%S').replace(tzinfo=TZ)
        age_h = (datetime.datetime.now(TZ) - when).total_seconds() / 3600.0
        if age_h > max_age_h:
            return None, '最近一轮裁决已 %.1fh 前(>%.0fh) ⇒ 不能当现在的干净臂' % (age_h, max_age_h)
    start = marks[-2] if len(marks) >= 2 else 0
    verd: dict[str, str] = {}
    for line in lines[start:marks[-1] + 1]:
        m = re.match(r'\s+([✓✗])\s+(\S.*)$', line)
        if m:
            verd[m.group(2).strip()] = m.group(1)
    if not verd:
        return None, '最近裁决块里没有逐条裁决'
    return verd, '取自最近一轮套件裁决块(%d 条)' % len(verd)


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

    # ④ 开火必须**有区分力**(2026-09-12 20:3x, tp-189 的前提实测): 单臂探针只证明"命令非零退出", 而
    #    "判据在原件上本来就是红的"(世界漂移/依赖坏掉/断言根本不在套件里)同样让任何探针非零退出 ——
    #    那时登记簿读起来"守卫全活", 实际全死。故对抗臂之外要配**干净臂**: 该断言在**原件上必须绿**。
    #    干净臂不指望各探针自觉(实测 45 条带命令探针里只有 1 条实现了 DSH_PROBE_CLEAN), 由本检查中央配对。
    #    第一版用 dsh-assert-runner.py 单独跑断言体 —— **当场误报**: T139 的断言要求套件导出的 DSH_COG_RUN_PID,
    #    单独跑必然 AssertionError, 于是"干净臂红"报了一条假缺陷。断言的真值只在**套件自己的上下文**里成立,
    #    所以干净臂取**最近一轮套件裁决块**(✓/✗ 逐条落盘), 而不是另起进程重跑 body。
    clean_ok: list[str] = []
    clean_bad: list[str] = []
    clean_na: list[str] = []
    verdicts, vnote = suite_verdicts(_suite_log_path(), max_age_h=8.0)
    for gid, entry in declared.items():
        for fire in entry.get('mustFire') or []:
            name = str(fire.get('assertion') or '').strip()
            if not fire.get('command') or not name:
                continue
            if verdicts is None:
                clean_na.append('%s(%s)' % (gid, vnote))
                continue
            v = verdicts.get(name)
            if v == '✓':
                clean_ok.append(gid)
            elif v == '✗':
                clean_bad.append('%s: 断言「%s」在最近一轮套件里是红的' % (gid, name[:60]))
            else:
                clean_na.append('%s(最近一轮没有这条裁决)' % gid)
    for item in clean_bad:
        problems.append('干净臂红 ⇒ 该守卫的"开火"没有意义(判据在原件上就红): %s' % item)

    payload = {'scannedAt': datetime.datetime.now(TZ).isoformat(),
               'groups': len(groups), 'baselineGroups': len(baseline),
               'declared': len(declared), 'problems': problems,
               'liveFired': fired,
               'cleanArm': {'paired': len(clean_ok), 'red': len(clean_bad), 'na': len(clean_na),
                            'source': 'suite-verdict-log', 'note': vnote},
               'note': '新守卫(>=T112)必须登记开火路径; 声明的命令必须现在就能开火; '
                       '开火还须与干净臂配对(该断言在最近一轮套件里必须是 ✓), 否则"活"没有意义'}
    with open(_log_path(LOG), 'a', encoding='utf8') as fh:
        # 干净臂计数必须落进日志行(tp-189): 否则"配对有没有红"只活在 stdout 里, 排程日志里无从核对。
        fh.write('%s origin=%s 组%d 登记%d 实开火%d 问题%d 干净臂绿%d 红%d 取不到%d\n'
                 % (payload['scannedAt'][:16], os.environ.get('DSH_RUN_ORIGIN', 'manual'),
                    len(groups), len(declared), len(fired), len(problems),
                    len(clean_ok), len(clean_bad), len(clean_na)))
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('断言组 %d | 基线 %d | 已登记守卫 %d | 现场开火 %d | 问题 %d'
              % (len(groups), len(baseline), len(declared), len(fired), len(problems)))
        print('干净臂配对: 绿 %d | 红 %d | 取不到 %d(tp-189: 单臂探针的"开火"不构成区分力证明)'
              % (len(clean_ok), len(clean_bad), len(clean_na)))
        for item in problems:
            print('  · %s' % item)
        for item in fired:
            print('  开火: %s' % item)
    return 2 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
