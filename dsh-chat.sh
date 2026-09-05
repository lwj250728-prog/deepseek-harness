#!/usr/bin/env bash
# dsh-chat.sh — DeepSeek Harness 持续对话 wrapper
#
# 第一次调用创建会话并记住 sessionId，后续调用自动 --resume 续接。
# 会话状态存于 /home/ubuntu/dsh-fork/.dsh_session
#
# 用法:
#   dsh-chat.sh "任务"          # 自动续接（首次则新建）
#   dsh-chat.sh --new "任务"    # 强制新会话
#   dsh-chat.sh --reset         # 清除会话记录
#   dsh-chat.sh --show-id       # 显示当前 sessionId

set -e
export PATH="/home/ubuntu/.npm-global/bin:$PATH"
export DSH_HOME="${DSH_HOME:-/home/ubuntu/.dsh}"
# 沙箱权限：服务器无 landlock 后端，用 danger-full-access（显式非沙箱）让 bash 能执行命令
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

# 从 Hermes 环境读取 DeepSeek key
if [ -z "$DEEPSEEK_API_KEY" ] && [ -f ~/.hermes/.env ]; then
  export DEEPSEEK_API_KEY=$(grep "^DEEPSEEK_API_KEY=" ~/.hermes/.env | cut -d= -f2)
fi

DSH_BIN="/home/ubuntu/dsh-fork/apps/cli/lib/bin.js"
PATCH="/home/ubuntu/dsh-fork/cognitive-patch.yml"
SESSION_FILE="/home/ubuntu/dsh-fork/.dsh_session"

cd /home/ubuntu/dsh-fork

# 特殊命令
if [ "$1" = "--reset" ]; then
  rm -f "$SESSION_FILE"
  echo "会话已重置"
  exit 0
fi
if [ "$1" = "--show-id" ]; then
  [ -f "$SESSION_FILE" ] && cat "$SESSION_FILE" || echo "(无会话)"
  exit 0
fi

# 是否强制新会话
FORCE_NEW=0
if [ "$1" = "--new" ]; then
  FORCE_NEW=1
  shift
fi

# 决定是否 resume
RESUME_ARGS=()
if [ "$FORCE_NEW" -eq 0 ] && [ -f "$SESSION_FILE" ]; then
  SID=$(cat "$SESSION_FILE")
  [ -n "$SID" ] && RESUME_ARGS=(--resume "$SID")
fi

# 运行，捕获 stdout(结果) 和 stderr(session id + 诊断)
STDERR_TMP=$(mktemp)
set +e
OUTPUT=$(node "$DSH_BIN" --profile headless --patch "$PATCH" "${RESUME_ARGS[@]}" "$@" 2> "$STDERR_TMP")
EXIT_CODE=$?
set -e

# 打印结果（stdout）
echo "$OUTPUT"

# 提取 session id 并保存（每次运行都会打印，含 resume 后的）
SID_LINE=$(grep '^session: ' "$STDERR_TMP" 2>/dev/null | tail -1 | sed 's/^session: //')
if [ -n "$SID_LINE" ]; then
  echo "$SID_LINE" > "$SESSION_FILE"
fi

# 打印非 session 的 stderr 诊断（如有）
grep -v '^session: ' "$STDERR_TMP" 2>/dev/null | grep -v '^$' >&2 || true
rm -f "$STDERR_TMP"

exit $EXIT_CODE
