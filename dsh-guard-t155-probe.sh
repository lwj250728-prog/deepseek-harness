#!/usr/bin/env bash
# dsh-guard-t155-probe.sh — T155「rankKey 须与公式自洽」的开火探针(cl-218)
# 语义: 合成一条 rankKey 与公式不符的候选, 判据必须判红(那正是"配置没到运行时"的形态)。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移
set -uo pipefail
python3 -c '
c = {"expId": "exp_probe", "similarity": 0.5, "utility": 8, "rankKey": 0.5}   # 正确应为 0.5*(0.7+0.06*8)=0.59
want = c["similarity"] * (0.7 + 0.06 * c["utility"])
assert abs(want - c["rankKey"]) <= 0.002, "rankKey 与公式不自洽"
' 2>/dev/null && { echo "判据对不自洽的 rankKey 判绿了(应红)" >&2; exit 4; }
echo "[guard-fire] FIRED T155: rankKey 与公式不自洽被判红" >&2
exit 1
