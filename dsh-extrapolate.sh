#!/usr/bin/env bash
# dsh-extrapolate.sh — 外推扫描器（2026-09-09 00:2x 建立，cl-046）
#
# 用户点出的认知动作：人类发现一种植物茎块可食用 → 主动去查其他茎块是否也可食用。
# 系统此前没有这个动作：修好一处缺陷/确认一条经验后就停了，同型样本要等下次再被踩到。
#
# 本脚本把"外推"变成一次可重复执行的动作：给定一个已确认的模式（正则），
# 扫出代码库里的同型候选点，供主会话逐条裁决（是/不是同类缺陷）。
# 它只列候选，不下结论——裁决仍归外部锚（测试/用户/数据）。
#
# 用法:
#   dsh-extrapolate.sh "<正则>" [目录]
# 例:
#   dsh-extrapolate.sh "\.includes\(" ~/dsh-fork/packages/cognition   # 找文本嗅探点
set -uo pipefail

PATTERN="${1:?用法: dsh-extrapolate.sh \"<正则>\" [目录]}"
SCOPE="${2:-$HOME/dsh-fork/packages}"

echo "[extrapolate] 模式: $PATTERN"
echo "[extrapolate] 范围: $SCOPE"
echo

mapfile -t HITS < <(grep -rn --include='*.ts' -E "$PATTERN" "$SCOPE" 2>/dev/null \
  | grep -v '/tests/\|\.spec\.\|/lib/\|/node_modules/')

if [ "${#HITS[@]}" -eq 0 ]; then
  echo "无同型候选点（外推结果：该模式是孤例）"
  exit 0
fi

echo "同型候选 ${#HITS[@]} 处："
for h in "${HITS[@]}"; do
  file="${h%%:*}"; rest="${h#*:}"; line="${rest%%:*}"
  printf '  · %s:%s\n' "${file#"$HOME"/}" "$line"
  printf '      %s\n' "$(echo "$h" | cut -d: -f3- | sed 's/^[[:space:]]*//' | cut -c1-120)"
done
echo
echo "裁决清单（逐条问：这是同型缺陷，还是有第二道结构守卫？）："
for h in "${HITS[@]}"; do
  printf '  [ ] %s:%s\n' "${h%%:*}" "${h#*:}" | cut -d: -f1-2
done
