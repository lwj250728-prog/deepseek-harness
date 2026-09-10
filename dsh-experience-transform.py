#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""经验转化断言: 把"学到的教训"机械地绑到"能开火的断言"上(tp-101 / T117)。

为什么需要(实证, 不是设想):
  · 今天的同族病("改了产出方取值/口径, 消费方判据没跟上")复发 9 次, 而终止复发的**唯一有效做法**
    是把它翻译成断言(T112/T113/T114/T115/T116 共 22 条断言) —— 但这一步一直是手动的、逐次的;
  · 经验层别的通道都不在复发点开火: 引用率 40/296=13.5%, hitCount/positiveCount 全恒 0,
    taxonomy v1 卡在 09-09 且重建被拒(误差 6×), 链层按目标组织而同族病跨目标。
  所以缺的不是"再写一条经验", 而是**经验 → 断言 的转化登记与守门**:
    ①每个"修复型"经验必须登记它产出的断言(或显式写明为何不需要断言);
    ②每条登记过的断言必须仍存在于套件中(防断言腐烂后被当成还有保护);
    ③只对**新增**缺口开火 —— 历史积压不追溯(否则判据一上线就红, 变成狼来了)。

用法:
  dsh-experience-transform.py --scan             # 打印转化状态(人读)
  dsh-experience-transform.py --scan --json      # 机器读
  dsh-experience-transform.py --init-baseline    # 把当前未转化项写死为基线(只跑一次)
  dsh-experience-transform.py --strict-new       # 存在基线之后的新缺口则退出码 2
退出码: 0 正常; 1 读不到账本; 2 有新缺口(--strict-new)。
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys

# 目录可用环境变量覆盖: 断言套件必须能拿**合成账本**测试正向路径(新缺口必须开火),
# 而不是往真账本里塞假经验(观测通道不得被测试污染, cl-140)。
DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
EXPERIENCES = [
    ('experiences.jsonl', 'task'),          # 帧生经验不算"修复型"(它是自省产物)
]
REGISTRY = os.path.join(DIR, 'experience-assertions.json')
SUITE = os.path.join(REPO, 'dsh-cog-tests.sh')
LOG = os.path.join(DIR, 'experience-transform.log')


def _log_path(default: str) -> str:
    """归属分离(cl-146): 套件断言也会跑本脚本, 若与 cron 共用一个日志,
    '排程新鲜度'断言就无法区分[cron 真的跑了]与[套件顺手跑了一次] —— 同 cl-140 的观测通道污染家族。
    cron 用 --log 指定带 cron 标记的日志, 判据只认那份。"""
    if '--log' in sys.argv:
        idx = sys.argv.index('--log')
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return default
TZ = datetime.timezone(datetime.timedelta(hours=8))

# "修复型"经验: 描述了根因/修复/证伪/回归的教训 —— 这类经验如果不落到断言上, 就会复发。
FIX_MARKERS = re.compile(r'根因|修复|证伪|复发|回归|教训|误报|漏检|实测发现|踩过')
# 断言名字形如 T112 / "T116 第 6 断言"。登记时用断言组名即可。
ASSERTION_RE = re.compile(r'\bT\d{2,3}\b')


def load_experiences() -> list[dict]:
    rows: list[dict] = []
    for fname, kind in EXPERIENCES:
        path = os.path.join(DIR, fname)
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf8'):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            text = json.dumps(rec.get('sar') or {}, ensure_ascii=False) + str(rec.get('rawText') or '')
            rec['_text'] = text
            rec['_file'] = fname
            rec['_kind'] = kind
            rows.append(rec)
    return rows


def registry() -> dict:
    if not os.path.exists(REGISTRY):
        return {'entries': [], 'baselineUncovered': [], 'note': '登记簿缺失'}
    try:
        return json.load(open(REGISTRY, encoding='utf8'))
    except Exception:
        return {'entries': [], 'baselineUncovered': [], 'note': '登记簿损坏'}


def suite_text() -> str:
    try:
        return open(SUITE, encoding='utf8').read()
    except Exception:
        return ''


def scan() -> dict:
    reg = registry()
    linked = {e['expId']: e for e in reg.get('entries', []) if e.get('expId')}
    exempt = {e['expId'] for e in reg.get('entries', []) if e.get('exempt')}
    exempt |= {str(e.get('expId')) for e in (reg.get('exemptions') or []) if isinstance(e, dict)}
    exempt |= {str(x) for x in (reg.get('exemptions') or []) if isinstance(x, str)}
    baseline = set(reg.get('baselineUncovered') or [])
    suite = suite_text()

    fixish = [r for r in load_experiences() if FIX_MARKERS.search(r['_text'])]
    uncovered: list[dict] = []
    for rec in fixish:
        exp_id = str(rec.get('expId') or '')
        if not exp_id or exp_id in linked or exp_id in exempt or exp_id in baseline:
            continue
        uncovered.append({'expId': exp_id, 'ts': rec.get('timestamp'),
                          'snippet': rec['_text'][:120]})

    # 断言腐烂: 登记过但套件里已经找不到这个断言组 => 以为有保护其实没有。
    # 必须匹配**组头**形式 `[T112]`, 不能用裸子串: 实测踩过——本脚本自己的正向用例
    # 把 `"assertion": "T999"` 写进了套件文本, 于是裸子串搜索认为 T999 "存在",
    # 腐烂项判不出来(判据被自己的测试数据满足, cl-132 同型)。
    rotten = []
    for entry in reg.get('entries', []):
        name = str(entry.get('assertion') or '')
        if not name:
            continue
        if not re.search(r'\[%s\]' % re.escape(name), suite):
            rotten.append({'expId': entry.get('expId'), 'assertion': name})

    # 断言在套件中存在但没有经验登记(反向缺口): 只报数, 不判红(历史断言无从回溯)
    suite_groups = sorted(set(re.findall(r'\[T(\d{2,3})\]', suite)))
    registered_groups = {str(e.get('assertion') or '') for e in reg.get('entries', [])}
    unbound = [g for g in suite_groups if ('T%s' % g) not in registered_groups]

    payload = {
        'scannedAt': datetime.datetime.now(TZ).isoformat(),
        'fixTypeExperiences': len(fixish),
        'linked': len(linked),
        'exempt': len(exempt),
        'baselineCovered': len(baseline),
        'uncovered': uncovered,
        'uncoveredCount': len(uncovered),
        'rotten': rotten,
        'suiteAssertionGroups': len(suite_groups),
        'assertionGroupsWithoutExperience': len(unbound),
        'note': ('转化缺口只对**基线之后**的新增项开火: 历史积压追不回来, '
                 '但每一条新的修复型经验都必须登记断言或写明豁免理由'),
    }
    return payload


def main() -> int:
    args = sys.argv[1:]
    payload = scan()
    if '--init-baseline' in args:
        reg = registry()
        reg['baselineUncovered'] = [u['expId'] for u in payload['uncovered']]
        reg['baselineAt'] = datetime.datetime.now(TZ).isoformat()
        reg['note'] = reg.get('note') or '经验→断言 转化登记簿'
        json.dump(reg, open(REGISTRY, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
        print('基线已写入: %d 条历史未转化项(不追溯)' % len(reg['baselineUncovered']))
        return 0
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('修复型经验 %d | 已登记断言 %d | 豁免 %d | 基线覆盖 %d | **新增缺口 %d**'
              % (payload['fixTypeExperiences'], payload['linked'], payload['exempt'],
                 payload['baselineCovered'], payload['uncoveredCount']))
        for item in payload['uncovered'][:6]:
            print('  缺口 %s: %s' % (item['expId'], item['snippet'][:70]))
        print('断言腐烂(登记过但套件里已不存在) %d' % len(payload['rotten']))
        for item in payload['rotten'][:5]:
            print('  · %s -> %s' % (item['exptrId'] if False else item['expId'], item['assertion']))
        print('套件断言组 %d 个, 其中无经验绑定 %d 个(只报数, 历史断言无从回溯)'
              % (payload['suiteAssertionGroups'], payload['assertionGroupsWithoutExperience']))
    with open(_log_path(LOG), 'a', encoding='utf8') as fh:
        fh.write('%s 修复型%d 已登记%d 新增缺口%d 腐烂%d\n'
                 % (payload['scannedAt'][:16], payload['fixTypeExperiences'], payload['linked'],
                    payload['uncoveredCount'], len(payload['rotten'])))
    if '--strict-new' in args and (payload['uncoveredCount'] > 0 or payload['rotten']):
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
