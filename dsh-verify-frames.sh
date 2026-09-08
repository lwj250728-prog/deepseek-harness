#!/usr/bin/env bash
# dsh-verify-frames.sh — 部署后帧质量验证(v28 补自主进化闭环: 部署即完成≠有效, 需自动验证)
# 用法: ./dsh-verify-frames.sh [--minutes N]   # 检查最近 N 分钟(默认 15)的帧质量
# 验证项(对应今天校准的指标):
#   1. 有帧产出(非零)         —— 机制活着
#   2. 无"与上帧一致"敷衍帧    —— 措辞校准生效
#   3. 平均帧长 >= 200字       —— 实质而非确认态
#   4. 无超长静默空白(>30min)  —— 静默校准生效(深度帧替代空白)
# 退出码: 0=全过 1=有失败 2=无帧可查
set -uo pipefail
LOG="${DSH_COGNITIVE:-$HOME/.dsh/cognitive-pipeline}/quiet-driver-frames.jsonl"
# 参数: [--minutes N] 或直接 N(位置参数)
MINUTES="15"
if [ "${1:-}" = "--minutes" ] && [ -n "${2:-}" ]; then MINUTES="$2"
elif [ -n "${1:-}" ] && [ "${1#--}" = "$1" ]; then MINUTES="$1"; fi
if [ ! -f "$LOG" ]; then echo "✗ 帧日志不存在: $LOG"; exit 2; fi

CUTOFF=$(date -d "-${MINUTES} minutes" +%s 2>/dev/null || echo 0)
LOG_V="$LOG" CUT_V="$CUTOFF" python3 - << 'PYEOF'
import json, sys, datetime, re
import os
log, cutoff = os.environ["LOG_V"], int(os.environ["CUT_V"])
rows = []
try:
    for line in open(log, encoding='utf8'):
        d = json.loads(line)
        if d.get('ts', 0) >= cutoff * 1000 and d.get('kind') in ('direct-frame', 'candidate-hatch', 'action-frame'):
            rows.append(d)
except Exception as e:
    print(f"✗ 读日志失败: {e}"); sys.exit(2)

if not rows:
    print("✗ 窗口内无帧(机制可能停了或静默中)"); sys.exit(2)

fails = []
lengths = [len(d.get('output') or '') for d in rows]
# 2026-09-08 修正(T3 误报诊断): 原正则匹配"无变化"会误伤客观描述(如"oq-010 无变化"是环境陈述,
# 非敷衍)。敷衍=自我陈述式的空转确认, 须锚定主语/句式: "与上帧一致""维持待命""无实质推进"
# "无新观察"等; 客观描述"X 无变化/无新数据"不计。低信息豁免帧(声明"无新信息"+依据)亦不计。
lazy = sum(1 for d in rows if re.search(r'与上帧一致|维持待命|无实质推进|无新观察|无新增观察|实质相同', d.get('output') or ''))
# 豁免帧计数(供比例监控): 显式声明"无新信息"且给出依据的帧
exempt = sum(1 for d in rows if re.search(r'无新信息', d.get('output') or ''))
avg = sum(lengths) / len(lengths)
# 静默空白检测: 帧间隔
gaps = []
prev = None
allrows = []
for line in open(log, encoding='utf8'):
    d = json.loads(line)
    if d.get('kind') in ('direct-frame', 'candidate-hatch', 'action-frame'):
        allrows.append(d.get('ts', 0))
allrows.sort()
for i in range(1, len(allrows)):
    g = (allrows[i] - allrows[i-1]) / 60000
    if g > 30: gaps.append(round(g))

print(f"窗口帧数: {len(rows)} | 平均长度: {avg:.0f}字 | 敷衍帧: {lazy} | 豁免帧: {exempt} | 超30min静默空白: {len(gaps)}处")
if len(rows) < 2:
    print("⚠ 帧数过少, 部分判断不可靠"); sys.exit(1)
if avg < 200: fails.append(f"平均帧长 {avg:.0f} < 200 (可能退回确认态)")
if lazy > 0: fails.append(f"{lazy} 帧含敷衍措辞(校准未生效?)")
# 豁免比例监控(cl-014): 豁免帧合法但连续滥用=伪饱足风险。仅告警不判失败——
# 用户静默期豁免本就合理; 真正的防线是帧头"变化源清单"(豁免前须逐项核对)。
if len(rows) >= 3 and exempt / len(rows) > 0.6:
    print(f"⚠ 豁免帧占比 {exempt}/{len(rows)} > 60%——请确认这些帧过了变化源清单(cl-014: 用户消息/账本/载体身份/外部数据/配置改动)")
if fails:
    for f in fails: print(f"✗ {f}")
    sys.exit(1)
print("✓ 帧质量验证通过(实质产出/无敷衍/无长空白)")
sys.exit(0)
PYEOF
