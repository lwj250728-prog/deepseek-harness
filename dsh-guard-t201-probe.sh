#!/usr/bin/env bash
# dsh-guard-t201-probe.sh — T201「时限不得绕过 fail-closed」的开火探针
# 语义: 把 checker 的**两条 fail-closed 出口**分别变异成"到点就放行"(后门版), 再用 T201 的判据去审它
#       —— 两条都必须判红。这是被"探针自身失效"逼出来的第二版: 第一版只变异了「度量器失败」那一支,
#       而"输出乱码但 exit 0"的坏工具走的是**解析**分支 ⇒ 变异版仍返回 3, 探针把"没测到"报成了漂移。
#   变异是结构可查的(改不到那一行就报自身失效), 也是行为可查的(它真的会放行)。
#   exit 1 = FIRED(判据能抓住这个缺陷)
#   exit 4 = 漂移(后门版却判绿 ⇒ 守卫是死的)
#   exit 3 = 探针自身失效(源码结构与探针假设不符)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-wait-check-refine.py"), encoding="utf8").read()
lines = src.split("\n")

def mutant_at(markers, name):
    idx = [k for k, l in enumerate(lines) if all(m in l for m in markers)]
    assert len(idx) == 1, "源码里找不到唯一的标记 %r(结构变了, 探针自身失效): %r" % (markers, idx)
    i = idx[0]
    assert lines[i + 1].strip() == "return 3", "标记 %r 后面不再是 fail-closed 的 return 3: %r" % (markers, lines[i + 1])
    mut = list(lines)
    mut[i + 1] = "        return 0          # 变异: 到点就放行(后门)"
    open(os.path.join(T, name), "w", encoding="utf8").write("\n".join(mut))

# 标记必须同时含 print(: 「度量器失败」这四个字在文档串里也出现(实测踩到 —— 探针自己报自身失效)
mutant_at(("度量器失败", "print("), "mutant_toolfail.py")   # 分支 A: 度量器非零退出
mutant_at(("输出里找不到",), "mutant_parsefail.py")          # 分支 B: 输出解析不了
open(os.path.join(T, "err.py"), "w", encoding="utf8").write("import sys\nsys.exit(2)\n")
open(os.path.join(T, "garbage.py"), "w", encoding="utf8").write("print(\"完全不是预期格式的输出\")\n")
MK

PAST=$(python3 -c 'import datetime;print((datetime.datetime.now().astimezone()-datetime.timedelta(hours=1)).isoformat())')
if MUTANT_DIR="$TMP" PAST="$PAST" python3 -c '
import os, subprocess
T = os.environ["MUTANT_DIR"]
for mut, tool, what in (("mutant_toolfail.py", "err.py", "度量器非零退出"),
                        ("mutant_parsefail.py", "garbage.py", "输出解析不了")):
    r = subprocess.run(["python3", os.path.join(T, mut), "--min-n", "5", "--deadline", os.environ["PAST"]],
                       capture_output=True, text=True, timeout=600,
                       env=dict(os.environ, DSH_REFINE_EVAL=os.path.join(T, tool)))
    assert r.returncode == 3, "%s 时后门放行了(exit %d) —— 时限成了绕过 fail-closed 的后门" % (what, r.returncode)
' 2>/dev/null; then
  echo "判据对两条 fail-closed 出口的后门版都判绿了(应红)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T201: 度量器失败/输出解析不了 两种情形下, 过了时限也仍被要求 fail-closed(3)" >&2
exit 1
