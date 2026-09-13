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

用法: dsh-chain-readiness.py [--json]
退出码: 0 = pass; 1 = fail; 2 = 尚未到可判(未构建/未加载/样本不足); 3 = 观测不成立。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
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
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print('[ready] 链检索侧就绪状态: **%s**' % state)
        for s in steps:
            mark = '✓' if s['ok'] is True else ('✗' if s['ok'] is False else '—(不可判)')
            print('  %s %s  %s' % (mark, s['name'], s['detail']))
        print('[ready] 下一步: %s' % nxt)
    return rc


if __name__ == '__main__':
    sys.exit(main())
