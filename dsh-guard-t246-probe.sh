#!/usr/bin/env bash
# dsh-guard-t246-probe.sh — T246「复习拒收路径 + 共现归一 + 单一口径」的开火探针(**双臂**)
# 三个变异体必须**各自**让判据转红(任一存活 ⇒ 判据对该缺陷无区分力):
#   A 抹掉 `--why` 要求              ⇒ ①「无理由不许写账本」该红(防自我刷分的闸门消失)
#   B 共现不归一(用原始次数计数)      ⇒ ③该红(第一版真实病灶: 250 行审计里人人互相共现, assoc 冲到 352)
#   C 把 _raw 的 cc_strong 退回旧口径 ⇒ ④该红(同一指标两套口径: J=0.5 的真邻居在报告里算 1 个、分数里算 0 个)
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T246 必绿。
set -uo pipefail
NAME="复习通道的拒收路径: 无理由不许写账本 + 共现必须 Jaccard 归一"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-activity-model.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T246 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
restore() { cp -p "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT

survived=""
for M in A B C; do
  python3 - "$SRC" "$M" <<'MK' || exit 3
import sys
p, which = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf8").read()
REPL = {
    "A": [("    if not str(args.why or '').strip():",
           "    if False:  # MUTANT A: 复习不再要求理由")],
    "B": [("            j = c / union if union else 0.0",
           "            j = float(c)  # MUTANT B: 不归一(原始次数)"),
          ("    cc_strong = len(cc)                      # coincidence() 已按 Jaccard 阈值过滤",
           "    cc_strong = int(sum(cc.values()))        # MUTANT B: 按原始次数计数")],
    "C": [("    # 在分数里算 0 个(\"报告说有联系, 打分时这条联系没参与\")。coincidence() 已按 COOCC_JACCARD 过滤, 统一用 len。\n    cc_strong = len(cc)",
           "    # MUTANT C: 退回旧口径(只算 Jaccard 恰好 1.0 的邻居)\n    cc_strong = sum(1 for k, v in cc.items() if v >= COOCC_MIN)")],
}[which]
for old, new in REPL:
    assert s.count(old) == 1, "结构变了, 探针自身失效(%s): %r" % (which, old[:60])
    s = s.replace(old, new)
open(p, "w", encoding="utf8").write(s)
assert "MUTANT" in open(p, encoding="utf8").read(), "变异没落盘"
MK
  python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
  restore
  [ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
  if [ "$rc" -eq 0 ]; then survived="$survived $M"; fi
  if [ "$rc" -eq 3 ]; then echo "变异体 $M 拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
done

if [ -n "$survived" ]; then
  echo "变异体$survived 存活 ⇒ 判据对这些缺陷无区分力" >&2
  exit 4
fi
echo "[guard-fire] FIRED T246: 三个变异体(无理由放行 / 共现不归一 / 两套口径)全部被判据抓住" >&2
exit 1
