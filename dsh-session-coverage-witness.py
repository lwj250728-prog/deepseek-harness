#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-session-coverage-witness.py — 「改动必须有**在改动之后跑过**的覆盖」的见证(tp-193 / T28)。

T28 的原判据只认**文本引用**(套件里出现该文件路径或 basename) —— 那正好奖励假覆盖: 加一句注释就能变绿。
本工具把它换成**执行型见证**, 并在见证里同时记下**可证伪性**:

  · `--write`: ①在 `systemd-run --scope -p MemoryMax=…`(纪律: 所有复刻/测试跑一律带硬限)里跑**六个** src 文件
    对应的五个 spec, 要求**全绿**(tp-194 后为 94 例); ②**注入一个真变异**(把 agent-lookup 的
    `ApiRemoteSessionNotFound` 换成普通 `Error`, 带备份与恢复), 再跑一次, 要求**必须转红** —— 只有"能红"的测试
    才算覆盖; ③把 10 个文件(6 个 src + 4 个 spec... 实为 6 src + 5 spec = 11)的 sha256、通过数、以及
    `falsifiable: true` 写进世界目录的见证文件。
  · `--check`(套件里跑这条, 便宜): 见证必须存在、`falsifiable` 为真、通过数达标、**且 7 个文件的 sha256 与
    见证一致** —— 任何 src/spec 在见证之后改过 ⇒ 判红("改了但没有在改动之后重新核验")。

用法: dsh-session-coverage-witness.py [--write|--check] [--json]
退出码: 0 通过; 1 判红; 3 读数失败。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys

REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
TZ = datetime.timezone(datetime.timedelta(hours=8))

SRC = (
    'packages/api/remotes/src/agent-lookup.ts',
    'packages/client/runtime/src/client/sessions/manager.ts',
    'packages/host/apiproxy/src/api-proxy.ts',
    # tp-194 追加(2026-09-13 13:4x): 三个 session/* 文件, 逐个用**变异法**证明覆盖后才纳入 ——
    # format.ts(encodeSegment 去掉空串拒绝 ⇒ 2 failed)与 coordinator.ts(主路径谎报 truncated ⇒ 2 failed)
    # 原本就有覆盖; invariant.ts **原本没有覆盖**(把 apply 改成不注册, 整个测试车道全绿) ⇒ 补了
    # tests/invariant.spec.ts, 并验过它对"注册错包名/不注册"两种变异都会转红。
    'packages/session/session-persistence-jsonl/src/format.ts',
    'packages/session/session-persistence/src/coordinator.ts',
    'packages/session/session-handover/src/invariant.ts',
)
SPECS = (
    'packages/api/remotes/tests/agent-lookup.spec.ts',
    'packages/host/apiproxy/tests/api-proxy-cold.spec.ts',
    'packages/session/session-handover/tests/handover.spec.ts',
    'packages/client/runtime/tests/manager.client.spec.ts',
    'packages/session/session-handover/tests/invariant.spec.ts',
)
WATCHED = SRC + SPECS
MIN_PASSED = 94
MUTANT_FILE = 'packages/api/remotes/src/agent-lookup.ts'
MUTANT_OLD = """    throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
  }
  return { meta: inspected.meta, events: [...inspected.events] }"""
MUTANT_NEW = """    throw new Error('MUTANT: plain error instead of session-not-found')
  }
  return { meta: inspected.meta, events: [...inspected.events] }"""


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def witness_path() -> str:
    return os.path.join(cog_dir(), 'session-coverage-witness.json')


def sha(rel: str) -> str:
    p = os.path.join(REPO, rel)
    if not os.path.exists(p):
        return ''
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def run_specs(files) -> tuple[int, int, str]:
    """→ (通过数, 失败数, 说明)。一律在硬限作用域里跑。"""
    cmd = ['npx', 'vitest', 'run', *[os.path.join(REPO, f) for f in files]]
    if os.environ.get('DSH_SCOPE', '1') != '0':
        cmd = ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=1500M',
               '-p', 'MemorySwapMax=256M', '--'] + cmd
    try:
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=1200)
    except subprocess.TimeoutExpired:
        return -1, -1, '跑测试超时'
    out = (r.stdout or '') + (r.stderr or '')
    import re
    m = re.search(r'Tests\s+(\d+) failed \| (\d+) passed', out)
    if m:
        return int(m.group(2)), int(m.group(1)), '有失败'
    m = re.search(r'Tests\s+(\d+) passed', out)
    if m:
        return int(m.group(1)), 0, 'ok'
    return -1, -1, '读不出结论(exit %d): %s' % (r.returncode, out.strip()[-160:])


def write_witness() -> int:
    passed, failed, why = run_specs(SPECS)
    if passed < 0 or failed != 0 or passed < MIN_PASSED:
        print('[witness] 基线跑不通/不达标(通过 %s / 失败 %s, 需 ≥%d): %s ⇒ 不写见证'
              % (passed, failed, MIN_PASSED, why), file=sys.stderr)
        return 1
    # 可证伪性: 注入真变异, 必须转红, 然后恢复
    target = os.path.join(REPO, MUTANT_FILE)
    bak = target + '.witness-bak'
    shutil.copy(target, bak)
    falsifiable, mpassed, mfailed, mwhy = False, -1, -1, ''
    try:
        text = open(target, encoding='utf8').read()
        if text.count(MUTANT_OLD) != 1:
            print('[witness] 找不到变异点(结构变了) ⇒ 记 falsifiable=false', file=sys.stderr)
        else:
            open(target, 'w', encoding='utf8').write(text.replace(MUTANT_OLD, MUTANT_NEW))
            mpassed, mfailed, mwhy = run_specs(('packages/api/remotes/tests/agent-lookup.spec.ts',))
            falsifiable = mfailed > 0
    finally:
        shutil.move(bak, target)
    if not falsifiable:
        print('[witness] **注入变异后测试没转红**(失败 %s): 覆盖不可证伪 ⇒ 不写见证' % mfailed, file=sys.stderr)
        return 1
    payload = {'at': datetime.datetime.now(TZ).isoformat(), 'passed': passed, 'failed': failed,
               'falsifiable': True,
               'mutant': {'file': MUTANT_FILE, 'what': 'ApiRemoteSessionNotFound → 普通 Error',
                          'mutantPassed': mpassed, 'mutantFailed': mfailed},
               'hashes': {rel: sha(rel) for rel in WATCHED},
               'note': ('改动之后**真的跑过**这四个 spec(且注入变异会转红)才算覆盖。--check 只比对哈希: '
                        '任何 src/spec 在见证之后被改过 ⇒ 判红, 要求重新 --write。')}
    p = witness_path()
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    print('[witness] 已记录: %d passed, 变异后 %d failed(可证伪), %d 个文件哈希已入册 → %s'
          % (passed, mfailed, len(WATCHED), p))
    return 0


def check() -> int:
    p = witness_path()
    if not os.path.exists(p):
        print('[witness] 缺见证文件(%s) ⇒ 判红: 没有"在改动之后跑过"的证据(修法: --write)' % p, file=sys.stderr)
        return 1
    w = json.load(open(p, encoding='utf8'))
    problems = []
    if not w.get('falsifiable'):
        problems.append('见证里没有"可证伪"记录(注入变异后测试必须转红)')
    if int(w.get('passed') or 0) < MIN_PASSED:
        problems.append('见证里的通过数 %s < %d(用例被删/被跳过)' % (w.get('passed'), MIN_PASSED))
    hashes = w.get('hashes') or {}
    changed = [rel for rel in WATCHED if hashes.get(rel) != sha(rel)]
    if changed:
        problems.append('这些文件在见证之后改过 ⇒ 覆盖没在改动之后复核: %s' % changed)
    if problems:
        for x in problems:
            print('[witness] **判红**: %s' % x, file=sys.stderr)
        return 1
    print('[witness] 覆盖见证有效: %d passed, 可证伪=true, %d 个文件哈希一致(记于 %s)'
          % (w.get('passed'), len(WATCHED), str(w.get('at'))[:19]))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if args.write:
        return write_witness()
    return check()


if __name__ == '__main__':
    raise SystemExit(main())
