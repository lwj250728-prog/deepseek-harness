#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-intervention-preflight.py — 干预实验的**开工/判读前预演**(cl-285 的手工预演固化成脚本)

为什么要它(cl-265/cl-285 的教训): 干预窗口的结束、判读、恢复腿复核都是**无人值守**的时刻, 而它们各自依赖
一串会随源码改动而变的东西(池行格式、checker 判据、冻结基线口径、判读器分支)。手工预演过一次(2026-09-12
18:0x)才发现: 判读会落在 `no-headroom-controls`(对照无空间), 恢复腿会因"时点未到"返回 3 —— 这些**预期读数**
必须在窗口开始前写下来, 否则事后任何分支都能被解释成"符合预期"。

用法: dsh-intervention-preflight.py --target <goalId> [--start ISO] [--end ISO] [--json]
退出码: 0 = 全部预演项符合预期(或已如实报告偏差); 3 = 预演本身跑不动; 1 = 有预演项与预期不符(需人工看)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.expanduser('~/dsh-fork')
COG = os.path.expanduser('~/.dsh/cognitive-pipeline')
COPY = ('dormant-goals.jsonl', 'wake-interventions.jsonl', 'incubation-log.jsonl',
        'quiet-driver-frames.jsonl', 'wake-intervention-baseline.json', 'attribution-era.json')


def run(cmd, env=None, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env or dict(os.environ))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='goal-experience-library')
    ap.add_argument('--start', default=None)
    ap.add_argument('--end', default=None)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    sandbox = tempfile.mkdtemp(prefix='intervention-preflight-')
    for f in COPY:
        src = os.path.join(COG, f)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(sandbox, f))
    env = dict(os.environ, DSH_COG_DIR=sandbox)
    results = {}

    # ① 恢复预演: 池行须回到原阈值/原门, 且该门当场满足(⇒ 恢复即"可驱动")
    r = run([sys.executable, os.path.join(REPO, 'dsh-wake-intervention.py'), 'restore', args.target,
             '--reason', 'preflight(沙箱)'], env)
    rows = [json.loads(l) for l in open(os.path.join(sandbox, 'dormant-goals.jsonl'), encoding='utf8') if l.strip()]
    cur = {}
    for x in rows:
        if x.get('id'):
            cur[str(x['id'])] = x
    row = cur.get(args.target, {})
    checker = str(row.get('waitChecker') or '').strip()
    checker_rc = None
    if checker:
        try:
            # **门的求值用真实环境**: 它读的是检索审计/预注册等真实产物, 沙箱里没有它们 ⇒ 会被判"样本不足"
            # (本工具第一次跑就踩到: 沙箱内 checker exit=1 而真实环境 exit=0 ⇒ 假报"恢复后仍不可驱动")。
            checker_rc = run(['bash', '-lc', checker], dict(os.environ), 600).returncode
        except Exception:  # noqa: BLE001
            checker_rc = -1
    results['restore'] = {'exit': r.returncode, 'thresholds': row.get('triggerThresholds'),
                          'waitChecker': checker, 'checkerExit': checker_rc,
                          'drivableAfterRestore': checker_rc == 0 or checker == ''}

    # ② 驱动侧预演: 用**驱动自己的判据**看恢复后会不会被选中(真池作对照)
    probe = (
        "import { selectActionableGoals } from '" + os.path.join(REPO, 'packages/context/quiet-driver/src/index.ts') + "'\n"
        "import { execSync } from 'node:child_process'\n"
        "import * as fs from 'node:fs'\n"
        "const met = (cmd) => { try { execSync(cmd, { stdio: 'ignore', timeout: 60000 }); return true } catch { return false } }\n"
        "const waiting = (g) => String(g?.waitChecker ?? '').trim() !== '' && !met(String(g.waitChecker))\n"
        "const rd = (p) => fs.readFileSync(p, 'utf8')\n"
        "const out = {}\n"
        "out.sandbox = selectActionableGoals(rd(process.env.SANDBOX + '/dormant-goals.jsonl'), waiting).map(g => g.id)\n"
        "out.real = selectActionableGoals(rd(process.env.HOME + '/.dsh/cognitive-pipeline/dormant-goals.jsonl'), waiting).map(g => g.id)\n"
        "console.log(JSON.stringify(out))\n"
    )
    # 驱动侧判据同样在真实环境求值(沙箱只提供'已恢复的池行'这一份文本)
    r2 = run(['npx', 'tsx', '--eval', probe], dict(os.environ, SANDBOX=sandbox), 600)
    picked = {}
    if r2.returncode == 0:
        try:
            picked = json.loads(r2.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            picked = {}
    results['drivable'] = {'sandbox': picked.get('sandbox'), 'real': picked.get('real'),
                           'targetDrivableAfterRestore': args.target in (picked.get('sandbox') or [])}

    # ③ 判读预演(主判读 + 恢复腿复核), 记录分支与退出码 —— 这就是"预期读数"
    base = [sys.executable, os.path.join(REPO, 'dsh-wake-intervention-readout.py'), '--target', args.target]
    if args.start:
        base += ['--start', args.start]
    if args.end:
        base += ['--end', args.end]
    r3 = run(base + ['--json'], env, 900)
    verdict = None
    if r3.returncode == 0:
        try:
            verdict = json.loads(r3.stdout.strip().splitlines()[-1]).get('verdict')
        except Exception:  # noqa: BLE001
            verdict = None
    r4 = run(base + ['--reversal-eval'], env, 900)
    results['readout'] = {'exit': r3.returncode, 'expectedVerdict': verdict,
                          'reversalEvalExit': r4.returncode,
                          'reversalEvalMeaning': {0: '兑现(met)', 1: '未兑现(unmet)', 2: '未预登记',
                                                  3: '复核时点未到(pending)'}.get(r4.returncode, '未知')}

    shutil.rmtree(sandbox, ignore_errors=True)
    bad = []
    if results['restore']['exit'] != 0:
        bad.append('恢复预演失败(exit=%s)' % results['restore']['exit'])
    if not results['drivable']['targetDrivableAfterRestore']:
        bad.append('恢复后目标仍不可驱动(sandbox=%s)' % results['drivable']['sandbox'])
    if results['readout']['exit'] != 0:
        bad.append('主判读跑不动(exit=%s)' % results['readout']['exit'])
    if args.json:
        print(json.dumps({'target': args.target, 'results': results, 'problems': bad}, ensure_ascii=False))
    else:
        print('干预预演 target=%s' % args.target)
        print('  ① 恢复: exit=%s 阈值=%s 门=%s 门当场退出=%s ⇒ 恢复后可驱动=%s'
              % (results['restore']['exit'], results['restore']['thresholds'],
                 str(results['restore']['waitChecker'])[-42:], results['restore']['checkerExit'],
                 results['restore']['drivableAfterRestore']))
        print('  ② 驱动侧选中: 沙箱(已恢复)=%s | 真池(干预中)=%s'
              % (results['drivable']['sandbox'], results['drivable']['real']))
        print('  ③ 判读: exit=%s ⇒ **预期分支=%s**; 恢复腿复核 exit=%s(%s)'
              % (results['readout']['exit'], results['readout']['expectedVerdict'],
                 results['readout']['reversalEvalExit'], results['readout']['reversalEvalMeaning']))
        if bad:
            print('  ⚠ 与预期不符: %s' % '; '.join(bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
