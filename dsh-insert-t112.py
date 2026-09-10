#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 T112(测试账本终态语义守卫) 插入套件, 位置在结果汇总行之前。"""
import io, os, sys

P = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
ANCHOR = 'echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"'

BLOCK = r'''# ── T112 测试账本终态语义守卫(cl-133: "测试没跑通" ≠ "结论为否") ──
# 病根: 账本原只有 pending/in-progress/passed/failed/blocked; 决定性负面结论(假设被证伪)
# 与真失败(基础设施/前提缺失)都落 failed → 负面结论长期挂在"欠账"位上, 既污染失败信号
# 又诱导重复劳动。修: 引入 concluded 态 + 处置字段。本组断言守卫该语义不再回退。
# 防静默空过: 每条断言先验前提存在(否则守卫会因账本"恰好没有该类项"而空过)。
echo "[T112] 测试账本终态语义(非终态须有处置 / 结论须有重开条件 / 状态值合法)"
t "账本状态值均在允许集内" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
allowed = {"pending","in-progress","passed","reviewed","concluded","failed","blocked"}
bad = sorted({k: v.get("status") for k, v in by_id.items() if v.get("status") not in allowed})
assert not bad, "存在非法状态值(统计会漏掉它们): %s" % bad[:5]
assert len(by_id) >= 50, "账本规模异常, 断言前提不成立: %d" % len(by_id)
print("状态值合法, 条目 %d" % len(by_id))
'
t "非终态项必须带处置(否则无人再访)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
terminal = {"passed","reviewed","concluded"}
# 前提: 账本确实存在非终态项, 否则本断言空过(今天的静默空过病根)
open_items = {k: v for k, v in by_id.items() if v.get("status") not in terminal}
assert open_items, "无非终态项——本断言前提不成立, 不得算通过"
naked = sorted(k for k, v in open_items.items()
               if not (v.get("reviewBy") or v.get("unblockPlan") or v.get("disposition")))
assert not naked, "非终态项缺处置(reviewBy/unblockPlan/disposition): %s" % naked
print("非终态 %d 项均有处置" % len(open_items))
'
t "concluded 项必须带结论与重开条件" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
concluded = {k: v for k, v in by_id.items() if v.get("status") == "concluded"}
# 前提: 至少有一条已结单的否定结论, 否则断言空过
assert concluded, "无 concluded 项——本断言前提不成立(结论型结单尚未发生)"
bad = sorted(k for k, v in concluded.items()
             if not (v.get("conclusion") and v.get("reopenIf")))
assert not bad, "concluded 项缺 conclusion/reopenIf(结论会随前提变化而失效): %s" % bad
print("concluded %d 项均带 conclusion+reopenIf" % len(concluded))
'
t "concluded 与 failed 语义不得混用" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
# failed = 测试没跑通(欠账, 待修); concluded = 跑完且结论为否(产出, 带重开条件)。
# 混用的特征: 标 failed 却在 result 里写下了完整结论和根因。
import re
suspicious = []
for k, v in by_id.items():
    if v.get("status") != "failed":
        continue
    r = str(v.get("result") or "")
    if re.search(r"最终定位|根因|证伪|结论[:：]", r) and len(r) > 120:
        suspicious.append(k)
assert not suspicious, "这些标 failed 但已写下完整结论, 应转 concluded: %s" % suspicious
print("无 failed/concluded 混用")
'

'''

def main():
    src = io.open(P, encoding='utf8').read()
    if 'T112 测试账本终态语义守卫' in src:
        print('T112 已存在, 跳过插入')
        return 0
    if src.count(ANCHOR) != 1:
        print('锚点出现 %d 次, 拒绝插入' % src.count(ANCHOR))
        return 1
    io.open(P, 'w', encoding='utf8').write(src.replace(ANCHOR, BLOCK + ANCHOR))
    print('T112 已插入(4 断言)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
