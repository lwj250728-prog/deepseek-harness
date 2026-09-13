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


def changed_libs() -> tuple[list[str] | None, str]:
    """自 δ 基线以来**内容真变**的 lib 集 → (集合, 说明)。

    2026-09-13 14:3x(cl-308 的正确批评): 原先只钉 `cognitive-inject` 一个 lib 的 mtime ⇒ **无法发现"同一次
    重启还带上了别的包"**。实测 14:09 那次全量重建刷新 183 个 lib、内容真变 9 个(含 quiet-driver), 而门照旧
    报"B 臂已跑 0.3h" ⇒ **读数不可识别**(A/B 差别不止 δ)。故改成看**变更 lib 集**: 集 ⊆ {cognitive-inject} 才算
    δ 可识别; 基线用 --rebaseline 记(干净的构建+重启之后记一次)。
    """
    base_p = os.path.join(D, 'diversity-arm-baseline.json')
    if not os.path.exists(base_p):
        return None, '缺 δ 基线(%s) ⇒ 判不了"只有 δ 变了没"; 修法: 干净构建+重启后跑 --rebaseline' % base_p
    try:
        base = json.load(open(base_p, encoding='utf8'))
    except Exception as exc:  # noqa: BLE001
        return None, 'δ 基线读不了(%s)' % exc
    hashes = base.get('hashes') or {}
    if not hashes:
        return None, 'δ 基线里没有哈希表'
    import hashlib
    changed = []
    for path, want in hashes.items():
        fp = os.path.expanduser(path)
        if not os.path.exists(fp):
            changed.append(path + '(缺失)')
            continue
        cur = hashlib.sha256(open(fp, 'rb').read()).hexdigest()
        if cur != want:
            changed.append(path)
    return changed, '基线记于 %s(%d 个 lib)' % (str(base.get('at'))[:19], len(hashes))


def write_rebaseline() -> int:
    """把当前 lib 集哈希记为 δ 窗口的基线(只在**干净构建+重启之后**跑一次)。"""
    import hashlib, subprocess as sp
    out = sp.run(['bash', '-lc',
                  'cd %s && ls -d packages/*/*/lib/index.js 2>/dev/null' % REPO],
                 capture_output=True, text=True, timeout=120).stdout.split()
    if not out:
        print('[wait-diversity] 找不到任何 lib/index.js ⇒ 不记基线', file=sys.stderr)
        return 3
    hashes = {p: hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in out}
    start = process_start()
    payload = {'at': datetime.datetime.now(TZ).isoformat(),
               'processStart': start.isoformat() if start else None,
               'hashes': hashes,
               'rule': 'δ 可识别的条件: 自此基线以来**变更的 lib 集 ⊆ {cognitive-inject}**; 其它包一变 ⇒ 报不可识别'}
    p = os.path.join(D, 'diversity-arm-baseline.json')
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    print('[wait-diversity] 已记 δ 基线: %d 个 lib → %s' % (len(hashes), p))
    return 0


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
    ap.add_argument('--rebaseline', action='store_true', help='把当前 lib 集记为 δ 基线(干净构建+重启之后跑一次)')
    args = ap.parse_args()
    if args.rebaseline:
        return write_rebaseline()

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
    changed, why_changed = changed_libs()
    if changed is None:
        print('[wait-diversity] %s' % why_changed)
        return 1
    foreign = sorted({c for c in changed if 'context/cognitive-inject' not in c})
    if foreign:
        print('[wait-diversity] **B 臂不可识别**: 自 δ 基线以来这些包也变了 %s ⇒ A/B 差别不止 δ '
              '(门此前只钉 cognitive-inject 一个 lib, 看不见同批的其它包) ⇒ 本窗口的读数不可用作 δ 归因'
              % foreign[:5])
        return 1
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
