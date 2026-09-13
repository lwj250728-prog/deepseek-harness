#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-suite-baseline.py — **增长闸门**: 新增判据不得抬高套件红数(cl-374 / tp-213 / T257)

为什么需要它(本期实证): 我在两天里给套件加了 T246–T255 十条判据与若干探针, 结果套件裁决
  03:48 = 633 通过 / 12 失败  →  06:08 = 636 通过 / 22 失败
**通过数只 +3, 失败数 +10** —— 而我一直用单条断言的结果宣称"绿"。缺的不是"再跑一次", 是一条**会拦住我的闸门**。

判据(与实现无关的三条):
  ① **新红必判红**: 本次失败集合里出现基线里没有的项 ⇒ exit 1, 并**指名**是哪些(必须由新增者处置或显式登记为存量);
  ② **缩小即棘轮**: 本次失败集合是基线的**真子集** ⇒ 原子写回基线(保留权限位), 让"修好之后又坏回去"能被抓住;
  ③ **比成员不比数量**: 数量相同但成员不同的"替换"(修好一条又弄坏另一条)必须被判红 —— 只比数量会完全漏掉。

用法:
  dsh-suite-baseline.py --compare <current.json>   # {"assertions": N, "failing": ["断言名", ...]}
  dsh-suite-baseline.py --show
注入点(判据/探针用): DSH_SUITE_BASELINE=<path>  替代默认基线文件
退出码: 0 = 不更坏(可能同时已棘轮); 1 = 出现新红(指名); 3 = 环境不成立(读不到/写不进)。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
DEFAULT = os.path.join(os.path.expanduser('~/.dsh/cognitive-pipeline'), 'suite-baseline.json')


def baseline_path() -> str:
    return os.environ.get('DSH_SUITE_BASELINE') or DEFAULT


def load(path: str) -> dict:
    if not os.path.exists(path):
        return {'assertions': 0, 'failing': [], 'createdAt': None, 'ratchets': []}
    with open(path, encoding='utf8') as fh:
        data = json.load(fh)
    data.setdefault('failing', [])
    data.setdefault('assertions', 0)
    data.setdefault('ratchets', [])
    return data


def save(path: str, data: dict) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, os.stat(path).st_mode & 0o7777)      # 覆写保留权限位(cl-332 的教训)
    except OSError:
        pass
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--compare', help='本次裁决 JSON 路径: {"assertions": N, "failing": [名字]}')
    ap.add_argument('--show', action='store_true')
    args = ap.parse_args()
    path = baseline_path()

    if args.show or not args.compare:
        data = load(path)
        print('[suite-baseline] %s | 断言 %s | 失败 %d 条 | 棘轮 %d 次 | 更新 %s'
              % (path, data.get('assertions'), len(data.get('failing') or []),
                 len(data.get('ratchets') or []), str(data.get('updatedAt'))[:19]))
        for f in sorted(data.get('failing') or []):
            print('   - %s' % f)
        return 0

    try:
        with open(args.compare, encoding='utf8') as fh:
            cur = json.load(fh)
    except Exception as exc:
        print('[suite-baseline] 读不到本次裁决: %s ⇒ 环境不成立' % exc, file=sys.stderr)
        return 3
    cur_failing = set(cur.get('failing') or [])
    cur_assertions = int(cur.get('assertions') or 0)
    base = load(path)
    base_failing = set(base.get('failing') or [])

    # **引导(bootstrap)**: 基线还不存在时, 把本次当成**存量登记**而不是"全是新红" ——
    # 否则第一次运行必然判红、基线永远建不起来(自测 ① 就是这么空转的: --show 显示断言 0 / 失败 0 条)。
    # 必须显式可见: 打印"首次建立"并写盘。
    if base.get('createdAt') is None and not base_failing:
        base.update({'assertions': cur_assertions, 'failing': sorted(cur_failing),
                     'createdAt': datetime.datetime.now(TZ).isoformat(),
                     'updatedAt': datetime.datetime.now(TZ).isoformat(),
                     'ratchets': base.get('ratchets') or []})
        try:
            save(path, base)
        except OSError as exc:
            print('[suite-baseline] 基线写不进去: %s ⇒ 环境不成立' % exc, file=sys.stderr)
            return 3
        print('[suite-baseline] **首次建立基线**: 断言 %d / 存量红 %d 条(此后新红才判红)'
              % (cur_assertions, len(cur_failing)))
        return 0

    new_reds = sorted(cur_failing - base_failing)
    fixed = sorted(base_failing - cur_failing)

    if new_reds:
        print('[suite-baseline] **新红 %d 条**(基线里没有 ⇒ 必须由新增者处置或显式登记): %s'
              % (len(new_reds), new_reds[:6]), file=sys.stderr)
        if cur_assertions > int(base.get('assertions') or 0):
            print('[suite-baseline] 断言数 %s → %s(增加 %d) —— **新增判据把红数抬高了**'
                  % (base.get('assertions'), cur_assertions, cur_assertions - int(base.get('assertions') or 0)), file=sys.stderr)
        return 1

    ratcheted = False
    if fixed:
        record = {'at': datetime.datetime.now(TZ).isoformat(), 'fixed': fixed,
                  'from': len(base_failing), 'to': len(cur_failing)}
        base['failing'] = sorted(cur_failing)
        base['ratchets'] = (base.get('ratchets') or []) + [record]
        base['assertions'] = max(cur_assertions, int(base.get('assertions') or 0))
        base['updatedAt'] = record['at']
        if base.get('createdAt') is None:
            base['createdAt'] = record['at']
        try:
            save(path, base)
            ratcheted = True
        except OSError as exc:
            print('[suite-baseline] 棘轮写回失败(判定不受影响, 但改善没被锁住): %s' % exc, file=sys.stderr)
    else:
        # 没有新红也没有减少: 只更新断言数(用于下次判断"是否在增加判据的同时抬高了红数")
        base['assertions'] = max(cur_assertions, int(base.get('assertions') or 0))
        base['updatedAt'] = datetime.datetime.now(TZ).isoformat()
        if base.get('createdAt') is None:
            base['createdAt'] = base['updatedAt']
        try:
            save(path, base)
        except OSError:
            pass

    print('[suite-baseline] 不更坏: 断言 %d / 失败 %d 条%s'
          % (cur_assertions, len(cur_failing), (' | 已棘轮收紧 %d 条' % len(fixed)) if ratcheted else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
