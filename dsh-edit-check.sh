#!/usr/bin/env bash
# dsh-edit-check.sh — 编辑后立即校验(cl-072②): 按扩展名做最便宜的语法闸
#
# 为什么需要: 2026-09-09 13:3x 实测——套件脚本自身语法错时, bash 仍按行执行前半段,
# 于是"跑完了"可能掩盖"文件已坏"; 编辑动作与校验动作之间没有强制绑定, 全靠自觉。
# 用法: ./dsh-edit-check.sh <文件...>   (退出码非0 = 有文件未过)
set -uo pipefail
fail=0
for f in "$@"; do
  case "$f" in
    *.sh)
      if bash -n "$f" 2>/tmp/dsh-edit-check.err; then echo "✓ bash -n $f"
      else echo "✗ bash -n $f"; sed 's/^/    /' /tmp/dsh-edit-check.err; fail=1; fi ;;
    *.py)
      if python3 -m py_compile "$f" 2>/tmp/dsh-edit-check.err; then echo "✓ py_compile $f"
      else echo "✗ py_compile $f"; sed 's/^/    /' /tmp/dsh-edit-check.err; fail=1; fi ;;
    *.json)
      if python3 -c "import json,sys; json.load(open(sys.argv[1],encoding='utf8'))" "$f" 2>/tmp/dsh-edit-check.err; then echo "✓ json $f"
      else echo "✗ json $f"; sed 's/^/    /' /tmp/dsh-edit-check.err; fail=1; fi ;;
    *.jsonl)
      if python3 -c "
import json,sys
bad=[i for i,l in enumerate(open(sys.argv[1],encoding='utf8'),1) if l.strip() and (json.loads(l) or True)]
" "$f" 2>/tmp/dsh-edit-check.err; then echo "✓ jsonl $f"
      else echo "✗ jsonl $f"; sed 's/^/    /' /tmp/dsh-edit-check.err; fail=1; fi ;;
    *) echo "· 跳过(未知类型) $f" ;;
  esac
done
[ "$fail" -eq 0 ] && echo "全部通过" || echo "有文件未通过"
exit "$fail"
