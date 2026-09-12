#!/usr/bin/env bash
# dsh-guard-t204-probe.sh — T204「判读速率的分母必须是该臂的时代覆盖小时数」的开火探针
# 语义: 把判读器**变异**成旧口径(分母用窗口全长), 再让 T204 的判据去审它 —— 必须判红。
#   (第一版探针把判据直接用在**正确**实现上, 于是"判据通过"被报成了漂移 —— 开火探针必须审一个
#    **缺陷件**, 否则它测的是"代码现在是对的", 而不是"判据抓得住错"; T201 的探针也是审变异件。)
#   合成账本: 24h 窗口里时代只覆盖最后 6h, 覆盖段 2 条推进 ⇒ 正确口径 2/6=0.333, 旧口径 2/24=0.083。
#   exit 1 = FIRED(判据能抓住旧口径)
#   exit 4 = 漂移(变异成旧口径却仍判绿 ⇒ 守卫是死的)
#   exit 3 = 探针自身失效(源码结构与假设不符)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'MK' || exit 3
import datetime, json, os, sys
T = sys.argv[1]
now = datetime.datetime.now().astimezone()
iso = lambda dt: dt.isoformat()
open(os.path.join(T, "attribution-era.json"), "w", encoding="utf8").write(
    json.dumps({"since": iso(now - datetime.timedelta(hours=12))}))
open(os.path.join(T, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("")
open(os.path.join(T, "wake-interventions.jsonl"), "w", encoding="utf8").write("")
open(os.path.join(T, "dormant-goals.jsonl"), "w", encoding="utf8").write(
    json.dumps({"id": "goal-x", "status": "active"}) + "\n")
with open(os.path.join(T, "incubation-log.jsonl"), "w", encoding="utf8") as f:
    for offs in (20, 20, 20, 8, 8):
        f.write(json.dumps({"ts": iso(now - datetime.timedelta(hours=offs)), "goalId": "goal-x",
                            "evidence": "pool-change"}) + "\n")
open(os.path.join(T, "window.json"), "w", encoding="utf8").write(json.dumps(
    {"start": iso(now - datetime.timedelta(hours=30)), "end": iso(now - datetime.timedelta(hours=6))}))
src = open(os.path.expanduser("~/dsh-fork/dsh-wake-intervention-readout.py"), encoding="utf8").read()
marker = "        return n / cov"
assert src.count(marker) == 1, "找不到 rate() 的分母那一行(结构变了, 探针自身失效)"
mut = src.replace(marker, "        return n / (span / 3600000.0)   # 变异: 旧口径(窗口全长作分母)")
open(os.path.join(T, "mutant.py"), "w", encoding="utf8").write(mut)
MK

if DSH_COG_DIR="$TMP" MUTANT="$TMP/mutant.py" python3 -c '
import json, os, subprocess
T = os.environ["DSH_COG_DIR"]
w = json.load(open(os.path.join(T, "window.json"), encoding="utf8"))
r = subprocess.run(["python3", os.environ["MUTANT"], "--target", "goal-x",
                    "--start", w["start"], "--end", w["end"]],
                   capture_output=True, text=True, timeout=600, env=dict(os.environ))
assert r.returncode == 0, "变异版跑不动: " + (r.stderr or r.stdout)[-200:]
p = [json.loads(l) for l in open(os.path.join(T, "wake-intervention-readout.jsonl"), encoding="utf8") if l.strip()][-1]
assert abs(p["interventionCoverageHours"] - 6.0) < 0.05, "覆盖小时数不对: %r" % p["interventionCoverageHours"]
assert abs(p["targetInterventionRate"] - 2.0 / 6.0) < 0.01, (
    "分母不是时代覆盖(2/6=0.333 才是对的, 实得 %r)" % p["targetInterventionRate"])
' 2>/dev/null; then
  echo "变异成旧口径(分母=窗口全长)却判绿了 —— 基线会被低估、ratio 被放大、偏向 causal" >&2
  exit 4
fi
echo "[guard-fire] FIRED T204: 旧口径(2/24)被 T204 抓出, 正口径为 2/6" >&2
exit 1
