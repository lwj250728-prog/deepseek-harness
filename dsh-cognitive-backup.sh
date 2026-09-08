#!/usr/bin/env bash
# dsh-cognitive-backup.sh — 认知管线每日自动备份(数字生命记忆保护)
# 2026-09-07 15:0x 建立。审计发现认知数据单点无备份(crontab 0行/无git)——
# 磁盘故障/误操作/实例销毁=记忆丢失, 与北极星"有连续记忆"冲突。
# 备份范围: ~/.dsh/cognitive-pipeline 全部认知资产(jsonl账本/md文档/设计链)
# 保留策略: 近7天每日 + 每周滚动(保留14份, 自动清理最旧)
set -euo pipefail

SRC="$HOME/.dsh/cognitive-pipeline"
DEST="$HOME/backups/cognitive-daily"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP_DAILY=7
KEEP_TOTAL=14

mkdir -p "$DEST"
# 排除临时/锁类文件, 备份核心认知资产
# 2026-09-08 22:2x 补漏: 小说工作区(草稿/设定/账本, 6.6 万字正文)此前不在任何备份或版本控制
# 范围内——认知账本每日备份, 而真正的产出物(小说)单点裸奔, 与"存续底线"冲突。
tar czf "$DEST/cognitive-$STAMP.tar.gz" \
  -C "$HOME/.dsh" \
  --exclude='cognitive-pipeline/temp_strategies.jsonl' \
  --exclude='cognitive-pipeline/*.pyc' \
  cognitive-pipeline/ \
  -C "$HOME" \
  --exclude='*.png' --exclude='*.pyc' --exclude='__pycache__' \
  dsh-workshop/novels/ 2>/dev/null

# 清理: 保留最近 KEEP_TOTAL 份
ls -1t "$DEST"/cognitive-*.tar.gz 2>/dev/null | tail -n +$((KEEP_TOTAL + 1)) | xargs -r rm -f

# 异地推送(阿里云备用机, 跨云冗余——2026-09-07 15:2x 打通)
REMOTE_HOST="root@47.120.52.240"
REMOTE_DIR="/root/dsh-backups"
REMOTE_KEY="$HOME/.ssh/dsh.pem"
if [ -f "$REMOTE_KEY" ]; then
  timeout 60 scp -i "$REMOTE_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    "$DEST/cognitive-$STAMP.tar.gz" "$REMOTE_HOST:$REMOTE_DIR/" >/dev/null 2>&1 \
    && echo "[backup] 异地推送完成: $REMOTE_HOST:$REMOTE_DIR/cognitive-$STAMP.tar.gz" \
    || echo "[backup] ⚠ 异地推送失败(本地备份保留)"
else
  echo "[backup] 无异地密钥, 跳过远程推送"
fi

echo "[backup] $(date '+%F %T') 完成: $DEST/cognitive-$STAMP.tar.gz ($(du -h "$DEST/cognitive-$STAMP.tar.gz" | cut -f1))"
