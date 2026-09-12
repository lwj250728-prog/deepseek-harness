#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-assert-isolation-check.py — 新判据必须**可隔离**(空世界下必须判红) —— cl-273 的落地

由来(2026-09-12 13:3x 三问帧实验): 我用 `DSH_COG_DIR=<空目录>` 批量跑冻结组里的断言, 想证明"判据抓得住
缺陷", 结果 **22/22 全绿、判红 0 条** —— 逐条看路径后确认: 不是空洞, 是**它们根本不读这个变量**(几乎全部把
`~/.dsh/cognitive-pipeline` 写成绝对路径)。于是判据有了第三类缺陷: **不可隔离** —— 只能对着活世界跑,
所以 ①喂不了合成缺陷件(要加注入点才行), ②只能等活世界真坏才转红(发现延迟 = 实际损失)。

本判据把这条约定变成可执行检查:
  · 断言名在**冻结基线**(assert-isolation-baseline.json)里 ⇒ 历史债, 不审(但清单不许腐烂);
  · 基线之外(**新**)的 python3-c 断言 ⇒ 必须带 `DSH_COG_DIR`/`DSH_*` 世界根注入点, 且在**空世界**下判红
    (读不到世界就该失败, 而不是"空过");
  · 取不到 body / 超时 ⇒ 记为 skip 并**显式报数**(不得当成通过)。

用法: dsh-assert-isolation-check.py [--suite P] [--baseline P] [--timeout S] [--json] [--freeze]
      --freeze 把**当前全部**断言名写入基线(建立历史债快照, 只做一次)
退出码: 0 = 合规; 1 = 有新判据不可隔离; 3 = 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import tempfile

DEFAULT_SUITE = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
# 基线路径跟着 DSH_COG_DIR 走: 这样在**空世界**里跑本判据会因缺基线而判红(exit 3) ⇒ 它自己也是
# 可隔离的(否则它就会成为 T210 的第一条违规: 一条只读绝对路径的元判据)。
DEFAULT_BASE = os.path.join(os.environ.get('DSH_COG_DIR') or
                            os.path.expanduser('~/.dsh/cognitive-pipeline'),
                            'assert-isolation-baseline.json')


def assertions(suite: str):
    """→ [(name, body)] 只取 python3 -c 型(T118 保证 body 内无裸单引号 ⇒ 可靠取法)。"""
    lines = open(suite, encoding="utf8").read().split("\n")
    out = []
    for i, l in enumerate(lines):
        s = l.strip()
        if s.startswith('t "') and "python3 -c '" in s:
            name = s.split('"')[1]
            body = []
            for j in range(i + 1, len(lines)):
                if lines[j].strip() == "'":
                    break
                body.append(lines[j])
            out.append((name, "\n".join(body)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--suite', default=DEFAULT_SUITE)
    ap.add_argument('--baseline', default=DEFAULT_BASE)
    ap.add_argument('--timeout', type=float, default=20.0)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--freeze', action='store_true')
    ap.add_argument('--exempt', default=None, help='把某条断言显式排除(须配 --reason)')
    ap.add_argument('--reason', default='')
    args = ap.parse_args()
    if not os.path.exists(args.suite):
        print('[isolation] 读不到套件: %s' % args.suite, file=sys.stderr)
        return 3
    items = assertions(args.suite)
    if args.freeze:
        payload = {'at': datetime.datetime.now().astimezone().isoformat(),
                   'names': sorted({n for n, _ in items}),
                   'reason': ('cl-273 实测: 抽 22 条断言喂空世界(DSH_COG_DIR=空目录) ⇒ 22/22 仍判绿, 因为绝大多数'
                              '把 ~/.dsh/cognitive-pipeline 写成绝对路径。这批历史判据**不可隔离** ⇒ 冻结为债; '
                              '此后新增的判据必须可隔离(空世界下判红), 否则只能等活世界真坏才发现。')}
        json.dump(payload, open(args.baseline, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        print('[isolation] 已冻结 %d 条历史断言为不可隔离债' % len(payload['names']))
        return 0
    if args.exempt:
        if not str(args.reason).strip():
            print('[isolation] --exempt 必须配 --reason(显式豁免要留理由)', file=sys.stderr)
            return 3
        payload = json.load(open(args.baseline, encoding='utf8')) if os.path.exists(args.baseline) else {'names': []}
        payload.setdefault('exempt', []).append({'name': args.exempt, 'reason': args.reason,
                                                  'at': datetime.datetime.now().astimezone().isoformat()})
        json.dump(payload, open(args.baseline, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        print('[isolation] 已显式豁免: %s' % args.exempt)
        return 0
    base = set()
    if os.path.exists(args.baseline):
        _b = json.load(open(args.baseline, encoding='utf8'))
    base = set(_b.get('names') or [])
    exempt = {e.get('name') for e in (_b.get('exempt') or [])}
    if not base:
        print('[isolation] 缺冻结基线(先 --freeze) —— 不得把"没有基线"当成通过', file=sys.stderr)
        return 3
    present = {n for n, _ in items}
    rotten = sorted(base - present)
    new_items = [(n, b) for n, b in items if n not in base and n not in exempt]
    empty = tempfile.mkdtemp(prefix="isolation-empty-")
    env = dict(os.environ, DSH_COG_DIR=empty)
    bad, skipped = [], []
    for name, body in new_items:
        if not body.strip() or "npx tsx" in body:
            skipped.append(name)
            continue
        try:
            r = subprocess.run([sys.executable, "-c", body], capture_output=True, text=True,
                               timeout=args.timeout, env=env)
        except subprocess.TimeoutExpired:
            skipped.append(name)
            continue
        if r.returncode == 0:
            bad.append(name)
    if args.json:
        print(json.dumps({'new': len(new_items), 'notIsolatable': bad, 'skipped': skipped,
                          'rotten': rotten}, ensure_ascii=False))
    if rotten:
        print('红: 冻结基线里有断言已消失(基线腐烂, 应同步缩减): %s' % rotten[:5], file=sys.stderr)
        return 1
    if bad:
        print('红: 新判据在空世界下仍判绿(= 不读世界根, 喂不了缺陷件, 只能等活世界真坏): %s' % bad[:5], file=sys.stderr)
        return 1
    print('[isolation] 新判据 %d 条均可隔离(空世界下判红); 历史债 %d 条; 跳过 %d 条(重活/取不到 body)'
          % (len(new_items) - len(skipped), len(base), len(skipped)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
