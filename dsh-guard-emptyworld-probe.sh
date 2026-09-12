#!/usr/bin/env bash
# dsh-guard-emptyworld-probe.sh — "可隔离的断言"的通用开火探针(cl-272 债务的便宜那部分)
#
# 由来(2026-09-12 13:5x 三问帧实测): 债务集里抽样 42 条轻量断言, 只有 **2 条**在空世界下判红
# ⇒ 可隔离; 其余 40 条不读世界根, 必须先补注入点才能喂缺陷件。对可隔离的那部分, 开火命令可以
# **一行生成**: 把世界根指向空目录, 同一条断言必须转红。
#
# 用法: dsh-guard-emptyworld-probe.sh "<断言名>"
#   exit 1 = FIRED(空世界下确实判红) / exit 4 = 漂移(空世界下仍判绿 ⇒ 它并不读世界根) / exit 3 = 取不到断言
set -uo pipefail
NAME="${1:?用法: dsh-guard-emptyworld-probe.sh \"<断言名>\"}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if DSH_COG_DIR="$TMP" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "$NAME" >/dev/null 2>&1; then
  echo "[emptyworld] 空世界下仍判绿: $NAME —— 它不读世界根(不可隔离), 不能用这个通用探针" >&2
  exit 4
fi
echo "[guard-fire] FIRED: 空世界下判红($NAME)" >&2
exit 1
