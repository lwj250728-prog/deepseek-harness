#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-probe-arms-check.py — 开火探针必须**双臂可区分**(tp-189 的落地)。

由来(2026-09-13 12:0x, 用户追问"采纳 0 会不会是没记录"同轮的自查): guard-fire 登记簿里有 45 条带命令的
mustFire, 而 `dsh-guard-fire-check.py` 只看出场码 —— 只要探针退出申报码就记"开火=守卫活着"。单臂探针
**无法区分**这两种情形: (a) 判据抓住了变异; (b) 判据**本来就红**(世界漂移/依赖坏掉/断言根本不在套件里)。
实测: 对全部 45 条跑 `DSH_PROBE_CLEAN=1`, 只有 1 条(T217)退出 0 ⇒ 其余 44 条是单臂。

本脚本把"双臂"变成可核的量, 并守住三条纪律:
  ① **测量化**: 每条 mustFire 写 `arms:{mutant, clean}` —— 由 `--write-arms` 实跑填入, **不许手写**;
  ② **存量冻结为债**: 44 条单臂写进 `probe-arms-baseline.json`, **只减不增**; 冻结清单里的守卫若消失/没有命令 ⇒ 腐烂, 判红;
  ③ **新增门槛**: 不在冻结清单里、又只有单臂的探针 ⇒ 判红(等价于"登记时就要求双臂")。

用法: dsh-probe-arms-check.py [--write-arms] [--freeze] [--only T217] [--json]
退出码: 0 合规; 1 有新单臂/冻结清单腐烂/双臂数下降; 3 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load(path: str):
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf8') as fh:
        return json.load(fh)


def measure(cmd: str, timeout: float) -> tuple[int | None, int | None, str]:
    """→ (变异臂码, 干净臂码, 说明)。干净臂 = 带 DSH_PROBE_CLEAN=1 再跑一次同一命令。"""
    # 变异臂必须**显式剥掉** DSH_PROBE_CLEAN: 否则当本脚本自己被 DSH_PROBE_CLEAN=1 包着跑时(套件里就是这样),
    # 变异臂会串到干净臂那支 ⇒ 把"双臂可区分"的探针误判成"双臂同码"。这个坑是 T222 的探针当场抓出来的。
    env_m = {k: v for k, v in os.environ.items() if k != 'DSH_PROBE_CLEAN'}
    try:
        m = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True, timeout=timeout, env=env_m)
    except subprocess.TimeoutExpired:
        return None, None, '变异臂超时'
    try:
        c = subprocess.run(['bash', '-lc', cmd], capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, DSH_PROBE_CLEAN='1'))
    except subprocess.TimeoutExpired:
        return m.returncode, None, '干净臂超时'
    return m.returncode, c.returncode, ''


def verdict(mutant: int | None, clean: int | None, expected: int) -> str:
    if mutant is None or clean is None:
        return 'error'
    if mutant != expected:
        return 'mutant-mismatch'          # 探针自己漂了(或根本没开火)
    if clean == 0:
        return 'two-arm'                  # 变异件红 + 原件绿 ⇒ 有区分力
    if clean == expected:
        return 'single-arm'               # 忽略 DSH_PROBE_CLEAN: 干净臂与变异臂同码 ⇒ 证明不了区分力
    return 'other'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--write-arms', action='store_true', help='把实测 arms 写回登记簿(唯一写入者)')
    ap.add_argument('--freeze', action='store_true', help='把当前单臂集合冻结为债基线')
    ap.add_argument('--only', default=None)
    ap.add_argument('--timeout', type=float, default=300.0)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    d = cog_dir()
    reg_path = os.path.join(d, 'guard-fire.json')
    base_path = os.path.join(d, 'probe-arms-baseline.json')
    reg = load(reg_path)
    if reg is None:
        print('[arms] 读不到登记簿: %s' % reg_path, file=sys.stderr)
        return 3

    # 2026-09-13 12:4x **口径修正(对账时抓出)**: 原来按 **guard id** 冻结/比较, 而 T139/T140 各有 2 条带命令条目
     # ⇒ "同一 guard 下新增一条单臂探针"对门槛**不可见**(集合去重把两条压成一条)。改为按**条目键** = guard|assertion,
     # 一条 mustFire 一个键。冻结清单里存的也是键 ⇒ 新增/腐烂都能逐条看见。
    def entry_key(gid: str, mf: dict) -> str:
        return '%s|%s' % (gid, str(mf.get('assertion') or '')[:40])

    entries = []
    for g in reg.get('guards') or []:
        for mf in (g.get('mustFire') or []):
            if str(mf.get('command') or '').strip():
                entries.append((entry_key(str(g.get('guard')), mf), str(g.get('guard')), mf))
    if args.only:
        entries = [e for e in entries if e[1] == args.only]
    if not entries:
        print('[arms] 没有带命令的 mustFire ⇒ 无对象可测(前提不成立)', file=sys.stderr)
        return 3

    base = load(base_path) or {}
    frozen = set(base.get('frozenSingleArm') or [])
    frozen_two_arm = int(base.get('twoArmCount') or 0)

    results = {}
    for key, gid, mf in entries:
        expected = int(mf.get('expectedExit', 1))
        m, c, note = measure(str(mf['command']), args.timeout)
        v = verdict(m, c, expected)
        results[key] = {'guard': gid, 'mutant': m, 'clean': c, 'expected': expected, 'verdict': v, 'note': note}
        if args.write_arms:
            mf['arms'] = {'mutant': m, 'clean': c}

    if args.write_arms:
        reg['armsMeasuredAt'] = datetime.datetime.now(TZ).isoformat()
        reg['armsMeasuredBy'] = 'dsh-probe-arms-check.py'
        tmp = reg_path + '.tmp'
        with open(tmp, 'w', encoding='utf8') as fh:
            json.dump(reg, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        if os.path.exists(reg_path):
            os.chmod(tmp, os.stat(reg_path).st_mode & 0o7777)
        os.replace(tmp, reg_path)

    two_arm = sorted(g for g, r in results.items() if r['verdict'] == 'two-arm')
    single = sorted(g for g, r in results.items() if r['verdict'] == 'single-arm')
    other = sorted(g for g, r in results.items() if r['verdict'] not in ('two-arm', 'single-arm'))
    label = lambda k: results[k].get('guard', k)

    if args.freeze:
        payload = {'at': datetime.datetime.now(TZ).isoformat(),
                   'frozenSingleArm': single,
                   'twoArmCount': len(two_arm),
                   'reason': ('tp-189: 45 条带命令探针里只有 1 条(T217)实现了干净臂 ⇒ 其余 44 条**无法区分**'
                              '"判据抓住变异"与"判据本来就红"。存量冻结为债(只减不增); 新增探针必须双臂。'
                              '此清单由 dsh-probe-arms-check.py --freeze 生成, 不许手改。')}
        tmp = base_path + '.tmp'
        with open(tmp, 'w', encoding='utf8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, base_path)
        print('[arms] 已冻结: 单臂 %d 条, 双臂 %d 条 → %s' % (len(single), len(two_arm), base_path))
        return 0

    problems = []
    new_single: list[str] = []
    if not base:
        problems.append('缺冻基线(先跑 --freeze): %s' % base_path)
    else:
        # ② 冻结清单不得腐烂
        rotten = sorted(frozen - set(results))
        for g in rotten[:5]:
            problems.append('%s 在冻结清单里但已不存在/已无命令(清单腐烂, 应同步缩减)' % g)
        # ③ 新增的单臂探针不许出现
        new_single = sorted(set(single) - frozen)
        for g in new_single[:5]:
            problems.append('%s 是**新的单臂探针**(不在冻结清单里) ⇒ 登记前必须让干净臂(DSH_PROBE_CLEAN=1)退出 0'
                            % label(g))
        # 双臂数只能长不能缩
        if len(two_arm) < frozen_two_arm:
            problems.append('双臂探针数从冻结时的 %d 掉到 %d(不许减少)' % (frozen_two_arm, len(two_arm)))
    # 探针自身漂移/崩坏也要报(它不是"单臂债", 是坏账)
    for g in other:
        problems.append('%s 的测量异常: %s(变异臂 %s / 干净臂 %s, 期望 %s)'
                        % (g, results[g]['note'] or results[g]['verdict'], results[g]['mutant'],
                           results[g]['clean'], results[g]['expected']))

    print('[arms] 带命令探针 %d: 双臂 %d / 单臂 %d / 异常 %d%s'
          % (len(results), len(two_arm), len(single), len(other),
             '(冻结基线: 单臂 %d, 双臂 %d)' % (len(frozen), frozen_two_arm) if base else ''))
    if two_arm:
        print('       双臂(变异红+原件绿): %s' % ', '.join(label(g) for g in two_arm))
    if new_single:
        print('       **新单臂(判红)**: %s' % ', '.join(label(g) for g in new_single))
    for p in problems:
        print('  · %s' % p)
    if args.json:
        print(json.dumps({'results': results, 'twoArm': two_arm, 'singleArm': single,
                          'problems': problems}, ensure_ascii=False))
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
