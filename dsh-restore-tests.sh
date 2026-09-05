#!/usr/bin/env bash
# dsh-restore-tests.sh — 按包恢复被禁用的测试文件（重构前必做）
#
# 背景：部署期 skip_text.sh 把 670 个测试禁用了(.spec.ts → .spec.ts.disabled)。
# 规范：重构/修改某包前，先恢复该包的测试，用测试验证改动，避免无测试重构。
#
# 用法:
#   ./dsh-restore-tests.sh list                       # 列出所有被禁测试的包
#   ./dsh-restore-tests.sh packages/cognition/cognitive-pipeline   # 恢复指定包
#   ./dsh-restore-tests.sh cognitive-pipeline         # 按包名模糊恢复
#   ./dsh-restore-tests.sh --all                      # 恢复全部
set -euo pipefail
cd "$(dirname "$0")"

list_disabled() {
  echo "被禁测试分布(包 → 数量):"
  find packages -name '*.disabled' -path '*/tests/*' 2>/dev/null \
    | sed -E 's|\./packages/([^/]+/[^/]+)/.*|\1|' | sort | uniq -c | sort -rn
}

restore_pkg() {
  local pat="$1"
  local count=0
  while IFS= read -r f; do
    mv "$f" "${f%.disabled}"
    count=$((count + 1))
  done < <(find packages -name '*.disabled' -path '*/tests/*' 2>/dev/null | grep "$pat")
  echo "恢复 $pat: $count 个测试文件"
}

case "${1:-list}" in
  list|-l) list_disabled ;;
  --all|-a)
    local c=0
    while IFS= read -r f; do mv "$f" "${f%.disabled}"; c=$((c+1)); done \
      < <(find packages -name '*.disabled' -path '*/tests/*' 2>/dev/null)
    echo "恢复全部: $c 个测试文件" ;;
  *)
    restore_pkg "$1" ;;
esac
