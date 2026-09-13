#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-retrieval-freeze.py — 检索侧的**用户指令冻结**门(cl-284/检索目标)。

由来(2026-09-13 14:4x, 用户指示「好，暂时不动检索」): 冻结如果只写在我脑子里, 驱动侧**不认日历也不认指示** ——
它会照旧按时把"检索目标的 nextAction 已就绪"推成行动帧(实测本目标已被催办多次)。按 cl-250/cl-126 的纪律,
条件型等待必须在**驱动侧**生效: 挂一个 waitChecker, 满足才放行。

条件(exit 0 = 该驱动检索目标):
  · 冻结**未声明**(缺文件) ⇒ 0(没有冻结, 该干就干);
  · 冻结**已解除**(`lifted: true`) ⇒ 0;
  · 冻结**已过期**(`reviewBy` 已过) ⇒ 0 并打印"冻结到期, 需重新裁决"(把决定权交回, 不静默续冻);
  · 否则(冻结生效中) ⇒ 1 并打印冻结范围与重开条件。
读数失败(fail-closed) ⇒ 1: 读不到冻结状态时**不驱动**(宁可停着, 也不在状态不明时动检索)。

用法: dsh-wait-check-retrieval-freeze.py [--json]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))



def _deadline_state(raw):
    """-> (是否已过, 'none'|'passed'|'bad')。空串=未声明时限(none)。

    自包含: 不依赖模块级 TZ(某个门里没有定义它 —— 2026-09-13 15:1x 实测 NameError)。
    """
    tz = datetime.timezone(datetime.timedelta(hours=8))
    raw = (raw or '').strip()
    if not raw:
        return False, 'none'
    try:
        d = datetime.datetime.fromisoformat(raw)
    except Exception:
        return False, 'bad'
    d = d if d.tzinfo else d.replace(tzinfo=tz)
    return (datetime.datetime.now(tz) >= d), 'passed'

def freeze_path() -> str:
    d = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
    return os.path.join(d, 'retrieval-freeze.json')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--deadline', default='', help='声明式时限(ISO): 到点仍不满足 => 放行并标注证据不足; 写错 => fail-closed')
    args = ap.parse_args()

    # 2026-09-13 15:1x: 池内门活性判据(dsh-goal-gate-liveness.py)实测**三个 active 目标的门全部无界**
    # => 系统可能永久静默(没有任何一条能靠时间解冻)。根因之一是这几个门没有把"时限"声明在**命令行**上,
    # 于是活性判据看不见它、也无法核验它是否被行为消费。此处按 cl-266/T201 的先例统一补上:
    #   · 时限解析不了 => fail-closed 不放行(绝不因为"写了个坏时限"而放行);
    #   · 到点仍不满足 => 放行, 但**必须显式标注**"放行理由=deadline / 证据不足"(时限放行 != 条件已满足)。
    _dl_passed, _dl_state = _deadline_state(args.deadline)
    if _dl_state == 'bad':
        print('[retrieval-freeze] 时限写错(' + repr('%r') + ' 无法解析) => fail-closed 不放行')
        return 1
    if _dl_passed:
        print('[retrieval-freeze] 时限已到而条件仍未满足 => 按**时限放行**并标注放行理由=deadline(证据不足, 不得当作条件已满足)')
        return 0
    p = freeze_path()
    if not os.path.exists(p):
        print('[freeze] 未声明冻结(缺 %s) ⇒ 放行' % p)
        return 0
    try:
        f = json.load(open(p, encoding='utf8'))
    except Exception as exc:  # noqa: BLE001
        print('[freeze] 冻结状态读不了(%s) ⇒ fail-closed 视为冻结中(状态不明时不驱动检索)' % exc)
        return 1
    if f.get('lifted') is True:
        print('[freeze] 冻结已解除(%s) ⇒ 放行' % str(f.get('liftedAt'))[:19])
        return 0
    rb = str(f.get('reviewBy') or '')
    now = datetime.datetime.now(TZ)
    if rb:
        try:
            due = datetime.datetime.fromisoformat(rb)
            due = due if due.tzinfo else due.replace(tzinfo=TZ)
            if now > due:
                print('[freeze] 冻结**已到期**(reviewBy=%s) ⇒ 放行, 但需重新裁决: 是续冻还是解冻? '
                      '按用户指示冻结的条目, 续冻必须由用户重新确认' % rb)
                return 0
        except Exception:  # noqa: BLE001
            print('[freeze] reviewBy 解析不了(%r) ⇒ fail-closed 视为冻结中' % rb)
            return 1
    if args.json:
        print(json.dumps(f, ensure_ascii=False))
    print('[freeze] 检索侧**冻结中**(%s 起, 依据: %s) ⇒ 不驱动; 重开条件: %s'
          % (str(f.get('at'))[:19], str(f.get('by'))[:40], str(f.get('reopenWhen'))[:120]))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
