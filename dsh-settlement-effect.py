#!/usr/bin/env python3
"""结算效果见证（tp-090 / T108；cl-128 的效果侧）。

cl-128 的根因是**结算用的是被截到 800 字符的回合文本**，而实测 7 个漏判回合的 expId
提及位置在 1052~1557 字符处——全被截断吃掉，于是"文本里明明写了 expId"被记成未引用
（账本 14.5% vs 文本 32.3%）。

代码层断言（T107）只能证明"改了"；本脚本给出**效果证据**：
  取构建之后创建的注入，若其 expIds 出现在**同一回合的 assistant 文本**里，
  则该注入**不得**被结算为 cited=false。出现即说明修复无效（或结算又跑在别处）。

样本不足时明确说"样本不足"，不伪装成通过。

用法：dsh-settlement-effect.py [--since-ms N] [--quiet]
退出码：0 = 无漏判（或样本不足）；1 = 仍有漏判。
"""
from __future__ import annotations

import argparse
import bisect
import collections
import datetime
import json
import os
import re
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
SESSIONS = os.path.expanduser('~/.dsh/sessions')
MAIN = 'session-63251d85-ef77-4299-939d-9a6fe9b5bec6'
EXP = re.compile(r'exp_\d+')
OUT = os.path.join(DIR, 'settlement-effect.json')
MIN_SAMPLE = 3


def session_log(session_id: str) -> str | None:
    for workspace in os.listdir(SESSIONS):
        candidate = os.path.join(SESSIONS, workspace, session_id, 'session.jsonl.zstd')
        if os.path.exists(candidate):
            return candidate
    return None




def stream_lines(path: str):
    """逐行产出解压后的日志行 —— 不把整份解压结果读进内存。

    2026-09-10 21:03 事故: 会话日志 58MB → 解压 163MB, 原实现用
    subprocess.run(capture_output=True) 一次读进内存, 单脚本峰值 **~1.04 GB**;
    叠加 node 服务自身 1.4-1.7 GB(机器 3.6 GB), dsh-web 被内核 oom-kill。
    观测工具不得把被观测对象打死 ⇒ 一律流式(cl-155)。
    """
    proc = subprocess.Popen(['zstd', '-dc', path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        for raw_line in proc.stdout:
            yield raw_line.decode('utf8', 'replace')
    finally:
        try:
            proc.stdout.close()
        finally:
            proc.wait(timeout=60)

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--since-ms', type=int, default=None)
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()

    since = args.since_ms
    if since is None:
        lib = os.path.expanduser('~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js')
        since = int(os.path.getmtime(lib) * 1000) if os.path.exists(lib) else 0

    log_path = session_log(MAIN)
    if log_path is None:
        print('缺会话日志: 无法核对文本命中', file=sys.stderr)
        return 1
    starts: dict[int, int] = {}
    texts: dict[int, list[str]] = collections.defaultdict(list)
    current: int | None = None
    for line in stream_lines(log_path):
        if '"turn/start"' not in line and '"assistant/message"' not in line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        data = event.get('data') or {}
        if event.get('type') == 'turn/start':
            turn = data.get('turn')
            stamp = event.get('time')
            current = turn if isinstance(turn, int) else None
            if isinstance(turn, int) and isinstance(stamp, int):
                starts.setdefault(turn, stamp)
        elif event.get('type') == 'assistant/message' and current is not None:
            message = data.get('message') or {}
            text = ' '.join(block.get('text', '') for block in (message.get('content') or [])
                            if isinstance(block, dict) and block.get('type') == 'text')
            if text:
                texts[current].append(text)
    ordered = sorted((stamp, turn) for turn, stamp in starts.items())
    start_ms = [s for s, _ in ordered]
    turn_nos = [t for _, t in ordered]

    injections: dict[str, dict] = {}
    for line in open(os.path.join(DIR, 'injections.jsonl'), encoding='utf8'):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record.get('injectionId'), str):
            injections[record['injectionId']] = record

    scope = [r for r in injections.values()
             if str(r.get('sessionId')) == MAIN and (r.get('createdAt') or 0) > since]
    hit_settled: list[dict] = []
    misses: list[dict] = []
    for record in scope:
        index = bisect.bisect_right(start_ms, record.get('createdAt') or 0) - 1
        if index < 0:
            continue
        mentioned = set(EXP.findall(' '.join(texts.get(turn_nos[index], []))))
        injected = set(record.get('expIds') or [])
        if not (mentioned & injected):
            continue
        entry = {'injectionId': record['injectionId'], 'turn': turn_nos[index],
                 'expIds': sorted(mentioned & injected), 'cited': record.get('cited')}
        if record.get('cited') is False:
            misses.append(entry)
        elif record.get('cited') is True:
            hit_settled.append(entry)

    payload = {
        'generatedAt': datetime.datetime.now().isoformat(),
        'sinceMs': since,
        'sinceLocal': datetime.datetime.fromtimestamp(since / 1000).strftime('%Y-%m-%d %H:%M:%S'),
        'scopeInjections': len(scope),
        'textHits': len(hit_settled) + len(misses),
        'textHitsSettledCited': len(hit_settled),
        'textHitsBookedFalse': len(misses),
        'misses': misses[:10],
        'minSample': MIN_SAMPLE,
        'verdict': ('insufficient-sample' if len(hit_settled) + len(misses) < MIN_SAMPLE
                    else ('ok' if not misses else 'still-missing')),
    }
    with open(OUT, 'w', encoding='utf8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    if not args.quiet:
        print('构建后注入 %d 条; 文本命中 %d 条(book=true %d, book=false %d) => %s'
              % (len(scope), payload['textHits'], len(hit_settled), len(misses), payload['verdict']))
    if payload['verdict'] == 'still-missing':
        print('红: 文本命中却被结算为未引用 %d 条(结算修复未生效): %s'
              % (len(misses), misses[:3]), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
