#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采纳裁决闸门: 观察型 nextAction 的"武装"机制(tp-099 / T116)。

问题形态: 目标 goal-adoption-rate 的下一步是"观察型"——要等样本涨到能裁决。
等待型步骤若只写在 nextAction 里, 行动帧会一遍遍推同一步(exp_126 的轰炸), 而
真正的风险是反向的: 等样本达标了也没人把 nextAction 翻成可执行, 目标静默停摆
(exp_189: "写标记文件触发感知"是幻觉接线, 触发链必须有明确消费者)。

本脚本就是那个消费者: 由 cron 定时读 A/B 判据(唯一生产者), 一旦**闸门达标**就
把目标的 nextAction 改写成可执行的裁决指令; 未达标则明确记账"仍在等"。
判据不是魔数: 方向裁决要求 Wilson 区间**分离**(distinct from 点估计比较)。

用法: dsh-adoption-gate-arm.py [--dry-run]
退出码: 0 = 已检查(无论是否武装); 1 = 读不到判据。
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

DIR = os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.path.expanduser('~/dsh-fork')
GOALS = os.path.join(DIR, 'dormant-goals.jsonl')
AB = os.path.join(DIR, 'ab-compare.json')
LOG = os.path.join(DIR, 'adoption-gate.log')
TZ = datetime.timezone(datetime.timedelta(hours=8))
TARGET = 'goal-adoption-rate'

ARMED_ACTION = (
    '执行(闸门已达标, 由 dsh-adoption-gate-arm.py 自动武装): 读 ab-compare.json 的 adoptionVerdict —— '
    '①若 direction=adverse-significant ⇒ 按预登记回滚 topK 3→1(改 profile + 重建 + 重启 + 记 confounder); '
    '②若 direction=better-significant 或 indistinguishable 且三条主判据不降 ⇒ 保留 topK=3 并把结论写进目标 notes; '
    '③若 lift 的 n>=100 ⇒ 同时裁决 lift 有效性(阈值 lift>=2)。裁决后清空本 nextAction 并关单。'
    '【待用户】cl-094/cl-130: 确认留在 deepseek-flash 还是换 deepseek-v4-pro。'
)


def _load(path: str) -> dict | None:
    try:
        return json.load(open(path, encoding='utf8'))
    except Exception:
        return None


def refresh() -> dict | None:
    run = subprocess.run([sys.executable, os.path.join(REPO, 'dsh-ab-compare.py'), '--quiet'],
                         capture_output=True, text=True, timeout=600)
    if run.returncode != 0:
        return None
    try:
        return json.load(open(AB, encoding='utf8'))
    except Exception:
        return None


def _arg(flag: str, default: str) -> str:
    """--flag value 取值(可测性: 断言套件用临时文件跑, 不碰真账本)。"""
    if flag in sys.argv:
        idx = sys.argv.index(flag)
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    return default


def main() -> int:
    dry = '--dry-run' in sys.argv
    goals_path = _arg('--goals', GOALS)
    ab_path = _arg('--ab', AB)
    # 测试必须能把痕迹写到自己的临时文件: 合成用例写进生产日志 = 制造假痕迹
    # (实测踩过: 两条合成 ARMED 行混进 adoption-gate.log, 读日志的人会以为闸门真的武装了)。
    log_path = _arg('--log', LOG)
    payload = refresh() if ab_path == AB else _load(ab_path)
    if payload is None:
        line = '缺判据 origin=%s: ab-compare 不可用, 闸门未检查' % os.environ.get('DSH_RUN_ORIGIN', 'manual')
        print(line, file=sys.stderr)
        with open(log_path, 'a', encoding='utf8') as fh:
            fh.write('%s %s\n' % (datetime.datetime.now(TZ).isoformat(), line))
        return 1
    verdict = payload.get('adoptionVerdict') or {}
    adoption = payload.get('adoption') or {}
    union = adoption.get('afterUnion') or {}
    direction = verdict.get('direction')
    turns = union.get('turnsWithInjection') or 0
    lift_turns = (adoption.get('segments') or {}).get('before', {}).get('turnsWithInjection')
    lift_n = turns + (lift_turns or 0)

    # 闸门一: 方向可裁决(区间分离); 闸门二: lift 的样本达标(>=100 回合)
    gate_direction = direction in ('adverse-significant', 'better-significant')
    gate_lift = lift_n >= 100
    armed = gate_direction or gate_lift
    reasons = []
    if gate_direction:
        reasons.append('方向已分离(%s)' % direction)
    if gate_lift:
        reasons.append('lift 样本达标(n=%d>=100)' % lift_n)

    stamp = datetime.datetime.now(TZ).strftime('%Y-%m-%d %H:%M')
    changed = False
    if armed and not dry:
        rows = [json.loads(l) for l in open(goals_path, encoding='utf8') if l.strip()]
        for goal in rows:
            if goal.get('id') == TARGET:
                if str(goal.get('nextAction') or '').startswith('执行(闸门已达标'):
                    reasons.append('已是武装态, 跳过改写')
                    break
                goal['nextAction'] = ARMED_ACTION
                notes = goal.get('notes')
                if isinstance(notes, str):
                    notes = [notes]
                goal['notes'] = list(notes or []) + [
                    '%s 闸门自动武装: %s —— nextAction 已改写为可执行裁决指令(观察型步骤到此为止)。'
                    % (stamp, '、'.join(reasons))]
                changed = True
                break
        if changed:
            with open(goals_path, 'w', encoding='utf8') as fh:
                fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')

    line = ('%s origin=%s 闸门=%s | 方向=%s | 后窗回合=%d | lift样本=%d | %s'
            % (stamp, os.environ.get('DSH_RUN_ORIGIN', 'manual'), 'ARMED' if armed else 'waiting', direction, turns, lift_n,
               '、'.join(reasons) or '未达标(继续观察)'))
    with open(log_path, 'a', encoding='utf8') as fh:
        fh.write(line + '\n')
    print(line)
    if armed and not changed and not dry:
        print('(已是武装态, 无需改写)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
