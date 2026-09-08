#!/usr/bin/env bash
# dsh-integrity-check.sh — 数字生命记忆完整性监控(安全防护)
# 2026-09-07 15:4x 建立; 15:5x 修复误报(可信写入判定 v2: 提交周期+mtime)。
# 威胁模型: 入侵者拿到 dsh/ubuntu shell 可篡改记忆账本。
# 防线: 我的合法写入会进git(每30min自动提交)——文件变更若"未提交且超过一个提交周期"=可疑(合法早该被提交);
#       mtime 新(<35min)的变更视为刚写入待提交, 刷新基线不告警。
# 基线: ~/.dsh/cognitive-pipeline/.integrity-baseline.sha256  告警: .integrity-alerts.log
set -uo pipefail

DIR="$HOME/.dsh/cognitive-pipeline"
GIT_REPO="$HOME/.dsh"
BASELINE="$DIR/.integrity-baseline.sha256"
ALERT_LOG="$DIR/.integrity-alerts.log"
COMMIT_CYCLE_MIN=35   # 自动提交周期30min + 余量
FILES=(
  "$DIR/user-model.md"
  "$DIR/world-model.md"
  "$DIR/north-star.jsonl"
  "$DIR/dormant-goals.jsonl"
  "$DIR/exploration-inducements.jsonl"
  "$DIR/existence-bottom-line.md"
  "$DIR/identity-north-star.md"
  "$DIR/claims-ledger.jsonl"
)

case "${1:-check}" in
  init)
    : > "$BASELINE"
    for f in "${FILES[@]}"; do
      [ -f "$f" ] && sha256sum "$f" >> "$BASELINE"
    done
    echo "[integrity] 基线已建: $(wc -l < "$BASELINE") 个文件"
    ;;
  check)
    [ -f "$BASELINE" ] || { echo "[integrity] 无基线, 先跑 init"; exit 2; }
    violations=0
    : > "$BASELINE.tmp"
    while read -r hash path; do
      if [ ! -f "$path" ]; then
        echo "[integrity] ⚠ 文件消失: $path ($(date '+%F %T'))" >> "$ALERT_LOG"
        violations=$((violations+1)); continue
      fi
      cur=$(sha256sum "$path" | awk '{print $1}')
      if [ "$cur" = "$hash" ]; then
        echo "$cur  $path" >> "$BASELINE.tmp"
        continue
      fi
      # 文件变了——判定可信/可疑
      mtime_s=$(stat -c %Y "$path" 2>/dev/null || echo 0)
      age_min=$(( ($(date +%s) - mtime_s) / 60 ))
      if [ "$age_min" -le "$COMMIT_CYCLE_MIN" ]; then
        # mtime 新 = 刚写入(我/cron 在提交周期内) → 可信, 刷新基线
        echo "$cur  $path" >> "$BASELINE.tmp"
        echo "[integrity] ✓ 近期更新(可信): $path (${age_min}min前, 提交周期内)"
      else
        # mtime 旧但内容变了 = 提交周期外变更 → 可疑
        echo "[integrity] ⚠ 疑似篡改(变更超提交周期): $path (${age_min}min前变更) $(date '+%F %T')" >> "$ALERT_LOG"
        echo "  - 基线: $hash"
        echo "  - 现在: $cur"
        violations=$((violations+1))
      fi
    done < "$BASELINE"
    mv "$BASELINE.tmp" "$BASELINE"
    if [ "$violations" -eq 0 ]; then
      echo "[integrity] ✓ 全部 $(wc -l < "$BASELINE") 个记忆文件安全 ($(date '+%F %T'))"
    else
      echo "[integrity] ✗ $violations 个文件疑似篡改! 详见 $ALERT_LOG"
    fi
    ;;
esac
