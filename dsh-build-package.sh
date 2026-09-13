#!/usr/bin/env bash
# dsh-build-package.sh — **单包构建**(cl-351 部署时考古出来的路径)
#
# 为什么需要它: 根构建是 `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`。第一条命令是
# **全仓类型闸门**(tsconfig.host.json 里 noEmit: true, 不产出任何文件), 只要别人有在飞的工作带类型错误
# (实测 67 个错误 / 7 个文件, 其中 dormant-goal/src 8 个), 整条链就断在 && 前面, tsdown 根本不跑 ——
# 于是"改了源码但产物没更新", 而载体跑的是产物 ⇒ 声明与行为脱节, 且**看不出是构建被挡了**。
#
# 关键事实(实测):
#   · 有自带 tsdown.config.ts 的包: 在包目录里 `npx tsc -b tsconfig.json`(emit 到 lib/types) 再 `npx tsdown`。
#   · 走根 workspace 配置的包(没有自己的 tsdown.config.ts): 在**根目录**跑 `npx tsdown -F <相对包路径>`。
#     ⚠️ `-F` 从命令行传入是**精确字符串匹配**(tsdown 只在值是 RegExp 时才按正则), 所以要写
#     `-F packages/cognition/cognitive-pipeline`, 写 `/cognitive-pipeline$/` 会"没有匹配的配置"而报错。
#
# 用法: dsh-build-package.sh <相对路径如 packages/cognition/cognitive-pipeline>
# 退出码: 0 成功; 3 参数错/包不存在; 其余为构建器退出码。
set -uo pipefail
R="${DSH_REPO:-$HOME/dsh-fork}"
PKG="${1:-}"
[ -n "$PKG" ] || { echo "用法: dsh-build-package.sh <包相对路径>" >&2; exit 3; }
[ -d "$R/$PKG" ] || { echo "包不存在: $R/$PKG" >&2; exit 3; }
cd "$R" || exit 3

if [ -f "$PKG/tsdown.config.ts" ]; then
  echo "[build] $PKG 自带 tsdown.config.ts ⇒ 包内构建(tsc -b + tsdown)"
  ( cd "$PKG" && npx tsc -b tsconfig.json && npx tsdown --env.DSH_BUILD_FACE host ) || exit $?
else
  echo "[build] $PKG 走根 workspace 配置 ⇒ tsdown -F $PKG"
  # 先 emit(tsconfig.json 是 noEmit:false 的那份, 产出 lib/types), 再用根配置打包。
  ( cd "$PKG" && npx tsc -b tsconfig.json ) || exit $?
  npx tsdown --env.DSH_BUILD_FACE host -F "$PKG" || exit $?
fi
echo "[build] 完成: $PKG/lib/index.js $(stat -c %y "$PKG/lib/index.js" 2>/dev/null | cut -c1-19)"
