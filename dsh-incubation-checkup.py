#!/usr/bin/env python3
"""dsh-incubation-checkup.py — 孵化机制转化率体检(cron 每 2h)

由来(cl-211): 这项体检原先是"每次唤醒跑一次", 但它连续两次通过 ⇒ 通过时每次唤醒都在重复同一件事,
是"仪表替代动作"的另一种形态。故按 cl-211 的自我限制条款降频为 **cron 每 2h**, 把唤醒槽位让回真实动作。

判据(按每目标的 lastActionAt 分界, 改写即重置计时):
  某目标在**自己的 nextAction 生效之后** 24h 内 唤醒 >=5 且采纳 0 ⇒ 违规, 写言行账本告警(自武装)。
结果总是追加进 incubation-stats.md(不覆盖历史)。
退出码: 0 = 无违规; 1 = 有违规(已写告警); 3 = 读数失败
"""
import collections
import datetime
import json
import os
import sys

D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
TRIGGER = os.path.join(D, "goal-trigger-log.jsonl")
GOALS = os.path.join(D, "dormant-goals.jsonl")
STATS = os.path.join(D, "incubation-stats.md")
LEDGER = os.path.join(D, "claims-ledger.jsonl")
TERMINAL = {"done", "retired", "closed"}
WINDOW_H = 24
MIN_WAKES = 5
TZ = datetime.timezone(datetime.timedelta(hours=8))
# 排程/会话来源标记: cron 行给 DSH_RUN_ORIGIN, 会话里可能是 DSH_COG_ORIGIN —— 两个都认,
# 并**真的写进产出**(否则"登记了标记"只是台账上的一句话, 台账检查器会抓)。
ORIGIN = os.environ.get("DSH_RUN_ORIGIN") or os.environ.get("DSH_COG_ORIGIN") or "manual"


def dt(s):
    try:
        d = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=TZ)).astimezone(TZ)
    except Exception:
        return None


def main() -> int:
    if not os.path.exists(TRIGGER) or not os.path.exists(GOALS):
        print("[读数失败] 缺触发日志或目标池", file=sys.stderr)
        return 3
    now = datetime.datetime.now(TZ)
    wakes = [(dt(r.get("ts")), r) for r in (json.loads(l) for l in open(TRIGGER, encoding="utf8") if l.strip())]
    wakes = [(d, r) for d, r in wakes if d and (now - d).total_seconds() <= WINDOW_H * 3600]
    latest = {}
    for l in open(GOALS, encoding="utf8"):
        if l.strip():
            g = json.loads(l)
            if g.get("id"):
                latest[g["id"]] = g

    # ── 口径修正(2026-09-13 12:0x, 由"采纳 0 会不会是没记录"这一追问驱动; 见 incubation-checkup-era.json) ──
    # 旧口径把**全部**触发行都当"唤醒": 实测该目标某个 24h 窗口里 30 条触发行中 24 条是
    # `skipped=waiting`(哨兵/驱动根本没投递), 而那 6 条投递出去的, 目标**自己的门是关着的**
    # (`waitChecker=dsh-wait-check-intervention.py`, nextAction 原文就是"读机械判读结果并处置(条件门已挂…)")
    # ⇒ 驱动侧不会驱动它, 采纳在构造上不可能发生。把这些算进分母, 报出来的就是"唤醒在空转"——
    # 而事实是"**目标按设计在等**, 等的那件事被事故卡住了"(恢复腿没跑 + 静默空操作写入, 见 cl-265)。
    # 故: ①只有**投递过**的唤醒计数; ②目标处在**停泊期**(池里带着 waitChecker)的唤醒单列, 不进分母;
    # ③采纳仍以插件的 adopted 标记为准(它只在"被唤醒的那个回合"里做池快照对比 —— 这层**会话局部性**
    #   会让别的会话里的推进看不见, 属**漏报**方向, 在下面的 备注 里如实标注, 不在此处硬补)。
    gates = {}   # goalId -> [(time, hasGate)]
    for l in open(GOALS, encoding="utf8"):
        if not l.strip():
            continue
        g2 = json.loads(l)
        gid = g2.get("id")
        t = dt(g2.get("lastActionAt") or g2.get("ts"))
        if gid and t:
            gates.setdefault(gid, []).append((t, bool(str(g2.get("waitChecker") or "").strip())))
    for v in gates.values():
        v.sort()

    def parked_at(gid, when):
        hist = [x for x in gates.get(gid, []) if x[0] <= when]
        return hist[-1][1] if hist else False

    rows, viol = [], []
    for gid in sorted({r.get("goalId") for _, r in wakes}):
        gw = [(d, r) for d, r in wakes if r.get("goalId") == gid]
        g = latest.get(gid) or {}
        la = dt(g.get("lastActionAt"))
        post = [(d, r) for d, r in gw if la and d > la]
        delivered = [(d, r) for d, r in post if not r.get("skipped")]
        parked = [(d, r) for d, r in delivered if parked_at(gid, d)]
        live = [(d, r) for d, r in delivered if not parked_at(gid, d)]
        pw = len(live)
        pa = sum(1 for _, r in live if r.get("adopted"))
        rows.append((gid, g.get("status"), len(gw), len(delivered), len(parked),
                     len(post) - len(delivered), la.strftime("%H:%M") if la else "无", pw, pa))
        if la and pw >= MIN_WAKES and pa == 0:
            viol.append(gid)

    sec = ["", "---", "",
           "## 转化率体检(origin=%s，%s，近 %dh；按 lastActionAt 分界；口径 2026-09-13 修正)" % (
               ORIGIN, now.strftime("%m-%d %H:%M"), WINDOW_H), "",
           "| 目标 | 池状态 | 触发行 | 投递 | 停泊期投递 | 未投递 | 改写时刻 | 可计唤醒/采纳 |",
           "|---|---|---|---|---|---|---|---|"]
    for gid, st, tw, dlv, pk, sk, la, pw, pa in rows:
        sec.append("| %s | %s | %d | %d | %d | %d | %s | %d / **%d** |" % (gid, st, tw, dlv, pk, sk, la, pw, pa))
    sec += ["", ("- 口径: **可计唤醒** = 投递过(`skipped` 空) **且** 目标当时不处在停泊期(池里没挂 waitChecker); "
                 "停泊期的唤醒注定不能转化(驱动侧不驱动它) ⇒ 单列不进分母"),
            "- 已知偏差(漏报方向): 采纳用插件的 `adopted` 标记, 它只在**被唤醒的那个回合**里比对池快照 ⇒ "
            "推进若发生在别的会话/别的回合, 该标记看不见(会让告警**迟报**, 不会造成误报)",
            "", "**判据**（改写后 24h 内不得出现'**可计**唤醒 ≥%d 且采纳 0'）：**%s**%s" % (
        MIN_WAKES, "通过" if not viol else "不通过", (" —— 违规: " + ", ".join(viol)) if viol else ""), ""]
    with open(STATS, "a", encoding="utf8") as f:
        f.write("\n".join(sec) + "\n")
    print("[incubation-checkup] origin=%s 体检完成: %d 个目标, 违规 %d" % (ORIGIN, len(rows), len(viol)))

    if viol:
        row = {"id": "cl-incubation-stall", "status": "open",
               "claim": "孵化转化率违规: %s 在各自 nextAction 生效后 24h 内 唤醒 ≥%d 且采纳 0 —— 唤醒在空转" % (", ".join(viol), MIN_WAKES),
               "source": "dsh-incubation-checkup.py (cron)",
               "reviewBy": (now + datetime.timedelta(days=1)).strftime("%Y-%m-%d")}
        row["ts"] = now.isoformat()
        with open(LEDGER, "a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return 1
    # 恢复: 关闭遗留告警
    exists = os.path.exists(LEDGER)
    if exists:
        lr = [json.loads(l) for l in open(LEDGER, encoding="utf8") if l.strip()]
        op = next((r for r in reversed(lr) if r.get("id") == "cl-incubation-stall" and r.get("status") not in TERMINAL), None)
        if op is not None:
            r = dict(op)
            r.update({"status": "done", "doneNote": "下次体检无违规(唤醒已恢复转化)", "ts": now.isoformat()})
            with open(LEDGER, "a", encoding="utf8") as f:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
