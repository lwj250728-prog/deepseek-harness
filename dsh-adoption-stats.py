#!/usr/bin/env python3
"""按回合类别的采纳统计（唯一口径，带数据来源水位）（tp-077 / T94）。

为什么需要它：cl-116 的教训——我用 cl-100 修复**之前**的账本算出"反思类帧 0/501"，
据此立了一个默认关闭的闸门；用修复后的干净窗口重算是 5.6%（与用户回合同级）。
同一天里我把同一把坏尺子用了两次。根因不是算错，而是**每次手算、每次换窗口、没人
标注这段数据的可信起点**。

此后采纳率只有一个生产者和一套水位：
  · 水位1 citationSettlementFixedAt: cl-100 修复落地时刻——之前的帧回合引用从未被
    结算（全部记 false），任何采纳率都必须从此刻之后取数；
  · 水位2 sessionLog: 回合分类需要会话日志（哪一回合有没有真实用户消息）；
  · 输出必须同时打印窗口与水位，缺水位直接非零退出（宁可不出数，也不出没来源的数）。

用法：dsh-adoption-stats.py [--since ISO] [--session-id ID] [--json]
退出码：0 = 出数；1 = 缺水位/无可判数据。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.path.expanduser('~/dsh-fork')
SESSIONS = os.path.expanduser('~/.dsh/sessions')
MAIN_SESSION = 'session-63251d85-ef77-4299-939d-9a6fe9b5bec6'
# cl-100 修复的提交：结算路径改为"帧回合也结算、且结算与累计解耦"
SETTLEMENT_FIX_COMMIT = '8ed52e7'
# 提交 → 重启之间的部署间隔上界: 这段窗口内的记录仍由旧进程结算, 不能算进干净窗口。
DEPLOY_GRACE_MS = 2 * 60 * 1000


def commit_epoch(rev: str) -> int | None:
    """Author time (ms) of one commit, or None when unknown."""
    try:
        out = subprocess.run(['git', '-C', REPO, 'show', '-s', '--format=%at', rev],
                             capture_output=True, text=True, timeout=30)
        return int(out.stdout.strip()) * 1000 if out.stdout.strip() else None
    except Exception:
        return None


def session_log_path(session_id: str) -> str | None:
    for workspace in os.listdir(SESSIONS):
        candidate = os.path.join(SESSIONS, workspace, session_id, 'session.jsonl.zstd')
        if os.path.exists(candidate):
            return candidate
    return None


def stream_lines(path: str):
    """逐行产出解压后的日志行 —— 不把整个解压结果读进内存。

    2026-09-10 21:03 实测事故: 本脚本原用 subprocess.run(capture_output=True) 读 zstd 输出,
    单次运行峰值 RSS **1.04 GB**(会话日志 58MB → 解压 163MB, 加上 decode 副本);
    而 ab-compare 一次要跑 4 遍本脚本、闸门每 30 分钟、观察每小时、套件每 6 小时都跑 ——
    叠加 node 服务自身 1.7 GB RSS(3.6 GB 机器), 直接把 dsh-web 打成 oom-kill(systemd 记录 21:03:21)。
    改为流式: 峰值降到每行级别。
    """
    proc = subprocess.Popen(['zstd', '-dc', path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for raw_line in proc.stdout:                    # 逐行, 不缓冲整份
            yield raw_line.decode('utf8', 'replace')
    finally:
        try:
            proc.stdout.close()
        finally:
            proc.wait(timeout=60)


def turn_classes(log_path: str) -> tuple[list[dict], list[int]]:
    """Turns (start/user/frame) and the sorted start times."""
    turns: list[dict] = []
    current: dict | None = None
    for line in stream_lines(log_path):
        if '"turn/start"' not in line and '"user/message"' not in line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        stamp = event.get('time')
        data = event.get('data') or {}
        if not isinstance(stamp, int):
            continue
        if event.get('type') == 'turn/start':
            current = {'start': stamp, 'user': False, 'frame': None}
            turns.append(current)
        elif event.get('type') == 'user/message' and current is not None:
            source = data.get('source') or {}
            if source.get('kind') == 'user':
                current['user'] = True
            elif source.get('plugin') == 'quiet-driver':
                current['frame'] = str(source.get('summary') or '')[:10]
    turns = [t for t in turns if t['start']]
    return turns, [t['start'] for t in turns]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', default=None, help='ISO 时间；默认取结算修复水位')
    parser.add_argument('--until', default=None,
                        help='ISO 时间上界(左闭右开)。A/B 对照须由同一生产者切两个窗口, '
                             '而不是另写脚本算第二套口径(cl-134)')
    parser.add_argument('--session-id', default=MAIN_SESSION)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    # 内存闸(cl-155): 本脚本是重活(解压+扫描会话日志)。宿主只有 3.6GB, 服务本身 ~1.7GB,
    # 若不设闸, 它会和服务抢内存并把服务打成 oom-kill —— 观测工具不该杀死被观测对象。
    try:
        with open('/proc/meminfo', encoding='utf8') as _fh:
            avail_kb = next(int(l.split()[1]) for l in _fh if l.startswith('MemAvailable'))
    except Exception:
        avail_kb = 10 ** 9
    if avail_kb < 400 * 1024:
        print('内存不足(可用 %d MB < 400 MB): 拒绝运行, 以免触发 OOM' % (avail_kb // 1024), file=sys.stderr)
        return 3

    watermark = commit_epoch(SETTLEMENT_FIX_COMMIT)
    if watermark is None:
        print('缺水位: 无法确定 cl-100 结算修复时刻(数据来源不可信, 拒绝出数)', file=sys.stderr)
        return 1
    since = (int(datetime.datetime.fromisoformat(args.since).timestamp() * 1000)
             if args.since else watermark + DEPLOY_GRACE_MS)
    until = (int(datetime.datetime.fromisoformat(args.until).timestamp() * 1000)
             if args.until else None)

    def in_window(created: int) -> bool:
        """左闭右开窗口。单点实现, 所有取数路径共用(防同一脚本内两套口径)。"""
        return created >= since and (until is None or created < until)

    log_path = session_log_path(args.session_id)
    if log_path is None:
        print('缺水位: 找不到会话日志 %s(无法分类回合)' % args.session_id, file=sys.stderr)
        return 1
    turns, starts = turn_classes(log_path)
    if not starts:
        print('会话日志无可判回合', file=sys.stderr)
        return 1

    import bisect
    injections: dict[str, dict] = {}
    for line in open(os.path.join(DIR, 'injections.jsonl'), encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record.get('injectionId'), str):
            injections[record['injectionId']] = record   # last-wins (cl-041)

    # cl-118 修订版: 采纳率必须分两口径报——首次注入 vs 重复提醒。
    # 一条提醒的价值是"终于落地的那一次"(实测 exp_126 第 68 次、exp_264 第 6 次),
    # 按每次注入计会系统性低估提醒的价值, 也会把"体积大"误读成"质量差"。
    session_records = sorted(
        (r for r in injections.values() if str(r.get('sessionId')) == args.session_id),
        key=lambda r: r.get('createdAt') or 0)
    seen_exp: set[str] = set()
    first_or_repeat: dict[str, str] = {}
    for record in session_records:
        ids = list(record.get('expIds') or [])
        first_or_repeat[record['injectionId']] = (
            'repeat' if any(e in seen_exp for e in ids) else 'first')
        seen_exp.update(ids)

    stats: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0])
    lenses: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0])
    for record in injections.values():
        if str(record.get('sessionId')) != args.session_id:
            continue
        created = record.get('createdAt') or 0
        if not in_window(created):
            continue
        index = bisect.bisect_right(starts, created) - 1
        if index < 0:
            continue
        turn = turns[index]
        kind = '用户回合' if turn['user'] else (
            '行动帧' if str(turn['frame'] or '').startswith('行动帧') else '反思类帧')
        cited = record.get('cited') is True
        unsettled = record.get('cited') is None
        bucket = stats[kind]
        bucket[0] += 1
        if cited:
            bucket[1] += 1
        elif unsettled:
            bucket[2] += 1
        lens = lenses[first_or_repeat.get(record['injectionId'], 'first')]
        lens[0] += 1
        if cited:
            lens[1] += 1
        elif unsettled:
            lens[2] += 1

    # cl-128: 采纳率必须有对照才有意义。背景 = 同期"文本提到**未被注入**的 expId"的回合占比
    # (本会话是元认知回路, 我常自发写 expId, 底噪 ~18%)。lift = 注入项被引用的比例 / 背景率。
    import re as _re
    EXP_RE = _re.compile(r'exp_\d+')
    log_path2 = session_log_path(args.session_id)
    mentioned_injected = []      # 回合: 文本提到注入项
    mentioned_background = []    # 回合: 文本提到非注入项
    if log_path2 is not None:
        cur_turn = None
        by_turn_text: dict[int, list[str]] = {}
        for line in stream_lines(log_path2):
            if '"turn/start"' not in line and '"assistant/message"' not in line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            data = event.get('data') or {}
            if event.get('type') == 'turn/start':
                cur_turn = data.get('turn')
            elif event.get('type') == 'assistant/message' and isinstance(cur_turn, int):
                message = data.get('message') or {}
                text = ' '.join(block.get('text', '') for block in (message.get('content') or [])
                                if isinstance(block, dict) and block.get('type') == 'text')
                if text:
                    by_turn_text.setdefault(cur_turn, []).append(text)
        turn_starts = {}
        for line in stream_lines(log_path2):
            if '"turn/start"' not in line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            data = event.get('data') or {}
            if isinstance(data.get('turn'), int) and isinstance(event.get('time'), int):
                turn_starts.setdefault(data['turn'], event['time'])
        ordered = sorted((stamp, turn) for turn, stamp in turn_starts.items())
        start_ms = [s for s, _ in ordered]
        turn_nos = [x for _, x in ordered]
        for record in session_records:
            created = record.get('createdAt') or 0
            if not in_window(created):
                continue
            index = bisect.bisect_right(start_ms, created) - 1
            if index < 0:
                continue
            turn = turn_nos[index]
            mentioned = set(EXP_RE.findall(' '.join(by_turn_text.get(turn, []))))
            injected = set(record.get('expIds') or [])
            if mentioned & injected:
                mentioned_injected.append(turn)
            if mentioned - injected:
                mentioned_background.append(turn)
    turns_with_injection = len({turn_nos[bisect.bisect_right(start_ms, r.get('createdAt') or 0) - 1]
                                for r in session_records if in_window(r.get('createdAt') or 0)
                                and bisect.bisect_right(start_ms, r.get('createdAt') or 0) - 1 >= 0}) \
        if log_path2 is not None else 0
    adoption_turns = len(set(mentioned_injected))
    background_turns = len(set(mentioned_background))
    payload_extra = {
        'turnsWithInjection': turns_with_injection,
        'textMentionAdoptionTurns': adoption_turns,
        'textMentionAdoptionRate': round(adoption_turns / turns_with_injection, 4) if turns_with_injection else None,
        'backgroundTurns': background_turns,
        'backgroundRate': round(background_turns / turns_with_injection, 4) if turns_with_injection else None,
        'lift': (round((adoption_turns / turns_with_injection) / (background_turns / turns_with_injection), 3)
                 if turns_with_injection and background_turns else None),
        'liftNote': 'lift = 文本提到注入项的回合占比 / 同期背景(提到未注入项)占比; n<100 时 CI 很宽, 不可据单点判定',
    }

    total = [sum(v[i] for v in stats.values()) for i in range(3)]
    payload = {
        'windowStart': datetime.datetime.fromtimestamp(since / 1000).isoformat(),
        'windowStartSource': ('cl-100 结算修复提交 %s + 部署宽限 %d 分钟(提交→重启之间由旧进程结算)'
                              % (SETTLEMENT_FIX_COMMIT, DEPLOY_GRACE_MS // 60000)),
        'windowEnd': (datetime.datetime.fromtimestamp(until / 1000).isoformat()
                      if until is not None else None),
        'windowSemantics': '左闭右开 [windowStart, windowEnd); windowEnd=null 表示到当前',
        'sessionId': args.session_id,
        'classes': {k: {'injected': v[0], 'cited': v[1], 'unsettled': v[2],
                        'rate': round(v[1] / v[0], 4) if v[0] else None}
                    for k, v in sorted(stats.items())},
        'total': {'injected': total[0], 'cited': total[1], 'unsettled': total[2],
                  'rate': round(total[1] / total[0], 4) if total[0] else None},
        **payload_extra,
        # 首次注入(该经验在本会话中第一次出现) / 重复提醒(出现过至少一次)
        'firstVsRepeat': {k: {'injected': v[0], 'cited': v[1], 'unsettled': v[2],
                              'rate': round(v[1] / v[0], 4) if v[0] else None}
                          for k, v in sorted(lenses.items())},
    }
    # 只有"默认全窗口"才写规范文件。子窗口结果不得覆盖唯一口径的落盘快照——
    # 09-10 17:4x 实测踩过: 加 --since 跑后窗时把快照的 windowStart 改成 14:07,
    # 下游 A/B 读快照当水位, 于是整张对照表的窗口全错位(cl-134)。
    canonical = args.since is None and args.until is None
    if canonical:
        with open(os.path.join(DIR, 'adoption-stats.json'), 'w', encoding='utf8') as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
    payload['canonicalSnapshotWritten'] = canonical

    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('窗口: %s → %s (来源: %s)'
          % (payload['windowStart'], payload['windowEnd'] or '当前', payload['windowStartSource']))
    for kind, values in payload['classes'].items():
        print('  %-8s 注入 %3d 采纳 %2d 未结算 %d 采纳率 %s'
              % (kind, values['injected'], values['cited'], values['unsettled'],
                 'n/a' if values['rate'] is None else '%.1f%%' % (values['rate'] * 100)))
    for lens, values in payload['firstVsRepeat'].items():
        label = '首次注入' if lens == 'first' else '重复提醒'
        print('  %-8s 注入 %3d 采纳 %2d 未结算 %d 采纳率 %s'
              % (label, values['injected'], values['cited'], values['unsettled'],
                 'n/a' if values['rate'] is None else '%.1f%%' % (values['rate'] * 100)))
    if payload['turnsWithInjection']:
        print('  文本口径: 提到注入项 %d/%d 回合, 背景(提到未注入项) %d 回合 => lift %s'
              % (payload['textMentionAdoptionTurns'], payload['turnsWithInjection'],
                 payload['backgroundTurns'], payload['lift']))
    print('  合计     注入 %3d 采纳 %2d 未结算 %d 采纳率 %s'
          % (total[0], total[1], total[2],
             'n/a' if payload['total']['rate'] is None else '%.1f%%' % (payload['total']['rate'] * 100)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
