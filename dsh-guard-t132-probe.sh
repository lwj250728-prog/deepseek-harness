#!/usr/bin/env bash
# dsh-guard-t132-probe.sh — T132「账本关闭行的写入模板必须带 ts」的开火探针(cl-188)
#
# 语义：把该守卫的判据跑在**修复前**的源码修订(默认 ab211e5^)上，期望它开火(非零退出)。
#   · 开火(exit 1) = 守卫真能抓到"关闭行缺 ts"这一型，不是永远绿的摆设；
#   · 不开火(exit 0) = 判据失效(正则被改坏 / 历史被改写) —— 由 T119「声明的开火命令必须现场
#     开火(非零退出)」直接判红。
#
# 为什么要有这个探针：quiet-driver 里两处 status:'done' 自动关单行曾整个没有 ts 字段，
# 数据层断言(cl-174 那一族)结构上碰不到它们——只有"查写入模板"的断言能抓，而模板断言如果不
# 能在已知坏修订上开火，就只是装饰。
set -uo pipefail
REV="${1:-ab211e5^}"
SRC="$(git -C /home/ubuntu/dsh-fork show "$REV:packages/context/quiet-driver/src/index.ts" 2>/dev/null)" || {
  echo "探针失效: 取不到 $REV 的源码(历史被改写?)" >&2
  exit 1
}
[ -n "$SRC" ] || { echo "探针失效: $REV 的源码为空" >&2; exit 1; }

BAD="$(printf '%s' "$SRC" | python3 -c '
import re, sys
src = sys.stdin.read()
hits = [m.start() for m in re.finditer(r"status: .done.,", src)]
bad = [i for i in hits if "ts:" not in src[i:i + 260]]
print(len(bad))
')"

echo "修复前修订 $REV: 关闭行模板缺 ts 的有 $BAD 处"
if [ "$BAD" -gt 0 ]; then
  exit 1
fi
echo "守卫未开火(判据可能已失效): 该修订上找不到缺 ts 的关闭行模板" >&2
exit 0
