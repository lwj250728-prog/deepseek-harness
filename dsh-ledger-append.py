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
    ap.add_argument("--reclaim-id", action="store_true", help="确认这是同一个事的改写(否则拒绝覆盖已有 claim 正文)")
    args = ap.parse_args()

    rows = load(args.ledger)
    prev = None
    for r in rows:
        if r.get("id") == args.id:
            prev = r
    if prev is None:
        print("[ledger-append] 拒绝: 该 id 不存在(%s)——追加行不能凭空造 id" % args.id, file=sys.stderr)
        return 2

    import re as _re
    # 2026-09-12 15:5x(反事实自审所得): 抽查今日 18 条结单, 只有 10 条带**机器可核的证据指针**
    # (提交哈希/T编号/脚本名/账本 id/文件路径), 其余只有叙述 ⇒ "账本可自查"这个前提只被半支持。
    # 故: 结单(status=done/closed)时 doneNote 或 nextAction 里必须出现**至少一个可核指针**,
    # 否则拒绝(确有理由无指针者, 显式 --set noEvidenceReason="...")。
    EVIDENCE_PTR = _re.compile(r"\b[0-9a-f]{7,40}\b|\bT\d{2,3}\b|\bdsh-[a-z0-9-]+\.(py|sh)\b|"
                               r"\b(tp|cl)-[\w-]+\b|\bexp_\d+\b|\binject_\d+\b|/[[\w./-]+\.(py|sh|jsonl|json|md)")
    patch = {}
    for kv in args.set:
        if "=" not in kv:
            print("[ledger-append] 拒绝: --set 需要 KEY=VALUE, 收到 %r" % kv, file=sys.stderr)
            return 2
        k, v = kv.split("=", 1)
        # 2026-09-12 14:4x(与 dsh-goal-pool-write.py 同日同型缺陷的**复现**): --set 原先把一切值当字符串 ——
        # 实测: 我给 cl-274 写 `--set 'pendingConsumers=["a.py","b.py"]'`, 落盘成了**字符串**而不是列表, 于是
        # 消费方（T211 判据）读出来是字符集合, 判据当场转红。池写入口在 05:2x 已修, 这里漏了 ⇒ 同一类缺陷
        # 会在**兄弟工具**里复现。只对 JSON 容器(以 { 或 [ 开头)做解析, 标量语义保持不变(避免 '5' 变 5)。
        if v.strip()[:1] in ("{", "["):
            try:
                patch[k] = json.loads(v)
                continue
            except Exception:
                pass
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
    # 结单必须有**可核指针**(反事实自审所得: 今日 18 条结单里 8 条只有叙述)
    new_status = str(patch.get("status") or "")
    if new_status in ("done", "closed"):
        blob = " ".join(str(patch.get(k) or "") for k in ("doneNote", "nextAction", "result", "evidence"))
        if not EVIDENCE_PTR.search(blob) and not str(patch.get("noEvidenceReason") or "").strip():
            print("[ledger-append] 拒绝结单: doneNote/nextAction 里没有**机器可核的证据指针**"
                  "(提交哈希 / T编号 / 脚本名 / 账本 id / 文件路径); 确有理由请显式 --set noEvidenceReason=\"...\"",
                  file=sys.stderr)
            return 2

    # id 碰撞守卫(2026-09-12 16:0x **实测到的真实事故**): 我(主会话)与旁路会话在同一分钟各写了一条 cl-280,
    # 而追加式账本是 **last-wins** ⇒ 后写者把前者整条盖掉, 前者的 claim 在 last-wins 读法下**消失**。
    # 故: 当补丁要**改写 claim 正文**(与当前行逐字不同)且没有显式 --reclaim-id 时, 拒绝 ——
    # 这正是"两个不同的事共用了一个 id"的形态; 单纯更新状态/字段不受影响。
    new_claim = patch.get("claim")
    if isinstance(new_claim, str) and new_claim.strip() and new_claim.strip() != str(prev.get("claim") or "").strip() \
            and not args.reclaim_id:
        print("[ledger-append] 拒绝: 这会**改写已存在 id 的 claim 正文**(last-wins 下原 claim 会消失) —— "
              "多半是两个不同的事共用了同一个 id; 请换一个未占用的 id, 或确属同一事加 --reclaim-id",
              file=sys.stderr)
        return 2

    if args.dry_run:
        print("[dry-run] " + line)
        return 0
    with open(args.ledger, "a", encoding="utf8") as f:
        f.write(line + "\n")
    print("[ledger-append] %s: 继承 %d 字段, 覆盖 %s" % (args.id, len(prev), sorted(patch.keys())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
