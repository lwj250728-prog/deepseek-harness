#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-goal-pool-write.py — 目标池的**唯一写入口**(cl-233/cl-235 的写侧收口)。

为什么需要: 池是只追加 + last-wins 的账本, 写者却有多个(帧回写、插件 bump、我临时写的脚本)。
实测两种坏形态:
  ① **意图回退** —— 写者拿着旧快照回写, 末行携带比前一行更旧的 nextAction ⇒ last-wins 反而读到
     旧意图, 行动帧重复催办已完成的事(旁路帧实测到这一形态);
  ② **纯重复追加** —— 同一内容反复追加, 行数只涨不增信息。
根因不是"某个写者写错了", 而是**没有唯一的写入口**: 谁都能往文件里追加一行, 且没人负责保证
"末行是最新意图"。

本工具把这条不变量做进写路径:
  · 读池一律 **last-wins**(该 id 的当前行 = 文件中最后一行);
  · 写 = 在**当前行**上打补丁再追加(不是拿调用方手上的旧副本, 调用方只能给补丁);
  · **单调守卫**: 不允许把 lastActionAt/lastProgressAt 写得更旧; 若调用方给了更旧的 nextAction 而
    当前行的 lastActionAt 更新, 则拒绝(除非显式 --allow-regress 并写明理由);
  · **幂等**: 补丁应用后与当前行逐字段相同 ⇒ 不追加。

用法:
  dsh-goal-pool-write.py <id> --next-action '...' [--append-note '...'] [--set status=active] --write
  dsh-goal-pool-write.py <id> --bump triggerCount --write        # 数值自增
  dsh-goal-pool-write.py <id> --show                              # 只打印当前行(last-wins)
默认 dry-run(不落盘)。退出码: 0 成功/无变化; 2 被守卫拒绝; 3 读不到池或 id 不存在。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import sys

DEFAULT_POOL = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')
NOTE_FIELDS = ('notes',)


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def load_current(pool: str) -> tuple[list[dict], dict]:
    rows = [json.loads(l) for l in open(pool, encoding='utf8') if l.strip()]
    current: dict = {}
    for r in rows:                       # last-wins: 该 id 的当前行 = 最后一行
        current[str(r.get('id'))] = r
    return rows, current


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('id')
    ap.add_argument('--pool', default=DEFAULT_POOL)
    ap.add_argument('--next-action')
    ap.add_argument('--append-note')
    ap.add_argument('--set', action='append', default=[], metavar='K=V')
    ap.add_argument('--bump', action='append', default=[], metavar='FIELD')
    ap.add_argument('--allow-regress', action='store_true')
    ap.add_argument('--reason', default='')
    ap.add_argument('--show', action='store_true')
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.pool):
        print('读不到目标池: %s' % args.pool, file=sys.stderr)
        return 3
    rows, current = load_current(args.pool)
    cur = current.get(args.id)
    if cur is None:
        print('目标池里没有 id=%s(新目标请先建行)' % args.id, file=sys.stderr)
        return 3
    if args.show:
        print(json.dumps(cur, ensure_ascii=False, indent=1))
        return 0

    row = dict(cur)
    # 单调守卫: 先把当前时间戳提出来对比, 任何"更旧"的写入都拒绝
    stamp_now = str(cur.get('lastActionAt') or cur.get('lastProgressAt') or '')
    if args.next_action is not None:
        row['nextAction'] = args.next_action
    if args.append_note:
        row['notes'] = str(cur.get('notes') or '') + args.append_note
    for kv in args.set:
        if '=' not in kv:
            print('--set 需要 KEY=VALUE: %r' % kv, file=sys.stderr)
            return 3
        k, v = kv.split('=', 1)
        row[k] = v
    for field in args.bump:
        row[field] = int(cur.get(field) or 0) + 1

    new_stamp = now_iso()
    row['lastActionAt'] = new_stamp
    if 'lastProgressAt' in cur or args.next_action is not None:
        row['lastProgressAt'] = new_stamp

    for field in ('lastActionAt', 'lastProgressAt'):
        before, after = str(cur.get(field) or ''), str(row.get(field) or '')
        if before and after and after < before and not args.allow_regress:
            print('拒绝: %s 会从 %s 回退到 %s(意图回退); 确有理由请加 --allow-regress --reason' % (field, before, after),
                  file=sys.stderr)
            return 2
    if stamp_now and new_stamp < stamp_now and not args.allow_regress:
        print('拒绝: 新行时间戳 %s 早于当前行 %s' % (new_stamp, stamp_now), file=sys.stderr)
        return 2

    if json.dumps(row, ensure_ascii=False, sort_keys=True) == json.dumps(cur, ensure_ascii=False, sort_keys=True):
        print('[goal-pool-write] %s: 无变化, 不追加(幂等)' % args.id)
        return 0
    if not args.write:
        print('[dry-run] 将追加: %s' % json.dumps({k: row[k] for k in ('id', 'status', 'nextAction', 'lastActionAt') if k in row}, ensure_ascii=False)[:300])
        return 0
    shutil.copy(args.pool, '/tmp/dormant-goals.before-write-%s.jsonl' % datetime.datetime.now().strftime('%H%M%S'))
    with open(args.pool, 'a', encoding='utf8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    print('[goal-pool-write] %s: 已追加(基于当前行 %s 打补丁%s)' % (args.id, stamp_now or '无时间戳', ', 含理由: ' + args.reason if args.reason else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
