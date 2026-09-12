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

第二类可隔离性(2026-09-12 19:5x, T217 触发): 有一条新判据在空世界下**必然判绿却不空洞** —— 它自带合成
世界(临时目录 + 合成账本), 走的是**变异证伪**而不是世界根注入(和 T214/T216 同一族)。用"空世界判红"判它
是**口径错配**: 它读世界根的方式就是自己造一个。故本条判据承认两种等价的隔离性证明:
  (a) 空世界下判红 —— 世界根注入点; 或
  (b) **登记在 guard-fire.json 的 must-fire 探针被真跑一次且按预期退出**(变异版被抓 ⇒ 判据确实能区分对错)。
(b) 比 (a) 更强而不是更弱: (a) 只证明"它读世界根", (b) 证明"喂它一个坏件它会红" —— 而是**机器跑出来的**,
不是文本理由。故 `--exempt` 只留给经不起 (b) 的历史债, 新判据请走登记探针这条正路。

用法: dsh-assert-isolation-check.py [--suite P] [--baseline P] [--timeout S] [--json] [--freeze]
                                 [--registry P] [--probe-timeout S]
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
# (b) 类隔离性的证据源: guard-fire 登记簿。缺它 ⇒ 只有 (a) 一条路(不做静默放行)。
DEFAULT_REGISTRY = os.path.join(os.environ.get('DSH_COG_DIR') or
                                os.path.expanduser('~/.dsh/cognitive-pipeline'),
                                'guard-fire.json')


def mutant_witness(name: str, registry: str, timeout: float):
    """把某条判据的 must-fire 探针**真跑两臂** → (是否证明, 说明)。

    只认 guard-fire.json 里 `assertion` 名字逐字相同、且带 `command` 的登记项。
    两臂(缺一不可, 否则"常退 1 的假探针"也能骗过只看出场码的核验):
      · 变异臂: 按登记的 expectedExit 退出 ⇒ 判据抓得住变异件;
      · 干净臂: 带 DSH_PROBE_CLEAN=1 再跑 ⇒ 必须退出 0 ⇒ 判据在**原件**上不红。
    探针自身失效(exit 3) / 没开火 / 干净臂也红 ⇒ 一律不算证明(不做静默放行)。
    """
    if not os.path.exists(registry):
        return False, '无登记簿(%s)' % registry
    try:
        reg = json.load(open(registry, encoding='utf8'))
    except Exception as exc:
        return False, '登记簿读不了(%s)' % exc
    cmds = []
    for g in (reg.get('guards') or []):
        for mf in (g.get('mustFire') or []):
            if str(mf.get('assertion') or '').strip() == name and str(mf.get('command') or '').strip():
                cmds.append((g.get('guard'), mf['command'], int(mf.get('expectedExit', 1))))
    if not cmds:
        return False, '登记簿里没有本条判据的 must-fire 探针'
    fails = []
    for guard, cmd, want in cmds:
        try:
            r = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True,
                               timeout=timeout, env=dict(os.environ))
            if r.returncode != want:
                fails.append('登记的探针 %s 没按预期开火(变异臂 exit %d, 期望 %d): %s' % (
                    guard, r.returncode, want, (r.stderr or r.stdout).strip()[-120:]))
                continue
            c = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True,
                               timeout=timeout, env=dict(os.environ, DSH_PROBE_CLEAN='1'))
        except subprocess.TimeoutExpired:
            fails.append('探针 %s 超时(>%.0fs)' % (guard, timeout))
            continue
        if c.returncode != 0:
            fails.append('探针 %s 缺干净臂/干净臂也红(exit %d): 只证明"判据会红", 没证明"红在变异上" —— '
                         '常退 %d 的假探针同样通不过这条' % (guard, c.returncode, want))
            continue
        return True, '变异探针 %s 双臂可区分(变异臂 exit %d / 干净臂 exit 0)' % (guard, want)
    return False, ('; '.join(fails) if fails else '无可用探针')


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
    ap.add_argument('--registry', default=DEFAULT_REGISTRY)
    ap.add_argument('--probe-timeout', type=float, default=180.0)
    ap.add_argument('--no-probe', action='store_true', help='只按空世界口径判(不跑变异探针)')
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
    mutant_ok, mutant_no = [], []
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
            # 空世界仍判绿 ⇒ 不读世界根。若它自带合成世界, 则须拿**变异探针真跑一次**来抵账。
            if args.no_probe:
                bad.append(name)
                continue
            proven, why = mutant_witness(name, args.registry, args.probe_timeout)
            if proven:
                mutant_ok.append('%s(%s)' % (name, why))
            else:
                mutant_no.append('%s(%s)' % (name, why))
                bad.append(name)
    if args.json:
        print(json.dumps({'new': len(new_items), 'notIsolatable': bad, 'skipped': skipped,
                          'rotten': rotten, 'mutantIsolatable': mutant_ok,
                          'mutantRejected': mutant_no}, ensure_ascii=False))
    if rotten:
        print('红: 冻结基线里有断言已消失(基线腐烂, 应同步缩减): %s' % rotten[:5], file=sys.stderr)
        return 1
    if bad:
        print('红: 新判据不可隔离(空世界下判绿且无开火的变异探针 ⇒ 既喂不了缺陷件也只能等活世界真坏): %s'
              % bad[:5], file=sys.stderr)
        return 1
    print('[isolation] 新判据 %d 条均可隔离(空世界下判红 %d 条; 变异探针已开火 %d 条); 历史债 %d 条; 跳过 %d 条'
          % (len(new_items) - len(skipped), len(new_items) - len(skipped) - len(mutant_ok),
             len(mutant_ok), len(base), len(skipped)))
    if mutant_ok:
        print('[isolation] 变异可隔离(靠 guard-fire 登记的探针真跑开火): %s' % '; '.join(mutant_ok))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
