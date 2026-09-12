#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-intervention.py — 目标唤醒的**开关干预**工具(cl-264 的干预实验)。

为什么需要它: 观测层面已经用尽 —— "有唤醒的时段推进更快"(×2.49/×13.4)在**同样活跃时段对照**下不成立
(目标层 30/60 分钟粒度 p≈0.10 ⇒ no-signal; 全库层"活跃但无唤醒"的段数为 0 ⇒ 对照不适用),
因为唤醒与推进**共线于活动期**, 观测分不开因果。唯一能分开的办法是**干预**: 关掉某目标的唤醒, 看推进是否随之下降。

设计原则(全部为了让实验可在无人记得的情况下正确结束):
  ① **开关=池字段**: 用 `triggerThresholds`(kernel/focus) 抬到 1.01 = 任何相似度都命不中 ⇒ 该目标不再被唤醒。
     不新增代码路径、不改驱动, 只改一个已有字段的值。
  ② **原值必须落盘**: 每次 disable 都把原 `triggerThresholds` 与触发计数写进 `wake-interventions.jsonl`,
     使 restore 有据可依(回滚不靠记忆, 也不靠 git)。
  ③ **本工具只改这一个字段**: 其余字段由现有唯一写入方 `dsh-goal-pool-write.py` 追加行(last-wins), 保持写入口收口。

用法:
  dsh-wake-intervention.py disable <goalId> --hours 24 --reason "..." --reversal-expectation "..."
  dsh-wake-intervention.py preregister <goalId> --expectation "..."   # 给已开窗口补登记恢复腿预期
  dsh-wake-intervention.py restore <goalId> [--reason "..."]            # 按登记的原值恢复
  dsh-wake-intervention.py status [<goalId>]
退出码: 0 正常; 2 参数/状态问题(如 restore 无原始值可依); 3 池不可读。

**恢复腿必须预登记**(2026-09-12 10:2x 加, 由 T203 守): 干预实验的恢复腿如果等到窗口结束后再解释,
那就不是预登记而是事后叙事 —— 与 `threshold-prereg.json` 同一条纪律。故 `disable` **强制**要
`--reversal-expectation`(窗口结束前必须看到什么的判据), 且它必须在**窗口结束之前**落盘;
已开的窗口可用 `preregister` 补登记(仍须早于窗口结束, 否则 lint 判红)。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
POOL = os.path.join(D, 'dormant-goals.jsonl')
RECORD = os.path.join(D, 'wake-interventions.jsonl')
WRITER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-goal-pool-write.py')
OFF_THRESHOLDS = {'kernel': 1.01, 'focus': 1.01}   # 相似度上界为 1 ⇒ 1.01 永不命中
# 2026-09-12 06:1x **实测查证后补的关键一刀**: dormant-goal 哨兵读 `triggerThresholds`, 但 quiet-driver 的
# **行动帧**只读 `status`/`nextAction`/`waitChecker` —— 只抬阈值 ⇒ 孵化提醒停了, **行动帧照来**(实验只关掉一半信号,
# 结论会失真)。故关闭时**同时**把 waitChecker 设成永不满足(`/bin/false`): cl-250 已把两侧语义统一(exit 0=该干),
# 于是这一个字段能同时关掉哨兵与驱动两边的唤醒。
OFF_WAIT_CHECKER = '/bin/false'


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def current(goal_id: str) -> dict:
    row = None
    for line in open(POOL, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if str(r.get('id')) == goal_id:
                row = r                                   # last-wins
    if row is None:
        raise LookupError('池里没有该目标: ' + goal_id)
    return row


def pool_rows() -> dict:
    """池的 last-wins 视图。"""
    latest: dict = {}
    for line in open(POOL, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if r.get('id'):
                latest[str(r['id'])] = r
    return latest


def control_headroom(target: str, timeout: float = 60.0) -> dict:
    """对照臂**有没有推进空间**(2026-09-12 11:5x 实测缺陷所在的机制化)。

    干预实验的预登记判据是"目标降幅**大于所有对照**"—— 这条判据要能开火, 前提是**至少有一条对照臂
    真的在推进**。实测: 三条 active 目标全部门未满足时(目标 /bin/false + 孵化的判读门 + 检索的样本门),
    对照臂自己也塌成 0 ⇒ 判据**不可能**成立, 于是 no-effect 是被构造成出来的、不是测出来的
    (与 T199"饱和 ⇒ 判据没有开火空间"同型)。故关闭干预前先探测: 无门或门当场 exit 0 ⇒ 有空间。
    测不出(门跑不动/超时)⇒ 按**没有**空间记(fail-closed: 宁可要求显式豁免)。
    """
    out: dict = {}
    for gid, row in pool_rows().items():
        if gid == target or str(row.get('status')) != 'active':
            continue
        cmd = str(row.get('waitChecker') or '').strip()
        if not cmd:
            out[gid] = {'headroom': True, 'why': '无门'}
            continue
        try:
            rc = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout).returncode
        except Exception as exc:  # noqa: BLE001
            out[gid] = {'headroom': False, 'why': '门跑不动(%s)' % type(exc).__name__}
            continue
        out[gid] = {'headroom': rc == 0, 'why': '门当场满足' if rc == 0 else '门未满足(exit %d)' % rc}
    return out


def records() -> list[dict]:
    if not os.path.exists(RECORD):
        return []
    out = []
    for line in open(RECORD, encoding='utf8'):
        if line.strip():
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def apply(goal_id: str, thresholds: dict, reason: str, wait_checker: str | None = None) -> int:
    """通过唯一写入方改 triggerThresholds(与 waitChecker)(保持写入口收口)。"""
    cmd = ['python3', WRITER, goal_id, '--pool', POOL,
           '--set', 'triggerThresholds=' + json.dumps(thresholds, ensure_ascii=False)]
    if wait_checker is not None:
        cmd += ['--set', 'waitChecker=' + wait_checker]
    cmd += ['--reason', reason, '--write']
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    print((r.stdout or '') + (r.stderr or ''), end='')
    return r.returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('disable')
    d.add_argument('goal')
    d.add_argument('--hours', type=float, default=24.0)
    d.add_argument('--reason', default='')
    d.add_argument('--allow-no-headroom', action='store_true',
                   help='明知没有任何对照臂有推进空间仍要开窗(须在 --reason 写明为什么这种窗口仍有信息量)')
    d.add_argument('--reversal-expectation', default='',
                   help='恢复腿预登记: 窗口结束后必须看到什么(留空即拒绝关闭 —— 事后叙事不算预登记)')
    p = sub.add_parser('preregister')
    p.add_argument('goal')
    p.add_argument('--expectation', required=True)
    s = sub.add_parser('restore')
    s.add_argument('goal')
    s.add_argument('--reason', default='干预窗口结束, 回滚到原阈值')
    st = sub.add_parser('status')
    st.add_argument('goal', nargs='?')
    args = ap.parse_args()

    if args.cmd == 'status':
        for rec in records():
            if rec.get('event') in ('disable', 'restore') and (args.goal is None or rec.get('goal') == args.goal):
                print('%s %-8s %s -> %s | 原因: %s' % (str(rec.get('ts'))[:19], rec.get('event'),
                                                       rec.get('goal'), json.dumps(rec.get('thresholdsAfter'), ensure_ascii=False),
                                                       str(rec.get('reason'))[:60]))
        if not records():
            print('（无干预记录）')
        return 0

    try:
        row = current(args.goal)
    except LookupError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    orig = row.get('triggerThresholds')
    orig_wait = row.get('waitChecker') or ''
    if args.cmd == 'preregister':
        dis = [r for r in records() if r.get('goal') == args.goal and r.get('event') == 'disable']
        if not dis:
            print('preregister 无窗口可挂(该目标没有 disable 记录)⇒ 拒绝', file=sys.stderr)
            return 2
        with open(RECORD, 'a', encoding='utf8') as f:
            f.write(json.dumps({'ts': now_iso(), 'event': 'preregister', 'goal': args.goal,
                                'reversalExpectation': args.expectation,
                                'windowDisableTs': dis[-1].get('ts'),
                                'reason': '恢复腿预登记(须早于窗口结束)'}, ensure_ascii=False) + '\n')
        print('[干预] %s 恢复腿预期已预登记(窗口 disable@%s)' % (args.goal, str(dis[-1].get('ts'))[:19]))
        return 0
    if args.cmd == 'disable':
        if not str(args.reversal_expectation).strip():
            print('拒绝关闭: 缺 --reversal-expectation —— 恢复腿必须先登记判据(事后叙事不算预登记); '
                  '已开窗口可用 preregister 补登记', file=sys.stderr)
            return 2
        if orig == OFF_THRESHOLDS and str(orig_wait).strip() == OFF_WAIT_CHECKER:
            print('已经是关闭状态(阈值 %s + waitChecker %s), 幂等返回' % (json.dumps(orig, ensure_ascii=False), OFF_WAIT_CHECKER))
            return 0
        head = control_headroom(args.goal)
        no_headroom = not any(v['headroom'] for v in head.values())
        if no_headroom and not args.allow_no_headroom:
            print('拒绝关闭: 没有任何对照臂有推进空间(%s) ⇒ 预登记判据"目标降幅大于所有对照"天生没有开火空间, '
                  '这个窗口只会被构造成 no-effect(2026-09-12 实测: 三条 active 目标全部门未满足时正如此)。'
                  '确有理由请加 --allow-no-headroom 并在 --reason 写明。' % json.dumps(head, ensure_ascii=False),
                  file=sys.stderr)
            return 2
        rc = apply(args.goal, OFF_THRESHOLDS, args.reason or '关闭唤醒做干预实验', OFF_WAIT_CHECKER)
        if rc == 0:
            with open(RECORD, 'a', encoding='utf8') as f:
                f.write(json.dumps({'ts': now_iso(), 'event': 'disable', 'goal': args.goal,
                                    'controlHeadroom': head, 'headroomWaived': bool(no_headroom),
                                    'thresholdsBefore': orig, 'thresholdsAfter': OFF_THRESHOLDS,
                                    'waitCheckerBefore': orig_wait, 'waitCheckerAfter': OFF_WAIT_CHECKER,
                                    'triggerCountBefore': row.get('triggerCount'),
                                    'plannedHours': args.hours, 'reason': args.reason,
                                    'reversalExpectation': args.reversal_expectation}, ensure_ascii=False) + '\n')
            print('[干预] %s 唤醒已关闭(阈值 %s + waitChecker %s), 计划 %g 小时后恢复; 恢复腿预期已预登记'
                  % (args.goal, json.dumps(OFF_THRESHOLDS), OFF_WAIT_CHECKER, args.hours))
        return rc
    # restore
    prior = [r for r in records() if r.get('goal') == args.goal and r.get('event') == 'disable']
    if not prior:
        print('restore 无原始阈值可依(没有 disable 记录)⇒ 拒绝猜测', file=sys.stderr)
        return 2
    back = prior[-1].get('thresholdsBefore')
    if not isinstance(back, dict) or not back:
        print('disable 记录里没有原阈值 ⇒ 拒绝猜测', file=sys.stderr)
        return 2
    back_wait = prior[-1].get('waitCheckerBefore')
    rc = apply(args.goal, back, args.reason, back_wait if isinstance(back_wait, str) else '')
    if rc == 0:
        with open(RECORD, 'a', encoding='utf8') as f:
            f.write(json.dumps({'ts': now_iso(), 'event': 'restore', 'goal': args.goal,
                                'thresholdsAfter': back, 'waitCheckerAfter': prior[-1].get('waitCheckerBefore'),
                                'restoredFrom': prior[-1].get('ts'),
                                'reason': args.reason}, ensure_ascii=False) + '\n')
        print('[干预] %s 唤醒已恢复(阈值 %s)' % (args.goal, json.dumps(back, ensure_ascii=False)))
    return rc


if __name__ == '__main__':
    sys.exit(main())
