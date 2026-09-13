#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-chain-readiness.py — 链机制(检索侧)的**就绪报告**: 现在走到哪一步了? 还差什么?

为什么需要它(cl-359): 目标"链检索侧在载体加载后可用"的判定, 此前要我手工拼三样东西 ——
  ①`dsh-deploy-lag.py`(源码/产物/载体谁旧了: 何时生效)
  ②产物层端到端校验(`verify-deployed-chain.mjs`: 产物里的机制是否真的工作)
  ③`dsh-chain-inject-report.py`(线上链记录与预登记判据: 生效后效果如何)
每轮我都要跑三遍再心算结论 ⇒ 这正是"结论靠人拼"的地方, 也是漏判最容易发生的地方(漏跑一环就会把
"产物可用"误读成"已生效")。本工具把三环串成一个**单调推进的状态机**, 每步都给出下一步该做什么。

状态机(只能沿此序推进, 不允许跳步 —— 跳步就是把"未测"当成"通过"):
  not-built     产物比源码旧        ⇒ 先构建
  built-stale   产物就绪但载体未加载 ⇒ 等载体加载/重启(重启用户会话需其本人同意)
  live-warming  载体已加载, 线上链记录 < 阈值 ⇒ 机制在跑但样本不足以判定
  live-judging  链记录达阈值, 按预登记判据给 pass/fail
  blocked       探测本身不成立(拿不到载体/产物缺失/工具失败) ⇒ 先修观测

注入点(给判据/探针用, 不伪造真实载体):
  DSH_READY_VENDOR=<包相对路径>        默认为下列两包
  DSH_READY_DEPLOY_LAG=<deploy-lag 脚本路径>
  DSH_READY_VERIFY_CMD=<命令>          替代"跑 node 校验器"; 输出需含 "产物层全通" 或 JSON 含 passed==total
  DSH_READY_REPORT=<报告工具路径>
  DSH_READY_MIN_N=<int>                链记录判定的样本阈值(默认 10)
  DSH_DEPLOY_LAG_STATE / DSH_CHAIN_REPORT_LEDGER 等由被调工具自己读取(它们已支持注入)  ⇒ 判据可全链夹具化

用法: dsh-chain-readiness.py [--json] [--record]
  --record: 把本次读数**追加**成一行滚动数据到 `chain-readiness.jsonl`(cl-367)。
    · 为什么需要: cron 每 6h 跑套件(内含本工具的检查), 但读数只活在输出里 ⇒ 无法回答"现在是第几档、何时翻档"。
    · 正确性要求: ①**追加**而非重写(并发跑套件不许互相覆盖); ②有上限(默认留最后 2000 行), 触发时**用文件锁**做截断;
      ③`DSH_CHAIN_READINESS_DRY=1` 时**不写**(判据自检不许污染读数历史)。
  DSH_CHAIN_READINESS_LEDGER=<path>  替代默认读数文件(判据用它注入临时文件)
  DSH_CHAIN_READINESS_KEEP=<int>     保留行数上限(默认 2000)
退出码: 0 = pass; 1 = fail; 2 = 尚未到可判(未构建/未加载/样本不足); 3 = 观测不成立。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
REPO = os.path.expanduser('~/dsh-fork')
VENDORS = ['packages/context/cognitive-inject', 'packages/cognition/cognitive-pipeline']
DEPLOY_LAG = os.path.join(REPO, 'dsh-deploy-lag.py')
REPORT = os.path.join(REPO, 'dsh-chain-inject-report.py')
VERIFY = os.path.join(REPO, 'packages/context/cognitive-inject/scripts/verify-deployed-chain.mjs')


def run_json(cmd: list[str], env: dict) -> tuple[int, dict | None, str]:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env=env)
    out = (r.stdout or '') + (r.stderr or '')
    payload = None
    for line in reversed([x for x in (r.stdout or '').strip().splitlines() if x.strip()]):
        try:
            payload = json.loads(line)
            break
        except Exception:
            continue
    return r.returncode, payload, out


def record_reading(data: dict) -> str | None:
    """把一次读数追加进滚动文件(cl-367)。

    **追加**保证并发跑套件时互不覆盖; 只有超过上限(默认 2000 行)时才截断, 且截断持有 flock ——
    否则两个套件同时截断会互相吃掉对方的行(本会话已见账本被重复追加/重写的情形)。
    """
    import fcntl
    path = os.environ.get('DSH_CHAIN_READINESS_LEDGER') or os.path.join(
        os.path.expanduser('~/.dsh/cognitive-pipeline'), 'chain-readiness.jsonl')
    keep = int(os.environ.get('DSH_CHAIN_READINESS_KEEP') or 2000)
    # cl-368: 读数必须能回答"**重启会交付什么**" —— 只报我这两个包的 pending 会把分母缩小,
    # 而真正待决策的问题是: 哪些包重启就能生效(carrier-stale)、哪些**还得先构建**(build-stale)。
    repo = None
    try:
        rc2, payload, _ = run_json([sys.executable, os.environ.get('DSH_READY_DEPLOY_LAG') or DEPLOY_LAG, '--json'], dict(os.environ))
        if payload is not None:
            verdicts = [(r.get('package'), r.get('verdict')) for r in payload.get('rows', [])]
            repo = {
                'scanned': len(verdicts),
                'deliverableOnRestart': sorted(p for p, v in verdicts if v == 'carrier-stale'),
                'needsBuildFirst': sorted(p for p, v in verdicts if v in ('build-stale', 'missing')),
            }
    except Exception:
        repo = None      # 附属信息, 拿不到就留空(不许影响主判定)

    try:
        line = json.dumps({
            'ts': datetime.datetime.now(TZ).isoformat(),
            'state': data.get('state'),
            'repo': repo,
            'next': data.get('next'),
            'vendorVerdicts': data.get('vendorVerdicts'),
            # "待加载/待构建"的包名清单: 这是"还差什么"的可判读部分
            'pending': sorted(k for k, v in (data.get('vendorVerdicts') or {}).items() if v in ('carrier-stale', 'build-stale', 'missing')),
            'steps': [{'name': s.get('name'), 'ok': s.get('ok')} for s in data.get('steps', [])],
        }, ensure_ascii=False)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'a', encoding='utf8') as fh:
            fh.write(line + chr(10))
            fh.flush()
            os.fsync(fh.fileno())
        # 只有明显超限时才截断(避免每次跑都重写整个文件)
        with open(path, 'r+', encoding='utf8') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = [x for x in lock.read().splitlines() if x.strip()]
            if len(rows) > keep + keep // 5:
                tmp = path + '.tmp'
                with open(tmp, 'w', encoding='utf8') as out:
                    out.write(chr(10).join(rows[-keep:]) + chr(10))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(tmp, path)
    except Exception as exc:      # noqa: BLE001 —— **附属写入失败不许影响主判定**(记录是尽力而为, 但必须可见)
        print('[ready] 读数落盘失败(不影响本次判定): %s' % exc, file=sys.stderr)
        return None
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--record', action='store_true', help='把本次读数追加一行到滚动数据(cl-367)')
    args = ap.parse_args()
    vendors = [x for x in (os.environ.get('DSH_READY_VENDOR') or '').split(',') if x] or VENDORS
    min_n = int(os.environ.get('DSH_READY_MIN_N') or 10)
    env = dict(os.environ)
    steps: list[dict] = []

    def step(name: str, ok: bool | None, detail: str) -> None:
        steps.append({'name': name, 'ok': ok, 'detail': detail})

    # ① 构建 / 部署滞后
    lag_rc, lag, lag_out = run_json([sys.executable, os.environ.get('DSH_READY_DEPLOY_LAG') or DEPLOY_LAG,
                                     '--json', '--only', ','.join(vendors)], env)
    if lag is None:
        step('部署滞后可判', None, 'deploy-lag 没有可解析输出: %s' % lag_out[-200:])
        state = 'blocked'
    else:
        rows = {r['package']: r for r in lag.get('rows', [])}
        verdicts = {k: v.get('verdict') for k, v in rows.items()}
        build_stale = [k for k, v in verdicts.items() if v in ('build-stale', 'missing')]
        carrier_stale = [k for k, v in verdicts.items() if v == 'carrier-stale']
        step('产物不比源码旧(已构建)', not build_stale, 'build-stale: %s' % (build_stale or '无'))
        step('载体已加载新产物', not carrier_stale,
             ('待加载: %s' % carrier_stale) if carrier_stale else '载体启动晚于产物更新')
        if build_stale:
            state = 'not-built'
        elif carrier_stale:
            state = 'built-stale'
        else:
            state = 'live'
    total = passed = None
    if state in ('live', 'live-warming', 'live-judging'):
        # ② 产物层可用性(只在真的进到"已加载"之后才有意义 —— 跳步就是拿"未测"当"通过")
        cmd = os.environ.get('DSH_READY_VERIFY_CMD')
        if cmd:
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=900, env=env)
            vout = (r.stdout or '') + (r.stderr or '')
            passed = vout.count('✓')
            total = passed + vout.count('✗')
            ok = r.returncode == 0
        else:
            vrc, vpayload, vout = run_json(['node', os.environ.get('DSH_READY_VERIFY') or VERIFY, '--json'], env)
            ok = vrc == 0
            passed = (vpayload or {}).get('passed')
            total = (vpayload or {}).get('total')
        step('产物层端到端可用', ok, 'passed=%s/%s' % (passed, total))
        if not ok:
            state = 'blocked'

    # ③ 线上链记录与预判定
    if state == 'live':
        # 阈值**只有一处来源**: 把本工具的 min_n 传给仪表, 否则"样本够不够"会出现两套口径(cl-359 自测抓到)。
        env_rep = dict(env, DSH_CHAIN_REPORT_MIN_N=str(min_n))
        rrc, rep, rout = run_json([sys.executable, os.environ.get('DSH_READY_REPORT') or REPORT, '--json'], env_rep)
        if rep is None:
            step('判定仪表可跑', None, rout[-200:])
            state = 'blocked'
        else:
            n_chain = rep.get('totals', {}).get('chain', 0)
            n_normal = rep.get('totals', {}).get('chainNormal', 0)
            step('线上出现链注入记录', n_chain > 0, '链记录 %d 条(常规会话可引用 %d 条)' % (n_chain, n_normal))
            outcome = rep.get('outcome')
            step('样本达阈值(%d 条可引用链记录)' % min_n, n_normal >= min_n, 'outcome=%s' % outcome)
            state = 'live-judging' if outcome in ('pass', 'fail') else 'live-warming'

    if state in ('not-built', 'built-stale', 'live-warming'):
        rc = 2
    elif state == 'live-judging':
        rc = 0 if state == 'live-judging' else 2
    else:
        rc = 3

    # ④ 由判定仪表的结论决定最终 rc(状态机最后一站才谈通过/不通过)
    if state == 'live-judging':
        rc = 0 if rep.get('outcome') == 'pass' else 1

    nxt = {
        'not-built': '先构建: dsh-build-package.sh <包路径>(产物比源码旧)',
        'built-stale': '产物已就绪, 等载体加载/重启(重启用户会话需其本人同意); 加载后本命令会自动推进到 live-warming',
        'live-warming': '机制在跑但样本不足: 继续累积链记录, 达阈值后本命令会给 pass/fail',
        'live-judging': '按 cl-354 判据处置: fail 时看失败项, 若是"链从未被引用" ⇒ 提高 minSimilarity 或关 chain.enabled',
        'blocked': '观测不成立, 先修上一步标红的那环(工具/产物/账本)',
    }[state]
    data = {'state': state, 'steps': steps, 'next': nxt, 'vendors': vendors, 'minN': min_n,
            'vendorVerdicts': {k: v.get('verdict') for k, v in (rows.items() if lag else [])}}
    recorded = None
    if args.record and os.environ.get('DSH_CHAIN_READINESS_DRY') != '1':
        recorded = record_reading(data)

    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print('[ready] 链检索侧就绪状态: **%s**' % state)
        for s in steps:
            mark = '✓' if s['ok'] is True else ('✗' if s['ok'] is False else '—(不可判)')
            print('  %s %s  %s' % (mark, s['name'], s['detail']))
        print('[ready] 下一步: %s' % nxt)
        if args.record:
            print('[ready] 读数已落盘: %s' % (recorded or '未写(DRY 或写入失败)'))
    return rc


if __name__ == '__main__':
    sys.exit(main())
