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


def freeze_path() -> str:
    d = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
    return os.path.join(d, 'retrieval-freeze.json')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
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
