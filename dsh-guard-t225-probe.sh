#!/usr/bin/env bash
# dsh-guard-t225-probe.sh — T225「OOM 回归守卫」的开火探针(**双臂**)
# 变异臂(tp-192 的证伪信号): 把**物化预算改成无上限**(等价于回到"整份物化"的旧行为)注入真源码,
#   跑 T225 ⇒ 有界尾读测试必须变成 "1 failed | 11 passed" ⇒ 判据判红。改完**立即恢复**(trap 保证)。
# 干净臂(DSH_PROBE_CLEAN=1): 不改源码, 直接跑 T225 ⇒ 必须判绿(证明变异臂的红不是"判据本来就红")。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="会话加载主路径的 OOM 回归守卫(回归会红/产物有路径/崩溃计数不无凭增长)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/packages/session/session-persistence-jsonl/src/index.ts"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T225 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$SRC" "$BAK" || exit 3
restore() { cp "$BAK" "$SRC"; rm -f "$BAK"; }
trap restore EXIT

python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = """    this.materializeBudgetBytes = config.maxMaterializeBytes === 0
      ? undefined
      : config.maxMaterializeBytes ?? DEFAULT_MAX_MATERIALIZE_BYTES"""
new = "    this.materializeBudgetBytes = Number.POSITIVE_INFINITY  // MUTANT: 预算无效(=旧行为)"
assert s.count(old) == 1, "找不到预算赋值(结构变了, 探针自身失效)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
back = open(p, encoding="utf8").read()
assert "MUTANT: 预算无效" in back and "config.maxMaterializeBytes === 0" not in back, "变异没落盘"
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "把物化预算改成无上限(回到旧行为)后判据仍判绿 —— 这条守卫抓不住 OOM 回归" >&2
  exit 4
fi
echo "[guard-fire] FIRED T225: 物化预算被去掉后, 有界尾读测试转红并被判据抓住" >&2
exit 1
