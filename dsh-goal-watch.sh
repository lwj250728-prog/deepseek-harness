#!/usr/bin/env bash
# dsh-goal-watch.sh — 目标池 nextAction 滞留监视器
# 起因(cl-054): 账本已有到期裁决(T33), 但"目标池"本身——Q2 要审的对象——没有任何滞留锚:
#   active 目标没有 updatedAt/reviewBy, "待事件" 可以无限期冒充 active。
# 做法: 记录每个 active 目标 nextAction 的指纹与首见/变更时间; 变更即刷新, 滞留即暴露。
# 判据: 超过 maxDays 未变更 且 无未来 reviewBy → 视为滞留(T34 断言失败)。
set -uo pipefail
DIR="$HOME/.dsh/cognitive-pipeline"
GOALS="$DIR/dormant-goals.jsonl"
WATCH="$DIR/goal-watch.json"

python3 - "$GOALS" "$WATCH" <<'PY'
import json, sys, os, hashlib, datetime

goals_path, watch_path = sys.argv[1], sys.argv[2]
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
now_iso = now.isoformat(timespec="seconds")

try:
    watch = json.load(open(watch_path, encoding="utf8"))
except Exception:
    watch = {}

active = []
for line in open(goals_path, encoding="utf8"):
    line = line.strip()
    if not line:
        continue
    g = json.loads(line)
    if g.get("status") == "active":
        active.append(g)

active_ids = {g.get("id") for g in active}

for g in active:
    gid = g.get("id")
    na = (g.get("nextAction") or "").strip()
    fp = hashlib.sha256(na.encode("utf8")).hexdigest()[:12]
    rec = watch.get(gid, {})
    if rec.get("fingerprint") != fp:
        rec["fingerprint"] = fp
        rec["lastChanged"] = now_iso
        rec["changeCount"] = int(rec.get("changeCount", 0)) + 1
        rec.setdefault("firstSeen", now_iso)
    rec.setdefault("firstSeen", now_iso)
    rec["nextActionHead"] = na[:60]
    rec["active"] = True
    watch[gid] = rec

for gid, rec in watch.items():
    if gid not in active_ids:
        rec["active"] = False

json.dump(watch, open(watch_path, "w", encoding="utf8"), ensure_ascii=False, indent=2, sort_keys=True)

for g in active:
    gid = g.get("id")
    rec = watch[gid]
    try:
        lc = datetime.datetime.fromisoformat(rec["lastChanged"])
    except Exception:
        lc = now
    days = (now - lc).total_seconds() / 86400.0
    maxd = rec.get("maxDays", 2)
    print("%s | 滞留 %.2fd / 上限 %sd | reviewBy=%s | %s"
          % (gid, days, maxd, rec.get("reviewBy", "-"), rec.get("nextActionHead", "")))
PY
