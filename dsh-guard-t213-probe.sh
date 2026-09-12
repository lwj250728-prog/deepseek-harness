#!/usr/bin/env bash
# dsh-guard-t213-probe.sh — T213「读侧帧层判据必须与写侧同一口径」的开火探针
# 语义: 把 self-frame.ts 变异回**旧口径**(只看 situation 前缀, 不看 kind/action) —— 这正是 cl-280 的缺陷
#       (对现帧格式命中 0/135)。用同一条断言审它 ⇒ 必须转红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/self-frame.ts"), encoding="utf8").read()
body = """  // 与写侧同一判据: kind 优先(cl-102/cl-033: 文本嗅探曾把一条引用了模板字符串的任务经验误判成帧经验)。
  if (candidate.kind === 'frame') return true
  if (candidate.kind === 'task') return false
  const situation = candidate.sar.situation
  const action = String(candidate.sar.action ?? '')
  return SELF_FRAME_ACTION_PREFIX.length > 0 && action.startsWith(SELF_FRAME_ACTION_PREFIX)
    || SELF_FRAME_SITUATION_PREFIXES.some(prefix => situation.startsWith(prefix))
    || SELF_FRAME_PREFIXES.some(prefix => situation.startsWith(prefix))
    || situation.includes(SELF_FRAME_MARKER)"""
old = """  const situation = candidate.sar.situation
  return SELF_FRAME_PREFIXES.some(prefix => situation.startsWith(prefix))
    || situation.includes(SELF_FRAME_MARKER)"""
assert src.count(body) == 1, "找不到当前判据体(结构变了, 探针自身失效)"
open(os.path.join(T, "mutant-self-frame.ts"), "w", encoding="utf8").write(src.replace(body, old))
MK
if DSH_SELF_FRAME="$TMP/mutant-self-frame.ts" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "读侧帧层判据必须与写侧同一口径(帧层全中、任务层不误伤)" >/dev/null 2>&1; then
  echo "退回旧口径(只看 situation 前缀)却判绿 —— cl-280 的缺陷会原样复发" >&2
  exit 4
fi
echo "[guard-fire] FIRED T213: 旧口径(不看 kind/action)被同一条断言判红" >&2
exit 1
