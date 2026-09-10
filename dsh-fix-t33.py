#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tp-095 / cl-136: T33 判据从"状态白名单"改为"非终态即须有处置"。

缺陷(cl-132 家族的又一例): T33 的判据写作 `status in ("open","in-progress")`,
于是后来新增的状态取值(fixed-awaiting-evidence / fixed-awaiting-user / revised /
open-reframed / verified-working)全部落在判据之外 —— 实测 47 条非终态里只有 31 条被覆盖,
14 条成盲区, 其中 cl-001/cl-005 连 reviewBy 都没有。这正是"新增枚举取值, 消费方判据没跟上"。

改法: 判据改为"非终态(即不含 done/retired/closed)即须有处置位" —— 与测试账本 T112 同构;
并且合法阻塞项(待用户/沉池/已修待证)必须有**显式处置字段**, 否则红; 这样既不漏警也不假警。
"""
import io
import os
import sys

P = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
OLD_HEAD = '# ── T33 open 项到期裁决(2026-09-09 00:5x 固化——账本滞留 18 条一天无人裁决, 同 cl-037 家族) ──\necho "[T33] open项到期裁决(每条 open/in-progress 须有 reviewBy; 过期未裁决即失败)"\n'
NEW_HEAD = '''# ── T33 非终态项到期裁决(09-09 固化; 09-10 17:5x 按 cl-136 改为非终态判定) ──
# 原判据是状态白名单 open/in-progress —— 新增状态取值后 14 条非终态成盲区(cl-132 家族)。
# 现判据: 非终态(不含 done/retired/closed)即须有处置位; 合法阻塞项须有显式处置字段。
echo "[T33] 非终态项到期裁决(每条非终态须有处置位; 过期未裁决即失败)"
'''

OLD_BODY = '''t "open项均有reviewBy" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
bad = [k for k, v in by_id.items()
       if v.get("status") in ("open", "in-progress") and not v.get("reviewBy")]
assert not bad, "无 reviewBy 的 open 项: %s" % bad[:3]
'
t "open项未过期" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
today = datetime.date.today().isoformat()
overdue = [k for k, v in by_id.items()
           if v.get("status") in ("open", "in-progress")
           and isinstance(v.get("reviewBy"), str) and v["reviewBy"] < today]
assert not overdue, "已过 reviewBy 未裁决: %s" % overdue[:3]
'
'''

NEW_BODY = r'''t "非终态项均有处置位" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
# 终态 = 不必再裁决; 其余一律参与检查(不再用状态白名单, 否则新增取值即成盲区)。
TERMINAL = {"done", "retired", "closed"}
DISP = ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")
open_items = {k: v for k, v in by_id.items() if v.get("status") not in TERMINAL}
assert open_items, "无非终态项 —— 本断言前提不成立, 不得算通过"
naked = sorted(k for k, v in open_items.items() if not any(v.get(f) for f in DISP))
assert not naked, "非终态项缺处置位(reviewBy/disposition/unblockPlan/nextAction/blockedReason): %s" % naked[:5]
print("非终态 %d 项均有处置位" % len(open_items))
'
t "非终态项未过期" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
TERMINAL = {"done", "retired", "closed"}
today = datetime.date.today().isoformat()
open_items = {k: v for k, v in by_id.items() if v.get("status") not in TERMINAL}
overdue = [k for k, v in open_items.items()
           if isinstance(v.get("reviewBy"), str) and v["reviewBy"] < today]
assert not overdue, "已过 reviewBy 未裁决: %s" % overdue[:5]
print("非终态 %d 项无过期" % len(open_items))
'
t "盲区归零(新增状态取值必须被覆盖)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
TERMINAL = {"done", "retired", "closed"}
LEGACY = {"open", "in-progress"}
blind = sorted(k for k, v in by_id.items()
               if v.get("status") not in TERMINAL and v.get("status") not in LEGACY)
# 盲区被允许存在, 但必须是被判据覆盖到的: 逐条须有处置位, 否则即为"新增取值漏判"。
naked = [k for k in blind
         if not any(by_id[k].get(f) for f in ("reviewBy","disposition","unblockPlan","nextAction","blockedReason"))]
assert not naked, "新增状态取值落在判据之外且无处置位: %s" % naked[:5]
print("旧白名单之外的 %d 条已全部纳入判定" % len(blind))
'
'''

def main() -> int:
    src = io.open(P, encoding='utf8').read()
    if '按 cl-136 改为非终态判定' in src:
        print('T33 已改造过')
        return 0
    if src.count(OLD_HEAD) != 1:
        print('头部锚点命中 %d 次, 拒绝' % src.count(OLD_HEAD)); return 1
    if src.count(OLD_BODY) != 1:
        print('主体锚点命中 %d 次, 拒绝' % src.count(OLD_BODY)); return 1
    src = src.replace(OLD_HEAD, NEW_HEAD).replace(OLD_BODY, NEW_BODY)
    io.open(P, 'w', encoding='utf8').write(src)
    print('T33 已改造: 白名单 -> 非终态判定(3 断言)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
