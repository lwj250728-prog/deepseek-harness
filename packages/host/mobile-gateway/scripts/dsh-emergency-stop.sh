#!/usr/bin/env bash
# ============================================================
# dsh-emergency-stop.sh — 紧急安全关闭 DSH Web 及其端口
# ------------------------------------------------------------
# 适用: Ubuntu 服务器上由 systemd 托管的 DSH Web（dsh-web.service）
#       + mobile-gateway 网关端口，以及历史遗留的手动 nohup 实例。
# 安全: 只匹配 DSH 相关进程与端口，不误杀其他服务；
#       先停 systemd（防止一边失败一边拉起），再清残留，最后兜底释放端口。
#
# 用法:
#   sudo ./dsh-emergency-stop.sh            # 停止服务并释放端口
#   sudo ./dsh-emergency-stop.sh --disable  # 同时取消开机自启（彻底关闭）
#   sudo ./dsh-emergency-stop.sh --check    # 只检查状态，不做任何动作
# ============================================================
set -u

DISABLE=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --disable) DISABLE=1 ;;
    --check) CHECK=1 ;;
    *) echo "unknown argument: $arg (expect --disable | --check)"; exit 2 ;;
  esac
done

# DSH 相关端口：DSH web + mobile-gateway 网关（4088）+ 历史端口 4080
PORTS=(3080 4088 4080)

if [ "$(id -u)" -ne 0 ] && [ "$CHECK" = "0" ]; then
  echo "请用 sudo 运行: sudo $0 $*"
  exit 1
fi

if [ "$CHECK" = "1" ]; then
  echo "==> 当前 DSH 相关状态:"
  if systemctl list-unit-files dsh-web.service >/dev/null 2>&1; then
    echo "  systemd dsh-web: $(systemctl is-active dsh-web 2>/dev/null || echo inactive)"
  else
    echo "  systemd dsh-web: 无此单元"
  fi
  pgrep -af "profile web" || echo "  DSH 进程: 无"
  for port in "${PORTS[@]}"; do
    if ss -ltn | grep -q ":$port "; then
      echo "  端口 $port: 被占用"
    else
      echo "  端口 $port: 空闲"
    fi
  done
  exit 0
fi

echo "==> [1/4] 停止 systemd 服务 (dsh-web)"
if systemctl list-unit-files dsh-web.service >/dev/null 2>&1; then
  systemctl stop dsh-web
  if [ "$DISABLE" = "1" ]; then
    systemctl disable dsh-web >/dev/null 2>&1
    echo "    已停止，并取消开机自启（--disable）"
  else
    echo "    已停止（保留开机自启，可 systemctl start dsh-web 恢复）"
  fi
else
  echo "    无 systemd 单元 dsh-web（跳过）"
fi
sleep 1

echo "==> [2/4] 终止残留的 DSH 手动进程 (nohup/旧实例)"
pids=$(pgrep -f "profile web" || true)
if [ -n "$pids" ]; then
  echo "    发现: $(pgrep -af 'profile web' | tr '\n' '; ')"
  pkill -f "profile web" 2>/dev/null
  sleep 1
  leftover=$(pgrep -f "profile web" || true)
  if [ -n "$leftover" ]; then
    echo "    强杀: $leftover"
    pkill -9 -f "profile web" 2>/dev/null
  fi
else
  echo "    无残留进程"
fi
sleep 1

echo "==> [3/4] 端口占用兜底清理"
for port in "${PORTS[@]}"; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$pid" ]; then
    echo "    端口 $port 被 PID $pid 占用，终止..."
    kill -9 "$pid" 2>/dev/null
  fi
done
sleep 1

echo "==> [4/4] 验证端口释放"
ok=1
for port in "${PORTS[@]}"; do
  if ss -ltn | grep -q ":$port "; then
    echo "    FAIL: $port 仍被占用"
    ok=0
  else
    echo "    OK: $port 已释放"
  fi
done

echo ""
if [ "$ok" = "1" ]; then
  echo "✅ DSH Web 已紧急关闭，端口 $(IFS=,; echo "${PORTS[*]}") 全部释放"
else
  echo "⚠️  仍有端口占用，请检查: ss -ltnp | grep -E ':(3080|4088|4080) '"
  echo "   确认后可用: systemctl start dsh-web 恢复服务"
fi
