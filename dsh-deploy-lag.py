#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-deploy-lag.py — **部署滞后见证**: 源码 / 产物 / 运行中的载体, 三者谁是旧的?

为什么需要(cl-352): 今晚踩了三次同一类坑, 每次都以"看不出是构建被挡了"收场:
  ①根构建 `tsc -b tsconfig.host.json && tsdown` 的第一条是**全仓类型闸门**, 别人在飞工作一有类型错误
    整条 `&&` 链就断 ⇒ 源码改了、产物没变;
  ②我改了源码跑完 spec 就以为"落地了", 而载体(PID 399769)跑的是**加载时刻**的那份产物 ⇒
    "产物已更新"与"行为已改变"是两件事(实测: 产物 04:43, 载体 22:08 启动 ⇒ 差 6.5 小时);
  ③反过来, 产物比源码旧(忘了构建)同样静默。
三者任一不一致, 结论都会静默失真。本工具把三者摆在一起判, 并给出**下一步该做什么**。

判定(容差 1s, 避免文件系统时间粒度噪声):
  · build-stale  : 源码比产物新        ⇒ 需要构建(命令见 hints)
  · carrier-stale: 产物比载体启动新    ⇒ 需要下次加载/重启才生效
  · live         : 产物不新于载体启动且不旧于源码 ⇒ 生效中
  · missing      : 没有 lib/index.js

注入点(给判据/探针用, 免得去伪造真实载体):
  · DSH_DEPLOY_LAG_STATE=<json 文件>  状态代替实时探测, 形如
      {"carrierStart": <epoch 秒>, "packages": {"<包相对路径>": {"libMtime": <秒>, "srcMtime": <秒>}}}
  · DSH_DEPLOY_LAG_PID=<pid>          替代默认的载体 PID
  · DSH_DEPLOY_LAG_REPO=<path>        替代默认仓库根
  · DSH_DEPLOY_LAG_PACKAGES=a/b,c/d   只扫这些包(默认扫 packages/*/* 与 apps/cli)

用法:
  dsh-deploy-lag.py [--json] [--quiet] [--pid N] [--repo PATH]
退出码: 0 = 全部 live; 1 = 有滞后(build-carrier 任一); 3 = 无法判定(没有载体/仓库)。
"""
from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
TOLERANCE_S = 1.0


def _fmt(ts: float | None) -> str:
    if ts is None:
        return 'n/a'
    return datetime.datetime.fromtimestamp(ts, TZ).strftime('%m-%d %H:%M:%S')


def carrier_start(pid: int) -> float | None:
    """载体的启动时刻(epoch 秒), 来自 /proc/<pid>/stat 的 starttime 与 /proc/stat 的 btime。"""
    try:
        raw = open('/proc/%d/stat' % pid, encoding='utf8').read()
        # comm 里可能有空格/括号 ⇒ 以最后一个 ')' 为界
        rest = raw[raw.rfind(')') + 2:].split()
        starttime_ticks = int(rest[19])          # 字段 22(starttime); 去掉 pid/comm/state 后是第 19 个
        btime = None
        for line in open('/proc/stat', encoding='utf8'):
            if line.startswith('btime '):
                btime = int(line.split()[1])
                break
        if btime is None:
            return None
        return btime + starttime_ticks / os.sysconf('SC_CLK_TCK')
    except (OSError, IndexError, ValueError):
        return None


def newest_mtime(root: str, limit: int = 4000) -> float | None:
    """目录树里最新的 mtime(剪掉 node_modules/lib, 有上限)。"""
    newest: float | None = None
    seen = 0
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'lib', '.git', 'dist')]
        for name in files:
            seen += 1
            if seen > limit:
                return newest
            try:
                m = os.path.getmtime(os.path.join(base, name))
            except OSError:
                continue
            if newest is None or m > newest:
                newest = m
    return newest


def entry_file(pkg_dir: str) -> str | None:
    """这个包**真正的入口产物**: package.json 的 main 优先, 否则 lib/index.js, 否则 lib/bin.js。
    第一版只认 lib/index.js ⇒ apps/cli 与 apps/web 被误报 missing(而 apps/cli/lib/bin.js 恰恰是
    载体运行的那份 —— 假阳性会让人忽略真正要看的东西)。"""
    main = None
    pj = os.path.join(pkg_dir, 'package.json')
    if os.path.exists(pj):
        try:
            main = json.load(open(pj, encoding='utf8')).get('main')
        except Exception:
            main = None
    for cand in (main, 'lib/index.js', 'lib/bin.js', 'dist/index.html'):
        if not cand:
            continue
        path = os.path.join(pkg_dir, cand) if not os.path.isabs(cand) else cand
        if os.path.exists(path):
            return path
    return None


def package_dirs(repo: str, only: list[str] | None) -> list[str]:
    if only:
        return [os.path.join(repo, p) for p in only]
    out = sorted(glob.glob(os.path.join(repo, 'packages', '*', '*')))
    out += sorted(glob.glob(os.path.join(repo, 'apps', '*')))
    return [d for d in out if os.path.isdir(d)]


def survey(repo: str, pid: int, only: list[str] | None) -> dict:
    state_file = os.environ.get('DSH_DEPLOY_LAG_STATE')
    if state_file:
        state = json.load(open(state_file, encoding='utf8'))
        started = float(state['carrierStart'])
        rows = []
        for rel, info in state['packages'].items():
            lib = info.get('libMtime')
            rows.append({'package': rel, 'entry': info.get('entry'),
                         'libMtime': None if lib is None else float(lib),
                         'srcMtime': None if info.get('srcMtime') is None else float(info['srcMtime'])})
        return {'carrierStart': started, 'carrierPid': None, 'source': 'injected:' + state_file, 'rows': rows}
    started = carrier_start(pid)
    rows = []
    for d in package_dirs(repo, only):
        entry = entry_file(d)
        rows.append({
            'package': os.path.relpath(d, repo),
            'entry': None if entry is None else os.path.relpath(entry, d),
            'libMtime': None if entry is None else os.path.getmtime(entry),
            'srcMtime': newest_mtime(os.path.join(d, 'src')) if os.path.isdir(os.path.join(d, 'src')) else None,
        })
    return {'carrierStart': started, 'carrierPid': pid, 'source': 'live', 'rows': rows}


def verdict_of(row: dict, started: float | None) -> str:
    lib, src = row.get('libMtime'), row.get('srcMtime')
    if lib is None:
        return 'missing'
    if started is None:
        return 'unknown'
    if src is not None and src > lib + TOLERANCE_S:
        return 'build-stale'
    if lib > started + TOLERANCE_S:
        return 'carrier-stale'
    return 'live'


def hint(verdict: str, package: str) -> str:
    if verdict == 'build-stale':
        return 'npx tsdown --env.DSH_BUILD_FACE host -F %s(或 dsh-build-package.sh %s)' % (package, package)
    if verdict == 'carrier-stale':
        return '产物已更新, 载体仍是旧代码 ⇒ 下次加载/重启才生效(重启用户会话需其本人同意)'
    if verdict == 'missing':
        return '先去构建: dsh-build-package.sh %s' % package
    if verdict == 'unknown':
        return '拿不到载体启动时间 ⇒ 无法判定"是否生效"(检查 PID 或 /proc)'
    return ''


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--pid', type=int, default=int(os.environ.get('DSH_DEPLOY_LAG_PID') or 399769))
    ap.add_argument('--repo', default=os.environ.get('DSH_DEPLOY_LAG_REPO') or os.path.expanduser('~/dsh-fork'))
    ap.add_argument('--only', default=os.environ.get('DSH_DEPLOY_LAG_PACKAGES') or '')
    args = ap.parse_args()
    only = [x.strip() for x in args.only.split(',') if x.strip()] or None

    data = survey(args.repo, args.pid, only)
    started = data['carrierStart']
    rows = []
    for row in data['rows']:
        v = verdict_of(row, started)
        row = dict(row, verdict=v, hint=hint(v, row['package']))
        rows.append(row)

    stale = [r for r in rows if r['verdict'] in ('build-stale', 'carrier-stale')]
    if args.json:
        print(json.dumps({'carrierStart': started, 'carrierPid': data['carrierPid'], 'source': data['source'],
                          'stale': len(stale), 'rows': rows}, ensure_ascii=False))
    else:
        print('[deploy] 载体启动 %s(pid %s, 来源 %s) | 扫描 %d 个包'
              % (_fmt(started), data['carrierPid'] or '-', data['source'], len(rows)))
        for r in rows:
            if r['verdict'] == 'live' and args.quiet:
                continue
            print('  %-34s %-14s %s 产物 %s / 源码 %s'
                  % (r['package'], r['verdict'], r.get('entry') or '-', _fmt(r['libMtime']), _fmt(r['srcMtime'])))
            if r['hint'] and r['verdict'] != 'live':
                print('      ⇒ %s' % r['hint'])
        print('[deploy] %s: 滞后 %d 个 / 共 %d 个' % ('需要动作' if stale else '全部生效', len(stale), len(rows)))
    if started is None:
        return 3
    return 1 if stale else 0


if __name__ == '__main__':
    sys.exit(main())
