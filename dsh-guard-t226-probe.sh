#!/usr/bin/env bash
# dsh-guard-t226-probe.sh — T226「改动必须有改动之后跑过的覆盖见证」的开火探针(**双臂**)
# 变异臂: 改动一个被监视的 src 文件(不改语义, 只加一行注释)而**不重跑见证** ⇒ 哈希不符 ⇒ 判据必须判红
#         (这正是 T28 要的形状: "改了但没在改动之后核验")。用 trap 恢复。
# 干净臂(DSH_PROBE_CLEAN=1): 不改任何文件 ⇒ 判据必须判绿。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="改动必须有改动之后跑过的覆盖见证(执行型, 非文本引用)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
TARGET="$HOME/dsh-fork/packages/api/remotes/src/agent-lookup.ts"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T226 干净臂: 未改动时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 没改任何文件却判红 ⇒ 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$TARGET" "$BAK" || exit 3
trap 'cp "$BAK" "$TARGET"; rm -f "$BAK"' EXIT
printf '\n// MUTANT: 改动后未重跑见证\n' >> "$TARGET"
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "改了被监视文件却没重跑见证, 判据仍判绿 —— '改动之后跑过'这条并没有被核对" >&2
  exit 4
fi
echo "[guard-fire] FIRED T226: 改动后未重新核验 ⇒ 哈希不符 ⇒ 判据抓住" >&2
exit 1
