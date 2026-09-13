#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-chain-inject-report.py — 链注入(检索侧)的**判定仪表**: 生效了吗? 有用吗? 贵不贵?

为什么先建仪表(cl-354): cl-351 已经预登记了判据(链 citedCount>0 / 经验侧引用率不降 / chainChars 中位<=900),
但**判据要在数据到来之前就存在**, 否则事后挑口径就是自证。当前链记录 0 条(载体未加载), 正是建它的时机。

口径上最容易出错的三处, 仪表显式处理:
  ① **一次性会话会污染引用率**: quiet-frame-* 的注入没有"下一个回合"能提及它, 结算侧按设计立刻判未引用
     (cl-044/cl-270) ⇒ 把 182 条这类记录混进去会把引用率整体压低。仪表按会话类型**分开报**, 判据只用常规会话。
  ② **"未测到"不是"测到 0"**: chainChars 只在新代码加载后才有; 没有就把成本判据标成**未测**(not-measured),
     绝不折算成"通过"。
  ③ **样本不足不是通过**: 链记录 < MIN_N 时结论是**不可判**, 单独一个退出码(2), 与"通过(0)/不通过(1)"区分。

用法:
  dsh-chain-inject-report.py [--json] [--min-n 10] [--margin 0.2]
  DSH_CHAIN_REPORT_LEDGER=<injections.jsonl>   替代账本(判据/探针用它注入夹具)
  DSH_CHAIN_REPORT_AUDIT=<audit.jsonl>         替代审计(取 chainChars; 缺失 ⇒ 成本未测)
退出码: 0 = 判据通过; 1 = 判据不通过(指名哪条); 2 = 不可判(无链记录/样本不足); 3 = 环境不成立。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import statistics
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
COG = os.path.expanduser('~/.dsh/cognitive-pipeline')


def load_jsonl(path: str) -> list[dict]:
    if not path or not os.path.exists(path):
        return []
    rows = []
    for line in open(path, encoding='utf8'):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def is_one_shot(session_id: object) -> bool:
    return str(session_id or '').startswith('quiet-frame-')


def rate(rows: list[dict]) -> tuple[int, int, float | None]:
    """已结算记录的引用率(None = 无已结算样本, 不是 0)。"""
    settled = [r for r in rows if r.get('cited') is not None]
    if not settled:
        return 0, 0, None
    cited = sum(1 for r in settled if r.get('cited') is True)
    return cited, len(settled), cited / len(settled)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--min-n', type=int, default=int(os.environ.get('DSH_CHAIN_REPORT_MIN_N') or 10))
    ap.add_argument('--margin', type=float, default=0.2, help='经验侧引用率允许的相对下降幅度')
    args = ap.parse_args()

    ledger_path = os.environ.get('DSH_CHAIN_REPORT_LEDGER') or os.path.join(COG, 'injections.jsonl')
    audit_path = os.environ.get('DSH_CHAIN_REPORT_AUDIT') or os.path.join(COG, 'retrieval-audit.jsonl')
    records = load_jsonl(ledger_path)
    if not records and not os.path.exists(ledger_path):
        print('[chain-report] 账本不存在: %s ⇒ 环境不成立' % ledger_path, file=sys.stderr)
        return 3

    chain = [r for r in records if r.get('chainId')]
    plain = [r for r in records if not r.get('chainId')]
    chain_normal = [r for r in chain if not is_one_shot(r.get('sessionId'))]
    plain_normal = [r for r in plain if not is_one_shot(r.get('sessionId'))]

    c_cited, c_n, c_rate = rate(chain)
    p_cited, p_n, p_rate = rate(plain)
    cc_cited, cc_n, cc_rate = rate(chain_normal)
    pc_cited, pc_n, pc_rate = rate(plain_normal)

    # 基线窗口: 第一条链记录**之前**的常规会话注入; 之后为观测窗口(按 cl-351 的口径)。
    first_chain_at = min((r.get('createdAt') or 0) for r in chain) if chain else None
    if first_chain_at is not None:
        before = [r for r in plain_normal if (r.get('createdAt') or 0) < first_chain_at]
        after = [r for r in plain_normal if (r.get('createdAt') or 0) >= first_chain_at]
    else:
        before, after = plain_normal, []
    b_cited, b_n, b_rate = rate(before)
    a_cited, a_n, a_rate = rate(after)

    audit = load_jsonl(audit_path)
    chars = [x.get('chainChars') for x in audit if isinstance(x.get('chainChars'), (int, float)) and x.get('chainChars')]
    median_chars = statistics.median(chars) if chars else None

    criteria = []
    # 判据只用**可引用人口**: quiet-frame-* 的注入没有"下一个回合"能提及它, 结算侧按设计立刻判未引用
    # (cl-044/cl-270) ⇒ 把它们计入样本, 会把"不可判"变成"不通过", 并把引用率整体压低。它们只作信息报告。
    criteria.append({
        'name': '可引用样本足够(常规会话链记录 >= %d)' % args.min_n,
        'value': {'normal': len(chain_normal), 'oneShot': len(chain) - len(chain_normal)},
        'ok': len(chain_normal) >= args.min_n, 'measured': True,
    })
    criteria.append({
        'name': '链至少被引用过一次(citedCount > 0, 仅常规会话)',
        'value': cc_cited, 'ok': cc_cited > 0, 'measured': True,
    })
    # 经验侧不降: 与"第一条链记录之前"的常规会话引用率比(margin 内视为不降)
    ok_rate = True if (b_rate is None or a_rate is None) else a_rate >= b_rate * (1 - args.margin)
    criteria.append({
        'name': '经验侧引用率不降(相对基线降幅 <= %.0f%%)' % (args.margin * 100),
        'value': {'before': None if b_rate is None else round(b_rate, 4),
                  'after': None if a_rate is None else round(a_rate, 4),
                  'beforeN': b_n, 'afterN': a_n},
        'ok': ok_rate,
        'measured': not (b_rate is None or a_rate is None),
    })
    criteria.append({
        'name': '成本: 链段落字符中位 <= 900',
        'value': None if median_chars is None else round(median_chars, 1),
        'ok': True if median_chars is None else median_chars <= 900,
        'measured': median_chars is not None,
    })

    if len(chain_normal) < args.min_n:
        # 没有链记录 = 机制还没生效(not-yet); 有链记录但**可引用人口**不足 = 已生效但样本不够(insufficient)。
        outcome = 'not-yet' if not chain else 'insufficient'
    else:
        outcome = 'pass' if all(c['ok'] for c in criteria if c['measured']) else 'fail'
    pending = outcome in ('not-yet', 'insufficient')
    failing = [] if pending else [c['name'] for c in criteria if c['measured'] and not c['ok']]
    not_yet = [c['name'] for c in criteria if c['measured'] and not c['ok']] if pending else []

    data = {
        'outcome': outcome, 'failing': failing, 'notYet': not_yet, 'minN': args.min_n,
        'ledger': ledger_path, 'audit': audit_path,
        'totals': {'records': len(records), 'chain': len(chain), 'plain': len(plain),
                   'chainNormal': len(chain_normal), 'plainNormal': len(plain_normal)},
        'rates': {
            'chain': {'cited': c_cited, 'settled': c_n, 'rate': c_rate},
            'plain': {'cited': p_cited, 'settled': p_n, 'rate': p_rate},
            'chainNormalSessions': {'cited': cc_cited, 'settled': cc_n, 'rate': cc_rate},
            'plainNormalSessions': {'cited': pc_cited, 'settled': pc_n, 'rate': pc_rate},
            'baselineWindow': {'cited': b_cited, 'settled': b_n, 'rate': b_rate},
            'observedWindow': {'cited': a_cited, 'settled': a_n, 'rate': a_rate},
        },
        'firstChainInjectionAt': first_chain_at,
        'chainCharsMedian': median_chars,
        'criteria': criteria,
    }
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print('[chain-report] 账本 %d 条 | 链记录 %d / 常规会话链记录 %d'
              % (len(records), len(chain), len(chain_normal)))
        fmt = lambda r: 'n/a' if r['rate'] is None else '%d/%d=%.1f%%' % (r['cited'], r['settled'], r['rate'] * 100)
        print('  引用率(含一次性会话): 链 %s | 经验 %s   ← 一次性会话按设计立刻判未引用, 混进来会压低' % (fmt(data['rates']['chain']), fmt(data['rates']['plain'])))
        print('  引用率(仅常规会话):   链 %s | 经验 %s' % (fmt(data['rates']['chainNormalSessions']), fmt(data['rates']['plainNormalSessions'])))
        print('  经验侧基线窗口 %s → 观测窗口 %s' % (fmt(data['rates']['baselineWindow']), fmt(data['rates']['observedWindow'])))
        for c in criteria:
            mark = '✓' if c['ok'] else '✗'
            if not c['measured']:
                mark = '—(未测)'
            print('  %s %s  %s' % (mark, c['name'], json.dumps(c['value'], ensure_ascii=False)))
        tail = ''
        if not_yet:
            tail = ' —— 待判(不是不通过): ' + '; '.join(not_yet)
        elif failing:
            tail = ' —— 未过: ' + '; '.join(failing)
        print('[chain-report] 结论: %s%s' % (outcome, tail))
    if outcome in ('not-yet', 'insufficient'):
        return 2
    return 0 if outcome == 'pass' else 1


if __name__ == '__main__':
    sys.exit(main())
