#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 T112 追加第 5 断言: 非终态项的处置新鲜度(>3天无说明即红)。

这是 cl-113 承诺的原话("非终态项>3天且无说明即红"), 当时编在 T91 名下但 T91 被
采用率闸门占用了编号, 实质从未落地 —— 编号在、实质亡, 又一处"机制在、条件已死"。
断言语义: 非终态项须有 3 天内的处置时间(disposedAt), 或其 reviewBy 尚未过期。
"""
import io, os, sys

P = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
ANCHOR = """t "concluded 与 failed 语义不得混用\""""

BLOCK = r'''t "非终态项处置不得超期(3天无说明即红)" python3 -c '
import json, os, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(TZ)
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
terminal = {"passed","reviewed","concluded"}
open_items = {k: v for k, v in by_id.items() if v.get("status") not in terminal}
assert open_items, "无非终态项——本断言前提不成立, 不得算通过"

def parse(ts):
    if not ts: return None
    try:
        s = str(ts).replace("Z", "+00:00")
        d = datetime.datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=TZ)
    except Exception:
        return None

stale = []
for k, v in open_items.items():
    last = parse(v.get("disposedAt")) or parse(v.get("createdAt")) or parse(v.get("ts"))
    due = parse(v.get("reviewBy"))
    if due is not None and due < now:
        stale.append(k + "(reviewBy 已过期)")
        continue
    if last is None:
        stale.append(k + "(无任何时间戳, 无法判新鲜度)")
        continue
    age = (now - last).total_seconds() / 86400.0
    if age > 3:
        stale.append("%s(处置已 %.1f 天前, >3 天须补说明或重开)" % (k, age))
assert not stale, "非终态项处置超期: %s" % stale
print("非终态 %d 项处置均在新鲜期内" % len(open_items))
'
'''

def main():
    src = io.open(P, encoding='utf8').read()
    if '非终态项处置不得超期' in src:
        print('新鲜度断言已存在')
        return 0
    if src.count(ANCHOR) != 1:
        print('锚点出现 %d 次, 拒绝插入' % src.count(ANCHOR))
        return 1
    io.open(P, 'w', encoding='utf8').write(src.replace(ANCHOR, BLOCK + ANCHOR))
    print('T112 第 5 断言(处置新鲜度)已插入')
    return 0

if __name__ == '__main__':
    sys.exit(main())
