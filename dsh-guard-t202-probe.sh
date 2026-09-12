#!/usr/bin/env bash
# dsh-guard-t202-probe.sh — T202「门不得全体无界 / 时限须被行为消费」的开火探针
# 语义: 造两个**缺陷池** —— ①全体无界(所有 active 目标都是 /bin/false, 无时限)
#       ②装饰性时限(命令行里逐字有 --deadline, 但门根本不消费它) —— 判据必须对两者都判红。
#   ②是重点: 只看文本的结构判据会把它判绿, 只有"把时限换成过去再看门是否放行"的行为口径能抓住。
#   exit 1 = FIRED(判据能抓住缺陷)
#   exit 4 = 漂移(缺陷池被判绿 ⇒ 守卫是死的)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'MK' >/dev/null
import datetime, json, os, sys
T = sys.argv[1]
D = (datetime.datetime.now().astimezone() + datetime.timedelta(hours=20)).isoformat()
def pool(name, rows):
    p = os.path.join(T, name)
    open(p, "w", encoding="utf8").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return p
pool("all.jsonl", [{"id": "g1", "status": "active", "waitChecker": "/bin/false"}])
pool("deco.jsonl", [{"id": "g1", "status": "active", "waitChecker": "/bin/false --deadline " + D,
                     "waitCheckerDeadline": D}])
MK

for P in "$TMP/all.jsonl" "$TMP/deco.jsonl"; do
  if python3 /home/ubuntu/dsh-fork/dsh-goal-gate-liveness.py --pool "$P" --quiet 2>/dev/null; then
    echo "判据把缺陷池 $P 判绿了(应红) —— 无界门/装饰时限拦不住" >&2
    exit 4
  fi
done
echo "[guard-fire] FIRED T202: 全体无界池与装饰性时限池均被判红" >&2
exit 1
