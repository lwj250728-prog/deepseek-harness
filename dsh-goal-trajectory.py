#!/usr/bin/env python3
"""dsh-goal-trajectory.py — 目标轨迹树的数据源(供 UI 渲染)

产出 ~/.dsh/cognitive-pipeline/goal-trajectory.json: 每个目标一棵精简轨迹树,
把"已完成 / 执行中 / 规划排程"三态显式分类, 每步带上可核查的账本 id 与时间戳。

分类口径(全部来自现有账本, 不新造状态):
  completed  = 该目标名下已 done/retired/closed 的账本项
  executing  = 该项未关单, 且目标的 nextAction 可执行(非等待型)
  planned    = 未关单但有 reviewBy/未来日期, 或目标 nextAction 是等待型(等待条件未到)
  blocked    = 未关单且无处置位(异常态, 单独标出)
用法: python3 dsh-goal-trajectory.py [--out P] [--json]
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

D = os.path.expanduser("~/.dsh/cognitive-pipeline")
GOALS = os.path.join(D, "dormant-goals.jsonl")
CLAIMS = os.path.join(D, "claims-ledger.jsonl")
TRIGGERS = os.path.join(D, "goal-trigger-log.jsonl")
OUT = os.path.join(D, "goal-trajectory.json")
TERMINAL = {"done", "retired", "closed"}
TS_PROBE = """
import { isWaitingNextAction } from './packages/context/quiet-driver/src/waiting.ts'
const items = JSON.parse(process.argv[2])
console.log(JSON.stringify(items.map(([text, ms]) => isWaitingNextAction(text ?? '', new Date(ms)))))
"""


def load(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path, encoding="utf8") if l.strip()]


def waiting_flags(actions, repo):
    """等待型判定走**唯一实现**(tsx 加载 TS 判据), 不在这里再写一份正则。

    → (flags, evaluated)：evaluated=False 表示**判据没跑成**。
    第一版失败时直接返回全 False, 于是所有目标都被当成"可执行(executing)"——这正是
    '缺证据伪装成判定'那一族(与 T11/退场检查器同型)。现在必须显式上报。
    """
    if not actions:
        return [], True
    now_ms = int(datetime.datetime.now().timestamp() * 1000)
    items = [[a, now_ms] for a in actions]
    try:
        r = subprocess.run(["npx", "tsx", "-e", TS_PROBE, "x", json.dumps(items)],
                           cwd=repo, capture_output=True, text=True, timeout=180)
        if r.returncode == 0:
            return json.loads(r.stdout.strip().splitlines()[-1]), True
    except Exception:
        pass
    return [False] * len(actions), False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--repo", default=os.path.expanduser("~/dsh-fork"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    goals_latest = {}
    for g in load(GOALS):
        if g.get("id"):
            goals_latest[g["id"]] = g
    claims = {}
    for c in load(CLAIMS):
        if c.get("id"):
            claims[c["id"]] = c          # last-wins
    triggers = load(TRIGGERS)

    def claim_belongs(c, goal):
        txt = " ".join(str(c.get(k, "")) for k in ("claim", "note", "source", "disposition", "doneNote"))
        for tok in (goal["id"], str(goal.get("title") or "")[:6]):
            if tok and tok in txt:
                return True
        return False

    goals = [g for g in goals_latest.values() if g.get("status") != "dormant" or g.get("nextAction")]
    flags, waiting_ok = waiting_flags([str(g.get("nextAction") or "") for g in goals], args.repo)

    out_goals = []
    for g, waiting in zip(goals, flags):
        items = [c for c in claims.values() if claim_belongs(c, g)]
        items.sort(key=lambda c: str(c.get("ts") or ""))
        steps, counts = [], {"completed": 0, "executing": 0, "planned": 0, "blocked": 0}
        for c in items:
            st = c.get("status")
            if st in TERMINAL:
                kind = "completed"
            elif not any(c.get(f) for f in ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")):
                kind = "blocked"
            else:
                rb = str(c.get("reviewBy") or "")
                future = bool(re.match(r"\d{4}-\d{2}-\d{2}", rb)) and rb[:10] > datetime.datetime.now().strftime("%Y-%m-%d")
                kind = "planned" if (waiting or future) else "executing"
            counts[kind] += 1
            steps.append({"id": c["id"], "kind": kind, "status": st, "ts": str(c.get("ts"))[:19],
                          "claim": str(c.get("claim"))[:160], "reviewBy": c.get("reviewBy"),
                          "evidence": str(c.get("doneNote") or c.get("disposition") or "")[:160]})
        na = str(g.get("nextAction") or "")
        st = str(g.get("status") or "")
        if st in ("paused", "dormant"):
            lane = "planned"          # 暂停/沉池的目标不在执行道上, 但仍是"已规划未执行"
        elif not na:
            lane = "completed"
        else:
            lane = "planned" if waiting else "executing"
        wakes = sum(1 for t in triggers if t.get("goalId") == g["id"])
        adopted = sum(1 for t in triggers if t.get("goalId") == g["id"] and t.get("adopted"))
        out_goals.append({
            "id": g["id"], "title": str(g.get("title") or "")[:80], "status": g.get("status"),
            "lane": lane, "waiting": bool(waiting), "nextAction": na[:200], "lastActionAt": str(g.get("lastActionAt") or "")[:19],
            "wakes": wakes, "adopted": adopted,
            "counts": counts, "steps": steps[-25:],
        })
    order = {"executing": 0, "planned": 1, "completed": 2}
    out_goals.sort(key=lambda x: (order.get(x["lane"], 9), -x["counts"]["executing"]))
    payload = {
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "source": {"goals": GOALS, "claims": CLAIMS, "triggers": TRIGGERS},
        "waitingEvaluated": waiting_ok,
        "legend": {"completed": "已关单(有交付物/结论)", "executing": "目标 nextAction 可执行, 未关单项",
                   "planned": "等待型/有 reviewBy 的未来项", "blocked": "未关单且无处置位(异常)"},
        "goals": out_goals,
    }
    # 原子写(cl-243 家族): 这份 JSON 会被 UI 与 T150 判据**同时**读, 直接写目标路径时读者可能读到半个文件
    # (json.load 抛错 ⇒ 判据把"写入竞态"读成"数据不一致")。先写同目录临时文件再 os.replace。
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, args.out)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print("已写 %s: %d 个目标%s" % (args.out, len(out_goals),
              "" if waiting_ok else " (**等待判据未跑成: 车道按'执行中'处理, 属降级输出**)"))
        for g in out_goals:
            print("  %-34s %-9s 完成%-3d 执行%-3d 规划%-3d (唤醒%d/采纳%d)" % (
                g["id"], g["lane"], g["counts"]["completed"], g["counts"]["executing"],
                g["counts"]["planned"], g["wakes"], g["adopted"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
