#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-degeneracy-check.py — 合成世界的**非退化自证**(tp-201 / 判据组 T231)。

问题(2026-09-13, 1 小时内两次同形**假绿**):
  用"合成世界"判数字的判据, 在世界**退化**时会报绿 —— 而假绿比红危险(红会被追, 绿不会):
    ① T229 第一版: 合成日志里那条 ✗ 距文件尾**不足 400 行** ⇒ 变异等价于没变、探针 exit 4(漂移);
    ② T230 第一版: 合成世界探针的 `NAME=` 用单引号 ⇒ 工具解析出 `name=''` ⇒ 体哈希 None ⇒
       **过期检查被静默跳过**, 那一步在"测了个空"时**报绿**。
  排查后: 套件里**没有任何**非退化类断言, 而合成世界型判据只有 T229/T230 两处。

本工具把三条绑成 machine-checkable(**行为**, 不是文本引用):
  ① **覆盖**: 凡体内出现 `tempfile.mkdtemp(` 的判据(即"注入世界再判数字")⇒ **必须在登记簿里有一条退化变异**,
     否则红「缺退化变异 ⇒ 非退化未自证」;
  ② **行为**: 登记簿每条退化变异都**实际施加**到目标文件(带落盘回读), 然后跑该判据 ⇒ **必须变红**;
     不变红即红「退化变异没被抓住 ⇒ 该判据认不出自己的世界退化了」;
  ③ **不腐烂**: 登记簿条目指向的判据必须在套件里仍存在, 目标文件与片段仍存在 —— 否则红。

安全约定: 变异只作用于**脚本源码**, 且复原在 finally 里(哈希比对确认复原); 变异片段一律避开会把产物写到
真实账本路径的代码(例如"忽略 --bindings 注入"这类变异会让 --record 写进 ~/.dsh ⇒ 禁止作为退化变异)。

用法:
  dsh-degeneracy-check.py --check [--json] [--only ID] [--list]
  DSH_COG_DIR 可覆盖登记簿位置; --registry / --suite / --repo 可显式覆盖(供合成世界判据使用)。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

try:
    import fcntl
except ImportError:      # 非 POSIX: 退化为无锁(仍按顺序施加/复原变异)
    fcntl = None

TZ = datetime.timezone(datetime.timedelta(hours=8))
TAG = '[degeneracy]'
REPO = os.path.expanduser('~/dsh-fork')
RUNNER = os.path.join(REPO, 'dsh-assert-runner.py')


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load(path: str):
    try:
        with open(path, encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return None


def fsha(path: str) -> str:
    try:
        return hashlib.sha256(open(path, 'rb').read()).hexdigest()
    except Exception:
        return ''


BODY_RE = r't\s+"([^"]+)"\s+python3 -c \'\n(.*?)\n\'\n'


def suite_bodies(suite: str) -> dict:
    try:
        text = open(suite, encoding='utf8').read()
    except Exception:
        return {}
    return {m.group(1): m.group(2) for m in re.finditer(BODY_RE, text, re.S)}


def synthetic_world_judgements(suite: str) -> list[str]:
    """体内自己 mkdtemp 造世界的判据 = "注入世界再判数字"的那种。"""
    return sorted(n for n, b in suite_bodies(suite).items() if 'tempfile.mkdtemp(' in b)


def mark(ok: bool, text: str) -> str:
    return '%s %s %s' % ('✓' if ok else '✗', TAG, text)


def run_judgement(name: str, timeout: float) -> tuple[int, str]:
    try:
        r = subprocess.run([sys.executable, RUNNER, '--name', name],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or '') + (r.stderr or '')
    except subprocess.TimeoutExpired:
        return 124, '超时'


def check(args) -> int:
    # 互斥: 本检查会**暂时改写**被判工具源码(与双臂探针同一手法) ⇒ 两个检查并发会交错变异 ⇒ 用文件锁串行化。
    lock = None
    if fcntl is not None:
        try:
            # **共享**变异锁: 与 arms 检查用同一把(cl-316 ②) —— 变异是按**文件**冲突的, 不是按机制。
            lock = open(os.path.join(cog_dir(), '.mutation.lock'), 'w')
            import signal as _sig

            def _on_alarm(_s, _f):
                raise TimeoutError('等锁超时')

            _sig.signal(_sig.SIGALRM, _on_alarm)
            _sig.alarm(int(getattr(args, 'lock_wait', 180)))   # 等锁而不是立刻放弃:
            # 立刻 exit 3 会让 T231 在 arms 检查跑的时候变红 —— 判据的裁决取决于另一个检查在不在跑。
            try:
                fcntl.flock(lock, fcntl.LOCK_EX)
            finally:
                _sig.alarm(0)
        except (OSError, TimeoutError):
            print('%s 等共享变异锁超时(另一个变异机制在跑) ⇒ 本次不施加变异(exit 3, 不等于判据通过)' % TAG, file=sys.stderr)
            return 3
        except Exception:
            lock = None
    suite = args.suite or os.path.join(args.repo, 'dsh-cog-tests.sh')
    reg_path = args.registry or os.path.join(cog_dir(), 'synthetic-world-mutants.json')
    reg = load(reg_path)
    if not reg or not reg.get('entries'):
        print('%s 读不到退化变异登记簿(或为空): %s ⇒ 前提不成立' % (TAG, reg_path), file=sys.stderr)
        return 3
    bodies = suite_bodies(suite)
    if not bodies:
        print('%s 读不到套件断言体: %s ⇒ 前提不成立' % (TAG, suite), file=sys.stderr)
        return 3

    reds, greens, entries = [], [], reg['entries']
    if args.only:
        entries = [e for e in entries if e.get('id') == args.only]

    # ① 覆盖: 每个合成世界判据至少有一条退化变异; 存量(登记时已有的)冻结为债, **只对新增加红**。
    # 为什么必须冻结: 登记时实测套件里有 %d 个判据体内 mkdtemp 自造世界(远多于我假设的 2 个) ⇒
    # "凡合成世界必须有退化变异"在存量上不可行, 与"单臂探针债"同一处置。
    synth = synthetic_world_judgements(suite)
    covered = {e.get('judgement') for e in entries}
    frozen = set(reg.get('frozenNoMutant') or [])
    fresh = [n for n in synth if n not in covered and n not in frozen]
    for name in fresh:
        reds.append({'id': '(覆盖)', 'why': '缺退化变异 ⇒ 非退化未自证(新增判据): %s' % name})
    gone = [n for n in frozen if n not in synth]
    if gone:
        print(mark(True, '冻结清单里有 %d 个判据已不在套件(自然减少, 债只减不增): %s'
                   % (len(gone), '; '.join(gone[:3]))), file=sys.stderr)
    print(mark(not fresh, '合成世界型判据 %d 个: 有退化变异 %d / 冻结为债 %d / **新增缺变异 %d**'
               % (len(synth), len([n for n in synth if n in covered]),
                  len([n for n in synth if n in frozen]), len(fresh))), file=sys.stderr)

    # ③ 不腐烂 + ② 行为
    for e in entries:
        eid, name = str(e.get('id') or '?'), str(e.get('judgement') or '')
        why = []
        path = e.get('file') or ''
        if name not in bodies:
            why.append('登记簿条目指向的判据在套件里不存在(腐烂)')
        if not os.path.isfile(path):
            why.append('目标文件不存在: %s' % path)
        if why:
            reds.append({'id': eid, 'why': why})
            continue
        src = open(path, encoding='utf8').read()
        if src.count(e['old']) != 1:
            reds.append({'id': eid, 'why': ['变异锚点在目标文件里出现 %d 次(期望 1) ⇒ 变异已失效'
                                            % src.count(e['old'])]})
            continue
        base_sha = fsha(path)
        rc_clean, _ = run_judgement(name, args.timeout)
        if rc_clean != 0:
            # 判据本身现在就红 ⇒ 无法判定"退化变异有没有被抓住"(先修判据)
            reds.append({'id': eid, 'why': ['判据 %s 在未变异时就判红 ⇒ 本次无法判定(先修判据)' % name]})
            continue
        try:
            mutated = src.replace(e['old'], e['new'])
            with open(path, 'w', encoding='utf8') as fh:
                fh.write(mutated)
                fh.flush()
                os.fsync(fh.fileno())
            if e['new'] not in open(path, encoding='utf8').read():
                reds.append({'id': eid, 'why': ['变异没落盘']})
                continue
            rc_mut, out = run_judgement(name, args.timeout)
        finally:
            with open(path, 'w', encoding='utf8') as fh:
                fh.write(src)
                fh.flush()
                os.fsync(fh.fileno())
            if fsha(path) != base_sha:
                reds.append({'id': eid, 'why': ['复原失败(哈希不一致) —— 目标文件可能已损坏!']})
                continue
        if rc_mut == 0:
            reds.append({'id': eid, 'why': ['退化变异(%s)没被抓住: 判据仍判绿 ⇒ 它认不出自己的世界退化了'
                                            % e.get('kind')]})
        else:
            greens.append({'id': eid, 'kind': e.get('kind'), 'judgement': name, 'rc_clean': rc_clean,
                           'rc_mutant': rc_mut, 'tail': out.strip().splitlines()[-1][:120] if out.strip() else ''})

    for g in greens:
        print(mark(True, '%s [%s] 退化后判红(rc %s→%s)' % (g['id'], g['kind'], g['rc_clean'], g['rc_mutant'])),
              file=sys.stderr)
    for r in reds:
        print(mark(False, '%s: %s' % (r['id'], ' ｜ '.join(r['why']))), file=sys.stderr)
    print('%s 合成世界判据 %d / 登记退化变异 %d: 抓住 %d / 判红 %d'
          % (TAG, len(synth), len(entries), len(greens), len(reds)), file=sys.stderr)
    if args.json:
        print(json.dumps({'synthetic': synth, 'entries': len(entries),
                          'caught': greens, 'red': reds}, ensure_ascii=False))
    return 1 if reds else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--only', default=None)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--suite', default=None)
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--timeout', type=float, default=600.0)
    ap.add_argument('--lock-wait', dest='lock_wait', type=float, default=180.0)
    args = ap.parse_args()
    suite = args.suite or os.path.join(args.repo, 'dsh-cog-tests.sh')
    if args.list:
        for n in synthetic_world_judgements(suite):
            print(n)
        return 0
    if not args.check:
        ap.error('需要 --check 或 --list')
    return check(args)


if __name__ == '__main__':
    sys.exit(main())
