#!/usr/bin/env bash
# dsh-guard-t152-probe.sh — T152「轨迹树面板接线」的开火探针
# 语义: 拿一个**不存在的插件路径**去问同一个判据, 它必须判红(证明"接线断了"会被抓, 而不是恒绿)。
#   exit 1 = 开火   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移
set -uo pipefail
if python3 -c '
import re, subprocess
r = subprocess.run(["curl", "-s", "--max-time", "15", "http://127.0.0.1:3080/"], capture_output=True, text=True)
m = re.search(r"/plugins/@deepseek-ai/dsh-client-ui-no-such-plugin/client\.js", r.stdout)
assert m, "boot 清单里没有该插件"
' 2>/dev/null; then
  echo "判据对不存在的插件判绿了(应红)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T152: 不存在的插件在 boot 清单中查无此条" >&2
exit 1
