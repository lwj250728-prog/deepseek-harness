#!/usr/bin/env bash
# dsh-guard-t214-probe.sh — T214「帧生判据三处同口径」的开火探针
# 语义: 把 dsh-injection-noise.py 的判据变异回**旧口径**(只看 situation 前缀) —— 这正是 cl-283 的缺陷
#       (它自带第三份判据, 与写侧/读侧互相偏离, 导致"已修好"被读成"没修好")。用同一条断言审 ⇒ 必须转红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-injection-noise.py"), encoding="utf8").read()
body = """    if exp.get('kind') == 'frame':
        return True
    if exp.get('kind') == 'task':
        return False
    action = str((exp.get('sar') or {}).get('action') or '')
    situation = ((exp.get('sar') or {}).get('situation') or '')
    if action.startswith('quiet-driver 旁路三问帧') or situation.startswith(('三问帧旁路评估',)):
        return True"""
old = """    situation = ((exp.get('sar') or {}).get('situation') or '')"""
assert src.count(body) == 1, "找不到对齐后的判据体(结构变了, 探针自身失效)"
mut = src.replace(body, old + "   # 变异: 退回旧口径(不看 kind/action)")
open(os.path.join(T, "mutant-noise.py"), "w", encoding="utf8").write(mut)
MK
if DSH_NOISE_TOOL="$TMP/mutant-noise.py" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "帧生判据三处同口径(工具侧须与写侧产物一致)" >/dev/null 2>&1; then
  echo "退回旧口径(自带第三份判据)却判绿 —— cl-283 的偏离会原样复发" >&2
  exit 4
fi
echo "[guard-fire] FIRED T214: 工具侧退回旧口径被同一条断言判红" >&2
exit 1
