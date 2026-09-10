#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内存哨兵(tp-108 / cl-155): OOM 没有记忆, 得有人替它记。

2026-09-10 21:03 事故: dsh-web 被内核 oom-kill(systemd 记 `Failed with result 'oom-kill'`,
21:03:29 自动重启 → PID 3357487)。**我完全不知道** —— 是本会话用户告诉我"发生了内存 oom"。
原因: (a) 宿主只有 3.6 GB; (b) node 服务自身 RSS 1.4–1.7 GB(本会话日志 58MB 压缩/163MB 解压,
会话状态常驻内存); (c) 我新加的一批观测脚本用 `subprocess.run(capture_output=True)` 读 zstd 输出,
**单脚本峰值 1.04 GB**, 而 ab-compare 一次要跑它们 4 遍、闸门每 30 分、观察每时、套件每 6 小时。

本哨兵做两件事:
  1. 每 5 分钟记一行 (可用内存 / swap / dsh-web RSS / 负载 / 正在跑的观测脚本数) 到 memory-watch.jsonl ——
     让下一次 OOM 有**前兆轨迹**可查(而不是只能靠用户告知);
  2. 可用内存低于阈值时追加一条显式告警行(仍写同一账本, status=alert), 帧自查可见。
用法: dsh-memory-watch.py [--json]
退出码: 0 正常; 2 = 已触发内存告警。
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
LOG = os.path.join(DIR, 'memory-watch.jsonl')
TZ = datetime.timezone(datetime.timedelta(hours=8))
ALERT_MB = 350
WATCH_SCRIPTS = ('dsh-adoption-stats.py', 'dsh-ab-compare.py', 'dsh-adoption-observe.py',
                 'dsh-settlement-effect.py', 'dsh-implicit-adoption.py', 'dsh-cog-tests.sh')


def meminfo() -> dict:
    out = {}
    try:
        with open(os.environ.get('DSH_MEMINFO_PATH', '/proc/meminfo'), encoding='utf8') as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0].rstrip(':') in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
                    out[parts[0].rstrip(':')] = int(parts[1]) // 1024
    except Exception:
        pass
    return out


def service_rss_mb() -> int | None:
    try:
        out = subprocess.run(['pgrep', '-f', 'bin.js web'], capture_output=True, text=True, timeout=20).stdout.split()
        if not out:
            return None
        rss = subprocess.run(['ps', '-o', 'rss=', '-p', out[0]], capture_output=True, text=True, timeout=20).stdout.strip()
        return int(rss) // 1024 if rss.isdigit() else None
    except Exception:
        return None


def heavy_running() -> list[str]:
    """正在跑的重脚本(按 argv 末位匹配)。

    自指修正(cl-155): 首版直接 `name in ps_out` —— 而 ps 会列出**我自己所在的那条 bash -c**,
    其命令行里恰好包含这些脚本名(heredoc 正文进了 argv), 于是"重脚本正在跑"恒为真, 哨兵自己把自己
    报成高危。改为: 逐行取 argv 最后一个 token, 必须是该脚本名, 且整行不含 bash -c / DSH_RUN_ORIGIN。
    """
    try:
        out = subprocess.run(['ps', '-eo', 'cmd'], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return []
    found = set()
    for line in out.splitlines():
        if 'bash -c' in line or 'DSH_RUN_ORIGIN' in line:
            continue
        tokens = line.split()
        if not tokens:
            continue
        last = tokens[-1]
        for name in WATCH_SCRIPTS:
            if last == name or last.endswith('/' + name):
                found.add(name)
    return sorted(found)


def main() -> int:
    args = sys.argv[1:]
    mi = meminfo()
    avail = mi.get('MemAvailable')
    if avail is None:
        print('读不到 MemAvailable', file=sys.stderr)
        return 1
    rec = {
        'ts': datetime.datetime.now(TZ).isoformat(),
        'origin': os.environ.get('DSH_RUN_ORIGIN', 'manual'),
        'memTotalMB': mi.get('MemTotal'), 'memAvailableMB': avail,
        'swapUsedMB': (mi.get('SwapTotal', 0) - mi.get('SwapFree', 0)),
        'serviceRssMB': service_rss_mb(), 'heavyScriptsRunning': heavy_running(),
        'alert': avail < ALERT_MB,
    }
    if rec['heavyScriptsRunning'] and rec['serviceRssMB'] and rec['serviceRssMB'] > 1200 and avail < 600:
        rec['alert'] = True
        rec['alertReason'] = '服务 RSS>1.2GB 且可用<600MB 且有观测脚本在跑: OOM 高危组合'
    with open(LOG, 'a', encoding='utf8') as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
    if rec['alert']:
        print('内存告警: 可用 %sMB / swap 已用 %sMB / 服务 RSS %sMB / 重脚本 %s'
              % (rec['memAvailableMB'], rec['swapUsedMB'], rec['serviceRssMB'], rec['heavyScriptsRunning']))
    if '--json' in args:
        print(json.dumps(rec, ensure_ascii=False))
    return 2 if rec['alert'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
