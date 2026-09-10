#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""枚举取值 → 消费方判据 的同改守门(tp-102 / T118, 即"族级 meta 断言")。

今天的同族病(9 次)都是同一个形状: **给产出方新增/改了一个取值, 消费方判据没跟上**。
先测过两种朴素写法, 都不可行(实测):
  · "源码里所有字面量都要被套件引用" —— 67 个候选, 40 个未引用(60%), 且样本多是事件名/配置键,
    根本不是"取值 ⇒ 判据"的关系, 判据一上线就红;
  · 只取"联合类型成员" —— 14 个联合类型 / 42 个成员, 19 个未引用(45%), 仍偏高。
故本判据落在**可界定总体 + 基线**上: 声明式的取值集合(联合类型)成员, 要么被套件里的断言引用,
要么在登记簿里写明豁免理由; **只对基线之后新增的成员开火**(历史积压不追溯, 同 T117 纪律)。

用法:
  dsh-enum-consumer-check.py --scan [--json]
  dsh-enum-consumer-check.py --init-baseline
  dsh-enum-consumer-check.py --strict-new     # 有新成员未覆盖则退出码 2
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
REGISTRY = os.path.join(DIR, 'enum-consumers.json')
LOG = os.path.join(DIR, 'enum-consumers.log')


def _log_path(default: str) -> str:
    """归属分离(cl-146): cron 与套件跑同一脚本时日志必须分开, 否则'排程新鲜度'判据可被套件跑满足。"""
    if '--log' in sys.argv:
        idx = sys.argv.index('--log')
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return default
# 套件路径可单独覆盖: 合成源测试需要把[扫哪份源码]与[拿哪份套件做覆盖率]解耦,
# 否则 DSH_REPO 一改套件也找不到(实测踩过: 合成用例直接退出 1)。
SUITE = os.environ.get('DSH_SUITE') or os.path.join(REPO, 'dsh-cog-tests.sh')
TZ = datetime.timezone(datetime.timedelta(hours=8))
ROOTS = (
    'packages/cognition/cognitive-pipeline/src',
    'packages/context/quiet-driver/src',
    'packages/context/cognitive-inject/src',
)
UNION = re.compile(r"type\s+(\w+)\s*=\s*((?:\s*'[^']+'\s*\|)*\s*'[^']+')\s*;?")


def collect() -> list[dict]:
    found: list[dict] = []
    for root in ROOTS:
        base = os.path.join(REPO, root)
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                if not name.endswith('.ts'):
                    continue
                path = os.path.join(dirpath, name)
                text = open(path, encoding='utf8').read()
                for match in UNION.finditer(text):
                    members = re.findall(r"'([^']+)'", match.group(2))
                    if len(members) < 2:
                        continue
                    found.append({'type': match.group(1),
                                  'file': os.path.relpath(path, REPO),
                                  'members': sorted(set(members))})
    return found


def main() -> int:
    args = sys.argv[1:]
    try:
        suite = open(SUITE, encoding='utf8').read()
    except Exception:
        print('读不到套件: %s' % SUITE, file=sys.stderr)
        return 1
    reg = {'entries': [], 'exemptions': [], 'baselineUncovered': [], 'baselineAt': None}
    if os.path.exists(REGISTRY):
        try:
            reg = json.load(open(REGISTRY, encoding='utf8'))
        except Exception:
            pass
    # 豁免既可能是裸字符串, 也可能是带理由的对象(2026-09-10 20:1x 改): 两种都要解出取值 ——
    # 改完格式忘了改消费方, 当场被 T118 的'基线后不得有新增未覆盖'抓住(同族第 N 例)。
    exempt = {str(x.get('value')) for x in (reg.get('exemptions') or []) if isinstance(x, dict) and x.get('value')}
    exempt |= {str(x) for x in (reg.get('exemptions') or []) if isinstance(x, str)}
    exempt |= {str(e.get('value')) for e in (reg.get('entries') or []) if e.get('exempt')}
    covered = {str(e.get('value')) for e in (reg.get('entries') or [])}
    baseline = set(reg.get('baselineUncovered') or [])

    unions = collect()
    members = sorted({m for u in unions for m in u['members']})
    uncovered = [m for m in members
                 if m not in suite and m not in exempt and m not in covered and m not in baseline]
    payload = {
        'scannedAt': datetime.datetime.now(TZ).isoformat(),
        'unionCount': len(unions),
        'memberCount': len(members),
        'coveredBySuite': len([m for m in members if m in suite]),
        'declared': len(covered),
        'exempt': len(exempt),
        'baselineCovered': len(baseline),
        'uncovered': uncovered,
        'uncoveredCount': len(uncovered),
        'note': ('总体=声明式联合类型的成员(可界定); 成员要么被套件断言引用, 要么登记豁免; '
                 '只对基线之后新增的成员开火'),
    }
    if '--init-baseline' in args:
        reg['baselineUncovered'] = uncovered
        reg['baselineAt'] = datetime.datetime.now(TZ).isoformat()
        json.dump(reg, open(REGISTRY, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
        print('基线已写入: %d 个历史未覆盖成员(不追溯)' % len(uncovered))
        return 0
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('联合类型 %d | 成员 %d | 套件已引用 %d | 已登记 %d | 豁免 %d | 基线 %d | **新增未覆盖 %d**'
              % (payload['unionCount'], payload['memberCount'], payload['coveredBySuite'],
                 payload['declared'], payload['exempt'], payload['baselineCovered'], payload['uncoveredCount']))
        for value in uncovered[:8]:
            print('  未覆盖: %s' % value)
    with open(_log_path(LOG), 'a', encoding='utf8') as fh:
        fh.write('%s origin=%s 成员%d 已引用%d 新增未覆盖%d\n'
                 % (payload['scannedAt'][:16], os.environ.get('DSH_RUN_ORIGIN', 'manual'),
                    payload['memberCount'], payload['coveredBySuite'], payload['uncoveredCount']))
    return 2 if ('--strict-new' in args and uncovered) else 0


if __name__ == '__main__':
    raise SystemExit(main())
