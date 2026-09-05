#!/usr/bin/env bash
# start-dsh-web.sh — 在 Linux 上以服务方式启动/停止 DeepSeek Harness Web
#
# 用法:
#   ./start-dsh-web.sh start       # 后台启动并等待健康检查通过
#   ./start-dsh-web.sh stop        # 优雅停止（超时后强杀）
#   ./start-dsh-web.sh restart     # 重启
#   ./start-dsh-web.sh status      # 查看运行状态与健康检查
#   ./start-dsh-web.sh logs        # 持续查看日志（Ctrl-C 退出）
#
# 所有路径与监听参数都可用环境变量覆盖（见下方“部署配置”）。
# Web 默认只绑定 127.0.0.1：CLI 主动拒绝 --host 0.0.0.0（该入口等同远程命令执行），
# 公网访问应通过 Caddy/nginx 反向代理，并把公网 authority 放进 DSH_TRUSTED_HOSTS，
# 用于 /api 浏览器信任围栏（防 DNS rebinding / 跨站请求）。

set -euo pipefail

# ---------- 部署配置（可用环境变量覆盖） ----------
DSH_ROOT="${DSH_ROOT:-/home/ubuntu/dsh-fork}"
DSH_BIN="${DSH_BIN:-$DSH_ROOT/apps/cli/lib/bin.js}"
DSH_PATCH="${DSH_PATCH:-$DSH_ROOT/cognitive-patch.yml}"
DSH_HOME_DIR="${DSH_HOME_DIR:-/home/ubuntu/.dsh}"
NPM_GLOBAL_BIN="${NPM_GLOBAL_BIN:-/home/ubuntu/.npm-global/bin}"

# 监听地址：保持 127.0.0.1，公网通过反向代理进入。
DSH_WEB_HOST="${DSH_WEB_HOST:-127.0.0.1}"
DSH_WEB_PORT="${DSH_WEB_PORT:-3080}"

# 反代入口的 authority（host 或 host:port），空格分隔可写多个。
# 手机通过 http://43.139.222.112 访问时，Caddy 把该 Host 透传给后端，
# 信任围栏据此放行 /api 请求。
DSH_TRUSTED_HOSTS="${DSH_TRUSTED_HOSTS:-43.139.222.112}"

# 运行目录、PID 文件与日志。
DSH_LOG_DIR="${DSH_LOG_DIR:-$DSH_ROOT/logs}"
DSH_PID_FILE="${DSH_PID_FILE:-$DSH_LOG_DIR/dsh-web.pid}"
DSH_LOG_FILE="${DSH_LOG_FILE:-$DSH_LOG_DIR/dsh-web.log}"

# 健康检查地址（回环即可，进程存活 + 能响应页面才算就绪）。
DSH_HEALTH_URL="${DSH_HEALTH_URL:-http://127.0.0.1:$DSH_WEB_PORT/}"
# 启动最多等待秒数；日志跟随行数。
DSH_START_TIMEOUT="${DSH_START_TIMEOUT:-60}"
DSH_LOG_LINES="${DSH_LOG_LINES:-100}"

# ---------- 固定环境 ----------
export PATH="$NPM_GLOBAL_BIN:$PATH"
export DSH_HOME="$DSH_HOME_DIR"
# 本机无 landlock 后端，用 danger-full-access（显式非沙箱）让 bash 能执行命令。
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

# 从 Hermes 环境读取 DeepSeek key（若未显式设置）。
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$HOME/.hermes/.env" ]; then
  export DEEPSEEK_API_KEY
  DEEPSEEK_API_KEY="$(grep '^DEEPSEEK_API_KEY=' "$HOME/.hermes/.env" | cut -d= -f2-)"
fi

usage() {
  sed -n '2,15p' "$0"
}

read_pid() {
  cat "$DSH_PID_FILE" 2>/dev/null || true
}

is_running() {
  local pid
  pid="$(read_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

healthcheck() {
  curl -fsS --max-time 5 -o /dev/null "$DSH_HEALTH_URL"
}

start() {
  if is_running; then
    echo "dsh web 已在运行 (pid $(read_pid))"
    return 0
  fi

  mkdir -p "$DSH_LOG_DIR"
  cd "$DSH_ROOT"

  local args=(web --patch "$DSH_PATCH")
  if [ -n "$DSH_WEB_HOST" ]; then
    args+=(--host "$DSH_WEB_HOST")
  fi
  args+=(--port "$DSH_WEB_PORT")
  for h in ${DSH_TRUSTED_HOSTS:-}; do
    [ -n "$h" ] && args+=(--trusted-host "$h")
  done

  echo "启动 dsh web: node $(basename "$DSH_BIN") ${args[*]}"
  nohup node "$DSH_BIN" "${args[@]}" >>"$DSH_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$DSH_PID_FILE"
  echo "pid=$pid，日志: $DSH_LOG_FILE"

  local waited=0
  while [ "$waited" -lt "$DSH_START_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "启动失败：进程已退出，最近日志：" >&2
      tail -n 30 "$DSH_LOG_FILE" >&2 || true
      rm -f "$DSH_PID_FILE"
      return 1
    fi
    if healthcheck; then
      echo "dsh web 已就绪: http://127.0.0.1:$DSH_WEB_PORT/"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "等待健康检查超过 ${DSH_START_TIMEOUT}s（进程仍存活），请查看日志: $DSH_LOG_FILE" >&2
  return 1
}

stop() {
  if ! is_running; then
    echo "dsh web 未运行"
    rm -f "$DSH_PID_FILE"
    return 0
  fi

  local pid
  pid="$(read_pid)"
  echo "停止 dsh web (pid $pid) ..."
  kill "$pid" 2>/dev/null || true

  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "优雅停止超时，发送 SIGKILL" >&2
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$DSH_PID_FILE"
  echo "dsh web 已停止"
}

status() {
  if is_running; then
    echo "dsh web: 运行中 (pid $(read_pid))"
    if healthcheck; then
      echo "健康检查: OK ($DSH_HEALTH_URL)"
    else
      echo "健康检查: FAILED"
      return 3
    fi
  else
    echo "dsh web: 未运行"
    return 3
  fi
}

logs() {
  tail -n "$DSH_LOG_LINES" -F "$DSH_LOG_FILE"
}

cmd="${1:-start}"
case "$cmd" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  logs) logs ;;
  help|--help|-h) usage ;;
  *)
    echo "未知命令: $cmd" >&2
    usage
    exit 2
    ;;
esac
