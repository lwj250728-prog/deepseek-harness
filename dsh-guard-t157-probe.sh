#!/usr/bin/env bash
# 开火探针(T157): 形状闸必须对"自取消形状"开火, 且不得对正常取数 effect 误报。
# 约定: exit 1 = 按预期开火(守卫有效); exit 0 = 没开火(守卫失效, 须修); 其它 = 崩了。
set -u
repo="${DSH_REPO:-$HOME/dsh-fork}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/packages/client/probe/src/client"
# ① 自取消形状(修复前的真实写法) —— 闸必须报违例
cat > "$tmp/packages/client/probe/src/client/Bad.tsx" <<'TSX'
import { useEffect } from 'react'
export function Bad({ status, refresh }: { status: string; refresh: (s: AbortSignal) => void }) {
  useEffect(() => {
    if (status !== 'idle') return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [status, refresh])
  return null
}
TSX
if python3 "$repo/dsh-client-effect-shape-check.py" --repo "$tmp" >/dev/null 2>&1; then
  echo "未开火: 自取消形状未被判违例" >&2
  exit 0
fi
# ② 正常形状(ref 守卫) —— 闸不得误报
cat > "$tmp/packages/client/probe/src/client/Bad.tsx" <<'TSX'
import { useEffect, useRef } from 'react'
export function Good({ refresh }: { refresh: (s: AbortSignal) => void }) {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const controller = new AbortController()
    void refreshRef.current(controller.signal)
    return () => { controller.abort() }
  }, [])
  return null
}
TSX
if ! python3 "$repo/dsh-client-effect-shape-check.py" --repo "$tmp" >/dev/null 2>&1; then
  echo "误报: 正常(空依赖+ref)取数 effect 被判违例" >&2
  exit 0
fi
echo "形状闸按预期开火(自取消判红, 正常形状放行)" >&2
exit 1
