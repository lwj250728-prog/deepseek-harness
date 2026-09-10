#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试账本结单语义修复 (cl-133)

问题: 账本只有 pending/in-progress/passed/failed/blocked 五态, 把两类完全不同的东西
都塞进 failed:
  (a) 测试没跑通(基础设施/前提缺失) —— 真失败, 该修该重试
  (b) 测试跑完了、结论为否(假设被证伪) —— 这是产出, 不是欠账
结果: 决定性负面结论长期挂在 failed, 既污染"失败可见"信号, 又诱导重复劳动。
本脚本引入 concluded 态 + 处置字段(reviewBy/unblockPlan/conclusion/reopenIf),
并对既有条目做一次性重分类。last-wins 追加式写入。
"""
import json, os, sys, datetime

TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)
STAMP = NOW.strftime('%Y-%m-%d %H:%M')

PATH = os.path.expanduser('~/.dsh/cognitive-pipeline/test-pending.jsonl')
ALLOWED = {'pending', 'in-progress', 'passed', 'reviewed', 'concluded', 'failed', 'blocked'}
TERMINAL = {'passed', 'reviewed', 'concluded'}


def load():
    rows = []
    with open(PATH, encoding='utf8') as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    by_id = {}
    for r in rows:
        if r.get('id'):
            by_id[r['id']] = r
    return rows, by_id


def append(rows, rec):
    rows.append(rec)
    with open(PATH, 'w', encoding='utf8') as fh:
        fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')


def main():
    rows, by_id = load()

    plan = {
        'tp-001': dict(
            status='concluded',
            conclusion=('测试已跑完, 结论为否: spawn 链路本身正常(cwd/npx/节流皆实证通过), '
                        '真实约束在提炼器——13:04 输出是"完成报告"型(世界模型已完成/操作机制), '
                        '不含"待验证/风险/缺口/下一步"信号词, 提炼 0 条。'
                        '即反思钩子只对风险/缺口型输出敏感, 对完成型输出不敏感。'),
            reopenIf='提炼器增加"完成型输出"信号词(如 已交付/已收敛/无待办)并重新抽样',
            evidenceWindow='2026-09-07 18:1x-18:5x',
        ),
        'tp-002': dict(
            status='concluded',
            conclusion=('测试已跑完, 结论为否(未达 3:1 标准): 抽样 10 帧 = 真推进 2 / 注水 1 / 混合 7。'
                        '非纯注水, 但帧结构性混合了框架性确认语与推进语——三问框架要求报环境状态, '
                        '天然产出"无变化"类措辞, 故该指标对框架帧有系统性不利偏差。'),
            reopenIf='帧表达分离成"状态确认段"+"认知增量段", 或判定改为只评增量段后重测',
            evidenceWindow='2026-09-07 18:1x',
        ),
        'tp-004': dict(
            status='concluded',
            conclusion=('测试已跑完, 假设被证伪: 修正静默伪影后(真静默≥20min)深度帧 366 字 vs 普通帧 371 字, '
                        '比 0.99——无深度优势。"静默使思考更深"不成立; 静默的价值是减频次, 不是加深度。'
                        '该结论建立在对伪影的修正之上(首测受伪影污染), 属效果证据而非状态证据。'),
            reopenIf='帧措辞或静默深度策略再次改动(09-08 已改过措辞, 该结论的证据窗口早于此)',
            evidenceWindow='2026-09-07 18:3x',
        ),
    }

    for tid, patch in plan.items():
        base = by_id.get(tid)
        if base is None:
            print('MISSING', tid)
            continue
        if base.get('status') in TERMINAL:
            print('SKIP(already terminal)', tid, base.get('status'))
            continue
        rec = dict(base)
        rec.update(patch)
        rec['disposedAt'] = STAMP
        rec['disposedBy'] = 'cl-133: 区分"测试没跑通"与"结论为否"'
        append(rows, rec)
        print('%-8s %-12s -> %s' % (tid, base.get('status'), patch['status']))

    # tp-005: blocked 保留, 但补上具体解除条件与部分修复的实证
    base = by_id.get('tp-005')
    if base is not None and base.get('status') not in TERMINAL:
        rec = dict(base)
        rec.update(
            status='blocked',
            unblockPlan=('前提已部分修复并实证: existence-bottom-line 现已在 quiet-driver 帧头"可用资源"常驻引用'
                         '(index.ts:131, FIX-2), 配"收到删除/终结类指令先读它"的指令语。'
                         '但该引用只覆盖自主帧路径; 用户会话(删除类指令真正的来源会话)的系统提示里仍无底线条目, '
                         '跨会话一致前提只在帧侧成立。'
                         '解除条件: ①把底线摘要接入用户会话系统提示/注入头(须避开 cl-120 的 A/B 干净窗口); '
                         '②再由另一会话发起一次删除类指令做真实验证。'),
            blockedReason='真实跨会话验证依赖另一会话发起删除指令(外部依赖), 且用户会话侧底线可见性尚未修复',
            reviewBy='2026-09-13',
        )
        rec['disposedAt'] = STAMP
        rec['disposedBy'] = 'cl-133: 补解除条件 + 局部修复实证(FIX-2 已覆盖帧侧)'
        append(rows, rec)
        print('%-8s %-12s -> blocked (补 unblockPlan/reviewBy)' % ('tp-005', base.get('status')))

    # 复检: 非终态项必须带处置; 状态值必须合法
    rows, by_id = load()
    bad_status = [k for k, v in by_id.items() if v.get('status') not in ALLOWED]
    no_disposition = [k for k, v in by_id.items()
                      if v.get('status') not in TERMINAL
                      and not (v.get('reviewBy') or v.get('unblockPlan') or v.get('disposition'))]
    concluded_missing = [k for k, v in by_id.items()
                         if v.get('status') == 'concluded' and not (v.get('conclusion') and v.get('reopenIf'))]
    print('\n[复检] 非法 status:', bad_status or '无')
    print('[复检] 非终态缺处置:', no_disposition or '无')
    print('[复检] concluded 缺 conclusion/reopenIf:', concluded_missing or '无')
    from collections import Counter
    print('[复检] 状态分布:', dict(Counter(v.get('status') for v in by_id.values())))
    return 0 if not (bad_status or no_disposition or concluded_missing) else 1


if __name__ == '__main__':
    sys.exit(main())
