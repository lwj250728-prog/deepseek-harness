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

    items, meta, skipped_stale = [], [], 0
    for ms, gid, ts in rows:
        g = latest.get(gid)
        if g is None:
            continue
        # 关键修正(2026-09-11 08:5x, 由一次假红逼出): 判据不能用**当前** nextAction 去审**历史**跳过决定。
        # 我刚刚按 T149 把两个"待事件"目标改写成动作型, 于是它们过去那些 skipped:waiting 立刻"变得不一致"而假红。
        # 正确做法: 只看"当前 nextAction 已经生效之后"的唤醒(用 lastActionAt 作分界)。
        la = str(g.get("lastActionAt") or "")
        if la:
            import datetime as _dt
            try:
                la_ms = _dt.datetime.fromisoformat(la).timestamp() * 1000
                if ms < la_ms:
                    skipped_stale += 1
                    continue
            except Exception:
                pass
        items.append([str(g.get("nextAction") or ""), ms])
        meta.append((gid, ts, str(g.get("nextAction") or "")))
    if not items:
        print("[样本不足] 无可用(唤醒, 目标)配对, 不判(另有 %d 条因 nextAction 已改写而跳过)" % skipped_stale)
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

    # 2026-09-12 09:2x **判据随机制更新(cl-267)**: "是否该跳过"现在**有 checker 时由 checker 说了算**
    # (文本启发式只在无 checker 时兜底)。所以"文本看着像行动型"不再能证明它不该被跳过 —— 实测:
    # 检索目标的 nextAction 是行动型措辞, 但它的 refine checker 未满足 ⇒ 标 skipped:waiting 是**正确**的,
    # 而本 lint 用旧口径 (只看文本) 把它判成红。修正: 有 checker 的目标, 以 checker 的当场退出码为准。
    goals_by_id = latest   # 池内目标(last-wins), 见上面的读取循环

    def checker_unmet(gid: str) -> bool | None:
        cmd = str(goals_by_id.get(gid, {}).get("waitChecker") or "").strip()
        if cmd == "":
            return None
        try:
            return subprocess.run(cmd, shell=True, capture_output=True, timeout=60).returncode != 0
        except Exception:
            return True   # fail-closed: 测不出就不当"已到点"

    bad = []
    for (gid, ts, action), waiting in zip(meta, verdicts):
        checked = checker_unmet(gid)
        if checked is True:
            continue          # checker 未满足 ⇒ 跳过是正确的, 与文本无关
        if checked is None and waiting is False:
            bad.append("%s@%s 无 checker 且 nextAction 已不等待却仍 skipped:waiting → %s"
                       % (gid, str(ts)[11:16], action[:48]))
    if bad:
        print("红: " + "; ".join(bad[:3]), file=sys.stderr)
        return 1
    print("部署后 %d 条 skipped:waiting 唤醒, 逐条按已部署判据复核: 均确为等待中" % len(meta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
