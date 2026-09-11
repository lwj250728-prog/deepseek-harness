#!/usr/bin/env python3
"""dsh-goal-wait-lint.py — active 目标不得停在"无法解析的等待"上(cl-206)

缺陷背景: cl-198 修掉的是**日期型**等待(到点即恢复可执行); 但**事件型**等待("待事件(样本≥30)")没有
任何判据能把它解析成"现在可执行了吗" —— 于是目标会被唤醒侧永久判为等待, 计数照涨、事情不动。
实测: goal-experience-library 触发 0 / 采纳 0, 它的 nextAction 正是"待事件(样本≥30 自动可判)",
而样本早已到过 39(记录数)。

判据(只看 active 目标):
  nextAction 若被判据(唯一实现 quiet-driver/waiting.ts, 经 tsx 调用)判为"等待中", 则必须**可解析**:
  ① 带日期/钟点(到点自动恢复), 或 ② 带 waitChecker 字段(一条能自己回答"条件满足了吗"的命令)。
  两者都没有 ⇒ 红: 这个目标只会被永久跳过。

用法: dsh-goal-wait-lint.py [--goals P] [--repo P] [--json]
退出码: 0 = 合规; 1 = 存在无法解析的等待; 3 = 读数/调用失败
"""
import argparse
import json
import os
import subprocess
import sys

COG = os.path.expanduser("~/.dsh/cognitive-pipeline")
TS_PROBE = """
import { isWaitingNextAction, parseWaitingMoment } from './packages/context/quiet-driver/src/waiting.ts'
const items = JSON.parse(process.argv[2])
console.log(JSON.stringify(items.map(([text, ms]) => {
  const d = new Date(ms)
  const t = text ?? ''
  return { waiting: isWaitingNextAction(t, d), hasMoment: parseWaitingMoment(t.trim(), d) !== null }
})))
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goals", default=os.path.join(COG, "dormant-goals.jsonl"))
    ap.add_argument("--repo", default=os.path.expanduser("~/dsh-fork"))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.goals):
        print("[读数失败] 目标池不存在: " + args.goals, file=sys.stderr)
        return 3

    import time
    now_ms = int(time.time() * 1000)
    latest = {}
    for line in open(args.goals, encoding="utf8"):
        if not line.strip():
            continue
        g = json.loads(line)
        if g.get("id"):
            latest[g["id"]] = g
    active = [g for g in latest.values() if g.get("status") == "active"]
    if not active:
        print("[前提不成立] 没有 active 目标, 不判")
        return 0

    items = [[str(g.get("nextAction") or ""), now_ms] for g in active]
    probe = subprocess.run(["npx", "tsx", "-e", TS_PROBE, "x", json.dumps(items)],
                           cwd=args.repo, capture_output=True, text=True, timeout=180)
    if probe.returncode != 0:
        print("[读数失败] 无法调用等待判据: " + probe.stderr.strip()[-200:], file=sys.stderr)
        return 3
    verdicts = json.loads(probe.stdout.strip().splitlines()[-1])

    bad, ok = [], []
    for g, v in zip(active, verdicts):
        na = str(g.get("nextAction") or "")
        if not na.strip():
            # 空 nextAction: 既不是可执行步骤, 也不是可解析的等待 —— 该目标在池子里空转(实测 goal-adoption-rate)。
            bad.append("%s: (nextAction 为空)" % g["id"])
            continue
        if not v["waiting"]:
            ok.append((g["id"], "可执行(判据不认为在等待)"))
            continue
        # 判为等待: 必须有解析途径。**不能靠"前缀里有数字"猜日期**——
        # 第一版就这么写, 于是 "待事件(样本≥30 自动可判)" 里的 30 被当成日期, 判据空过(实测)。
        # 改成直接问唯一的判据实现: parseWaitingMoment 解得出时刻吗?
        checker = str(g.get("waitChecker") or "").strip()
        if v["hasMoment"]:
            ok.append((g["id"], "日期型等待(到点自行放行)"))
        elif checker:
            ok.append((g["id"], "带 waitChecker"))
        else:
            bad.append("%s: %s" % (g["id"], na[:52]))

    if args.json:
        print(json.dumps({"activeGoals": len(active), "unresolvable": bad}, ensure_ascii=False))
    if bad:
        print("红: active 目标停在**无法解析的等待**上(唤醒侧只会永久跳过): " + "; ".join(bad[:4]), file=sys.stderr)
        return 1
    print("active %d 个: 均为可执行或可解析等待" % len(active))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
