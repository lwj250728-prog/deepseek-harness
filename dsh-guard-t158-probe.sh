#!/usr/bin/env bash
# 开火探针(T158): 内容基线必须分得开"仅 mtime 变"(放行)与"内容真的变了"(判待部署)。
# 约定: exit 1 = 按预期开火; exit 0 = 没开火(判据失效); 其它 = 崩了。
set -u
repo="${DSH_REPO:-$HOME/dsh-fork}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/libs" "$tmp/state"
printf 'export const a = 1\n' > "$tmp/libs/index.js"
# ① 记录基线后内容未变 ⇒ 必须判 identical(exit 0)
python3 "$repo/dsh-deploy-lib-hashes.py" --record --glob "$tmp/libs/*.js" --file "$tmp/state/hashes.json" >/dev/null || { echo "记录基线失败" >&2; exit 3; }
if ! python3 "$repo/dsh-deploy-lib-hashes.py" --check --glob "$tmp/libs/*.js" --file "$tmp/state/hashes.json" >/dev/null 2>&1; then
  echo "误报: 内容未变却判待部署" >&2
  exit 0
fi
# ② 只改 mtime(内容逐字节相同) ⇒ 仍必须判 identical —— 这正是本轮的真实情形
touch "$tmp/libs/index.js"
if ! python3 "$repo/dsh-deploy-lib-hashes.py" --check --glob "$tmp/libs/*.js" --file "$tmp/state/hashes.json" >/dev/null 2>&1; then
  echo "误报: 只改了 mtime 就判待部署" >&2
  exit 0
fi
# ③ 真的改内容 ⇒ 必须判 changed(exit 2)
printf 'export const a = 2\n' > "$tmp/libs/index.js"
if python3 "$repo/dsh-deploy-lib-hashes.py" --check --glob "$tmp/libs/*.js" --file "$tmp/state/hashes.json" >/dev/null 2>&1; then
  echo "未开火: 内容真的变了却没判待部署" >&2
  exit 0
fi
echo "内容基线按预期开火(仅 mtime 变放行, 内容变判红)" >&2
exit 1
