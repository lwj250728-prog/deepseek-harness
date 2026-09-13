#!/usr/bin/env python3
"""dsh-incubation-checkup.py — 孵化机制转化率体检(cron 每 2h)

由来(cl-211): 这项体检原先是"每次唤醒跑一次", 但它连续两次通过 ⇒ 通过时每次唤醒都在重复同一件事,
是"仪表替代动作"的另一种形态。故按 cl-211 的自我限制条款降频为 **cron 每 2h**, 把唤醒槽位让回真实动作。

判据(固定 24h 日历窗; 2026-09-14 cl-344 修正):
  某目标在**固定 24h 日历窗**内 可计唤醒(投递且非停泊) >=5 且采纳 0 ⇒ 违规, 写言行账本告警;
  可计唤醒 <5 ⇒ 报"样本不足(covered)", 不算通过。
  旧口径用"lastActionAt 之后"分界, 但 lastActionAt 被目标**自己的采纳**前移 ⇒ 窗口被成功清零,
  判据只剩"不可测"(实测 219 个逐小时窗口开火 0 次), 故弃用。
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
        # ── 窗口修正(cl-344, 2026-09-14 04:1x, 由"判据还开得动火吗"这一追问驱动) ──
        # 旧口径 post = "lastActionAt 之后": lastActionAt 在目标**每次行动时**前移, 而采纳正是一种行动
        # ⇒ 一个正在转化的目标被自己的成功清零窗口, 可计唤醒恒 <5 ⇒ 只剩"不可测"一条路。实测:
        # 72h 内逐小时回测 219 个 (goal×hour) 窗口, 判据开火 **0** 次; 而口径改写前的
        # 09-12T10:00→09-13T10:00 它每 2h 开火共 13 次(分母含停泊唤醒, 停泊唤醒按设计永不采纳
        # ⇒ 结构性假阳性)。两者是同一混淆(停泊≠空转)的两个产物 ⇒ 改为**固定 24h 日历窗**,
        # 与"改写即重置"脱钩。判据的可测性守卫仍是 pw < MIN_WAKES, 但其含义从"恒真"变回"真样本不足"。
        post = gw
        delivered = [(d, r) for d, r in post if not r.get("skipped")]
        parked = [(d, r) for d, r in delivered if parked_at(gid, d)]
        live = [(d, r) for d, r in delivered if not parked_at(gid, d)]
        pw = len(live)
        pa = sum(1 for _, r in live if r.get("adopted"))
        rows.append((gid, g.get("status"), len(gw), len(delivered), len(parked),
                     len(post) - len(delivered), la.strftime("%H:%M") if la else "无", pw, pa))
        if la and pw >= MIN_WAKES and pa == 0:
            viol.append(gid)
    # 不可测(covered): 窗口内**可计唤醒** < MIN_WAKES ⇒ 分母太小, 判据**不可能**有意义地触发。
    # 它既不等于"通过"(没测到), 也不能触发结单(结单=声称"已恢复转化", 而分母为空时无从说起)。
    # 由来(cl-342): 04:00 体检在 pw=0/0/0 下仍打"通过", 且每 2h 给告警补写一条假结单
    # "下次体检无违规(唤醒已恢复转化)"(24h 内无任何可计唤醒转化) ⇒ 盲读数写假结单。
    # 由来(cl-344): 窗口由 lastActionAt 分界改为固定日历窗后, 这条守卫仍是**唯一**的可测性条件,
    # 但含义变了 —— 旧窗下它恒真(可计唤醒恒 <5 ⇒ 看不见任何状态), 新窗下它只在真的样本太小时为真
    # (实测三目标可计唤醒 8/8/29 ⇒ 全部可测)。故不另设样本量旋钮(未登记的旋钮本身就是债)。
    untestable = [gid for gid, _st, _tw, _dlv, _pk, _sk, la, pw, _pa in rows
                  if (not la) or pw < MIN_WAKES]
    verdict = "不通过" if viol else ("通过" if not untestable else "不可测(covered)")

    sec = ["", "---", "",
           "## 转化率体检(origin=%s，%s，固定 %dh 日历窗；口径 2026-09-13 修正 + 2026-09-14 窗口修正 cl-344)" % (
               ORIGIN, now.strftime("%m-%d %H:%M"), WINDOW_H), "",
           "| 目标 | 池状态 | 触发行 | 投递 | 停泊期投递 | 未投递 | 末次行动 | 可计唤醒/采纳 |",
           "|---|---|---|---|---|---|---|---|"]
    for gid, st, tw, dlv, pk, sk, la, pw, pa in rows:
        sec.append("| %s | %s | %d | %d | %d | %d | %s | %d / **%d** |" % (gid, st, tw, dlv, pk, sk, la, pw, pa))
    sec += ["", ("- 口径: **可计唤醒** = 投递过(`skipped` 空) **且** 目标当时不处在停泊期(池里没挂 waitChecker); "
                 "停泊期的唤醒注定不能转化(驱动侧不驱动它) ⇒ 单列不进分母"),
            "- 已知偏差(漏报方向): 采纳用插件的 `adopted` 标记, 它只在**被唤醒的那个回合**里比对池快照 ⇒ "
            "推进若发生在别的会话/别的回合, 该标记看不见(会让告警**迟报**, 不会造成误报)",
            "- 窗口(cl-344): 固定 24h 日历窗。旧口径「lastActionAt 之后」会被目标自己的成功(采纳即行动)清零 ⇒ "
            "可计唤醒恒 <5, 判据只剩「不可测」; 实测 219 个逐小时窗口开火 0 次, 而分母含停泊唤醒的旧旧口径每 2h 假阳性。",
            "", "**判据**（固定 24h 窗内: **可计**唤醒 ≥%d 且采纳 0 ⇒ 违规）：**%s**%s" % (
        MIN_WAKES, verdict, (" —— 违规: " + ", ".join(viol)) if viol else ""),
            ("- **样本不足(covered)**: %s 的可计唤醒 < %d ⇒ 分母太小, 本行**不是通过**;"
             " 要让它可测须先修投递(见 投递/触发行 列)" % (", ".join(untestable), MIN_WAKES)) if untestable else "", ""]
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
    # 恢复: 关闭遗留告警 —— 只认**每个 id 的最新一行**的状态(账本是 append-only, 历史里的
    # open 行永远存在; 用 "任意一行非终态" 去找 open 会把 09-13T10:00 那条陈旧 open 行
    # 每 2h 重新"关闭"一次, 于是每 2h 追加一条假结单 —— cl-342 实测 12:00→04:00 共 9 条)。
    if not untestable and os.path.exists(LEDGER):
        with open(LEDGER, encoding="utf8") as f:
            lr = [json.loads(l) for l in f if l.strip()]
        last = {}
        for r in lr:
            last[r.get("id")] = r          # 后写覆盖先写 ⇒ 取到该 id 的权威状态
        op = last.get("cl-incubation-stall")
        if op is not None and op.get("status") not in TERMINAL:
            r = dict(op)
            r.update({"status": "done", "doneNote": "下次体检无违规且判据可测(可计唤醒≥%d)" % MIN_WAKES,
                      "ts": now.isoformat()})
            with open(LEDGER, "a", encoding="utf8") as f:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
