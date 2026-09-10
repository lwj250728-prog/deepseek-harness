#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登记 cl-133 / cl-134 两条(本轮两段工作的正式入账)。"""
import json, os, sys, datetime

TZ = datetime.timezone(datetime.timedelta(hours=8))
NOW = datetime.datetime.now(TZ)
STAMP = NOW.strftime('%Y-%m-%d %H:%M')
P = os.path.expanduser('~/.dsh/cognitive-pipeline/claims-ledger.jsonl')

ENTRIES = [
    {
        'id': 'cl-133',
        'ts': NOW.isoformat(),
        'claim': ('测试账本把"测试没跑通"(欠账)与"跑完了、结论为否"(产出)都记在 failed 上, '
                  '于是决定性负面结论长期以欠账面貌滞留, 既污染失败信号又诱导重复劳动'),
        'source': '测试审视帧: 回头裁决 5 条非终态项时发现 tp-001/002/004 全是"结论为否"而非"没跑通"',
        'status': 'done',
        'doneAt': NOW.isoformat(),
        'doneNote': (
            '引入 concluded 终态(带 conclusion + reopenIf: 前提一变即重开, 防"结论亡"), '
            'tp-035→passed(T30 覆盖早已存在, 挂 in-progress 只是没人回头裁决), tp-001/002/004→concluded, '
            'tp-005→blocked 并补齐解除条件(帧侧已修 FIX-2 index.ts:131, 用户会话侧仍无 → 该路径才是删除指令真正来源)。'
            '守卫 T112 五断言(状态合法/非终态须有处置/结论须带重开条件/处置超3天或无时间戳即红/failed-concluded 不混用), '
            '每条断言先验前提防空过, 超期守卫做负向测试证明能开火。非终态 5→1(且带 reviewBy)。'
            '顺带: cl-113 承诺的"落地 T91"是编号误记——T91 早被采用率闸门占用, 实质从未落地, 现落在 T112。'
        ),
        'reviewBy': None,
    },
    {
        'id': 'cl-134',
        'ts': NOW.isoformat(),
        'claim': ('A/B 对照的主判据(不同经验数 + 采纳率不降 + 绝对采纳数不降)只有漏斗侧在表里, '
                  '采纳侧完全缺席——判读要人肉另跑采纳脚本, 于是"对照"看着像结论其实只有半张表'),
        'source': '行动帧执行 goal-adoption-rate 的观察型 nextAction: 检查判读链能否机械出数',
        'status': 'done',
        'doneAt': NOW.isoformat(),
        'doneNote': (
            '补齐三段窗口采纳对照(前窗 / 后窗旧口径段 / 后窗新口径段), 采纳率仍只由唯一生产者出数'
            '(ab-compare 只切窗口, shell 转发 dsh-adoption-stats.py, 不重算第二套口径); '
            '并加 dsh-adoption-observe.py + 每小时 cron 落追加式观察快照(判读看趋势, 不凭记忆)。'
            '补齐过程中修掉四类"出数即错数": ①子窗口运行覆盖唯一口径落盘快照, 下游把快照当水位 ⇒ 前窗被读成 14:07 起、'
            '时长 0.0h 却照样出数; ②口径变更时刻取 commit author time(04:57 提交)而非生效时刻(15:50 部署) ⇒ 后窗被切成空集; '
            '③判据字段只在打印分支里算 ⇒ --quiet 消费者读到 null; ④绝对采纳条数未按窗口时长归一化(前窗 9h vs 后窗 3h)。'
            '全部固化为 T113 五断言(子窗口不得改写快照/口径取自账本且须同瞬间含时区/前窗非空/判据在 --quiet 下也落盘/'
            '观察排程在册且日志新鲜), 套件 388/388。'
            '首个读数: 前窗 9.13h 注入 51/采纳 7(13.7%)/文本口径回合率 35.3%/lift 2.25; 后窗 3.35h 注入 20/采纳 3(15.0%)/'
            '文本率 15.0%/lift 0.75; 不同经验数 10→19。三条主判据满足, 但回合级文本口径与 lift 方向不利; '
            '后窗回合 20(<40)故不下结论, 预登记回滚规则: 后窗文本率 < 前窗一半 且 回合>=40 ⇒ topK 回滚到 1。'
        ),
        'reviewBy': None,
    },
]


def main() -> int:
    rows = [json.loads(l) for l in open(P, encoding='utf8') if l.strip()]
    have = {r.get('id') for r in rows}
    added = 0
    for entry in ENTRIES:
        if entry['id'] in have:
            print('已存在, 跳过', entry['id']); continue
        rows.append(entry); added += 1
        print('登记', entry['id'])
    with open(P, 'w', encoding='utf8') as fh:
        fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
    by = {r['id']: r for r in rows if r.get('id')}
    from collections import Counter
    print('新增 %d 条 | 状态分布 %s' % (added, dict(Counter(v.get('status') for v in by.values()))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
