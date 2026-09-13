#!/usr/bin/env bash
# dsh-guard-t223-probe.sh — T223「引用时代边界可被行为验证」的开火探针(**双臂**)
# 语义: 把 citation-era.json 的 since **人为往前挪**到 09-09T00:00(证伪信号要求的那一刀) ⇒ 前窗会落进
#       一段"引用还不可观测"的时期, 却出现了被引用行 ⇒ 判据必须判红。
# 干净臂(DSH_PROBE_CLEAN=1)另验两件事: ①真世界判绿; ②**样本不足时必须显式跳过**(打印"不得当作通过"),
#       而不是静默判绿 —— 那是判据最容易退化成"空过"的地方。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="引用时代边界须可被行为验证(since 前窗引用率≤后窗1/5, 且近期无被引用注入)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
COG="${DSH_COG_DIR:-$HOME/.dsh/cognitive-pipeline}"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  # ① 真世界必须判绿
  if ! python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "干净臂: 真世界被判红(判据在原件上就红, 对变异无区分力)" >&2
    exit 3
  fi
  # ② 样本不足必须**显式跳过**并打印"不得当作通过", 而不是静默绿
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  python3 - "$T" <<'MK' || exit 3
import json, os, sys, datetime
T = sys.argv[1]
tz = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(tz)
# 只有 3 条已结算注入, 且都在 since 之前 ⇒ 前窗 < 30 ⇒ 判据应跳过
since = now
rows = []
for i in range(3):
    rows.append({"createdAt": int((since - datetime.timedelta(hours=2 + i)).timestamp() * 1000),
                 "cited": False, "expIds": ["exp_%d" % i]})
with open(os.path.join(T, "injections.jsonl"), "w", encoding="utf8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
json.dump({"since": since.isoformat(), "reason": "合成: 样本不足"}, open(os.path.join(T, "citation-era.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
  OUT=$(DSH_COG_DIR="$T" python3 "$RUNNER" --name "$NAME" 2>&1)
  RC=$?
  if [ "$RC" != "0" ]; then
    echo "干净臂: 样本不足时判红(应跳过而非判红) —— 判据把'判不了'读成了'有问题'" >&2
    exit 3
  fi
  case "$OUT" in
    *样本不足*) : ;;
    *) echo "干净臂: 样本不足时既没判红也没明说'样本不足' ⇒ 静默绿(=空过), 这是判据最容易退化的形态" >&2; exit 3 ;;
  esac
  case "$OUT" in
    *不得当作通过*) : ;;
    *) echo "干净臂: 跳过了但没写'不得当作通过'(读的人会把它当成通过)" >&2; exit 3 ;;
  esac
  echo "[guard-fire] T223 干净臂: 真世界判绿; 样本不足时显式跳过(应然)" >&2
  exit 0
fi

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp "$COG/injections.jsonl" "$T/" 2>/dev/null || { echo "取不到注入账本, 探针自身失效" >&2; exit 3; }
python3 - "$T" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
json.dump({"since": "2026-09-09T00:00:00+08:00",
           "reason": "合成变异: since 人为往前挪(证伪信号要求的刀)"},
          open(os.path.join(T, "citation-era.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
if DSH_COG_DIR="$T" python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "把 since 往前挪到 09-09T00:00 后判据仍判绿 —— 边界不可被行为验证(声明与数据可以不一致)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T223: since 被人为挪动后被判据抓住(边界确实在被验证)" >&2
exit 1
