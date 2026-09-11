#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署边界的内容基线(cl-224)。

问题(2026-09-11 16:3x 实测): `dsh-deploy-intent.py` 用 **mtime** 判定"有新构建未部署"
(lib 构建时刻 >= 服务启动时刻)。可我这一轮只改了**客户端**源码, 构建命令却顺带重新产出了
host 面 `lib/index.js` —— 源码一字未动、产物内容逐字节相同, 只是 mtime 变新。于是检测器报
`pending=True / verdict=uncarried`, 套件"有部署意图时必须真有排程载体"转红, 而**根本不需要重启**:
对一个跑着同样代码的进程做一次重启, 是拿"状态看起来对"换"真的做了什么"。

判据: 部署意图 = 产物内容与"服务启动时所用的内容"不同。mtime 只是**线索**, 内容才是**事实**。
故本工具在部署窗口重启成功后记录各 host 面 lib 的 sha256 作为基线; 检测器只在
"mtime 变新 **且** 内容不在基线(或与基线不同)"时才算待部署。

用法:
  dsh-deploy-lib-hashes.py --record [--origin deploy-window] [--glob PATTERN]
  dsh-deploy-lib-hashes.py --check  [--glob PATTERN] [--json]
--check 退出码: 0 内容一致(可判"仅 mtime 变"); 2 内容已变或缺基线(待部署, fail-closed)。
"""
from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import sys

DEFAULT_GLOB = '/home/ubuntu/dsh-fork/packages/*/*/lib/index.js'
BASELINE = os.path.expanduser('~/.dsh/cognitive-pipeline/deploy-lib-hashes.json')


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def digest(path: str) -> str | None:
    try:
        with open(path, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def current(glob_pattern: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for path in sorted(glob.glob(glob_pattern)):
        d = digest(path)
        if d is not None:
            out[path] = d
    return out


def load_baseline(file: str) -> dict:
    try:
        return json.load(open(file, encoding='utf8'))
    except Exception:
        return {}


def record(glob_pattern: str, file: str, origin: str) -> dict:
    hashes = current(glob_pattern)
    row = {'ts': now_iso(), 'origin': origin, 'glob': glob_pattern, 'count': len(hashes), 'hashes': hashes}
    os.makedirs(os.path.dirname(file), exist_ok=True)
    with open(file, 'w', encoding='utf8') as f:
        json.dump(row, f, ensure_ascii=False, indent=1)
    return row


def check(glob_pattern: str, file: str) -> dict:
    base = load_baseline(file)
    base_hashes = base.get('hashes') or {}
    cur = current(glob_pattern)
    if not base_hashes:
        return {'verdict': 'unverifiable', 'reason': '无内容基线(尚未在部署窗口记录) ⇒ 保守算待部署',
                'changed': [], 'missing': [], 'baselineTs': None, 'count': len(cur)}
    changed = [p for p, h in cur.items() if p in base_hashes and base_hashes[p] != h]
    missing = [p for p in cur if p not in base_hashes]
    return {
        'verdict': 'changed' if (changed or missing) else 'identical',
        'reason': ('内容已变: %d 个文件' % len(changed)) if changed
        else ('基线里没有这些产物: %d 个(保守算待部署)' % len(missing)) if missing
        else '每个 host 面产物的 sha256 都与基线一致 ⇒ 只有 mtime 变新, 无需重启',
        'changed': changed, 'missing': missing, 'baselineTs': base.get('ts'), 'count': len(cur),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--record', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--glob', default=DEFAULT_GLOB)
    ap.add_argument('--file', default=BASELINE)
    ap.add_argument('--origin', default=os.environ.get('DSH_RUN_ORIGIN') or 'manual')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if args.record == args.check:
        print('用法: --record 或 --check(二选一)', file=sys.stderr)
        return 2
    if args.record:
        row = record(args.glob, args.file, args.origin)
        print('[deploy-lib-hashes] 记录 %d 个产物的内容基线 → %s' % (row['count'], args.file))
        return 0
    result = check(args.glob, args.file)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print('[deploy-lib-hashes] %s: %s' % (result['verdict'], result['reason']))
    return 0 if result['verdict'] == 'identical' else 2


if __name__ == '__main__':
    raise SystemExit(main())
