#!/usr/bin/env python3
"""dsh-mustfire-audit.py — 开火命令的"以坏充火"审计(tp-119 / cl-191)

问题：T119 原先只要求登记的 must-fire 命令 `exit != 0`。可是**探针自己崩了**也满足这一条：
2026-09-11 04:1x 我给 T139(b) 写的第一版开火命令正则不匹配, 以 `IndexError: list index out of
range` 退出 1 —— 在 T119 眼里"守卫开火了", 实际什么都没测。非零退出把这三种东西混成一种：
真开火 / 探针崩溃 / 退出码漂移。

本审计不自己实现判定(避免"两套实现各自漂移")，而是逐条过统一执行器 dsh-guard-fire-run.sh，
把它的 4 个退出码翻译成人话：
  1 FIRED 真开火 · 0 NOFIRE 守卫没开火 · 3 CRASH 以坏充火 · 4 OFFCODE 退出码漂移

用法: python3 dsh-mustfire-audit.py [--out FILE] [--guard-fire FILE]
退出码: 0 = 全部 FIRED; 1 = 存在 CRASH/NOFIRE/OFFCODE
"""
import argparse
import json
import os
import subprocess
import time

RUNNER = "/home/ubuntu/dsh-fork/dsh-guard-fire-run.sh"
VERDICT = {1: "FIRED", 0: "NOFIRE", 3: "CRASH", 4: "OFFCODE"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/.dsh/cognitive-pipeline/mustfire-audit.json"))
    ap.add_argument("--guard-fire", default=os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.json"))
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    reg = json.load(open(args.guard_fire, encoding="utf8"))
    results = []
    for g in reg["guards"]:
        for f in (g.get("mustFire") or []):
            if not f.get("command"):
                continue
            want = str(f.get("expectedExit", 1))
            t0 = time.time()
            try:
                r = subprocess.run(["bash", RUNNER, g["guard"], want, f["command"]],
                                   capture_output=True, text=True, timeout=args.timeout)
                code, err = r.returncode, r.stderr
            except subprocess.TimeoutExpired:
                code, err = 9, "TimeoutExpired(%ds)" % args.timeout
            verdict = VERDICT.get(code, "UNKNOWN")
            last = (err.strip().splitlines() or [""])[-1]
            results.append({
                "guard": g["guard"], "assertion": f.get("assertion"),
                "expectedExit": int(want), "runnerExit": code, "verdict": verdict,
                "detail": last[:160], "elapsedS": round(time.time() - t0, 1),
                "command": f["command"],
            })
            print("%-6s %-8s runner_exit=%s want=%s | %s | %s"
                  % (g["guard"], verdict, code, want, (f.get("assertion") or "(无描述)")[:26], last[:60]))

    counts = {v: sum(1 for r in results if r["verdict"] == v)
              for v in ("FIRED", "NOFIRE", "CRASH", "OFFCODE", "UNKNOWN")}
    report = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "totalCommands": len(results),
        "counts": counts,
        "results": results,
    }
    with open(args.out, "w", encoding="utf8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    print("\n合计 %d 条: FIRED=%d NOFIRE=%d CRASH=%d OFFCODE=%d UNKNOWN=%d"
          % (len(results), counts["FIRED"], counts["NOFIRE"], counts["CRASH"],
             counts["OFFCODE"], counts["UNKNOWN"]))
    print("报告: " + args.out)
    return 0 if counts["FIRED"] == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
