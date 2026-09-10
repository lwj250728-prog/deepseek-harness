#!/usr/bin/env bash
# dsh-guard-t145-probe.sh — T145「部署脚本须留持久记录」的开火探针(tp-123)
# 语义: 判据是"部署动作必须留下含 start/done 的持久记录"。给判据一份**空记录文件**, 它必须判红。
#   exit 1 = 开火(抓住"没有记录")   ← must-fire 约定的期望码
#   exit 4 = 退出码漂移(空记录却判绿)
#
# 记一笔: 第一版探针用"/proc/self/cwd/<不存在目录>"当不可写路径 —— 结果 emit() 的
# os.makedirs(dirname(log)) 顺着 /proc/self/cwd 真的把目录建到了仓库里(且判据根本没被触发)。
# 教训: 探针不要依赖"路径不可写"这种平台相关的假设, 直接把**判据的输入**造成坏的那一种。
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
: > "$TMP/empty-deploy-log.jsonl"     # 空记录: 相当于"部署跑了但什么都没留下"

python3 - "$TMP/empty-deploy-log.jsonl" <<'CHECK'
import json, sys
log = sys.argv[1]
rows = [json.loads(l) for l in open(log, encoding="utf8") if l.strip()]
phases = [x.get("phase") for x in rows]
assert "start" in phases and "done" in phases, "记录缺少 start/done: %s" % phases
CHECK
CODE=$?
if [ "$CODE" -ne 0 ]; then
  echo "[guard-fire] FIRED T145: 空记录被判红(部署没有留下可复现的证据)" >&2
  exit 1
fi
echo "判据对空记录判绿了(应红)" >&2
exit 4
