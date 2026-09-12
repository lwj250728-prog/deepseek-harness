#!/usr/bin/env bash
# dsh-guard-t203-probe.sh — T203「恢复腿必须预登记」的开火探针
# 语义: 三条缺陷路径都必须被拦住
#   ① 未恢复的窗口缺恢复腿预登记      ⇒ lint 必须判红(exit 1)
#   ② 预登记晚于窗口结束(事后叙事)    ⇒ lint 必须判红(exit 1)
#   ③ disable 时不带 --reversal-expectation ⇒ 工具必须拒绝(exit 2)
#   exit 1 = FIRED(三条都被拦住)
#   exit 4 = 漂移(有缺陷路径被判绿/被放行 ⇒ 守卫是死的)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'MK' || exit 3
import datetime, json, os, sys
T = sys.argv[1]
now = datetime.datetime.now().astimezone()
dis = (now - datetime.timedelta(hours=2)).isoformat()
def rec(name, rows):
    p = os.path.join(T, name)
    open(p, "w", encoding="utf8").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
rec("missing.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 24}])
rec("posthoc.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 1},
                      {"ts": (now + datetime.timedelta(hours=2)).isoformat(), "event": "preregister",
                       "goal": "g", "reversalExpectation": "x"}])
open(os.path.join(T, "dormant-goals.jsonl"), "w", encoding="utf8").write(
    json.dumps({"id": "g1", "status": "active", "nextAction": "n",
                "triggerThresholds": {"kernel": 0.6, "focus": 0.55}, "waitChecker": "/bin/true"},
               ensure_ascii=False) + "\n")
MK

LINT=/home/ubuntu/dsh-fork/dsh-intervention-reversal-lint.py
for NAME in missing posthoc; do
  if python3 "$LINT" --record "$TMP/$NAME.jsonl" --quiet 2>/dev/null; then
    echo "缺陷账本 $NAME 被判绿了(应红) —— 恢复腿预登记拦不住" >&2
    exit 4
  fi
done
if DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-wake-intervention.py disable g1 >/dev/null 2>&1; then
  echo "缺 --reversal-expectation 却允许关闭干预 —— 恢复腿会变成事后叙事" >&2
  exit 4
fi
echo "[guard-fire] FIRED T203: 缺登记/事后登记均判红, 且无预期不得关闭干预" >&2
exit 1
