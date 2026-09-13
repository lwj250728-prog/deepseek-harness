#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wait-check-diversity-arm.py — cl-284 δ 实验的**样本门**(条件型等待, 不是日历型)。

为什么需要它: cl-284 的预登记写死了"每臂 ≥20 个可判回合且 ≥12 小时, 不足则只报计数不下结论"。
而"到点判读"这一步在**驱动侧**是行动帧 —— 行动帧只认条件不认日历(cl-250/cl-126 一族), 门没挂上时
每一轮都会把它当"该干了"重复催办(**实测**: 本目标在 09-13 12:3x 就收到过一枚针对 09-14 才可判读的帧)。
故把预登记的样本要求做成机器可判的条件门:

条件(全部满足才 exit 0):
  ① 活配置里 `diversityBonus.enabled` 为真(**B 臂真的在跑**, 不是只有一行配置);
  ② 能定出 B 臂起点: dsh-web 进程启动时刻(配置与 lib 必须先于它改动, 否则这一版没生效);
  ③ 起点至今 ≥ `--min-hours`(默认 12);
  ④ 起点之后**带 `retrievedIds` 的审计行数** ≥ `--min-turns`(默认 20) —— 这是"可判回合"的机器口径。

任何读数失败 ⇒ exit 1(fail-closed: 绝不冒充"满足")。
用法: dsh-wait-check-diversity-arm.py [--min-hours 12] [--min-turns 20] [--json]
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
PROFILE = os.environ.get('DSH_WEB_CONFIG') or os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml')
TZ = datetime.timezone(datetime.timedelta(hours=8))


def arm_enabled() -> tuple[bool, str]:
    """活配置里 B 臂是否开启(以及 δ 值)。读不到 ⇒ fail-closed 视为未开。"""
    try:
        text = open(PROFILE, encoding='utf8').read()
    except Exception as exc:  # noqa: BLE001
        return False, '活配置读不到(%s)' % exc
    m = re.search(r'diversityBonus:\s*\{([^}]*)\}', text)
    if m is None:
        return False, '活配置里没有 diversityBonus(未接 B 臂)'
    body = m.group(1)
    enabled = re.search(r'enabled:\s*(true|false)', body)
    delta = re.search(r'delta:\s*([0-9.]+)', body)
    if enabled is None or enabled.group(1) != 'true':
        return False, 'diversityBonus.enabled 不是 true'
    return True, 'δ=%s' % (delta.group(1) if delta else '?')


def process_start() -> datetime.datetime | None:
    try:
        pid = subprocess.run(['systemctl', '--user', 'show', 'dsh-web.service', '-p', 'MainPID', '--value'],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        if not pid:
            return None
        out = subprocess.run(['ps', '-o', 'etimes=', '-p', pid], capture_output=True, text=True, timeout=30).stdout.strip()
        if not out.isdigit():
            return None
        return datetime.datetime.now(TZ) - datetime.timedelta(seconds=int(out))
    except Exception:  # noqa: BLE001
        return None


def readable_turns(since: datetime.datetime) -> int:
    """起点之后带 retrievedIds 的审计行数(='可判回合'的机器口径)。"""
    p = os.path.join(D, 'retrieval-audit.jsonl')
    if not os.path.exists(p):
        return -1
    n = 0
    with open(p, encoding='utf8') as fh:
        for line in fh:
            if line.strip() == '':
                continue
            try:
                r = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if r.get('retrievedIds') is None:
                continue
            t = r.get('t')
            if not isinstance(t, (int, float)):
                continue
            if datetime.datetime.fromtimestamp(t / 1000, TZ) >= since:
                n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-hours', type=float, default=12.0)
    ap.add_argument('--min-turns', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    on, why = arm_enabled()
    if not on:
        print('[wait-diversity] B 臂未在跑(%s) ⇒ 继续等待(判读需要 B 臂先见效)' % why)
        return 1
    start = process_start()
    if start is None:
        print('[wait-diversity] 取不到 dsh-web 进程启动时刻 ⇒ fail-closed 视为未满足')
        return 1
    # 2026-09-13 13:0x **自查抓出(我自己的 docstring 声明了但没实现)**: 文档写"配置与 lib 必须先于进程启动,
    # 否则这一版没生效", 而代码只看进程启动时刻 ⇒ 会把"δ 还没生效的那段"也算进 B 臂时长(实测: 进程起于
    # 10:57 而配置改于 12:34, 门却报"B 臂已跑 2.1h")。这会让 12h 窗口里混进 A 臂数据, 直接污染 A/B 对照。
    # 修法: B 臂起点 = max(进程启动, 活配置 mtime, 产物 lib mtime); 若配置/lib 比进程新 ⇒ 明说"还没生效"。
    lib = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       'packages/context/cognitive-inject/lib/index.js')
    stamps = [(start, '进程启动')]
    for path, label in ((PROFILE, '活配置'), (lib, '产物 lib')):
        try:
            stamps.append((datetime.datetime.fromtimestamp(os.path.getmtime(path), TZ), label))
        except OSError:
            print('[wait-diversity] 读不到 %s 的 mtime ⇒ fail-closed 视为未满足' % label)
            return 1
    newest, which = max(stamps, key=lambda x: x[0])
    if newest > start:
        print('[wait-diversity] B 臂**还没生效**: %s(%s) 晚于进程启动(%s) ⇒ 等重启把它带上, 继续等待'
              % (which, newest.strftime('%F %T'), start.strftime('%F %T')))
        return 1
    start = newest
    elapsed_h = (datetime.datetime.now(TZ) - start).total_seconds() / 3600.0
    turns = readable_turns(start)
    payload = {'arm': why, 'armSince': start.isoformat(), 'armSinceBasis': which, 'elapsedHours': round(elapsed_h, 2),
               'judgeableTurns': turns, 'minHours': args.min_hours, 'minTurns': args.min_turns}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    if elapsed_h < args.min_hours:
        print('[wait-diversity] B 臂只跑了 %.1fh(< %.0fh) ⇒ 继续等待(还差 %.1f 小时)'
              % (elapsed_h, args.min_hours, args.min_hours - elapsed_h))
        return 1
    if turns < 0:
        print('[wait-diversity] 读不到审计账本 ⇒ fail-closed 视为未满足')
        return 1
    if turns < args.min_turns:
        print('[wait-diversity] 可判回合 %d < %d(自 B 臂起跑) ⇒ 继续等待, 不打扰' % (turns, args.min_turns))
        return 1
    print('[wait-diversity] 条件已满足: B 臂已跑 %.1fh ≥ %.0fh 且可判回合 %d ≥ %d ⇒ 该复算三项预登记判据了'
          % (elapsed_h, args.min_hours, turns, args.min_turns))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
