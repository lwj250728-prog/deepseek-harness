#!/usr/bin/env bash
# dsh-guard-t182-probe.sh — T182「账本写入侧自愈」的开火探针(cl-055)
#
# 语义：合成一本**缺 reviewBy** 的未关项账本，自愈必须把它补上且留痕(reviewByAuto)，
#       同时不许动终态项、不许改写已声明的 reviewBy。
#   exit 1 = 开火(自愈真的修好了坏账本) ← must-fire 约定的期望码
#   exit 4 = 自愈没生效(或反过来越权改判了不该动的行) —— 即 cl-055 的病灶仍在
#
# 为什么要有这条探针：cl-055 的病根是"约束只在审计侧"，于是判据红了却没有任何东西去修它。
# 只声明"有自愈脚本"不算证据 —— 必须现场跑一次坏账本，看它是否真被修好。
set -uo pipefail
python3 - <<'PYEOF'
import json, os, subprocess, sys, tempfile

heal = "/home/ubuntu/dsh-fork/dsh-claims-ledger-heal.py"
tmp = tempfile.mkdtemp()
led = os.path.join(tmp, "bad.jsonl")
log = os.path.join(tmp, "heal.log")
bad = [
    {"id": "cl-probe-a", "status": "open", "ts": "2026-09-01T00:00:00+08:00",
     "claim": "合成的坏行: 缺 reviewBy", "disposition": "待办"},
    {"id": "cl-probe-b", "status": "done", "ts": "2026-09-01T00:00:00+08:00", "claim": "终态行不该被动"},
    {"id": "cl-probe-c", "status": "open", "ts": "2026-09-01T00:00:00+08:00",
     "claim": "已声明窗口", "reviewBy": "2026-09-20"},
]
open(led, "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in bad) + "\n")
r = subprocess.run(["python3", heal, "--force", "--ledger", led, "--log", log],
                   capture_output=True, text=True, timeout=120)
if r.returncode != 0:
    print("自愈脚本失败: " + (r.stderr or r.stdout)[-200:], file=sys.stderr)
    sys.exit(4)
lat = {}
rows = 0
for line in open(led, encoding="utf8"):
    if line.strip():
        rows += 1
        x = json.loads(line)
        if x.get("id"):
            lat[x["id"]] = x
repaired = bool(lat["cl-probe-a"].get("reviewBy")) and lat["cl-probe-a"].get("reviewByAuto") is True
appended = rows == len(bad) + 1  # 只追加一行修正副本, 不原地改写
preserved = lat["cl-probe-a"].get("claim") == "合成的坏行: 缺 reviewBy"
untouched = (not lat["cl-probe-b"].get("reviewBy")) and lat["cl-probe-c"].get("reviewBy") == "2026-09-20"
# ts 语义(2026-09-12 01:5x 实测踩到): 状态被改写 ⇒ ts 必须换新且严格递增, 原创建时刻另存 createdTs。
# 抄原 ts 会让同 id 两行 ts 相等 ⇒ T132 红、按 ts 取最新的消费方读到随机状态。
ts_ok = (lat["cl-probe-a"].get("ts") > "2026-09-01T00:00:00+08:00"
         and lat["cl-probe-a"].get("createdTs") == "2026-09-01T00:00:00+08:00")
print("坏行被补=%s 只追加=%s 原字段保留=%s ts语义=%s 越权=%s (行 %d→%d)"
      % (repaired, appended, preserved, ts_ok, not untouched, len(bad), rows), file=sys.stderr)
if repaired and appended and preserved and untouched and ts_ok:
    sys.exit(1)   # 开火: 坏账本被修好, 且没有越权改判
print("自愈行为不符(未修好/原地改写/越权): 判据会怎样, 探针就怎样", file=sys.stderr)
sys.exit(4)
PYEOF
