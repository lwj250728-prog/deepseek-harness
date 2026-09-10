#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""推进 goal-adoption-rate: notes 追加本轮进展, nextAction 前进到下一步。

本轮性质: nextAction 是"观察型", 本步能做的不是"等", 而是把**判读变成机械动作**——
采纳侧此前在 A/B 对照里缺席, 每次判读都要人肉另跑脚本, 于是"判读"看着有依据其实只有一半
(漏斗侧)。补上之后本步完成, 下一步进入"按门槛读数"。
"""
import json, os, sys, datetime

TZ = datetime.timezone(datetime.timedelta(hours=8))
STAMP = datetime.datetime.now(TZ).strftime('%Y-%m-%d %H:%M')
P = os.path.expanduser('~/.dsh/cognitive-pipeline/dormant-goals.jsonl')

NOTES = [
    (STAMP + ' 采纳侧 A/B 对照补齐(cl-134)+ 首个读数。此前 A/B 只有漏斗与新鲜度,**主判据的采纳一半缺席**——'
     '判读要人肉另跑采纳脚本, 于是"对照"看着像结论其实只有半张表。现在 ab-compare 直接出三段窗口的采纳对照, '
     '并由 dsh-adoption-observe.py 每次观察落一行快照(判读看趋势, 不再拿记忆当基线, cl-116 的老毛病)。'
     '首个读数(切口 14:07, topK 1→3): 前窗 9.13h 注入 51 / 采纳 7 (13.7%) / 注入 5.6 条每小时 / 文本口径回合率 35.3% / lift 2.25; '
     '后窗 3.35h 注入 20 / 采纳 3 (15.0%) / 注入 6.0 条每小时 / 文本口径回合率 15.0% / lift 0.75; '
     '不同经验数 10 → 19 (近 2×); 注入条数分布出现 3 条档(前窗最多 2 条)。'),
    (STAMP + ' 三条主判据逐条核: ①不同经验数 10→19 上升 ✓ ②账本采纳率 13.7%→15.0% 不降 ✓ ③绝对采纳归一化后 '
     '(采纳/小时) 0.77→0.90 不降 ✓ —— 但**回合级文本口径与 lift 方向不利**(35.3%→15.0%, lift 2.25→0.75)。'
     '后窗有注入回合仅 20(< 方向裁决门槛 40), 按纪律**不下结论**; 预登记的回滚规则已写进对照输出: '
     '"后窗文本率 < 前窗一半 且 后窗回合>=40 ⇒ topK 回滚到 1"。lift 有效性仍待 n>=100。'),
    (STAMP + ' 本轮顺带修掉四类"出数即错数"的缺陷(全部 T113 固化为守卫): ①子窗口运行(--since/--until)覆盖了唯一口径的'
     '落盘快照, 下游把快照当水位 ⇒ 整张表错位(实测: 前窗被读成 14:07 起、时长 0.0h 却照样出数); '
     '②"口径变更时刻"取了 commit author time(04:57 提交)而非生效时刻(15:50 部署) ⇒ 后窗被切成空集; '
     '③判据字段只在打印分支里算, --quiet 消费者读到 null("判据只长在显示路径上"); '
     '④绝对采纳条数未归一化, 直接比条数等于比时段长度(前窗 9h vs 后窗 3h)。'
     '四处都是同一族: **口径/水位在消费侧被当成常量, 实际它会变**。'),
]

NEXT = ('观察型(继续, 判据已可机械出数): ①方向裁决门槛=后窗有注入回合>=40(现 20), 届时若后窗文本率 < 前窗一半'
        '(现 0.150 vs 0.353)则按预登记回滚 topK→1; ②lift 有效性命中门槛 n>=100(现 71 回合); '
        '③读数前先看 confounders(现 4 条, 含 15:50 结算口径变更 ⇒ cited 跨点不可比, 文本口径不受影响可跨点比); '
        '④每次观察用 dsh-adoption-observe.py 落快照后按趋势判, 不凭记忆。'
        '【待用户】cl-094/cl-130: 确认留在 deepseek-flash 还是换 deepseek-v4-pro(无别名断崖, 不急)。')


def main() -> int:
    rows = [json.loads(l) for l in open(P, encoding='utf8') if l.strip()]
    target = None
    for r in rows:
        if r.get('id') == 'goal-adoption-rate':
            target = r
    if target is None:
        print('目标不存在', file=sys.stderr)
        return 1
    notes = target.get('notes')
    if isinstance(notes, str):
        notes = [notes]
    notes = list(notes or []) + NOTES
    target['notes'] = notes
    target['nextAction'] = NEXT
    target['lastProgressAt'] = datetime.datetime.now(TZ).isoformat()
    with open(P, 'w', encoding='utf8') as fh:
        fh.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
    print('notes: %d 条 (+%d)' % (len(notes), len(NOTES)))
    print('nextAction 已前进 %d 字' % len(NEXT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
