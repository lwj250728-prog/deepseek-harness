#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-session-log-watch.py — 会话日志体积哨兵。

起因(2026-09-11 19:0x, 用户报"轮次太多导致 web 加载困难"): 本会话日志长到 **66.6 MB 压缩 /
204 MB 解压 / 189,099 行**, 而典型会话只有 2-3 MB。体量本身还有第二重代价: events 流的 `since`
在 v1 未实现("重连 = 重开流 + 重取历史"), 且冷读要把整份日志读成内存 Session —— 于是**每次服务重启
后第一次打开该会话都要重付这份成本**(实测仅解压就 2.35s CPU), 而服务当时 RSS 已 1.8GB / swap 1.18GB。
问题不在于"某次卡", 而在于**没有任何机制在日志悄悄长到 40 倍时提醒过我**。

本哨兵做三件事:
  ①廉价面: 对每个会话日志取 stat 体积(不读内容), 报告目录总体积、最大的几个、以及目录里被冷落的
    备份/重复文件(.bak 之类, 它们同样占地方且会混淆"日志多大"的判断);
  ②深度面(--deep 或超阈值时): 流式解压算**解压体积与行数**, 并统计 **chunk 行占比** —— chunk 是
     流式增量, 内容通常已被随后的最终消息承载, 是日志膨胀的主要来源(实测 38% vs 消息 33.9%);
  ③判据面: 压缩体积超阈值(默认 25MB)即写言行账本告警(cl-session-log-size, 带最大的几个会话与
     chunk 占比), 回落到阈值以下自动关单。

用法: dsh-session-log-watch.py [--root DIR] [--threshold-mb N] [--deep] [--json] [--no-alert]
退出码: 0 正常; 1 有会话超阈值; 2 扫描失败。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
SESSIONS_ROOT = os.environ.get('DSH_SESSIONS_ROOT') or os.path.expanduser('~/.dsh/sessions')
RECORD = os.path.join(DIR, 'session-log-watch.jsonl')
LEDGER = os.path.join(DIR, 'claims-ledger.jsonl')
ALERT_ID = 'cl-session-log-size'
DEFAULT_THRESHOLD_MB = 25.0
CHUNK_TYPES = ('assistant/chunk', 'reasoning-chunks', 'text-chunks', 'tool-call-chunks')


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def scan(root: str) -> list[dict]:
    """每个会话目录一行: 日志体积 + 目录里的其它文件(备份/重复)。"""
    out: list[dict] = []
    for project in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        pdir = os.path.join(root, project)
        if not os.path.isdir(pdir):
            continue
        for session in sorted(os.listdir(pdir)):
            sdir = os.path.join(pdir, session)
            if not os.path.isdir(sdir):
                continue
            logs, extras, total = [], [], 0
            for name in sorted(os.listdir(sdir)):
                path = os.path.join(sdir, name)
                if not os.path.isfile(path):
                    continue
                size = os.path.getsize(path)
                total += size
                if name.startswith('session.jsonl'):
                    if name.endswith(('.zstd', '.zst')) or name.endswith('.jsonl'):
                        logs.append({'file': name, 'bytes': size})
                    else:
                        extras.append({'file': name, 'bytes': size})
                else:
                    extras.append({'file': name, 'bytes': size})
            out.append({'project': project, 'session': session, 'dir': sdir, 'totalBytes': total,
                        'logs': logs, 'extras': extras,
                        'logBytes': max([l['bytes'] for l in logs], default=0)})
    return sorted(out, key=lambda r: -r['logBytes'])


def deep_stats(path: str, timeout: int = 300) -> dict:
    """流式统计(进程内读, 不嵌套 python -c —— 引号与换行会毁掉那种写法):
    解压后体积、行数、chunk 行占比。内存有界: 只按行消费 zstd 的输出。"""
    import collections
    cmd = ['zstd', '-dc', path] if path.endswith(('.zstd', '.zst')) else ['cat', path]
    types: collections.Counter = collections.Counter()
    total = lines = 0
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception as exc:
        return {'error': str(exc)}
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            lines += 1
            total += len(raw)
            try:
                rec = json.loads(raw)
            except Exception:
                continue
            types[str(rec.get('type') or rec.get('kind') or '?')] += 1
        proc.wait(timeout=timeout)
    except Exception as exc:
        proc.kill()
        return {'error': str(exc)}
    chunk = sum(types[t] for t in CHUNK_TYPES)
    return {'bytes': total, 'lines': lines, 'chunkLines': chunk,
            'chunkShare': round(chunk / lines, 4) if lines else 0,
            'topTypes': types.most_common(4)}


def write_alert(message: str) -> None:
    """言行账本告警(与其它哨兵同通道); 幂等: 已是同一条待办则不重复追加。"""
    rows = [json.loads(l) for l in open(LEDGER, encoding='utf8') if l.strip()] if os.path.exists(LEDGER) else []
    current = next((r for r in reversed(rows) if r.get('id') == ALERT_ID), None)
    if current is not None and current.get('status') not in ('done', 'retired', 'closed') and current.get('claim') == message:
        return
    row = dict(current or {})
    row.update({'id': ALERT_ID, 'status': 'open', 'claim': message, 'source': 'dsh-session-log-watch.py',
                'reviewBy': (datetime.date.today() + datetime.timedelta(days=2)).isoformat(),
                'nextAction': '按 plan「解决 web 加载困难」步骤 2B 压实或归档该会话日志; 继续用则开新会话'})
    row['ts'] = now_iso()
    with open(LEDGER, 'a', encoding='utf8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')


def close_alert() -> bool:
    rows = [json.loads(l) for l in open(LEDGER, encoding='utf8') if l.strip()] if os.path.exists(LEDGER) else []
    current = next((r for r in reversed(rows) if r.get('id') == ALERT_ID), None)
    if current is None or current.get('status') in ('done', 'retired', 'closed'):
        return False
    row = dict(current)
    row.update({'status': 'done', 'doneNote': '所有会话日志已回落到阈值以下', 'ts': now_iso()})
    with open(LEDGER, 'a', encoding='utf8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=SESSIONS_ROOT)
    ap.add_argument('--threshold-mb', type=float, default=float(os.environ.get('DSH_SESSION_LOG_ALERT_MB') or DEFAULT_THRESHOLD_MB))
    ap.add_argument('--deep', action='store_true', help='对超阈值会话做解压统计(默认只对它们自动做)')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-alert', action='store_true')
    args = ap.parse_args()
    try:
        rows = scan(args.root)
    except Exception as exc:
        print('扫描失败: %s' % exc, file=sys.stderr)
        return 2
    threshold = args.threshold_mb * 1048576
    over = [r for r in rows if r['logBytes'] > threshold]
    for r in over:
        log = r['logs'][0]['file'] if r['logs'] else None
        if log and (args.deep or True):
            r['deep'] = deep_stats(os.path.join(r['dir'], log))
    payload = {
        'ts': now_iso(), 'origin': os.environ.get('DSH_RUN_ORIGIN') or 'manual',
        'root': args.root, 'sessions': len(rows), 'thresholdMB': args.threshold_mb,
        'overCount': len(over),
        'top': [{'session': r['session'], 'logMB': round(r['logBytes'] / 1048576, 1),
                 'dirMB': round(r['totalBytes'] / 1048576, 1),
                 'chunkShare': (r.get('deep') or {}).get('chunkShare'),
                 'lines': (r.get('deep') or {}).get('lines'),
                 'extras': [{'file': e['file'], 'MB': round(e['bytes'] / 1048576, 1)}
                            for e in r['extras'] if e['bytes'] > 1048576]} for r in rows[:5]],
    }
    os.makedirs(DIR, exist_ok=True)
    with open(RECORD, 'a', encoding='utf8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')
    if not args.no_alert:
        if over:
            head = ', '.join('%s %.1fMB(chunk %s%%)' % (r['session'][:24], r['logBytes'] / 1048576,
                                                        round(100 * ((r.get('deep') or {}).get('chunkShare') or 0)))
                             for r in over[:3])
            write_alert('会话日志超阈值(%.0fMB): %d 个会话; 最大: %s —— 体量会拖慢 web 打开/重连'
                        '(重连需重取历史, 冷读要读整份日志)' % (args.threshold_mb, len(over), head))
        else:
            close_alert()
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('会话 %d 个 | 超阈值(%.0fMB) %d 个' % (len(rows), args.threshold_mb, len(over)))
        for t in payload['top']:
            print('  %-40s 日志 %6.1fMB 目录 %6.1fMB 行数 %s chunk占比 %s%%' % (
                t['session'][:40], t['logMB'], t['dirMB'], t['lines'],
                round(100 * t['chunkShare']) if t['chunkShare'] is not None else '?'))
            for e in t['extras']:
                print('      └ 冗余文件 %s (%.1fMB)' % (e['file'], e['MB']))
    return 1 if over else 0


if __name__ == '__main__':
    raise SystemExit(main())
