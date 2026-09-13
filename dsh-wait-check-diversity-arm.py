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
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')



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

def pkg_of(path: str) -> str:
    """从绝对路径取出包名(如 packages/context/cognitive-inject)。
    2026-09-13 14:5x 自查: 初版写 `'/'.join(p.split('/')[1:3])` —— 对**绝对路径**会切出 'home/ubuntu'
    (自测时当场暴露), 于是"声明集 vs 实际集"的比较永远不相等 ⇒ 前置形同虚设。"""
    parts = [x for x in path.split('/') if x]
    if 'packages' in parts:
        i = parts.index('packages')
        return '/'.join(parts[i:i + 3])
    return path


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


def resolve_lib_key(path: str) -> str:
    """把基线里的 lib 键解析成绝对路径 —— **相对键一律按 REPO 解析, 不按调用方 CWD**。

    2026-09-13 15:0x **sibling 会话抓到的真 bug**: `write_rebaseline()` 用 `ls -d packages/*/*/lib/index.js`
    且 cwd=REPO ⇒ 写出的键是**相对**的; 而 `changed_libs()` 里 `os.path.exists(相对键)` 按**调用方 CWD** 解析
    ⇒ 在 /home/ubuntu/dsh-fork 跑=正常, 在 /tmp 或 $HOME 跑=**231 个键全判缺失** ⇒ 报"不可识别"。dsh-web 的
    CWD 恰好是仓库所以今天蒙对了, 而 **cron 的默认 CWD 是 $HOME ⇒ 门会永久卡住**(冻结的重开条件(b)永不触发)。
    修法: 相对键按 REPO 解析; 新写的基线一律用绝对键。
    """
    p = os.path.expanduser(str(path))
    return p if os.path.isabs(p) else os.path.join(REPO, p)


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
        fp = resolve_lib_key(path)
        if not os.path.exists(fp):
            changed.append(str(path) + '(缺失)')
            continue
        cur = hashlib.sha256(open(fp, 'rb').read()).hexdigest()
        if cur != want:
            changed.append(str(path))
    return changed, '基线记于 %s(%d 个 lib)' % (str(base.get('at'))[:19], len(hashes))


def write_rebaseline(intent: list[str]) -> int:
    """把当前 lib 集哈希记为 δ 窗口的基线 —— 但**必须声明这个窗口里都有什么**。

    2026-09-13 14:4x **cl-310 的更正成立**: 初版 `--rebaseline` **没有干净性前置** —— 在任何状态下跑,
    它都会把当时那套 lib 冻成"基线", 于是门之后必然报"变革集 ⊆ {cognitive-inject} ⇒ 可识别", 而窗口里其实
    还夹着别的包(实测: 相对 `deploy-lib-hashes` 基线变更有 **10 个** lib)。那等于**把污染冻成假干净**。
    修法: 必须显式声明 `--intent <包列表>`, 且**实际变更集要与之逐字相等**(相等而非包含: 声明子集会把未声明的包
    悄悄带进窗口); 基线里同时记下 intent 与实际变更清单, 让**每一次读数都带着"本窗口是 δ + 哪些包"这个标签**。
    """
    import hashlib, subprocess as sp
    out = sp.run(['bash', '-lc',
                  'cd %s && ls -d packages/*/*/lib/index.js 2>/dev/null' % REPO],
                 capture_output=True, text=True, timeout=120).stdout.split()
    if not out:
        print('[wait-diversity] 找不到任何 lib/index.js ⇒ 不记基线', file=sys.stderr)
        return 3
    if not intent:
        print('[wait-diversity] 拒绝记基线: 必须用 --intent 声明这个窗口里都变更了哪些包(空窗口就写 none)。'
              '没有声明就记基线 = 把当时的污染冻成"干净基线"(cl-310)。', file=sys.stderr)
        return 3
    # 参照必须是**A 臂时代的** lib 快照, 而不是 `deploy-lib-hashes.json` —— 后者每次部署都会被自己刷新
    # (2026-09-13 14:5x 实测: 14:52 那次部署一跑, 它立刻变成"当前状态", 差集归零 ⇒ 前置形同虚设)。
    # 故用一份**只读的** A 臂参照 `diversity-arm-aref.json`(从当日 03:30 备份里取出, 见 --set-aref)。
    base_p = os.path.join(D, 'diversity-arm-aref.json')
    try:
        old = json.load(open(base_p, encoding='utf8')).get('hashes') or {}
    except Exception as exc:  # noqa: BLE001
        print('[wait-diversity] 读不到 A 臂参照(%s) ⇒ 判不了"实际变更集" ⇒ 拒记。'
              '缺少它请用 --set-aref <某次备份里的 deploy-lib-hashes.json>' % exc, file=sys.stderr)
        return 3
    actual = []
    for path, want in old.items():
        fp = resolve_lib_key(path)
        if not os.path.exists(fp):
            actual.append(str(path)); continue
        if hashlib.sha256(open(fp, 'rb').read()).hexdigest() != want:
            actual.append(str(path))
    act_pkgs = sorted({pkg_of(p) for p in actual})
    want_pkgs = sorted(set(intent))
    if act_pkgs != want_pkgs:
        print('[wait-diversity] **拒绝记基线: 声明的意图集与实际变更集不相等**\n'
              '  实际变更: %s\n  声明意图: %s\n'
              '  (相等要求是刻意的: 声明子集会把未声明的包悄悄带进窗口 ⇒ 之后门报"可识别"是假的)'
              % (act_pkgs, want_pkgs), file=sys.stderr)
        return 3
    # 一律写**绝对**键(相对键会把判决绑到调用方 CWD 上 —— 见 resolve_lib_key 的注释)
    hashes = {os.path.abspath(p): hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in out}
    start = process_start()
    payload = {'at': datetime.datetime.now(TZ).isoformat(),
               'processStart': start.isoformat() if start else None,
               'hashes': hashes,
               'declaredIntent': want_pkgs,
               'changedAtBaseline': act_pkgs,
               'windowLabel': 'δ + ' + (', '.join(act_pkgs) if act_pkgs else '(无其它包)'),
               'rule': 'δ 可识别的条件: 自此基线以来**变更的 lib 集必须 ⊆ declaredIntent**(不是"⊆{cognitive-inject}"), '
                       '因为本窗口本身就带着声明过的那些包; 出现声明外的变更 ⇒ 报不可识别'}
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
    ap.add_argument('--deadline', default='', help='声明式时限(ISO): 到点仍不满足 => 放行并标注证据不足; 写错 => fail-closed')
    ap.add_argument('--rebaseline', action='store_true', help='把当前 lib 集记为 δ 基线(干净构建+重启之后跑一次)')
    ap.add_argument('--intent', default='', help='声明本窗口里变更了哪些包(逗号分隔; 无则 none)')
    ap.add_argument('--set-aref', default='', help='把某份(备份里的) deploy-lib-hashes.json 记为**只读的 A 臂参照**')
    args = ap.parse_args()

    # 2026-09-13 15:1x: 池内门活性判据(dsh-goal-gate-liveness.py)实测**三个 active 目标的门全部无界**
    # => 系统可能永久静默(没有任何一条能靠时间解冻)。根因之一是这几个门没有把"时限"声明在**命令行**上,
    # 于是活性判据看不见它、也无法核验它是否被行为消费。此处按 cl-266/T201 的先例统一补上:
    #   · 时限解析不了 => fail-closed 不放行(绝不因为"写了个坏时限"而放行);
    #   · 到点仍不满足 => 放行, 但**必须显式标注**"放行理由=deadline / 证据不足"(时限放行 != 条件已满足)。
    _dl_passed, _dl_state = _deadline_state(args.deadline)
    if _dl_state == 'bad':
        print('[diversity-arm] 时限写错(' + repr('%r') + ' 无法解析) => fail-closed 不放行')
        return 1
    if _dl_passed:
        print('[diversity-arm] 时限已到而条件仍未满足 => 按**时限放行**并标注放行理由=deadline(证据不足, 不得当作条件已满足)')
        return 0
    if args.set_aref:
        import shutil
        src = os.path.expanduser(args.set_aref)
        if not os.path.exists(src):
            print('[wait-diversity] 找不到 %s' % src, file=sys.stderr)
            return 3
        dst = os.path.join(D, 'diversity-arm-aref.json')
        data = json.load(open(src, encoding='utf8'))
        data['note'] = ('δ 实验的 **A 臂参照**: 这份 lib 哈希来自 A 臂测量时代(部署前)。'
                        '--rebaseline 会拿当前 lib 与它比对, 并要求 --intent 与之**逐字相等** —— '
                        '这样"本窗口里都有什么"是被声明且可审计的, 而不是把污染冻成假干净(cl-310)。')
        tmp = dst + '.tmp'
        json.dump(data, open(tmp, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        os.replace(tmp, dst)
        print('[wait-diversity] 已记 A 臂参照: %d 个 lib → %s' % (len(data.get('hashes') or {}), dst))
        return 0
    if args.rebaseline:
        intent = [] if args.intent.strip().lower() in ('', 'none', '无') else [x.strip() for x in args.intent.split(',') if x.strip()]
        return write_rebaseline(intent)

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
    base_p = os.path.join(D, 'diversity-arm-baseline.json')
    intent = []
    label = ''
    if os.path.exists(base_p):
        try:
            b = json.load(open(base_p, encoding='utf8'))
            intent = list(b.get('declaredIntent') or [])
            label = str(b.get('windowLabel') or '')
        except Exception:  # noqa: BLE001
            intent, label = [], ''
    changed_pkgs = sorted({pkg_of(c) for c in (changed or [])})
    foreign = [c for c in changed_pkgs if c not in intent]
    if foreign:
        print('[wait-diversity] **B 臂不可识别**: 自 δ 基线以来出现**声明外**的包变更 %s ⇒ A/B 差别不止 δ '
              '(基线声明本窗口只含 %s) ⇒ 本窗口读数不可用作 δ 归因'
              % (foreign[:5], intent or ['(空)']))
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
