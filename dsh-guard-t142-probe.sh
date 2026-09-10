#!/usr/bin/env bash
# dsh-guard-t142-probe.sh — T142「有部署意图时必须真有排程载体」的开火探针(cl-189/tp-120)
#
# 语义：喂给判据一个"有意图但没有排程载体"的合成世界，判据必须把它判成缺陷(检测器 exit 2)。
#   exit 1 = 开火(判据抓住了"无人承载")   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(判据放过了它)     ← T119 的统一判定器会判红
# 另外对照一次"弱判据"(--carrier-policy scheduled-or-ledger)：账本项一算载体，同一个世界就被放过。
# 这正是 tp-120 原计划 (a) 或 (b) 中 (b) 的漏洞 —— 当晚一直开着的 cl-189 就足以让判据永不报警。
set -uo pipefail
DET=/home/ubuntu/dsh-fork/dsh-deploy-intent.py
NOW=$(date +%s)

python3 "$DET" --lib-ts "$NOW" --units-file /dev/null --ledger /tmp/t142-none.jsonl \
  --state /tmp/t142-probe.json --quiet
STRICT=$?

python3 "$DET" --lib-ts "$NOW" --units-file /dev/null --carrier-policy scheduled-or-ledger \
  --state /tmp/t142-probe-weak.json --quiet
WEAK=$?

echo "严格判据 exit=$STRICT (期望 2=无人承载) | 弱判据 exit=$WEAK (期望 1=被账本项放过)" >&2

if [ "$STRICT" -eq 2 ]; then
  exit 1
fi
echo "判据没抓住'无人承载'(严格判据 exit=$STRICT)" >&2
exit 4
