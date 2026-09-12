#!/usr/bin/env bash
# dsh-guard-t207-probe.sh — T207「无对照空间不得开窗」的开火探针
# 语义: 把干预工具**变异**成不再预检对照臂空间(旧行为), 再让 T207 的判据去审它 —— 必须判红。
#   (第一版把变异体放进 /tmp, 于是它找不到同目录的 dsh-goal-pool-write.py, 以 exit 2 失败 ——
#    "拒绝"与"跑不动"混成一个码, 探针把这条假信号报成了漂移。故: 变异体放仓库目录, 并同时要求
#    拒绝理由是**对照空间**那条, 而不是随便什么失败。)
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
REPO=/home/ubuntu/dsh-fork
TMP=$(mktemp -d); MUT="$REPO/.t207-mutant-intervention.py"
trap 'rm -rf "$TMP" "$MUT"' EXIT
python3 - "$TMP" "$MUT" <<'MK' || exit 3
import json, os, sys
T, MUT = sys.argv[1], sys.argv[2]
src = open("/home/ubuntu/dsh-fork/dsh-wake-intervention.py", encoding="utf8").read()
marker = "        if no_headroom and not args.allow_no_headroom:"
assert src.count(marker) == 1, "找不到对照臂空间预检(结构变了, 探针自身失效)"
open(MUT, "w", encoding="utf8").write(
    src.replace(marker, "        if False and no_headroom and not args.allow_no_headroom:   # 变异: 预检失效"))
open(os.path.join(T, "dormant-goals.jsonl"), "w", encoding="utf8").write("".join(
    json.dumps(r, ensure_ascii=False) + "\n" for r in [
        {"id": "goal-target", "status": "active", "nextAction": "x", "waitChecker": "/bin/true"},
        {"id": "goal-ctl1", "status": "active", "nextAction": "y", "waitChecker": "/bin/false"}]))
MK
if DSH_COG_DIR="$TMP" MUTANT="$MUT" python3 -c '
import os, subprocess
r = subprocess.run(["python3", os.environ["MUTANT"], "disable", "goal-target", "--hours", "24",
                    "--reversal-expectation", "恢复后 30 分钟内应见行动帧"],
                   capture_output=True, text=True, timeout=600, env=dict(os.environ))
assert r.returncode == 2, "对照臂全无空间却允许开窗(exit %d)" % r.returncode
assert "对照臂有推进空间" in (r.stderr or ""), "拒绝理由不是对照空间那条(是别的失败): " + (r.stderr or r.stdout)[-160:]
' 2>/dev/null; then
  echo "变异成旧行为(不预检对照空间)却判绿了 —— 窗口会被构造成 no-effect" >&2
  exit 4
fi
echo "[guard-fire] FIRED T207: 去掉对照臂空间预检后, T207 判红(且理由正确)" >&2
exit 1
