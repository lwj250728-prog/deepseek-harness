#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-oom-regression-check.py — 会话加载主路径的 OOM 回归守卫(tp-192)。

背景(2026-09-13 02:00 修复 aef45a8): 冷会话的 transcript 读取把整份日志物化进内存 —— 78.6MB/101802 帧的会话
在 1.9GB 堆上必然 OOM, 手机端一恢复该会话就 `POST /api/session.history` → ABRT → systemd 拉起 → 客户端重试
→ 崩溃循环(重启计数一度 499)。修法是**有界尾读**(`readTail`)+ **物化预算**(`maxMaterializeBytes`)。

本脚本不是重复包内测试, 而是补三件包内测试**结构上覆盖不到**的事:

  ① **回归真的会红**: 在 MemoryMax 硬限作用域里跑包自带的 `tail.spec.ts`, 要求 "12 passed" —— 实测把
     `maxMaterializeBytes` 改成无上限(等价旧行为)会让它变成 "1 failed | 11 passed" ⇒ 这条判据抓得住回归。
  ② **已部署的产物里真的有这条路径**: 源码改了但没重建/没重启, 线上就还是旧行为 —— 故核对 lib 产物里
     有 `readTail`/`maxMaterializeBytes`/`SessionMaterializationLimitError` 三个标记。
  ③ **崩溃循环计数器不得增长**: systemd 的 `NRestarts` 是可白拿的读数; 增长必须**有崩溃证据**(24h journal
     里的 OOM/ABRT)才允许, 否则视为静默异常重启。

纪律(2026-09-12 01:31 的教训): 所有复刻实验**必须**在 `systemd-run --scope -p MemoryMax=…` 里跑 ——
那次没隔离, 把线上 dsh 一起带崩。本脚本调用 vitest 时一律带上硬限(可用 DSH_OOM_SCOPE=0 关闭, 仅用于自测)。

用法: dsh-oom-regression-check.py [--baseline] [--json]
退出码: 0 合规; 1 判红; 3 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
TZ = datetime.timezone(datetime.timedelta(hours=8))
SPEC = os.environ.get('DSH_OOM_SPEC') or os.path.join(
    REPO, 'packages/session/session-persistence-jsonl/tests/tail.spec.ts')
LIB = os.environ.get('DSH_OOM_LIB') or os.path.join(
    REPO, 'packages/session/session-persistence-jsonl/lib/index.js')
MARKERS = ('readTail', 'maxMaterializeBytes', 'SessionMaterializationLimitError')
EXPECT_PASSED = 12
TIMEOUT = float(os.environ.get('DSH_OOM_TIMEOUT') or 900)


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def baseline_path() -> str:
    return os.path.join(cog_dir(), 'oom-crash-baseline.json')


def run_spec() -> tuple[int, str]:
    """在有界的 cgroup 作用域里跑包自带的有界尾读测试。"""
    if not os.path.exists(SPEC):
        return 3, '缺测试文件: %s' % SPEC
    cmd = ['npx', 'vitest', 'run', SPEC]
    scope = os.environ.get('DSH_OOM_SCOPE', '1') != '0'
    if scope:
        cmd = ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=1200M',
               '-p', 'MemorySwapMax=256M', '--'] + cmd
    try:
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return 3, '跑测试超时(>%.0fs)' % TIMEOUT
    out = (r.stdout or '') + (r.stderr or '')
    m = re.search(r'Tests\s+(\d+) failed \| (\d+) passed', out)
    if m:
        return 1, '有界尾读测试**有失败**: %s failed | %s passed' % (m.group(1), m.group(2))
    m = re.search(r'Tests\s+(\d+) passed', out)
    if m:
        n = int(m.group(1))
        if n < EXPECT_PASSED:
            return 1, '有界尾读测试只跑了 %d 例(< %d) ⇒ 用例被删/被跳过(不能只看"全绿")' % (n, EXPECT_PASSED)
        return 0, '%d passed' % n
    return 3, '读不出测试结论(exit %d): %s' % (r.returncode, out.strip()[-200:])


def check_lib() -> tuple[bool, str]:
    if not os.path.exists(LIB):
        return False, '缺产物 lib(说明该包未被构建): %s' % LIB
    text = open(LIB, encoding='utf8', errors='replace').read()
    missing = [m for m in MARKERS if m not in text]
    if missing:
        return False, ('产物里缺这些标记 %s ⇒ 源码改了但**没重建/没部署**, 线上仍是旧行为' % missing)
    return True, '产物含 %s' % ','.join(MARKERS)


def crash_evidence(since_iso: str | None = None, hours: int = 24) -> tuple[int, str]:
    """journal 里的 OOM/ABRT 痕迹条数。读不到 ⇒ -1(判不了)。

    2026-09-13 13:5x **自查抓出的洞**: 初版用"最近 24h"当窗口, 于是**陈旧证据会永久免责新增长** ——
    实测那 24h 里有 3369 条崩溃痕迹(09-13 凌晨的 OOM 夜), 于是"NRestarts 涨了"永远能被解释掉。
    改为**以基线记录时刻为窗口起点**: 只有基线之后发生的崩溃才配解释基线之后的增长。
    """
    try:
        if since_iso:
            start = datetime.datetime.fromisoformat(since_iso)
            if start.tzinfo is None:
                start = start.replace(tzinfo=TZ)
            since = start.astimezone(TZ).strftime('%Y-%m-%d %H:%M:%S')
        else:
            since = (datetime.datetime.now(TZ) - datetime.timedelta(hours=hours)).strftime('%Y-%m-%d %H:%M:%S')
        r = subprocess.run(['journalctl', '--user', '-u', 'dsh-web.service', '--since', since, '--no-pager'],
                           capture_output=True, text=True, timeout=120)
        hits = [l for l in (r.stdout or '').splitlines()
                if re.search(r'heap limit|OOM|Out of memory|ABRT|SIGABRT|core-dump', l, re.I)]
        return len(hits), (hits[-1][:120] if hits else '')
    except Exception:  # noqa: BLE001
        return -1, 'journal 读不到'


def nrestarts() -> int | None:
    try:
        out = subprocess.run(['systemctl', '--user', 'show', 'dsh-web.service', '-p', 'NRestarts', '--value'],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        return int(out) if out.isdigit() else None
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--baseline', action='store_true', help='记录当前 NRestarts 作为基线')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    problems, notes = [], []
    nr = nrestarts()
    if args.baseline:
        if nr is None:
            print('[oom] 取不到 NRestarts ⇒ 不记基线', file=sys.stderr)
            return 3
        p = baseline_path()
        payload = {'at': datetime.datetime.now(TZ).isoformat(), 'nRestarts': nr,
                   'reason': 'crash 循环基线: 增长必须伴随崩溃证据(24h journal 里的 OOM/ABRT), 否则算静默异常重启'}
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
        print('[oom] 已记基线: NRestarts=%d → %s' % (nr, p))
        return 0

    # ① 回归被判据抓住
    rc, why = run_spec()
    if rc == 3:
        problems.append('跑不了回归测试: %s' % why)
    elif rc != 0:
        problems.append(why)
    else:
        notes.append('有界尾读回归测试: %s' % why)

    # ② 产物里真有这条路径
    ok, why = check_lib()
    notes.append(why)
    if not ok:
        problems.append(why)

    # ③ 崩溃计数不得无凭增长
    bp = baseline_path()
    if not os.path.exists(bp):
        problems.append('缺崩溃计数基线(%s) ⇒ 判红(没有基线就谈不上"没增长"; 修法: --baseline)' % bp)
    elif nr is None:
        problems.append('取不到 NRestarts ⇒ 判红(fail-closed)')
    else:
        base = json.load(open(bp, encoding='utf8'))
        grew = nr - int(base.get('nRestarts') or 0)
        hits, tail = crash_evidence(base.get('at'))
        if grew > 0 and hits <= 0:
            problems.append('NRestarts 从 %s 涨到 %d(增 %d), 而**基线之后**的 journal 里没有崩溃证据 '
                            '⇒ 静默异常重启(注意: 基线之前的崩溃不予免责)' % (base.get('nRestarts'), nr, grew))
        else:
            notes.append('NRestarts %s→%d(增 %d), **基线之后**的崩溃痕迹 %s 条%s'
                         % (base.get('nRestarts'), nr, grew, hits if hits >= 0 else '?',
                            '; 最近一条: ' + tail if hits > 0 else ''))

    if args.json:
        print(json.dumps({'problems': problems, 'notes': notes}, ensure_ascii=False))
    for x in notes:
        print('[oom] %s' % x)
    for x in problems:
        print('[oom] **判红**: %s' % x, file=sys.stderr)
    print('[oom] %s' % ('通过' if not problems else '不通过(%d 项)' % len(problems)))
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
