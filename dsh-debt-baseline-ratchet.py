#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-debt-baseline-ratchet.py — 债基线的**棘轮**(tp-207/T241)。

问题(2026-09-14 03:3x 实测): 今晚多处判据用「冻结存量债、只减不增」的写法, 但**只做减法判断、没有任何地方把更紧的值写回基线**。
现成实例: `change-coverage-baseline.json` 声明 `noSpecCount = 2`, 而现实已是 1(我给 cognitive-inject 补了启用 spec 之后) ⇒
判据只做 `len(no_spec) <= known_n` ⇒ 下次那份 spec 若又消失, 现实回到 2 **仍判绿** ⇒ **改善没被锁住, 会静默回退**。
`probe-arms-baseline.json` 的 `frozenSingleArm` 同理。

不变式(两个方向都要管):
  · 现实**好于**基线(债变少) ⇒ **写回更紧的值**(棘轮) —— 否则改善会丢;
  · 现实**差于**基线(债变多) ⇒ **判红** —— 基线是"只减不增"的承诺。

用法:
  dsh-debt-baseline-ratchet.py --check      # 只判不变式(红=基线比现实松, 或债变多)
  dsh-debt-baseline-ratchet.py --ratchet    # 先写回更紧的值, 再判(供判据在用: 让改善被锁住)
  dsh-debt-baseline-ratchet.py --survey     # 打印全部基线的分类(债/下界/测量)与是否棘轮
注入: DSH_COG_DIR(账本目录) / DSH_DEBT_REGISTRY(登记簿路径) / DSH_REPO(仓库根)
"""
from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import subprocess
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
TAG = '[debt-ratchet]'
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
DEFAULT_REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'debt-baselines.json')
FALLBACK_REGISTRY = os.path.expanduser('~/.dsh/cognitive-pipeline/debt-baselines.json')


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load(path: str):
    try:
        with open(path, encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return None


def write_atomic(path: str, payload) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def changed_packages() -> list:
    out = subprocess.run(['git', '-C', REPO, 'log', '--since=24 hours ago', '--name-only',
                          '--pretty=format:', '--', 'packages'], capture_output=True, text=True).stdout
    files = [f for f in sorted(set(out.split())) if f.endswith('.ts') and '/src/' in f]
    return sorted({'/'.join(f.split('/')[:3]) for f in files})


def pkg_has_spec(pkg: str) -> tuple[bool, int]:
    """包内是否有可跑 spec(任意位置), 以及 .disabled 个数 —— 与 T237 同一口径(os.walk 剪 node_modules)。"""
    ok, dis = False, 0
    for dirpath, dirnames, filenames in os.walk(os.path.join(REPO, pkg)):
        dirnames[:] = [d for d in dirnames if d != 'node_modules']
        for fn in filenames:
            if fn.endswith('.spec.ts.disabled'):
                dis += 1
            elif fn.endswith('.spec.ts'):
                ok = True
    return ok, dis


def reality_no_spec_count() -> int:
    """现实: 24h 内改动过**且**没有任何可跑 spec 的包数(与 T237 的 no_spec 同口径, 但不跑 vitest)。"""
    n = 0
    for pkg in changed_packages():
        ok, _ = pkg_has_spec(pkg)
        if not ok:
            n += 1
    return n


def reality_single_arm() -> int:
    """现实: guard-fire 里**最近一次实测**为单臂(clean == 申报码)的探针数 —— 不需要重跑探针。"""
    reg = load(os.path.join(cog_dir(), 'guard-fire.json')) or {}
    n = 0
    for g in reg.get('guards') or []:
        for mf in (g.get('mustFire') or []):
            if not mf.get('command'):
                continue
            arms = mf.get('arms') or {}
            exp = int(mf.get('expectedExit') or 1)
            if arms.get('mutant') == exp and arms.get('clean') == exp:
                n += 1
    return n


REALITY = {
    'changeCoverageNoSpec': reality_no_spec_count,
    'probeSingleArm': reality_single_arm,
}


def survey(reg: dict, as_json: bool = False) -> int:
    rows = []
    for e in reg.get('entries') or []:
        rows.append({'file': e.get('file'), 'kind': e.get('kind'),
                     'ratcheted': bool(e.get('reality')),
                     'why': e.get('why') or ''})
    if as_json:
        print(json.dumps(rows, ensure_ascii=False))
        return 0
    print('%s 基线盘点(%d 条):' % (TAG, len(rows)))
    for r in rows:
        print('  %-44s %-18s %s%s' % (r['file'], r['kind'],
                                      '棘轮' if r['ratcheted'] else '**不棘轮**',
                                      (' —— ' + r['why']) if r['why'] else ''))
    return 0


def run(reg: dict, do_ratchet: bool, as_json: bool = False) -> int:
    reds, acts = [], []
    for e in reg.get('entries') or []:
        if e.get('kind') != 'debt' or not e.get('reality'):
            continue
        path = os.path.join(cog_dir(), e['file'])
        data = load(path)
        if data is None:
            reds.append('%s: 读不到基线文件 %s' % (e['file'], path))
            continue
        for key, probe in (e['reality'] or {}).items():
            fn = REALITY.get(probe)
            if fn is None:
                reds.append('%s.%s: 现实探针 %s 未注册(登记腐烂)' % (e['file'], key, probe))
                continue
            declared, real = data.get(key), fn()
            if declared is None:
                reds.append('%s.%s: 基线缺这个键' % (e['file'], key))
                continue
            if isinstance(declared, list):
                declared_n = len(declared)
            else:
                declared_n = int(declared)
            if real > declared_n:
                reds.append('%s.%s: **债变多**(现实 %d > 基线 %d) ⇒ 只减不增被破坏' % (e['file'], key, real, declared_n))
            elif real < declared_n:
                if do_ratchet:
                    data[key] = real if not isinstance(declared, list) else declared
                    data['ratchetedAt'] = datetime.datetime.now(TZ).isoformat()
                    data['ratchetNote'] = ('棘轮: %s 由 %d 收紧为 %d(tp-207/T241 —— 改善必须被锁住, '
                                           '否则下次坏回去仍判绿)' % (key, declared_n, real))
                    write_atomic(path, data)
                    acts.append('%s.%s: 棘轮 %d → %d(已写回)' % (e['file'], key, declared_n, real))
                else:
                    reds.append('%s.%s: 基线**比现实松**(基线 %d > 现实 %d) ⇒ 改善没被锁住, 需棘轮'
                                % (e['file'], key, declared_n, real))
    for a in acts:
        print('%s ✓ %s' % (TAG, a), file=sys.stderr)
    for r in reds:
        print('%s **判红** %s' % (TAG, r), file=sys.stderr)
    print('%s 债基线 %d 条参与判定: 棘轮 %d / 判红 %d'
          % (TAG, len([e for e in (reg.get('entries') or []) if e.get('kind') == 'debt' and e.get('reality')]),
             len(acts), len(reds)), file=sys.stderr)
    if as_json:
        print(json.dumps({'ratcheted': acts, 'red': reds}, ensure_ascii=False))
    return 1 if reds else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--ratchet', action='store_true')
    ap.add_argument('--survey', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--registry', default=None)
    args = ap.parse_args()
    path = args.registry or (DEFAULT_REGISTRY if os.path.exists(DEFAULT_REGISTRY) else FALLBACK_REGISTRY)
    reg = load(path)
    if not reg:
        print('%s 读不到债基线登记簿: %s ⇒ 前提不成立' % (TAG, path), file=sys.stderr)
        return 3
    if args.survey:
        return survey(reg, args.json)
    if not (args.check or args.ratchet):
        ap.error('需要 --check / --ratchet / --survey')
    return run(reg, do_ratchet=args.ratchet, as_json=args.json)


if __name__ == '__main__':
    sys.exit(main())
