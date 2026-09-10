#!/usr/bin/env python3
"""dsh-ledger-append.py — 言行账本的唯一追加入口(cl-191)

为什么需要它：账本是**追加式**的、消费方按 **last-wins** 读最后一行 ⇒ 新行漏写某个字段，
等价于把那个字段删掉。实测 2026-09-11 04:0x：我自己补写的 3 行(cl-175 / cl-189 /
cl-test-20260911-0329)就丢掉了前序行的 `reviewBy`，直接让套件"非终态项均有处置位"转红——
而 cl-041 的教训(读追加式账本必须自带 last-wins 语义)讲的是**读**侧，这里是**写**侧的同型病。

语义：
  · 继承同 id 最后一行的全部字段，再套用 --set 的覆盖；
  · ts 一律取当下(必须严格大于前一行，T132 守着这条)；
  · --dry-run 只打印不落盘。

用法：
  python3 dsh-ledger-append.py cl-189 --set status=open --set reviewBy=2026-09-12
  python3 dsh-ledger-append.py cl-189 --set status=done --set doneNote="已接线" --dry-run
"""
import argparse
import datetime
import json
import os
import sys

LEDGER = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")


def load(path):
    rows = []
    with open(path, encoding="utf8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("id")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--ledger", default=LEDGER)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = load(args.ledger)
    prev = None
    for r in rows:
        if r.get("id") == args.id:
            prev = r
    if prev is None:
        print("[ledger-append] 拒绝: 该 id 不存在(%s)——追加行不能凭空造 id" % args.id, file=sys.stderr)
        return 2

    patch = {}
    for kv in args.set:
        if "=" not in kv:
            print("[ledger-append] 拒绝: --set 需要 KEY=VALUE, 收到 %r" % kv, file=sys.stderr)
            return 2
        k, v = kv.split("=", 1)
        patch[k] = v

    now = datetime.datetime.now().astimezone().isoformat()
    if prev.get("ts") and str(prev["ts"]) >= now:
        print("[ledger-append] 拒绝: 新 ts(%s)未大于前一行 ts(%s)" % (now, prev["ts"]), file=sys.stderr)
        return 2

    row = dict(prev)
    row.update(patch)
    row["ts"] = now

    # 写侧自检: 非终态行必须有处置位(cl-191 的直接后果)
    terminal = {"done", "retired", "closed"}
    disp = ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")
    if row.get("status") not in terminal and not any(row.get(f) for f in disp):
        print("[ledger-append] 拒绝: 非终态行缺处置位(会立刻让 T33/盲区归零转红): %s" % args.id,
              file=sys.stderr)
        return 2

    line = json.dumps(row, ensure_ascii=False)
    if args.dry_run:
        print("[dry-run] " + line)
        return 0
    with open(args.ledger, "a", encoding="utf8") as f:
        f.write(line + "\n")
    print("[ledger-append] %s: 继承 %d 字段, 覆盖 %s" % (args.id, len(prev), sorted(patch.keys())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
