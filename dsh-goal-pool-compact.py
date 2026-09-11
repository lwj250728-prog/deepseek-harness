#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-goal-pool-compact.py — 目标池压实(写侧收口, cl-235)。

问题: 池是**只追加 + last-wins** 的账本, 每次写回(帧推进 nextAction、插件 bump 计数)都会追加
一行, 于是同一目标堆积多行(实测孵化 6 行/经验库 8 行/全池 19 行 7 目标)。读侧已改为 last-wins
(cl-233), 但**只治读不治写**留下两个后果:
  ① 任何仍按"文件序取首条"的旧读者会读到最老那行(已修, 但同类读者可能再出现);
  ② 更危险的是**意图回退**: 某个写者拿着旧快照回写, 末行就携带比前一行更旧的 nextAction —— 此时
     last-wins 反而读到"更旧的意图", 帧会重复催办已完成的事(旁路帧实测到这一形态)。

本工具做三件事(默认 dry-run, 不改文件):
  · 每个 id 只保留**内容最新**的一行(判据: lastActionAt/lastProgressAt 最大, 缺失则取最后一行);
  · 若发现"末行比前一行更旧"(意图回退)则**报红**, 因为那是写侧缺陷的实证, 不是压实能掩盖的;
  · --write 才落盘(先备份到 /tmp), 并给出压实前后行数。

用法:
  dsh-goal-pool-compact.py [--pool P] [--write] [--json]
退出码: 0 可压实/已压实; 2 检出意图回退(需人看); 3 读不到池。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import shutil
import sys

DEFAULT_POOL = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')


def stamp(goal: dict) -> str:
    return str(goal.get('lastActionAt') or goal.get('lastProgressAt') or goal.get('createdAt') or '')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', default=DEFAULT_POOL)
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if not os.path.exists(args.pool):
        print('读不到目标池: %s' % args.pool, file=sys.stderr)
        return 3
    rows = [json.loads(l) for l in open(args.pool, encoding='utf8') if l.strip()]
    by_id: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows:
        by_id[str(r.get('id'))].append(r)

    regressions: list[str] = []
    keep: list[dict] = []
    for gid, group in by_id.items():
        # 意图回退: 末行的时间戳早于前一行 ⇒ 有人拿旧快照回写
        if len(group) >= 2 and stamp(group[-1]) < stamp(group[-2]):
            regressions.append('%s: 末行 %s 早于前一行 %s' % (gid, stamp(group[-1]) or '?', stamp(group[-2]) or '?'))
        newest = max(group, key=stamp)
        # 时间戳全缺时按文件序取末行(视作最新)
        if stamp(newest) == '':
            newest = group[-1]
        keep.append(newest)

    payload = {
        'pool': args.pool, 'rowsBefore': len(rows), 'rowsAfter': len(keep),
        'goals': len(by_id), 'duplicatesRemoved': len(rows) - len(keep),
        'regressions': regressions, 'written': False,
        'ts': datetime.datetime.now().astimezone().isoformat(),
    }
    if args.write:
        backup = '/tmp/dormant-goals.before-compact-%s.jsonl' % datetime.datetime.now().strftime('%H%M%S')
        shutil.copy(args.pool, backup)
        with open(args.pool, 'w', encoding='utf8') as f:
            for g in keep:
                f.write(json.dumps(g, ensure_ascii=False) + '\n')
        payload['written'] = True
        payload['backup'] = backup

    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('池 %d 行 → %d 行(目标 %d 个, 去掉重复 %d 行)%s'
              % (payload['rowsBefore'], payload['rowsAfter'], payload['goals'],
                 payload['duplicatesRemoved'], '(已写入, 备份 %s)' % payload['backup'] if payload['written'] else '(dry-run)'))
        if regressions:
            print('检出意图回退(写侧缺陷实证, 非压实可掩盖):')
            for r in regressions:
                print('  · %s' % r)
    return 2 if regressions else 0


if __name__ == '__main__':
    raise SystemExit(main())
