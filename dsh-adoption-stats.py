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


def turn_classes(log_path: str) -> tuple[list[dict], list[int]]:
    """Turns (start/user/frame) and the sorted start times."""
    raw = subprocess.run(['zstd', '-dc', log_path], capture_output=True, timeout=300).stdout
    turns: list[dict] = []
    current: dict | None = None
    for line in raw.decode('utf8', 'replace').splitlines():
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
    parser.add_argument('--session-id', default=MAIN_SESSION)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    watermark = commit_epoch(SETTLEMENT_FIX_COMMIT)
    if watermark is None:
        print('缺水位: 无法确定 cl-100 结算修复时刻(数据来源不可信, 拒绝出数)', file=sys.stderr)
        return 1
    since = (int(datetime.datetime.fromisoformat(args.since).timestamp() * 1000)
             if args.since else watermark + DEPLOY_GRACE_MS)

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

    stats: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0])
    for record in injections.values():
        if str(record.get('sessionId')) != args.session_id:
            continue
        created = record.get('createdAt') or 0
        if created < since:
            continue
        index = bisect.bisect_right(starts, created) - 1
        if index < 0:
            continue
        turn = turns[index]
        kind = '用户回合' if turn['user'] else (
            '行动帧' if str(turn['frame'] or '').startswith('行动帧') else '反思类帧')
        bucket = stats[kind]
        bucket[0] += 1
        if record.get('cited') is True:
            bucket[1] += 1
        elif record.get('cited') is None:
            bucket[2] += 1

    total = [sum(v[i] for v in stats.values()) for i in range(3)]
    payload = {
        'windowStart': datetime.datetime.fromtimestamp(since / 1000).isoformat(),
        'windowStartSource': ('cl-100 结算修复提交 %s + 部署宽限 %d 分钟(提交→重启之间由旧进程结算)'
                              % (SETTLEMENT_FIX_COMMIT, DEPLOY_GRACE_MS // 60000)),
        'sessionId': args.session_id,
        'classes': {k: {'injected': v[0], 'cited': v[1], 'unsettled': v[2],
                        'rate': round(v[1] / v[0], 4) if v[0] else None}
                    for k, v in sorted(stats.items())},
        'total': {'injected': total[0], 'cited': total[1], 'unsettled': total[2],
                  'rate': round(total[1] / total[0], 4) if total[0] else None},
    }
    with open(os.path.join(DIR, 'adoption-stats.json'), 'w', encoding='utf8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('窗口起点: %s (来源: %s)' % (payload['windowStart'], payload['windowStartSource']))
    for kind, values in payload['classes'].items():
        print('  %-8s 注入 %3d 采纳 %2d 未结算 %d 采纳率 %s'
              % (kind, values['injected'], values['cited'], values['unsettled'],
                 'n/a' if values['rate'] is None else '%.1f%%' % (values['rate'] * 100)))
    print('  合计     注入 %3d 采纳 %2d 未结算 %d 采纳率 %s'
          % (total[0], total[1], total[2],
             'n/a' if payload['total']['rate'] is None else '%.1f%%' % (payload['total']['rate'] * 100)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
