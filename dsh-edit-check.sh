#!/usr/bin/env bash
# dsh-edit-check.sh — 编辑后立即校验(cl-072②): 按扩展名做最便宜的语法闸
#
# 为什么需要: 2026-09-09 13:3x 实测——套件脚本自身语法错时, bash 仍按行执行前半段,
# 于是"跑完了"可能掩盖"文件已坏"; 编辑动作与校验动作之间没有强制绑定, 全靠自觉。
# 用法: ./dsh-edit-check.sh <文件...>   (退出码非0 = 有文件未过)
#       ./dsh-edit-check.sh --show-targets   (只打印锚点目标集合, 不校验)
set -uo pipefail

# ── 锚点目标集合(tp-203 / 判据组 T235) ───────────────────────────────────────
# 由来(2026-09-14 00:2x 实测): 我给 dsh-mutant-gate.py 加 in_flight() 时把 leaks.append 的缩进从 16 空格降到 12 空格,
# 于是 T232 探针的 old 锚点与 deg-t232-gateblind.old **同时失效**; 而**为此造的判据 dsh-probe-binding.py --check
# 当时就是红的** —— 判据不缺, 缺的是「编辑 → 锚点检查」的机械接线。本段就是那根接线。
COG="${DSH_COG_DIR:-$HOME/.dsh/cognitive-pipeline}"
TARGETS=$(python3 - "$COG" <<'PY'
import json, os, sys
cog = sys.argv[1]
out = set()
try:
    b = json.load(open(os.path.join(cog, 'probe-bindings.json'), encoding='utf8'))
    for r in b.get('probes') or []:
        for a in r.get('anchors') or []:
            if a.get('file'):
                out.add(os.path.abspath(a['file']))
except Exception:
    pass
try:
    m = json.load(open(os.path.join(cog, 'synthetic-world-mutants.json'), encoding='utf8'))
    for e in m.get('entries') or []:
        if e.get('file'):
            out.add(os.path.abspath(e['file']))
except Exception:
    pass
try:
    w = json.load(open(os.path.join(cog, 'session-coverage-witness.json'), encoding='utf8'))
    mf = (w.get('mutant') or {}).get('file')
    if mf:
        out.add(os.path.abspath(os.path.join(os.path.expanduser('~/dsh-fork'), mf)))
except Exception:
    pass
print('\n'.join(sorted(out)))
PY
)
if [ "${1:-}" = "--show-targets" ]; then
  echo "锚点目标集合(取自登记簿, 不是硬编码名单):"
  printf '%s\n' "$TARGETS" | sed 's/^/  /'
  exit 0
fi

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

hit=0
for f in "$@"; do
  af=$(python3 -c 'import os,sys;print(os.path.abspath(sys.argv[1]))' "$f" 2>/dev/null)
  if [ -n "$af" ] && printf '%s\n' "$TARGETS" | grep -qxF "$af"; then
    hit=1
    echo "· $f 是**锚点目标**(有探针或退化登记在它身上做变异) ⇒ 立刻跑锚点检查"
  fi
done
if [ "$hit" -eq 1 ]; then
  if python3 "$HOME/dsh-fork/dsh-probe-binding.py" --check >/tmp/dsh-edit-check.pb 2>&1; then
    echo "✓ 锚点绑定检查通过"
  else
    echo "✗ 锚点绑定检查判红(改了被变异的目标文件却没同步锚点?)"
    tail -3 /tmp/dsh-edit-check.pb | sed 's/^/    /'
    fail=1
  fi
  DSH_MUTATION_LOCK_WAIT=5 python3 "$HOME/dsh-fork/dsh-degeneracy-check.py" --check >/tmp/dsh-edit-check.dg 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "✓ 退化登记检查通过"
  elif [ "$rc" -eq 3 ] || [ "$rc" -eq 7 ]; then
    echo "· 退化登记检查本次不可判(环境/锁, rc=$rc) —— 不算红, 但要知道它没验"
  else
    echo "✗ 退化登记检查判红"
    tail -3 /tmp/dsh-edit-check.dg | sed 's/^/    /'
    fail=1
  fi
fi

[ "$fail" -eq 0 ] && echo "全部通过" || echo "有文件未通过"
exit "$fail"
