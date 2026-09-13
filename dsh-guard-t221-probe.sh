#!/usr/bin/env bash
# dsh-guard-t221-probe.sh — T221「阶段总结帧必须产出底座 + 外部分」的开火探针
# 语义: 造一个**缺证据指针**的外部分(评审者给分但没写证据) ⇒ 判据必须判红。
#   exit 1 = FIRED / exit 4 = 漂移(缺失的外部分仍被判绿) / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
n = "2026-09-13T12:00:00+08:00"
with open(os.path.join(T, "stage-summary.jsonl"), "w", encoding="utf8") as f:
    f.write(json.dumps({"ts": n, "periodEnd": n, "hours": 6}, ensure_ascii=False) + "\n")
# 关键: 五维都有分, 但 evidence 全空 ⇒ 空口给分, 判据必须抓
dims = ["artifactTruth", "caliberHonesty", "goalSubstance", "selfCorrection", "anchorConsistency"]
with open(os.path.join(T, "stage-summary-external.jsonl"), "w", encoding="utf8") as f:
    f.write(json.dumps({"ts": n, "reviewer": "fake", "meanScore": 9.0,
                        "scores": {k: 9 for k in dims}, "evidence": {k: [] for k in dims},
                        "unverifiable": ["无"], "counterHypothesis": "无", "falsifierNextPeriod": "无"},
                       ensure_ascii=False) + "\n")
with open(os.path.join(T, "quiet-driver-frames.jsonl"), "w", encoding="utf8") as f:
    f.write(json.dumps({"ts": 1, "kind": "stage-summary-frame"}, ensure_ascii=False) + "\n")
MK
if DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py \
     --name "阶段总结帧必须真的产出总结与外部分(且外部分不得空口给分)" >/dev/null 2>&1; then
  echo "空口给分的外部分仍被判绿 —— '外部评审'会退化成我自己写一段评语" >&2
  exit 4
fi
echo "[guard-fire] FIRED T221: 无证据指针的外部分被判据抓住" >&2
exit 1
