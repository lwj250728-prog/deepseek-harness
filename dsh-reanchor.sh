#!/usr/bin/env bash
# dsh-reanchor.sh — 受控停机窗口: 应用待修链锚 + 清除过期粘性锚, 然后启动服务
#
# 为什么必须停机做(cl-030 教训): 认知管线的 experiences.jsonl 在运行时是"内存全量回写",
# 进程还持有旧值, 离线改文件会被下一次 flush 覆盖。只有在服务停、进程无内存副本的窗口里改,
# 才真正落盘。
#
# 用法: ./dsh-reanchor.sh
set -uo pipefail
log() { echo "[reanchor] $*"; }

# 关键安全网: 无论中间哪一步失败, 退出时一定把服务拉起来——否则本脚本会把载体停死。
cleanup() {
  if ! systemctl --user is-active --quiet dsh-web.service; then
    log "安全网: 服务未运行, 重新启动"
    systemctl --user start dsh-web.service
  fi
  log "结束 (PID $(systemctl --user show dsh-web.service -p MainPID --value))"
}
trap cleanup EXIT

log "停止 dsh-web.service ..."
systemctl --user stop dsh-web.service

python3 "$HOME/dsh-fork/dsh-reanchor-apply.py" || log "⚠ 修复脚本失败, 由安全网恢复服务"

log "启动 dsh-web.service ..."
systemctl --user start dsh-web.service
sleep 6
systemctl --user is-active dsh-web.service
log "完成 (PID $(systemctl --user show dsh-web.service -p MainPID --value))"
