#!/usr/bin/env bash
# dsh-cog — 启动带认知流水线插件的 DeepSeek Harness
# 用法:
#   dsh-cog web                 # Web UI (127.0.0.1:3080)
#   dsh-cog headless "任务"      # 一次性任务
#   dsh-cog web --port 8080     # 自定义端口

set -e

export PATH="/home/ubuntu/.npm-global/bin:$PATH"
export DSH_HOME="${DSH_HOME:-/home/ubuntu/.dsh}"
# 沙箱权限：服务器无 landlock 后端，用 danger-full-access（显式非沙箱）让 bash 能执行命令
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

# 从 Hermes 环境读取 DeepSeek key（若未显式设置）
if [ -z "$DEEPSEEK_API_KEY" ] && [ -f ~/.hermes/.env ]; then
  export DEEPSEEK_API_KEY=$(grep "^DEEPSEEK_API_KEY=" ~/.hermes/.env | cut -d= -f2)
fi

DSH_BIN="/home/ubuntu/dsh-fork/apps/cli/lib/bin.js"
PATCH="/home/ubuntu/dsh-fork/cognitive-patch.yml"

cd /home/ubuntu/dsh-fork

# 第一个参数若是 headless（非 dsh 内建子命令），转成 --profile headless
if [ "$1" = "headless" ]; then
  shift
  exec node "$DSH_BIN" --profile headless --patch "$PATCH" "$@"
fi

exec node "$DSH_BIN" "$1" --patch "$PATCH" "${@:2}"
