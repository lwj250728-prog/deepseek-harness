#!/usr/bin/env bash
# dsh-guard-t183-probe.sh — T183「噪声判据须区分条件型等待与真噪声」的开火探针(cl-252)
#
# 语义：判据必须有**分辨力**，不能靠"一律不判噪声"来自保。合成一对只差 waitChecker 的池：
#   A) waitChecker=false(条件未满足) ⇒ 必须标 heldByCondition 且**不得**列为噪声候选；
#   B) 同一目标、同一帧数与归因率, waitChecker=true(条件已满足) ⇒ 必须**仍然**列为噪声候选。
#   exit 1 = 两个方向都成立(判据真的在区分, 不是恒绿)
#   exit 4 = 判据没分辨力(要么把等待当噪声, 要么把噪声全豁免) —— 两种都是"读数失效"
#
# 为什么必须有这条探针: 修法本身是"把某类从候选里剔除" —— 这类改动最容易变成
# "什么都剔掉"(看起来永远没有噪声, 于是读数永远好看)。B 例就是防这一点。
set -uo pipefail
python3 - <<'PYEOF'
import json, os, subprocess, sys, tempfile, datetime

ROOT = "/home/ubuntu/dsh-fork"
TZ = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(TZ)


def run_case(checker):
    tmp = tempfile.mkdtemp()
    pool = [{"id": "g-x", "status": "active", "nextAction": "等待型步骤", "waitChecker": checker}]
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in pool) + "\n")
    frames = [{"kind": "action-frame", "goalId": "g-x", "nextAction": "旧步骤",
               "session": "s-probe", "ts": (now - datetime.timedelta(minutes=500 + i * 10)).isoformat()}
              for i in range(6)]
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in frames) + "\n")
    open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("\n")
    open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("\n")
    r = subprocess.run(["python3", os.path.join(ROOT, "dsh-wake-attribution.py"), "--json", "--no-record"],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
    if r.returncode != 0:
        print("归因脚本失败: " + (r.stderr or r.stdout)[-200:], file=sys.stderr)
        sys.exit(4)
    return json.loads(r.stdout.strip().splitlines()[-1])["perGoal"][0]


held = run_case("false")
met = run_case("true")
ok_held = held["heldByCondition"] is True and held["noiseCandidate"] is False
ok_met = met["waitConditionMet"] is True and met["noiseCandidate"] is True
print("条件未满足: held=%s 噪声候选=%s | 条件已满足: held=%s 噪声候选=%s"
      % (held["heldByCondition"], held["noiseCandidate"], met["heldByCondition"], met["noiseCandidate"]),
      file=sys.stderr)
if ok_held and ok_met:
    sys.exit(1)   # 开火: 判据两个方向都成立(既认出等待, 也没把噪声一并豁免)
print("判据无分辨力(未满足=%s / 已满足=%s)" % (ok_held, ok_met), file=sys.stderr)
sys.exit(4)
PYEOF
