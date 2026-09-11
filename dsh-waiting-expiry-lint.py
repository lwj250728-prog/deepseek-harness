#!/usr/bin/env python3
"""dsh-waiting-expiry-lint.py — 唤醒侧"等待判据已到点却仍跳过"的判据(cl-198 / tp-124)

缺陷背景(cl-198): `isWaitingNextAction` 原先只看文本不看时钟, 于是 `待 09-11 06:5x 复核(等待型)`
在到点之后仍被判"等待中", 唤醒循环**永久跳过**该目标(实测 35 次唤醒 0 采纳, 全部 skipped:waiting)。
本判据守的是"修复真的在跑": 部署之后, 若某次唤醒把某目标标成 `skipped=waiting`, 而**那一刻**
该目标的 nextAction 按判据其实已不等待(日期已到点/文本已不再等待), 即判红。

判据不自己实现等待逻辑(那会变成第三份副本), 而是调用唯一的 TS 实现:
  npx tsx 动态 import packages/context/quiet-driver/src/waiting.ts

用法:
  dsh-waiting-expiry-lint.py [--trigger-log P] [--goals P] [--after MS] [--repo P] [--min-rows N]
退出码: 0 = 合规或样本不足; 1 = 违规(已到点仍被判等待); 3 = 读数/调用失败
"""
import argparse
import json
import os
import subprocess
import sys

COG = os.path.expanduser("~/.dsh/cognitive-pipeline")
DEFAULT_TRIGGER = os.path.join(COG, "goal-trigger-log.jsonl")
DEFAULT_GOALS = os.path.join(COG, "dormant-goals.jsonl")
DEFAULT_LIB = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")

TS_PROBE = """
import { isWaitingNextAction } from './packages/context/quiet-driver/src/waiting.ts'
const items = JSON.parse(process.argv[2])
console.log(JSON.stringify(items.map(([text, ms]) => isWaitingNextAction(text ?? '', new Date(ms)))))
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trigger-log", default=DEFAULT_TRIGGER)
    ap.add_argument("--goals", default=DEFAULT_GOALS)
    ap.add_argument("--after", type=float, default=None, help="只看该毫秒时刻之后的唤醒(默认=lib mtime)")
    ap.add_argument("--repo", default=os.path.expanduser("~/dsh-fork"))
    ap.add_argument("--min-rows", type=int, default=1)
    args = ap.parse_args()

    if not os.path.exists(args.trigger_log):
        print("[读数失败] 触发日志不存在: " + args.trigger_log, file=sys.stderr)
        return 3
    after = args.after
    if after is None:
        # cl-202: 用共享的部署边界(max(lib 构建, 服务启动)), 不用裸 lib mtime
        after = int(subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-deploy-boundary.py")],
                                   capture_output=True, text=True, timeout=60).stdout.strip() or 0)

    import datetime
    def ts_ms(v):
        try:
            return datetime.datetime.fromisoformat(str(v)).timestamp() * 1000
        except Exception:
            return None

    rows = []
    for line in open(args.trigger_log, encoding="utf8"):
        if not line.strip():
            continue
        r = json.loads(line)
        ms = ts_ms(r.get("ts"))
        if ms is None or ms <= after:
            continue
        if r.get("skipped") != "waiting":
            continue
        rows.append((ms, r.get("goalId"), r.get("ts")))
    if len(rows) < args.min_rows:
        print("[样本不足] 部署后标 skipped:waiting 的唤醒 %d 条(< %d), 不判" % (len(rows), args.min_rows))
        return 0

    latest = {}
    for line in open(args.goals, encoding="utf8"):
        if not line.strip():
            continue
        g = json.loads(line)
        if g.get("id"):
            latest[g["id"]] = g

    items, meta = [], []
    for ms, gid, ts in rows:
        g = latest.get(gid)
        if g is None:
            continue
        items.append([str(g.get("nextAction") or ""), ms])
        meta.append((gid, ts, str(g.get("nextAction") or "")))
    if not items:
        print("[样本不足] 无可用(唤醒, 目标)配对, 不判")
        return 0

    probe = subprocess.run(["npx", "tsx", "-e", TS_PROBE, "x", json.dumps(items)],
                           cwd=args.repo, capture_output=True, text=True, timeout=180)
    if probe.returncode != 0:
        print("[读数失败] 无法调用等待判据: " + probe.stderr.strip()[-200:], file=sys.stderr)
        return 3
    try:
        verdicts = json.loads(probe.stdout.strip().splitlines()[-1])
    except Exception:
        print("[读数失败] 判据输出无法解析: " + probe.stdout.strip()[-200:], file=sys.stderr)
        return 3

    bad = []
    for (gid, ts, action), waiting in zip(meta, verdicts):
        if waiting is False:
            bad.append("%s@%s nextAction 已不等待却仍 skipped:waiting → %s" % (gid, str(ts)[11:16], action[:48]))
    if bad:
        print("红: " + "; ".join(bad[:3]), file=sys.stderr)
        return 1
    print("部署后 %d 条 skipped:waiting 唤醒, 逐条按已部署判据复核: 均确为等待中" % len(meta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
