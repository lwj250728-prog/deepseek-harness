#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""关单 cl-113(Q3 承诺: 清理非终态测试项 + 落地"超期即红"), 并把 cl-111 转为待证。"""
import json, os, sys, datetime

TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)
STAMP = NOW.strftime('%Y-%m-%d %H:%M')
P = os.path.expanduser('~/.dsh/cognitive-pipeline/claims-ledger.jsonl')

UPDATES = {
    'cl-113': dict(
        status='done',
        doneAt=NOW.isoformat(),
        doneNote=(
            '%s 关单(逐项兑现, 非整批宣称): ①tp-035 → passed: T30 组 5 断言已在套件中且全绿'
            '(meta子类显式标记/不再文本嗅探/lib已部署/外推扫描器可用/meta标记与文本一致), '
            'tp-035 自 09-09 00:16 挂 in-progress 后再无人看, 而所需覆盖早已存在——不是缺测试, 是缺回头裁决。'
            '②tp-001/002/004 → concluded(新引入的终态): 三条都"跑完了且结论为否", 原本却记在 failed 上, '
            '把"假设被证伪"与"测试没跑通"混为一谈(前者是产出, 后者是欠账), 直接污染失败信号并诱导重复劳动; '
            '每条补 conclusion + reopenIf(前提一变即重开), 例: tp-004 证伪了"静默使思考更深"(366 vs 371 字, 比 0.99), '
            '但该结论的证据窗口早于 09-08 帧措辞变更, 故 reopenIf 记"帧措辞或静默深度策略再改"。'
            '③tp-005 → blocked 保留但补齐解除条件: 前提已部分修复并实证(existence-bottom-line 现于 quiet-driver 帧头 '
            'index.ts:131 常驻引用, FIX-2), 但只覆盖自主帧路径; 用户会话(删除类指令真正来源)的系统提示里仍无该条目, '
            '故跨会话一致前提只在帧侧成立; 解除条件=接入用户会话系统提示(避开 cl-120 A/B 窗口) + 另一会话真实发起删除指令。'
            '④"落地 T91"这句当时编错了号——T91 早已被采用率闸门占用, 于是这条实质从未落地(编号在、实质亡, '
            '又一例"机制在、条件已死")。实质现落在 T112 第 2、5 断言: 非终态项须有处置, 且处置超 3 天或无处置时间戳即红。'
            '证伪信号复核: 承诺原文写"下次审视时这5项原封不动 = 口径未落地"——本次 5 项全部发生了状态迁移, 非原封不动。'
            '守卫有效性已做负向测试(合成 9 天前样本 → 断言开火为 STALE; 新鲜样本 → OK), 排除空过守卫。'
        ) % STAMP,
    ),
    'cl-111': dict(
        status='fixed-awaiting-evidence',
        revisedAt=NOW.isoformat(),
        note=(
            '%s 机制已落地: 再访机制不再依赖"审视帧记得回头", 而是由 T112 强制——'
            '①非终态项必须带处置(reviewBy/unblockPlan/disposition), 否则红; '
            '②处置超 3 天或无任何时间戳即红(负向测试证明能开火); '
            '③concluded 项必须带 conclusion + reopenIf, 防"结论亡"(前提变了结论照旧)。'
            '待证部分: 机制是"迫使裁决"而非"自动裁决", 是否真的减少旧项滞留, 需下一个审视周期实测。'
            '本次首轮效果: 非终态 5 → 1(且那 1 项带解除条件与 reviewBy); 账本终态/已处置 93/93。'
        ) % STAMP,
    ),
}


def main():
    rows = [json.loads(l) for l in open(P, encoding='utf8') if l.strip()]
    by_id = {}
    for r in rows:
        if r.get('id'):
            by_id[r['id']] = r
    for cid, patch in UPDATES.items():
        base = by_id.get(cid)
        if base is None:
            print('MISSING', cid); continue
        rec = dict(base); rec.update(patch)
        rows.append(rec)
        print('%-8s %-24s -> %s' % (cid, base.get('status'), patch['status']))
    with open(P, 'w', encoding='utf8') as fh:
        fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
    by = {}
    for r in rows:
        if r.get('id'):
            by[r['id']] = r
    from collections import Counter
    print('复检:', dict(Counter(v.get('status') for v in by.values())))
    print('非终态未关单:', sum(1 for v in by.values() if v.get('status') not in ('done', 'retired', 'closed')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
