#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-subgoal-apply.py — **子目标的唯一申请/审核通道**(用户 2026-09-14 指令)。

指令(原话): 「应该让目标孵化池机制增加一个子目标审核功能，帧产生的子目标要向目标孵化池申请」。

要解决的问题(2026-09-14 实测): 我的四层(目标 8 / claims 389 / 测试 212 / 判据 128)**之间没有任何关系字段** ——
目标→claim 只存在于 `nextAction` 散文里(词袋, 孵化那条提到 60 个 id); claim→目标 **0/389** 有字段;
今晚新增的 7 个判据里 T238/T239 **没有任何 claim 提到**。⇒ 生长全部发生在**叶子**(帧驱动/事故驱动),
边上没有结构, 于是三个 active 目标的 nextAction 全是等待型时, **没有任何目标为当晚的工作负责**。

本通道把"新造一个子目标"变成一次**申请**:
  · `--apply`: 帧/代理只能**申请**, 不能直接落地; 必填 `--serves`(目标 id 或 infra/debt) 与 `--evidence`(机器可核的指针);
  · `--adjudicate`: **池侧**裁决 accepted / rejected / deferred —— accepted 必须给理由并**钉住 serves 边**;
    deferred 必须给**重开条件**(否则视为 rejected); rejected 必须给理由;
  · `--list/--check`: 可核视图; `--check` 判不变式: ①无长期 pending ②accepted 必须有 serves 且该目标存在
    ③deferred 必须有 reOpen ④pending 总数不得超上限(防洪)。

用法:
  dsh-subgoal-apply.py --apply --title X --why Y --serves goal-xxx --kind judgement --evidence T243
  dsh-subgoal-apply.py --list --status pending
  dsh-subgoal-apply.py --adjudicate sg-0003 --verdict accepted --reason "服务于孵化的机制卫生子轨" --by pool
  dsh-subgoal-apply.py --check            # 判不变式(判据组 T243 消费它)
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
TAG = '[subgoal]'
DEFAULT_CAP = 12          # 同时在飞的申请上限(防洪): 超了必须先裁决再申请
PENDING_TTL_HOURS = 24    # 申请必须在一天内被裁决, 否则 --check 判红


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def ledger() -> str:
    return os.path.join(cog_dir(), 'subgoal-applications.jsonl')


def now() -> datetime.datetime:
    return datetime.datetime.now(TZ)


def load(path: str):
    try:
        with open(path, encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return None


def current() -> dict:
    """账本 last-wins: 每个 id 的当前状态 = 末行。"""
    out = {}
    try:
        for line in open(ledger(), encoding='utf8'):
            if line.strip():
                r = json.loads(line)
                if r.get('id'):
                    out[r['id']] = r
    except FileNotFoundError:
        pass
    return out


def append(rows: list) -> None:
    p = ledger()
    with open(p, 'a', encoding='utf8') as fh:            # 追加式: 只 append, 不重写(与其它账本同纪律)
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
        fh.flush()
        os.fsync(fh.fileno())


def goal_ids() -> set:
    rows = load(os.path.join(cog_dir(), 'dormant-goals.jsonl')) or []
    out = set()
    try:
        for line in open(os.path.join(cog_dir(), 'dormant-goals.jsonl'), encoding='utf8'):
            if line.strip():
                out.add(str(json.loads(line).get('id')))
    except Exception:
        pass
    return out


def next_id(cur: dict) -> str:
    n = 1
    while ('sg-%04d' % n) in cur:
        n += 1
    return 'sg-%04d' % n


EV_RE = re.compile(r'(cl-[a-z0-9-]+|tp-[0-9]+|T[0-9]{3}|/[^\s]+|[\w./-]+\.(py|sh|json|jsonl|md))')


def apply_one(args) -> int:
    cur = current()
    problems = []
    if not str(args.title or '').strip():
        problems.append('缺 --title')
    if not str(args.why or '').strip():
        problems.append('缺 --why(为什么要做; 空理由的申请一律拒)')
    serves = str(args.serves or '').strip()
    if not serves:
        problems.append('缺 --serves(必须指向一个目标 id, 或显式写 infra/debt)')
    elif serves not in ('infra', 'debt') and serves not in goal_ids():
        problems.append('--serves 指向的目标不存在: %r' % serves)
    if not str(args.evidence or '').strip():
        problems.append('缺 --evidence(必须给机器可核的指针: cl-/tp-/T 号或文件路径)')
    elif not EV_RE.search(args.evidence):
        problems.append('--evidence 里找不到任何可核指针(cl-/tp-/T 号或路径): %r' % args.evidence)
    if str(args.kind or '') not in ('judgement', 'test', 'claim', 'tool', 'doc', 'policy'):
        problems.append('--kind 必须是 judgement/test/claim/tool/doc/policy')
    pend = [r for r in cur.values() if r.get('status') == 'pending']
    if len(pend) >= DEFAULT_CAP:
        problems.append('在飞的申请已达上限 %d ⇒ 先裁决再申请(防洪)' % DEFAULT_CAP)
    for r in pend:
        if str(r.get('title') or '').strip() == str(args.title).strip():
            problems.append('同标题的申请已在飞: %s(%s)' % (r['id'], r.get('status')))
    if problems:
        print('%s 申请被拒(前置闸): %s' % (TAG, '; '.join(problems)), file=sys.stderr)
        return 3
    sid = next_id(cur)
    row = {'id': sid, 'ts': now().isoformat(), 'status': 'pending', 'origin': args.origin or 'frame',
           'title': str(args.title).strip(), 'why': str(args.why).strip(), 'serves': serves,
           'kind': args.kind, 'evidence': str(args.evidence).strip(), 'cost': args.cost or '',
           'appliedBy': args.by or 'agent'}
    append([row])
    print('%s 已受理申请 %s(serves=%s kind=%s) —— **未裁决前不得落地**(先申请后施工)' % (TAG, sid, serves, args.kind))
    return 0


def adjudicate(args) -> int:
    cur = current()
    r = cur.get(args.adjudicate)
    if not r:
        print('%s 没有这个申请: %s' % (TAG, args.adjudicate), file=sys.stderr)
        return 3
    if r.get('status') != 'pending' and not args.force:
        print('%s %s 已是 %s(改判需 --force)' % (TAG, args.adjudicate, r['status']), file=sys.stderr)
        return 3
    v = args.verdict
    problems = []
    if v == 'accepted':
        if not str(args.reason or '').strip():
            problems.append('accepted 必须给理由')
        serves = str(args.assign_serves or r.get('serves') or '')
        if not serves or (serves not in ('infra', 'debt') and serves not in goal_ids()):
            problems.append('accepted 必须钉住一个存在的 serves 边(或 infra/debt): %r' % serves)
    elif v == 'deferred':
        if not str(args.reopen or '').strip():
            problems.append('deferred 必须给重开条件(否则请直接 rejected)')
    elif v == 'rejected':
        if not str(args.reason or '').strip():
            problems.append('rejected 必须给理由(否则等于静默丢弃)')
    else:
        problems.append('verdict 必须是 accepted/rejected/deferred')
    if problems:
        print('%s 裁决被拒: %s' % (TAG, '; '.join(problems)), file=sys.stderr)
        return 3
    row = {'id': r['id'], 'ts': now().isoformat(), 'status': v,
           'serves': args.assign_serves or r.get('serves'), 'title': r.get('title'), 'kind': r.get('kind'),
           'evidence': r.get('evidence'), 'appliedAt': r.get('ts'), 'decidedBy': args.by or 'pool',
           'reason': str(args.reason or '').strip(), 'reOpen': str(args.reopen or '').strip()}
    append([row])
    print('%s 裁决 %s → %s(%s)' % (TAG, r['id'], v, row.get('reason') or row.get('reOpen') or ''))
    return 0


def check(args) -> int:
    cur = current()
    if not cur:
        print('%s 账本为空 ⇒ 前提不成立(机制在但没数据)' % TAG, file=sys.stderr)
        return 3
    reds, ok = [], 0
    goals = goal_ids()
    for sid, r in sorted(cur.items()):
        st = r.get('status')
        if st == 'pending':
            age = (now() - datetime.datetime.fromisoformat(str(r.get('ts')))).total_seconds() / 3600.0
            if age > PENDING_TTL_HOURS:
                reds.append('%s 申请挂了 %.1fh 未裁决(> %dh) ⇒ 申请通道不得变成垃圾场'
                            % (sid, age, PENDING_TTL_HOURS))
            else:
                ok += 1
        elif st == 'accepted':
            s = str(r.get('serves') or '')
            if not s or (s not in ('infra', 'debt') and s not in goals):
                reds.append('%s accepted 但 serves 边不存在: %r' % (sid, s))
            elif not str(r.get('reason') or '').strip():
                reds.append('%s accepted 但没写理由' % sid)
            else:
                ok += 1
        elif st == 'deferred':
            if not str(r.get('reOpen') or '').strip():
                reds.append('%s deferred 但没有重开条件(等于静默丢弃)' % sid)
            else:
                ok += 1
        elif st == 'rejected':
            if not str(r.get('reason') or '').strip():
                reds.append('%s rejected 但没写理由' % sid)
            else:
                ok += 1
        else:
            reds.append('%s 状态非法: %r' % (sid, st))
    pend = [r for r in cur.values() if r.get('status') == 'pending']
    if len(pend) > DEFAULT_CAP:
        reds.append('在飞申请 %d > 上限 %d' % (len(pend), DEFAULT_CAP))
    for r in reds:
        print('%s **判红** %s' % (TAG, r), file=sys.stderr)
    print('%s 申请 %d 条: 合规 %d / 判红 %d(在飞 %d / 上限 %d)'
          % (TAG, len(cur), ok, len(reds), len(pend), DEFAULT_CAP), file=sys.stderr)
    if args.json:
        print(json.dumps({'total': len(cur), 'ok': ok, 'red': reds, 'pending': len(pend)},
                         ensure_ascii=False))
    return 1 if reds else 0


def list_rows(args) -> int:
    cur = current()
    rows = [r for r in cur.values() if (not args.status or r.get('status') == args.status)]
    for r in sorted(rows, key=lambda x: str(x.get('id'))):
        print('%-9s %-9s %-28s serves=%-28s kind=%-10s %s'
              % (r.get('id'), r.get('status'), str(r.get('title'))[:28], r.get('serves'),
                 r.get('kind'), str(r.get('ts'))[:19]))
    print('%s 共 %d 条(筛选: %s)' % (TAG, len(rows), args.status or '全部'))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--adjudicate', default=None)
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--title', default='')
    ap.add_argument('--why', default='')
    ap.add_argument('--serves', default='')
    ap.add_argument('--kind', default='judgement')
    ap.add_argument('--evidence', default='')
    ap.add_argument('--cost', default='')
    ap.add_argument('--origin', default='frame')
    ap.add_argument('--by', default='')
    ap.add_argument('--verdict', default='')
    ap.add_argument('--reason', default='')
    ap.add_argument('--reopen', default='')
    ap.add_argument('--assign-serves', dest='assign_serves', default='')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--status', default='')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if args.apply:
        return apply_one(args)
    if args.adjudicate:
        return adjudicate(args)
    if args.check:
        return check(args)
    if args.list:
        return list_rows(args)
    ap.error('需要 --apply / --adjudicate <id> / --list / --check')
    return 2


if __name__ == '__main__':
    sys.exit(main())
